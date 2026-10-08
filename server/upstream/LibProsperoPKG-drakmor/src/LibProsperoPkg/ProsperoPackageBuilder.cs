// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// High-level PS5 package builder. Turns a prepared application
// folder into a complete, signed PS5 package entirely in-process: there is no external tool to
// install and no platform-specific shell-out. The GP5 project model, the inner/outer PFS image,
// the AES-XTS encryption, RSA-3072 public wraps and the finalized debug image are all
// produced by this library. The PS5 publishing key material is wired in through
// <see cref="LibProsperoPkg.Keys.ProsperoKeys"/> and the signing path through
// <see cref="LibProsperoPkg.PKG.ProsperoPkgSigner"/>.

using LibProsperoPkg.GP5;
using LibProsperoPkg.Keys;
using LibProsperoPkg.PKG;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace LibProsperoPkg;

/// <summary>The kind of PS5 package to produce.</summary>
public enum ProsperoPackageMode
{
    /// <summary>A generic PS5 application/game (already-prepared <c>sce_sys</c> + eboot folder).</summary>
    Application,

    /// <summary>A PS5 homebrew application.</summary>
    Homebrew,

    /// <summary>Additional content (DLC) that ships data.</summary>
    AdditionalContentData,

    /// <summary>Additional content (DLC) entitlement only, no data.</summary>
    AdditionalContentNoData,
}

/// <summary>The representation a built inner-PFS image is rendered in.</summary>
public enum InnerImageForm
{
    /// <summary>An unsigned, unencrypted PFS image (raw layout).</summary>
    Plaintext,

    /// <summary>An AES-XTS-encrypted PFS image (plaintext superblock + encrypted filesystem).</summary>
    Encrypted,

    /// <summary>A PFSC-compressed PFS image (the <c>pfs_image.dat</c> form).</summary>
    Compressed,

    /// <summary>
    /// A PS5 PFSv3 Kraken-compressed PFS image — the codec the
    /// <c>nwonly</c> path uses for the inner image. The container is self-describing
    /// (magic <c>PFSC</c>, format version 3, 0x40000 blocks, SHA3-256 digests) and is round-trip
    /// validated in-process with the managed Kraken decoder. Distinct from <see cref="Compressed"/>,
    /// which is the zlib PFSC used for the installable inner image.
    /// </summary>
    KrakenCompressed,
}

/// <summary>The container format the builder emits.</summary>
public enum ProsperoOutputFormat
{
    /// <summary>
    /// A metadata container (<c>\x7FCNT</c>) only. This holds nothing but the package metadata and
    /// is <b>not</b> a full, installable package — it cannot be installed on a console. Use it for
    /// inspection / tooling; produce <see cref="DebugImage"/> for an installable package.
    /// </summary>
    MetadataContainer,

    /// <summary>
    /// A finalized <i>debug</i> image (<c>\x7FFIH</c>, signed byte 0x00) — a full package, and the only
    /// form installable on a PS5 with debug mode enabled. The structure and embedded CNT are exact;
    /// the finalization digest table is debug-key gated and filled best-effort (see
    /// <see cref="LibProsperoPkg.PKG.ProsperoFihBuilder"/>). This is the default output.
    /// </summary>
    DebugImage,

    /// <summary>
    /// A standard finalized Retail image (<c>\x7FFIH</c>, signed byte 0x80). This mode requires a
    /// trusted <see cref="IProsperoRetailFinalizationProvider"/> that returns the protected
    /// 0x300-byte FIH material. The builder refuses to emit a structural-only 0x80 image.
    /// </summary>
    RetailImage,
}

/// <summary>Options describing the PS5 package to build.</summary>
public sealed class ProsperoBuildOptions
{
    /// <summary>The build preset.</summary>
    public ProsperoPackageMode Mode { get; set; } = ProsperoPackageMode.Application;

    /// <summary>
    /// The container format the builder emits. Defaults to the finalized debug
    /// <see cref="ProsperoOutputFormat.DebugImage"/>, since only a \x7FFIH image is a full,
    /// installable package; a bare \x7FCNT is metadata only.
    /// </summary>
    public ProsperoOutputFormat OutputFormat { get; set; } = ProsperoOutputFormat.DebugImage;

    /// <summary>
    /// Trusted console/tooling boundary used only by <see cref="ProsperoOutputFormat.RetailImage"/>.
    /// It produces the exact 0x300-byte standard Retail FIH material.
    /// </summary>
    public IProsperoRetailFinalizationProvider? RetailFinalizationProvider { get; set; }

    /// <summary>Folder whose contents become the package image (must contain <c>sce_sys/</c>).</summary>
    public string SourceFolder { get; set; } = "";

    /// <summary>Folder the finished <c>*.pkg</c> is written to.</summary>
    public string OutputFolder { get; set; } = "";

    /// <summary>36-character content id (e.g. <c>UP9000-PPSA00000_00-PROSPERO00000000</c>).</summary>
    public string ContentId { get; set; } = "";

    /// <summary>
    /// Optional 36-character primary package id. It is the identity used by publisher
    /// <c>ENTRY_KEYS</c> index 1 and the PFS-image-key KDF, and defaults to
    /// <see cref="ContentId"/>.
    /// </summary>
    public string? PrimaryId { get; set; }

    /// <summary>32-character passcode. Defaults to all zeroes.</summary>
    public string Passcode { get; set; } = new string('0', 32);

    /// <summary>Human-readable title written into <c>param.json</c> when one is generated.</summary>
    public string Title { get; set; } = "";

    /// <summary>9-character title id (e.g. <c>PPSA00000</c>).</summary>
    public string TitleId { get; set; } = "";

    /// <summary>Content/master version, formatted <c>NN.NN</c>.</summary>
    public string Version { get; set; } = "01.00";

    /// <summary>
    /// UTC package creation time used consistently by PFS timestamps and the publisher
    /// <c>param.json/pubtools/creationDate</c> field.
    /// </summary>
    public DateTime TimeStamp { get; set; } = DateTime.UnixEpoch;

    /// <summary>When true a minimal <c>param.json</c> is generated if the source folder lacks one.</summary>
    public bool GenerateParamJsonIfMissing { get; set; } = true;

    /// <summary>
    /// When true the inner <c>pfs_image.dat</c> is stored PFSC-compressed (shrinking the package,
    /// the dominant size driver) instead of raw. Incompressible images fall back to the raw wrapper
    /// automatically. Off by default to preserve the size-stable path. This is the zlib
    /// PFSC used for the installable inner image; for the <c>nwonly</c> Kraken codec
    /// set <see cref="InnerCompression"/> to <see cref="ProsperoInnerCompression.Kraken"/> instead.
    /// </summary>
    public bool CompressInnerImage { get; set; }

    /// <summary>
    /// Selects the inner-image codec explicitly. When left at <see cref="ProsperoInnerCompression.None"/>
    /// the legacy <see cref="CompressInnerImage"/> flag decides (true =&gt; <see cref="ProsperoInnerCompression.Zlib"/>).
    /// When set to a non-<c>None</c> value this takes precedence over <see cref="CompressInnerImage"/>:
    /// <list type="bullet">
    /// <item><see cref="ProsperoInnerCompression.Zlib"/> — zlib PFSC (installable inner image).</item>
    /// <item><see cref="ProsperoInnerCompression.Kraken"/> — PS5 PFSv3 Kraken (the
    /// <c>nwonly</c> inner-image codec), validated against reference output.
    /// Incompressible images fall back to the raw wrapper automatically.</item>
    /// </list>
    /// </summary>
    public ProsperoInnerCompression InnerCompression { get; set; } = ProsperoInnerCompression.None;

    /// <summary>
    /// Build the publisher data-first outer PFS containing NAPS-packed, direct-offset PPR-PFS data.
    /// Enabled by default. Set false only for the legacy superblock-first/PFSC package profile.
    /// </summary>
    public bool UsePublisherPprNaps { get; set; } = true;

    /// <summary>Encrypt the publisher outer PFS. Disable for a kstuff-lite plaintext/no-auth image.</summary>
    public bool EncryptOuterPfs { get; set; } = true;

    /// <summary>
    /// Optional 16-byte publishing CMAC key for NAPS outer-block digest slots. Keyed profiles
    /// require the matching key, while the verified Publishing Tools 2.79 debug/AC profile
    /// deliberately stores zero tags and passes the official host-side integrity verifier.
    /// </summary>
    public byte[]? NapsOuterBlockCmacKey { get; set; }

    /// <summary>
    /// Optional publisher-authored <c>common/etc/naps_meta_18.dat</c> SI payload. Publisher AC
    /// packages require this protected metric record; the library preserves it verbatim.
    /// </summary>
    public byte[]? NapsMeta18 { get; set; }

    /// <summary>
    /// Optional override for <c>ihsh/rhsh</c> and provider for the AES-XTS-derived
    /// <c>obcc</c> table inside <c>naps_meta_18.dat</c>. Ignored when
    /// <see cref="NapsMeta18"/> is supplied verbatim.
    /// </summary>
    public IProsperoNapsIntegrityProvider? NapsIntegrityProvider { get; set; }

    /// <summary>
    /// Optional exact path-to-AFID assignment for preserving a sparse publisher FIDX layout.
    /// Paths are rooted at the inner user root (for example <c>/data/file.bin</c>). Missing slot
    /// numbers become 256-KiB zero extents and <c>-1</c> AFID table entries.
    /// </summary>
    public IReadOnlyDictionary<string, uint>? PublisherAfidAssignments { get; set; }

    /// <summary>
    /// Optional expected 32-byte publisher <c>pfs-image-key</c>. The library derives this
    /// value locally from primary id, passcode and seed; when supplied, it is treated as a
    /// known-answer vector and must match.
    /// </summary>
    public byte[]? NapsPfsImageKey { get; set; }

    /// <summary>
    /// Optional raw 16-byte publisher <c>pfs-image-seed</c>. In the publisher profile this is
    /// also the outer-PFS seed
    /// stored at superblock offset <c>+0x370</c>. If <see cref="OuterPfsSeed"/> is supplied too,
    /// both values must be identical.
    /// </summary>
    public byte[]? NapsPfsImageSeed { get; set; }

    /// <summary>
    /// Optional publisher-authored raw <c>IMAGE_KEY</c> CNT entry (exactly <c>0x800</c> bytes)
    /// to preserve verbatim. When omitted, the library reproduces the native <c>sc2</c>
    /// RSA-3072 plus SHAKE128 construction from the locally derived PFS-image key.
    /// </summary>
    public byte[]? PublisherImageKey { get; set; }

    /// <summary>
    /// Optional publisher-authored raw <c>ENTRY_KEYS</c> CNT entry (exactly <c>0xB80</c> bytes).
    /// Supplying it preserves all seven RSA-3072 wrapped records verbatim for an exact rebuild.
    /// </summary>
    public byte[]? PublisherEntryKeys { get; set; }

    /// <summary>
    /// Optional fixed 16-byte outer-PFS seed. When omitted, the seed is derived in
    /// <see cref="DeterministicBuild"/> mode and generated with a cryptographic RNG otherwise.
    /// </summary>
    public byte[]? OuterPfsSeed { get; set; }

    /// <summary>
    /// Enables byte-reproducible package generation: stable RSA wrapping and a content-derived
    /// outer-PFS seed when <see cref="OuterPfsSeed"/> is omitted. The timestamp remains the explicit
    /// <see cref="TimeStamp"/> value (Unix epoch by default).
    /// </summary>
    public bool DeterministicBuild { get; set; }

    /// <summary>
    /// Legacy private-signing hook retained for source compatibility. Current publisher-compatible
    /// CNT generation does not use it: CNT+0x1000 is a deterministic RSA public-key wrap generated
    /// from the embedded sc2 passcode bank.
    /// </summary>
    public IProsperoMetadataSigner? MetadataSigner { get; set; }

    /// <summary>
    /// Optional provider for already-issued decrypted AC/AL <c>license.dat</c> and
    /// <c>license.info</c>. It takes precedence over loose sidecars in the source folder.
    /// The returned records are validated and CNT-encrypted by the builder.
    /// </summary>
    public IProsperoLicenseProvider? LicenseProvider { get; set; }

    /// <summary>
    /// Refuses to build unless every caller-supplied input required by the external Publishing
    /// Tools acceptance path is present. This checks availability, not whether a supplied signer
    /// or keyed provider belongs to a particular SDK trust domain; final acceptance is still
    /// established by <c>img_info</c>/<c>img_verify</c>.
    /// </summary>
    public bool RequirePublisherCompatibility { get; set; }

    /// <summary>Reports actual source bytes consumed while assembling the package image.</summary>
    public Action<long, long>? Progress { get; set; }
}

/// <summary>The result of a build: the output path plus any non-fatal warnings.</summary>
public sealed class ProsperoBuildResult
{
    public required string OutputPath { get; init; }
    public required IReadOnlyList<string> Warnings { get; init; }
}

/// <summary>
/// Folder -&gt; PS5 package builder. See the file header for the architecture.
/// </summary>
public static class ProsperoPackageBuilder
{
    // PS5 content ids use the 36-char shape; PS5 title ids are typically PPSAxxxxx.
    private static readonly Regex ContentIdRegex =
        new("^[A-Z]{2}[0-9]{4}-[A-Z]{4}[0-9]{5}_00-[A-Z0-9]{16}$", RegexOptions.Compiled);

    private static readonly Regex TitleIdRegex =
        new("^[A-Z]{4}[0-9]{5}$", RegexOptions.Compiled);

    /// <summary>True when the wired-in PS5 publishing key material is available.</summary>
    public static bool KeysAvailable => ProsperoKeys.IsPublisherRsaProfileAvailable;

    /// <summary>
    /// Encrypts a prepared (plaintext) inner PFS image with AES-XTS, deriving the
    /// EKPFS from the package content id + passcode, then the (tweak, data) keys from the EKPFS
    /// plus the image header seed. Offered as a standalone, round-trip-checked primitive.
    /// </summary>
    /// <param name="pfsImagePath">A prepared plaintext PFS image (in place).</param>
    /// <param name="contentId">The 36-character content id.</param>
    /// <param name="passcode">The 32-character passcode.</param>
    /// <param name="seed">Optional 16-byte header seed; <c>null</c> uses the image's own seed or generates one.</param>
    /// <param name="logger">Optional progress sink.</param>
    public static LibProsperoPkg.PFS.ProsperoPfsImageResult EncryptPfsImage(
        string pfsImagePath, string contentId, string passcode, byte[]? seed = null, Action<string>? logger = null)
    {
        var ekpfs = ProsperoPkgSigner.ComputeEkpfs(contentId, passcode);
        var options = new LibProsperoPkg.PFS.ProsperoPfsImageOptions { Ekpfs = ekpfs, Seed = seed };
        return LibProsperoPkg.PFS.ProsperoPfsImage.EncryptInPlace(pfsImagePath, options, logger);
    }

    /// <summary>
    /// Lays out a prepared folder into a plaintext PS5 inner-PFS image. The
    /// produced image is unsigned/unencrypted; pair it with <see cref="EncryptPfsImage"/>
    /// for the encrypted form, or with <see cref="BuildInnerImage"/> for the full pipeline.
    /// </summary>
    /// <param name="sourceFolder">A prepared application folder (its tree becomes the image's uroot).</param>
    /// <param name="outputPath">Destination plaintext inner-PFS image path.</param>
    /// <param name="logger">Optional progress sink.</param>
    public static LibProsperoPkg.PFS.ProsperoPfsLayoutResult BuildInnerPfsLayout(
        string sourceFolder, string outputPath, Action<string>? logger = null)
    {
        var options = new LibProsperoPkg.PFS.ProsperoPfsLayoutOptions();
        return LibProsperoPkg.PFS.ProsperoPfsLayout.BuildFromFolder(sourceFolder, outputPath, options, logger);
    }

    /// <summary>
    /// Runs the full inner-PFS pipeline end to end: lays out the folder into a plaintext
    /// inner-PFS image (<see cref="BuildInnerPfsLayout"/>), then renders it in the requested
    /// <paramref name="form"/> — left plaintext, AES-XTS-encrypted with the EKPFS derived from the
    /// content id + passcode (<see cref="EncryptPfsImage"/>), or PFSC-compressed
    /// (<see cref="LibProsperoPkg.PFS.ProsperoPfsc"/>). The forms are mutually exclusive: an encrypted
    /// image carries the plaintext PFS superblock the kernel needs, while a compressed image is a
    /// PFSC container — composing both is handled by the outer-PFS layer.
    /// </summary>
    /// <param name="sourceFolder">A prepared application folder.</param>
    /// <param name="outputPath">Destination inner-PFS image path.</param>
    /// <param name="contentId">The 36-character content id (used to derive the EKPFS when encrypting).</param>
    /// <param name="passcode">The 32-character passcode (used to derive the EKPFS when encrypting).</param>
    /// <param name="form">The inner-image representation to produce. Default <see cref="InnerImageForm.Encrypted"/>.</param>
    /// <param name="logger">Optional progress sink.</param>
    /// <returns>The final inner-PFS image path.</returns>
    public static string BuildInnerImage(
        string sourceFolder, string outputPath, string contentId, string passcode,
        InnerImageForm form = InnerImageForm.Encrypted, Action<string>? logger = null)
    {
        var log = logger ?? (_ => { });

        BuildInnerPfsLayout(sourceFolder, outputPath, log);

        switch (form)
        {
            case InnerImageForm.Plaintext:
                break;

            case InnerImageForm.Encrypted:
                log("AES-XTS-encrypting the laid-out inner PFS image...");
                EncryptPfsImage(outputPath, contentId, passcode, seed: null, log);
                break;

            case InnerImageForm.Compressed:
                log("Compressing the inner PFS image (PFSC)...");
                var tmp = outputPath + ".pfsc.tmp";
                var pfscOptions = new LibProsperoPkg.PFS.ProsperoPfscOptions
                {
                    BlockSize = 0x10000,
                };
                LibProsperoPkg.PFS.ProsperoPfsc.PackFile(outputPath, tmp, pfscOptions, log);
                File.Delete(outputPath);
                File.Move(tmp, outputPath);
                break;

            case InnerImageForm.KrakenCompressed:
                log("Compressing the inner PFS image (PFSv3)...");
                var krakenTmp = outputPath + ".pfsc.tmp";
                LibProsperoPkg.PFS.Compression.ProsperoCompressedPfsImage.PackFile(outputPath, krakenTmp, logger: log);
                File.Delete(outputPath);
                File.Move(krakenTmp, outputPath);
                break;

            default:
                throw new ArgumentOutOfRangeException(nameof(form), form, "Unknown inner-image form.");
        }

        return outputPath;
    }

    /// <summary>Returns true when <paramref name="contentId"/> is a well-formed 36-char content id.</summary>
    public static bool IsValidContentId(string? contentId) =>
        !string.IsNullOrEmpty(contentId) && ContentIdRegex.IsMatch(contentId);

    /// <summary>Returns true when <paramref name="titleId"/> looks like <c>PPSAxxxxx</c>.</summary>
    public static bool IsValidTitleId(string? titleId) =>
        !string.IsNullOrEmpty(titleId) && TitleIdRegex.IsMatch(titleId);

    /// <summary>
    /// Builds a content id from a publisher prefix, a title id and a 16-char label.
    /// Missing pieces are padded so the result is always 36 characters.
    /// </summary>
    public static string ComposeContentId(string? publisher, string? titleId, string? label)
    {
        publisher = (publisher ?? "UP9000").ToUpperInvariant();
        if (publisher.Length < 6) publisher = publisher.PadRight(6, '0');
        publisher = publisher[..6];

        titleId = (titleId ?? "PPSA00000").ToUpperInvariant();
        if (titleId.Length < 9) titleId = titleId.PadRight(9, '0');
        titleId = titleId[..9];

        label = (label ?? "").ToUpperInvariant();
        label = new string(label.Where(c => (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9')).ToArray());
        if (label.Length < 16) label = label.PadRight(16, '0');
        label = label[..16];

        return $"{publisher}-{titleId}_00-{label}";
    }

    /// <summary>The Prospero volume type used for a given mode.</summary>
    public static Gp5VolumeType VolumeTypeForMode(ProsperoPackageMode mode) => mode switch
    {
        ProsperoPackageMode.AdditionalContentData => Gp5VolumeType.prospero_ac,
        ProsperoPackageMode.AdditionalContentNoData => Gp5VolumeType.prospero_al,
        _ => Gp5VolumeType.prospero_app,
    };

    /// <summary>The PS5 PKG builder volume kind used for a given mode.</summary>
    public static LibProsperoPkg.PKG.ProsperoVolumeType ProsperoVolumeTypeForMode(ProsperoPackageMode mode) => mode switch
    {
        ProsperoPackageMode.AdditionalContentData => LibProsperoPkg.PKG.ProsperoVolumeType.AdditionalContentData,
        ProsperoPackageMode.AdditionalContentNoData => LibProsperoPkg.PKG.ProsperoVolumeType.AdditionalContentNoData,
        _ => LibProsperoPkg.PKG.ProsperoVolumeType.Application,
    };

    /// <summary>True when the mode produces additional-content (DLC) packages.</summary>
    public static bool IsDlcMode(ProsperoPackageMode mode) =>
        mode is ProsperoPackageMode.AdditionalContentData or ProsperoPackageMode.AdditionalContentNoData;

    /// <summary>The PS5 application category type written into a generated param.json for a mode.</summary>
    private static int CategoryTypeForMode(ProsperoPackageMode mode) => mode switch
    {
        // 0 = PS5 Game/App. DLC packages carry no applicationCategoryType in their param.json.
        _ => 0,
    };

    /// <summary>
    /// Builds the PS5 package described by <paramref name="options"/>.
    /// </summary>
    /// <param name="options">The build description.</param>
    /// <param name="logger">Optional sink for progress messages.</param>
    /// <returns>The finished package path and any non-fatal warnings.</returns>
    /// <exception cref="ArgumentException">A required option is missing or malformed.</exception>
    /// <exception cref="InvalidOperationException">The build failed.</exception>
    public static ProsperoBuildResult Build(ProsperoBuildOptions options, Action<string>? logger = null)
    {
        ArgumentNullException.ThrowIfNull(options);
        var log = logger ?? (_ => { });
        var warnings = new List<string>();

        if (string.IsNullOrWhiteSpace(options.SourceFolder) || !Directory.Exists(options.SourceFolder))
            throw new ArgumentException("Source folder does not exist.", nameof(options));
        if (string.IsNullOrWhiteSpace(options.OutputFolder))
            throw new ArgumentException("Output folder was not specified.", nameof(options));
        if (string.IsNullOrEmpty(options.Passcode) || options.Passcode.Length != 32)
            throw new ArgumentException("Passcode must be exactly 32 characters.", nameof(options));
        if (!IsValidContentId(options.ContentId))
            throw new ArgumentException("Content ID is not in the format XXYYYY-XXXXYYYYY_00-ZZZZZZZZZZZZZZZZ.", nameof(options));
        if (options.PrimaryId is not null && !IsValidContentId(options.PrimaryId))
            throw new ArgumentException("Primary ID is not in the format XXYYYY-XXXXYYYYY_00-ZZZZZZZZZZZZZZZZ.", nameof(options));
        if (options.OuterPfsSeed is { Length: not 16 })
            throw new ArgumentException("Outer PFS seed must contain exactly 16 bytes.", nameof(options));
        if (options.NapsPfsImageKey is { Length: not 32 })
            throw new ArgumentException("NAPS pfs-image-key must contain exactly 32 bytes.", nameof(options));
        if (options.NapsPfsImageSeed is { Length: not 16 })
            throw new ArgumentException("NAPS pfs-image-seed must contain exactly 16 bytes.", nameof(options));
        if (options.PublisherImageKey is { Length: not 0x800 })
            throw new ArgumentException(
                "Publisher IMAGE_KEY must contain exactly 0x800 bytes.", nameof(options));
        if (options.PublisherEntryKeys is { Length: not 0xB80 })
            throw new ArgumentException(
                "Publisher ENTRY_KEYS must contain exactly 0xB80 bytes.", nameof(options));
        if (options.OuterPfsSeed is not null &&
            options.NapsPfsImageSeed is not null &&
            !options.OuterPfsSeed.AsSpan().SequenceEqual(options.NapsPfsImageSeed))
        {
            throw new ArgumentException(
                "OuterPfsSeed and NapsPfsImageSeed identify the same publisher superblock seed and must match.",
                nameof(options));
        }
        if (options.NapsPfsImageKey is not null &&
            options.NapsPfsImageSeed is null &&
            options.OuterPfsSeed is null)
        {
            throw new ArgumentException(
                "An expected NAPS pfs-image-key requires NapsPfsImageSeed or OuterPfsSeed.",
                nameof(options));
        }
        if (options.OutputFormat == ProsperoOutputFormat.RetailImage &&
            options.RetailFinalizationProvider is null)
        {
            throw new ArgumentException(
                "RetailImage requires a trusted RetailFinalizationProvider; " +
                "a signed byte of 0x80 alone is not a finalized Retail package.",
                nameof(options));
        }
        if (options.OutputFormat == ProsperoOutputFormat.RetailImage &&
            options.Mode == ProsperoPackageMode.AdditionalContentNoData)
        {
            throw new ArgumentException(
                "RetailImage is not available for the direct PSAL AdditionalContentNoData layout.",
                nameof(options));
        }

        Directory.CreateDirectory(options.OutputFolder);
        var sourceFolder = Path.GetFullPath(options.SourceFolder);

        log(KeysAvailable
            ? "PS5 public RSA profile loaded (passcode[7] + mount-image + token)."
            : "Warning: the PS5 public RSA profile is unavailable; publisher wrapping is disabled.");
        if (!KeysAvailable)
            warnings.Add("PS5 publishing keys are unavailable.");

        // Ensure the package has a param.json.
        EnsureParamJson(options, sourceFolder, log, warnings);

        return BuildCore(options, sourceFolder, log, warnings);
    }

    /// <summary>
    /// Produces the final PS5 package via <see cref="LibProsperoPkg.PKG.ProsperoPkgBuilder"/>.
    /// The output is a complete <c>\x7FCNT</c> package with the inner + AES-XTS-encrypted outer PFS,
    /// all entries, every metadata digest and the CNT header public wrap. The result is checked
    /// in-process with the reader and an outer-PFS decrypt round-trip. On-console acceptance
    /// depends on console mode and firmware.
    /// </summary>
    private static ProsperoBuildResult BuildCore(
        ProsperoBuildOptions options, string sourceFolder, Action<string> log, List<string> warnings)
    {
        byte[]? napsCmacKey = options.NapsOuterBlockCmacKey
            ?? ProsperoPublishingSidecar.TryLoadNapsCmacKey();
        byte[]? napsPfsImageKey = options.NapsPfsImageKey;
        byte[]? napsPfsImageSeed = options.NapsPfsImageSeed;
        byte[]? publisherImageKey = options.PublisherImageKey
            ?? ProsperoPublishingSidecar.TryLoadPublisherImageKey();
        byte[]? publisherEntryKeys = options.PublisherEntryKeys
            ?? ProsperoPublishingSidecar.TryLoadPublisherEntryKeys();
        byte[]? napsMeta18 = options.NapsMeta18
            ?? ProsperoPublishingSidecar.TryLoadNapsMeta18();
        if (napsPfsImageSeed is null)
            napsPfsImageSeed = ProsperoPublishingSidecar.TryLoadNapsPfsImageSeed();
        if (napsPfsImageKey is null &&
            (napsPfsImageSeed is not null || options.OuterPfsSeed is not null))
        {
            napsPfsImageKey = ProsperoPublishingSidecar.TryLoadNapsPfsImageKey();
        }
        if (options.OuterPfsSeed is not null &&
            napsPfsImageSeed is not null &&
            !options.OuterPfsSeed.AsSpan().SequenceEqual(napsPfsImageSeed))
        {
            throw new InvalidDataException(
                $"{ProsperoPublishingSidecar.NapsPfsImageSeedFileName} does not match OuterPfsSeed.");
        }

        if (options.NapsOuterBlockCmacKey is null && napsCmacKey is not null)
            log($"Loaded {ProsperoPublishingSidecar.NapsCmacKeyFileName} from {ProsperoPublishingSidecar.DefaultDirectory}.");
        if (options.NapsPfsImageSeed is null && napsPfsImageSeed is not null)
            log(
                $"Loaded {ProsperoPublishingSidecar.NapsPfsImageSeedFileName} from " +
                $"{ProsperoPublishingSidecar.DefaultDirectory}.");
        if (options.NapsPfsImageKey is null && napsPfsImageKey is not null)
            log(
                $"Loaded expected {ProsperoPublishingSidecar.NapsPfsImageKeyFileName} from " +
                $"{ProsperoPublishingSidecar.DefaultDirectory}.");
        if (options.PublisherImageKey is null && publisherImageKey is not null)
            log(
                $"Loaded {ProsperoPublishingSidecar.PublisherImageKeyFileName} from " +
                $"{ProsperoPublishingSidecar.DefaultDirectory}.");
        if (options.PublisherEntryKeys is null && publisherEntryKeys is not null)
            log(
                $"Loaded {ProsperoPublishingSidecar.PublisherEntryKeysFileName} from " +
                $"{ProsperoPublishingSidecar.DefaultDirectory}.");
        if (options.NapsMeta18 is null && napsMeta18 is not null)
            log(
                $"Loaded {ProsperoPublishingSidecar.NapsMeta18FileName} from " +
                $"{ProsperoPublishingSidecar.DefaultDirectory}.");

        string finalPath = Path.Combine(options.OutputFolder, ComposePkgFileName(options.ContentId, options.Version));
        // PSAL is already a complete direct CNT+SI package and has no FIH/PFS layer.
        bool wantsFih = options.OutputFormat != ProsperoOutputFormat.MetadataContainer &&
                        options.Mode != ProsperoPackageMode.AdditionalContentNoData;
        bool wantsRetail = options.OutputFormat == ProsperoOutputFormat.RetailImage;

        // A CNT package holds only metadata and is NOT a full, installable package: only a finalized
        // \x7FFIH image is. So for the debug-image path the CNT is an intermediate that must NOT survive
        // next to the final package — the user asked for the final FIH image only. Build it under a
        // temporary name and delete it once the FIH is finalized.
        string cntPath = wantsFih
            ? Path.Combine(options.OutputFolder, "." + Path.GetFileName(finalPath) + ".cnt.tmp")
            : finalPath;

        var buildProps = new LibProsperoPkg.PKG.ProsperoPkgBuildProperties
        {
            SourceFolder = sourceFolder,
            ContentId = options.ContentId,
            PrimaryId = options.PrimaryId,
            Passcode = options.Passcode,
            VolumeType = ProsperoVolumeTypeForMode(options.Mode),
            TimeStamp = options.TimeStamp,
            CompressInnerImage = options.CompressInnerImage,
            InnerCompression = options.InnerCompression,
            UsePublisherPprNaps = options.UsePublisherPprNaps,
            EncryptOuterPfs = options.EncryptOuterPfs,
            NapsOuterBlockCmacKey = napsCmacKey,
            NapsMeta18 = napsMeta18,
            NapsIntegrityProvider = options.NapsIntegrityProvider,
            PublisherAfidAssignments = options.PublisherAfidAssignments,
            NapsPfsImageKey = napsPfsImageKey,
            NapsPfsImageSeed = napsPfsImageSeed,
            PublisherImageKey = publisherImageKey,
            PublisherEntryKeys = publisherEntryKeys,
            OuterPfsSeed = options.OuterPfsSeed,
            DeterministicBuild = options.DeterministicBuild,
            MetadataSigner = options.MetadataSigner,
            LicenseProvider = options.LicenseProvider,
            Progress = options.Progress,
        };

        bool usesNaps = options.UsePublisherPprNaps &&
                        options.Mode != ProsperoPackageMode.AdditionalContentNoData;
        if (options.RequirePublisherCompatibility && !ProsperoKeys.IsPublisherRsaProfileAvailable)
            throw new InvalidOperationException(
                "Strict publisher compatibility requires the complete sc2 public RSA profile.");
        if (usesNaps && napsCmacKey is null)
            log(
                "NAPS outer-block CMAC is disabled: Publishing Tools 2.79 debug/AC leaves the " +
                "eight-byte tags zero unless a keyed profile is explicitly selected.");
        log("Building the PS5 package...");
        bool splitPublisherImage = wantsFih && usesNaps && !wantsRetail;
        bool directPublisherImage = splitPublisherImage && !options.EncryptOuterPfs &&
                                    options.NapsIntegrityProvider is null;
        byte[]? nestedImageDigest;
        LibProsperoPkg.PKG.ProsperoSiBuildInputs? siInputs;
        try
        {
            LibProsperoPkg.PKG.ProsperoPkgBuilder.Build(
                buildProps, cntPath, out nestedImageDigest, out siInputs, log,
                splitPublisherImage, directPublisherImage ? finalPath : null);
        }
        catch
        {
            if (directPublisherImage) TryDelete(finalPath);
            throw;
        }

        if (!File.Exists(cntPath))
            throw new InvalidOperationException("The PS5 PKG builder did not produce an output package.");

        // Verify the produced container with the reader.
        bool finalized = false;
        try
        {
            var type = ProsperoPkgReader.DetectType(cntPath);
            if (type is null)
                warnings.Add("The produced package is not a recognisable PS5 PKG.");
            else
                log($"Validated intermediate container: {type} PS5 CNT (metadata only).");
        }
        catch (Exception ex)
        {
            warnings.Add("Output container validation failed: " + ex.Message);
        }

        // A CNT alone is metadata only, so unless the caller explicitly asked for the metadata
        // container we finalize it into a debug (FIH) image — the only form a debug-mode console
        // can install — and keep ONLY that final package.
        if (!wantsFih)
        {
            if (siInputs?.TemporaryInnerImagePath is string temporaryInner)
                TryDelete(temporaryInner);
            log(options.Mode == ProsperoPackageMode.AdditionalContentNoData
                ? "Done (PSAL CNT+SI package; no PFS/FIH layer)."
                : "Done (CNT metadata container).");
            return new ProsperoBuildResult { OutputPath = cntPath, Warnings = warnings };
        }

        try
        {
            log(wantsRetail
                ? "Finalizing the CNT into a Retail (FIH) image..."
                : "Finalizing the CNT into a debug (FIH) image...");

            // The trailing debug SI segment (sce_suppl) is assembled from the finalized mount image so its
            // playgo-chunk.crc and naps_meta_300 are byte-exact for the produced image. The reproducible
            // pfsimage.xml options + PlayGo chunk descriptor were captured during the CNT build above.
            Func<Stream, byte[]>? siFactory = wantsRetail || siInputs is null
                ? null
                : mountImage => LibProsperoPkg.PKG.ProsperoSiArchive.BuildDebugSiSegment(
                    siInputs.Xml, siInputs.PlayGoChunkDat, mountImage, siInputs.InnerImageSize, warnings,
                    siInputs.NapsMeta18, siInputs.IncludePfsImageXml, siInputs.ContentFiles,
                    siInputs.InnerImage, siInputs.NapsIntegrityProvider,
                    siInputs.NapsPfsImageKey, siInputs.NapsPfsImageSeed);

            string? pfsPath = siInputs?.PreparedFihPath ?? siInputs?.TemporaryOuterImagePath;
            var fihWarnings = LibProsperoPkg.PKG.ProsperoFihBuilder.BuildFromSources(
                cntPath, finalPath,
                wantsRetail
                    ? LibProsperoPkg.PKG.ProsperoFihVariant.Official
                    : LibProsperoPkg.PKG.ProsperoFihVariant.Debug,
                log,
                siArchive: null,
                siArchiveFactory: null,
                siArchiveStreamFactory: siFactory,
                nestedImageDigest: nestedImageDigest,
                nestedImageSize: checked((long)(siInputs?.NapsLayoutSize ?? 0)),
                nestedMetaBaseBlocks: siInputs?.NestedMetaBaseBlocks ?? 0,
                nwonlyContentVersionHi: siInputs?.ContentVersionHigh ?? 0,
                nwonlyNapsFileCount: checked((int)(siInputs?.FihNapsFileCount ?? 0)),
                nwonlyAppFileCount: siInputs?.AppFileCount ?? 0,
                nwonlySparseAfidCount: siInputs?.SparseAfidCount ?? 0,
                nwonlyEmptyFileCount: siInputs?.EmptyFileCount ?? 0,
                outerSuperblockIndex: siInputs?.OuterSuperblockIndex ?? -1,
                retailFinalizationProvider: options.RetailFinalizationProvider,
                separatePfsPath: pfsPath,
                pfsAlreadyAtOutput: siInputs?.PreparedFihPath is not null);
            warnings.AddRange(fihWarnings);

            var fihType = ProsperoPkgReader.DetectType(finalPath);
            var expectedType = wantsRetail
                ? LibProsperoPkg.PKG.ProsperoPkgType.FullRetail
                : LibProsperoPkg.PKG.ProsperoPkgType.FullDebug;
            if (fihType != expectedType)
                warnings.Add($"Produced FIH image was detected as {fihType}, expected {expectedType}.");
            else
                log($"Validated output container: {expectedType} PS5 FIH image.");
            finalized = true;
        }
        finally
        {
            // Remove the intermediate CNT so only the final FIH remains.
            TryDelete(cntPath);
            if (siInputs?.TemporaryInnerImagePath is string temporaryInner)
                TryDelete(temporaryInner);
            if (siInputs?.TemporaryOuterImagePath is string temporaryOuter)
                TryDelete(temporaryOuter);
            if (!finalized && siInputs?.PreparedFihPath is not null)
                TryDelete(finalPath);
        }

        log(wantsRetail ? "Done (Retail FIH)." : "Done (debug FIH).");
        return new ProsperoBuildResult { OutputPath = finalPath, Warnings = warnings };
    }

    /// <summary>Best-effort deletion of an intermediate build artifact.</summary>
    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch { /* best-effort cleanup of intermediate artifacts */ }
    }

    /// <summary>
    /// Compares two PS5 containers field-by-field (parsed header and entry table). Useful to verify
    /// that a candidate package matches a known-good reference container.
    /// </summary>
    /// <returns>An empty list when the containers match; otherwise the differences found.</returns>
    public static IReadOnlyList<string> CompareContainers(string referencePkg, string candidatePkg)
    {
        var diffs = new List<string>();
        var a = ProsperoPkgReader.Read(referencePkg);
        var b = ProsperoPkgReader.Read(candidatePkg);

        if (a.Type != b.Type) diffs.Add($"Type: {a.Type} != {b.Type}");
        if (a.Header is { } ha && b.Header is { } hb)
        {
            if (ha.EntryCount != hb.EntryCount) diffs.Add($"EntryCount: {ha.EntryCount} != {hb.EntryCount}");
            if (ha.EntryTableOffset != hb.EntryTableOffset) diffs.Add($"EntryTableOffset: {ha.EntryTableOffset:X} != {hb.EntryTableOffset:X}");
            if (ha.ContentId != hb.ContentId) diffs.Add($"ContentId: {ha.ContentId} != {hb.ContentId}");
            if (ha.ContentType != hb.ContentType) diffs.Add($"ContentType: {ha.ContentType} != {hb.ContentType}");
        }

        int n = Math.Min(a.Entries.Count, b.Entries.Count);
        for (int i = 0; i < n; i++)
        {
            var ea = a.Entries[i];
            var eb = b.Entries[i];
            if (ea.RawId != eb.RawId || ea.DataSize != eb.DataSize || ea.Flags1 != eb.Flags1)
                diffs.Add($"Entry[{i}] {ea.Id}/{eb.Id}: id={ea.RawId:X}/{eb.RawId:X} size={ea.DataSize}/{eb.DataSize} flags={ea.Flags1:X}/{eb.Flags1:X}");
        }
        if (a.Entries.Count != b.Entries.Count)
            diffs.Add($"Entry count differs: {a.Entries.Count} vs {b.Entries.Count}");

        return diffs;
    }

    private static void EnsureParamJson(
        ProsperoBuildOptions options, string sourceFolder, Action<string> log, List<string> warnings)
    {
        string? resolvedParam = LibProsperoPkg.PKG.ProsperoPkgBuilder.ResolveSourceFile(
            sourceFolder, "sce_sys/param.json");
        if (resolvedParam is not null)
        {
            string looseParam = Path.GetFullPath(Path.Combine(sourceFolder, "sce_sys", "param.json"));
            log(string.Equals(Path.GetFullPath(resolvedParam), looseParam, StringComparison.OrdinalIgnoreCase)
                ? "Using existing sce_sys/param.json."
                : $"Using GP5-mapped sce_sys/param.json from {resolvedParam}.");
            return;
        }

        if (!options.GenerateParamJsonIfMissing)
            throw new InvalidOperationException("sce_sys/param.json is missing and auto-generation is disabled.");

        var sceSys = Path.Combine(sourceFolder, "sce_sys");
        var paramPath = Path.Combine(sceSys, "param.json");
        Directory.CreateDirectory(sceSys);
        log("sce_sys/param.json not found - generating a minimal one from the supplied metadata.");
        File.WriteAllText(paramPath, BuildMinimalParamJson(options), new UTF8Encoding(false));
        warnings.Add("A minimal param.json was generated; review it for store-grade packages.");
    }

    private static string BuildMinimalParamJson(ProsperoBuildOptions options)
    {
        var titleId = IsValidTitleId(options.TitleId) ? options.TitleId : options.ContentId.Substring(7, 9);
        var title = string.IsNullOrWhiteSpace(options.Title) ? titleId : options.Title;
        var version = NormalizeVersion(options.Version);

        var root = new JsonObject
        {
            ["conceptId"] = "10000000",
            ["contentId"] = options.ContentId,
            ["masterVersion"] = version,
            ["requiredSystemSoftwareVersion"] = "00.00.00.00",
            ["titleId"] = titleId,
            ["localizedParameters"] = new JsonObject
            {
                ["defaultLanguage"] = "en-US",
                ["en-US"] = new JsonObject { ["titleName"] = title },
            },
        };

        if (options.Mode != ProsperoPackageMode.AdditionalContentNoData)
        {
            root["applicationCategoryType"] = CategoryTypeForMode(options.Mode);
            root["contentVersion"] = version;
        }

        return root.ToJsonString(new JsonSerializerOptions { WriteIndented = true });
    }

    private static string ComposePkgFileName(string contentId, string version)
    {
        var v = NormalizeVersion(version).Replace(".", "");
        if (v.Length < 4) v = v.PadLeft(4, '0');
        return $"{contentId}-A{v[..4]}-V{v[..4]}.pkg";
    }

    private static string NormalizeVersion(string? version)
    {
        if (string.IsNullOrWhiteSpace(version)) return "01.00";
        version = version.Trim();
        return Regex.IsMatch(version, "^[0-9]{2}\\.[0-9]{2}$") ? version : "01.00";
    }
}
