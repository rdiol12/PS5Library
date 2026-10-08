// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// End-to-end PS5 PKG/CNT writer: turns a prepared folder into a complete
// \x7FCNT package fully in-process. It assembles the outer container header, the system-container
// entries, the param.json + media entries and the inner+outer PFS image, then computes
// every digest and the header signature.
//
// Boundary: on-console acceptance is gated by the target console's configuration and is not
// validated here. The in-process validation covers the full
// structural correctness of the produced package: it round-trips through ProsperoPkgReader, its
// outer PFS decrypts back to the inner image, and every internal digest is self-consistent.

#nullable enable
using LibProsperoPkg.Content;
using LibProsperoPkg.GP5;
using LibProsperoPkg.PFS;
using LibProsperoPkg.PFS.Compression;
using LibProsperoPkg.Util;
using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.IO.Enumeration;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Xml.Linq;

namespace LibProsperoPkg.PKG;

/// <summary>
/// Reproducible inputs captured during a CNT build for producing the trailing debug SI segment
/// (<c>sce_suppl</c> ZIP). The package builder surfaces these out of
/// <see cref="ProsperoPkgBuilder"/>
/// so the finalizer (<see cref="ProsperoFihBuilder.BuildFromCnt"/>) can assemble the segment from the
/// finalized mount image via <c>ProsperoSiArchive.BuildDebugSiSegment</c>.
/// </summary>
internal sealed class ProsperoSiBuildInputs
{
    /// <summary>Fully-populated reproducible pfsimage.xml options (real self-consistent digests).</summary>
    public required ProsperoPfsImageXmlOptions Xml { get; init; }

    /// <summary>PlayGo chunk descriptor bytes (CNT entry 0x1001), copied verbatim into the SI, or null.</summary>
    public byte[]? PlayGoChunkDat { get; init; }

    /// <summary>
    /// Block-aligned stored size of the inner <c>pfs_image.dat</c> (<c>alignUp(storedSize, 0x10000)</c>) — the
    /// value the FIH records at <see cref="ProsperoPkgLayout.FihInnerImageSizeField"/> (0xA0) in the reference
    /// data-first layout. The SI's <c>naps_meta_300/301/302/308.dat</c> records derive from it as
    /// <c>R = InnerImageSize - 0x20000</c> via <see cref="ProsperoNapsMeta.BuildMeta300FromInnerImageSize"/>.
    /// It is captured here at build time because our superblock-first outer PFS leaves FIH[0xA0] at 0
    /// (that field is only populated for the data-first layout), so it cannot be read back from the mount image.
    /// </summary>
    public long InnerImageSize { get; init; }

    /// <summary>Unpadded byte size of <c>naps_pkg_layout.dat</c>, written to FIH offset 0xA8.</summary>
    public ulong NapsLayoutSize { get; init; }

    /// <summary>FIH +0x94 nonterminal NAPS FIDX/file count (<c>NumFiles - 1</c>).</summary>
    public uint FihNapsFileCount { get; init; }
    public int SparseAfidCount { get; init; }
    public int EmptyFileCount { get; init; }

    /// <summary>Protected publisher metric blob copied verbatim into the SI, when supplied.</summary>
    public byte[]? NapsMeta18 { get; init; }

    /// <summary>Protected NAPS table provider used when <see cref="NapsMeta18"/> is not supplied.</summary>
    public IProsperoNapsIntegrityProvider? NapsIntegrityProvider { get; init; }

    /// <summary>Raw 32-byte publisher PFS image key used by the built-in obcc generator.</summary>
    public byte[]? NapsPfsImageKey { get; init; }

    /// <summary>Raw 16-byte publisher PFS image seed used by the built-in obcc generator.</summary>
    public byte[]? NapsPfsImageSeed { get; init; }

    /// <summary>Whether this package profile carries pfsimage.xml in the debug SI.</summary>
    public bool IncludePfsImageXml { get; init; } = true;

    /// <summary>Inner content files used to construct the naps_meta_18 file/fstr records.</summary>
    public IReadOnlyList<(string Path, long Size)> ContentFiles { get; init; } = [];

    /// <summary>Exact assembled data-first inner image used to build the NAPS block map.</summary>
    public ProsperoPs5InnerImageResult? InnerImage { get; init; }

    /// <summary>Temporary file owned by the high-level finalizer and deleted after SI generation.</summary>
    public string? TemporaryInnerImagePath { get; init; }

    /// <summary>Separate outer PFS consumed and deleted by the high-level split finalizer.</summary>
    public string? TemporaryOuterImagePath { get; init; }

    /// <summary>Final FIH file that already contains its outer PFS at offset 0x10000.</summary>
    public string? PreparedFihPath { get; init; }

    public long NestedMetaBaseBlocks { get; init; }
    public uint ContentVersionHigh { get; init; }
    public int AppFileCount { get; init; }
    public int OuterSuperblockIndex { get; init; } = -1;
}

/// <summary>The PS5 volume kind, which selects the content-type code stamped into the header.</summary>
public enum ProsperoVolumeType
{
    /// <summary>A PS5 application / game (gd, content_type 0x20).</summary>
    Application,

    /// <summary>Additional content that ships data (ac, content_type 0x21).</summary>
    AdditionalContentData,

    /// <summary>Additional content, entitlement only / no data (al, content_type 0x22).</summary>
    AdditionalContentNoData,
}

/// <summary>
/// Selects how the inner <c>pfs_image.dat</c> is stored inside the encrypted outer PFS.
/// </summary>
public enum ProsperoInnerCompression
{
    /// <summary>Stored raw inside a PFSC wrapper (the default).</summary>
    None,

    /// <summary>
    /// zlib PFSC dinode compression (<see cref="LibProsperoPkg.PFS.ProsperoPfsc"/>). This is the
    /// codec the <em>installable</em> debug package uses for its inner image.
    /// </summary>
    Zlib,

    /// <summary>
    /// PS5 PFSv3 Kraken compression (<see cref="LibProsperoPkg.PFS.Compression.ProsperoCompressedPfsImage"/>).
    /// This codec stores <c>pfs_image.dat</c> as a self-describing Kraken "PFSC" container
    /// inside a regular outer-PFS file. The container round-trips byte-exact through the decoder;
    /// on-console package acceptance depends on console mode and firmware.
    /// </summary>
    Kraken,
}

/// <summary>Everything required to build a PS5 CNT package.</summary>
public sealed class ProsperoPkgBuildProperties
{
    /// <summary>The prepared source folder (must contain <c>sce_sys/param.json</c>).</summary>
    public required string SourceFolder { get; init; }

    /// <summary>The 36-character content id.</summary>
    public required string ContentId { get; init; }

    /// <summary>
    /// Primary package id used by publisher <c>ENTRY_KEYS</c> index 1 and the
    /// PFS-image-key KDF. Defaults to <see cref="ContentId"/>; update/base profiles
    /// may supply a distinct id.
    /// </summary>
    public string? PrimaryId { get; init; }

    /// <summary>The 32-character passcode (the EKPFS is derived from it; all-zero is the default).</summary>
    public string Passcode { get; init; } = new string('0', 32);

    /// <summary>The PS5 volume kind.</summary>
    public ProsperoVolumeType VolumeType { get; init; } = ProsperoVolumeType.Application;

    /// <summary>The volume timestamp written into the PFS inode table.</summary>
    public DateTime TimeStamp { get; init; } = DateTime.UnixEpoch;

    /// <summary>
    /// When true the inner <c>pfs_image.dat</c> is stored PFSC-compressed (the
    /// <see cref="LibProsperoPkg.PFS.ProsperoPfsc"/> / <c>LibProsperoPkg.PFS.PfscEncoder</c> path),
    /// shrinking the package (the dominant size driver). When false (the default) the
    /// inner image is stored raw inside a PFSC wrapper. Incompressible inner images fall back to the raw wrapper
    /// automatically. The compressed form is round-trip-validated in-process before use;
    /// on-console acceptance depends on console mode and firmware either way.
    /// </summary>
    /// <remarks>
    /// This is a convenience flag equivalent to <see cref="InnerCompression"/> =
    /// <see cref="ProsperoInnerCompression.Zlib"/>. When <see cref="InnerCompression"/> is set to a
    /// non-<see cref="ProsperoInnerCompression.None"/> value it takes precedence over this flag.
    /// </remarks>
    public bool CompressInnerImage { get; init; }

    /// <summary>
    /// Selects the inner-image codec. <see cref="ProsperoInnerCompression.None"/> (default) stores the
    /// inner image raw; <see cref="ProsperoInnerCompression.Zlib"/> uses the installable zlib
    /// PFSC path; <see cref="ProsperoInnerCompression.Kraken"/> produces the
    /// PS5 PFSv3 Kraken container. When left at
    /// <see cref="ProsperoInnerCompression.None"/>, the legacy <see cref="CompressInnerImage"/> flag is
    /// honoured (true ⇒ zlib) for backward compatibility.
    /// </summary>
    public ProsperoInnerCompression InnerCompression { get; init; } = ProsperoInnerCompression.None;

    /// <summary>
    /// Use the publisher data-first PPR-PFS/NAPS outer-image profile. Enabled by default; false
    /// retains the legacy superblock-first/PFSC path.
    /// </summary>
    public bool UsePublisherPprNaps { get; init; } = true;

    /// <summary>Encrypt the publisher outer PFS. Disable for a kstuff-lite plaintext/no-auth image.</summary>
    public bool EncryptOuterPfs { get; init; } = true;

    /// <summary>Optional 16-byte key for publisher NAPS outer-block CMAC tags.</summary>
    public byte[]? NapsOuterBlockCmacKey { get; init; }

    /// <summary>Optional publisher-authored AC SI metric record, preserved verbatim.</summary>
    public byte[]? NapsMeta18 { get; init; }

    /// <summary>
    /// Optional provider for the protected <c>ihsh/rhsh/obcc</c> tables generated inside
    /// <c>naps_meta_18.dat</c>.
    /// </summary>
    public IProsperoNapsIntegrityProvider? NapsIntegrityProvider { get; init; }

    /// <summary>Optional exact path-to-AFID assignment used to preserve sparse publisher layouts.</summary>
    public IReadOnlyDictionary<string, uint>? PublisherAfidAssignments { get; init; }

    /// <summary>
    /// Optional expected raw 32-byte publisher <c>pfs-image-key</c>. The builder derives this
    /// value locally from primary id, passcode and seed; a supplied value must match.
    /// </summary>
    public byte[]? NapsPfsImageKey { get; init; }

    /// <summary>
    /// Optional raw 16-byte publisher <c>pfs-image-seed</c> paired with the image key. This is
    /// also the outer-PFS superblock seed; if <see cref="OuterPfsSeed"/> is supplied, it must match.
    /// </summary>
    public byte[]? NapsPfsImageSeed { get; init; }

    /// <summary>
    /// Optional publisher-authored raw 0x800-byte CNT IMAGE_KEY entry to preserve verbatim.
    /// When omitted, the native RSA-3072 plus SHAKE128 payload is generated locally.
    /// </summary>
    public byte[]? PublisherImageKey { get; init; }

    /// <summary>Optional publisher-authored raw 0xB80-byte CNT ENTRY_KEYS entry.</summary>
    public byte[]? PublisherEntryKeys { get; init; }

    /// <summary>
    /// Optional fixed 16-byte outer-PFS seed. When omitted, the seed is derived in
    /// <see cref="DeterministicBuild"/> mode and generated with a cryptographic RNG otherwise.
    /// </summary>
    public byte[]? OuterPfsSeed { get; init; }

    /// <summary>
    /// Uses stable RSA PKCS#1 wrapping and derives a stable outer seed when one is not supplied.
    /// Intended for byte-for-byte regression builds; normal builds retain randomized RSA padding.
    /// </summary>
    public bool DeterministicBuild { get; init; }

    /// <summary>
    /// Legacy private-signing hook retained for source compatibility. Publisher CNT+0x1000 is not
    /// a private-key signature: the builder always reproduces sc2's deterministic public wrap with
    /// passcode-bank modulus 3.
    /// </summary>
    public IProsperoMetadataSigner? MetadataSigner { get; init; }

    /// <summary>
    /// Optional source of already-issued decrypted AC/AL RIF/license records.
    /// Returned records are validated before ordinary CNT entry encryption.
    /// </summary>
    public IProsperoLicenseProvider? LicenseProvider { get; init; }

    /// <summary>Reports actual source bytes consumed while assembling the package image.</summary>
    public Action<long, long>? Progress { get; init; }
}

/// <summary>
/// Prepared folder to complete PS5 CNT package builder. See the file header for the
/// architecture and validation boundary.
/// </summary>
public static class ProsperoPkgBuilder
{
    // PS5 header constants confirmed against reference packages.
    private const uint DrmTypePs5 = 0x10;          // CNT header @0x70.
    private const uint ContentTypeGd = 0x20;       // CNT header @0x74 (game data).
    private const uint ContentTypeAc = 0x21;       // additional content, with data.
    private const uint ContentTypeAl = 0x22;       // additional content, no data.
    private const uint HeaderProfileCodePs5 = 0xC; // CNT header @0x0C.
    private const uint FlagsPs5 = 0x00020001;      // Publisher VER_2 | base-package profile.
    private const ulong LegacyPfsFlags = 0x80000000000003CC;
    private const ulong PublisherPfsFlags = 0xA00000000000030C;

    private const ulong BodyOffset = 0x2000;
    private const ulong PfsImageOffset = 0x80000;  // Canonical PFS image offset.
    private const int BlockSize = 0x10000;

    // imagedigs.dat is the unnamed CNT entry id 0x040A (one after PSRESERVED_DAT 0x409). It is a CNT
    // body entry — NOT an inner-PFS file — so it does not digest its own storage: there is no fixpoint
    // and no multi-pass build. Its size (= outer block count x 32) is known up front from the image.
    private const uint ImagedigsEntryId = 0x040A;

    // playgo-chunk.dat is CNT entry id 0x1001. Its bytes are copied verbatim into the trailing debug SI
    // segment (common/etc/playgo-chunk.dat), so the SI capture reads them straight off the built entry.
    private const uint PlayGoChunkDatEntryId = 0x1001;

    /// <summary>The content-type code for a PS5 volume kind.</summary>
    public static uint ContentTypeFor(ProsperoVolumeType type) => type switch
    {
        ProsperoVolumeType.AdditionalContentData => ContentTypeAc,
        ProsperoVolumeType.AdditionalContentNoData => ContentTypeAl,
        _ => ContentTypeGd,
    };

    /// <summary>True for additional-content (DLC) volume kinds.</summary>
    public static bool IsAdditionalContent(ProsperoVolumeType type) =>
        type is ProsperoVolumeType.AdditionalContentData or ProsperoVolumeType.AdditionalContentNoData;

    private static ContentFlags ContentFlagsFor(ProsperoVolumeType type) => type switch
    {
        // PSAL carries no PFS image, but its direct metadata CNT uses this profile bit.
        ProsperoVolumeType.AdditionalContentNoData => ContentFlags.UPGRADABLE_APPLICATION,
        ProsperoVolumeType.AdditionalContentData =>
            ContentFlags.UPGRADABLE_APPLICATION | ContentFlags.GD_AC,
        _ => ContentFlags.GD_AC,
    };

    /// <summary>
    /// Builds the PS5 CNT package described by <paramref name="props"/> and writes it to
    /// <paramref name="outputPath"/>.
    /// </summary>
    /// <returns>The output path.</returns>
    /// <exception cref="ArgumentException">A required property is missing or malformed.</exception>
    public static string Build(ProsperoPkgBuildProperties props, string outputPath, Action<string>? logger = null)
        => Build(props, outputPath, out _, out _, logger);

    /// <summary>
    /// CNT-build overload that also surfaces the FIH 0xB0 publisher nested-layout digest. In the
    /// PPR/NAPS path this is SHA3-256(<c>naps_pkg_layout.dat</c>), threaded out here for the caller
    /// that finalizes the CNT into a debug (FIH) image (<see cref="ProsperoFihBuilder.BuildFromCnt"/>),
    /// which would otherwise only have the encrypted CNT and fall back to a best-effort outer-image hash.
    /// Also surfaces the reproducible <see cref="ProsperoSiBuildInputs"/> so the finalizer can assemble the
    /// trailing debug SI segment (<c>sce_suppl</c>) from the finalized mount image.
    /// </summary>
    internal static string Build(ProsperoPkgBuildProperties props, string outputPath, out byte[]? nestedImageDigest, out ProsperoSiBuildInputs? siInputs, Action<string>? logger = null, bool splitPublisherImage = false, string? preparedFihPath = null)
    {
        nestedImageDigest = null;
        siInputs = null;
        ArgumentNullException.ThrowIfNull(props);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);
        var log = logger ?? (_ => { });

        if (string.IsNullOrWhiteSpace(props.SourceFolder) || !Directory.Exists(props.SourceFolder))
            throw new ArgumentException("Source folder does not exist.", nameof(props));
        if (props.ContentId is not { Length: 36 })
            throw new ArgumentException("Content id must be exactly 36 characters.", nameof(props));
        if (props.PrimaryId is not null and not { Length: 36 })
            throw new ArgumentException("Primary id must be exactly 36 characters.", nameof(props));
        if (props.Passcode is not { Length: 32 })
            throw new ArgumentException("Passcode must be exactly 32 characters.", nameof(props));
        if (props.NapsOuterBlockCmacKey is { Length: not 16 })
            throw new ArgumentException("NAPS outer-block CMAC key must be exactly 16 bytes.", nameof(props));
        if (props.NapsPfsImageKey is { Length: not 32 })
            throw new ArgumentException("NAPS pfs-image-key must contain exactly 32 bytes.", nameof(props));
        if (props.NapsPfsImageSeed is { Length: not 16 })
            throw new ArgumentException("NAPS pfs-image-seed must contain exactly 16 bytes.", nameof(props));
        if (props.PublisherImageKey is { Length: not 0x800 })
            throw new ArgumentException(
                "Publisher IMAGE_KEY must contain exactly 0x800 bytes.", nameof(props));
        if (props.PublisherEntryKeys is { Length: not 0xB80 })
            throw new ArgumentException(
                "Publisher ENTRY_KEYS must contain exactly 0xB80 bytes.", nameof(props));
        if (props.OuterPfsSeed is not null &&
            props.NapsPfsImageSeed is not null &&
            !props.OuterPfsSeed.AsSpan().SequenceEqual(props.NapsPfsImageSeed))
        {
            throw new ArgumentException(
                "OuterPfsSeed and NapsPfsImageSeed identify the same publisher superblock seed and must match.",
                nameof(props));
        }

        string sourceFolder = Path.GetFullPath(props.SourceFolder);

        // Publisher EKPFS is the SHA3 KDF result at index 1.
        byte[] ekpfs = ProsperoPfsKeys.DeriveEkpfs(props.ContentId, props.Passcode);

        var directory = Path.GetDirectoryName(Path.GetFullPath(outputPath));
        if (!string.IsNullOrEmpty(directory)) Directory.CreateDirectory(directory);

        // --- Inner + outer PFS (version 2 = PS5), built by the PFS builder. ---
        // imagedigs.dat is an OUTER CNT entry (id 0x040A) that holds one per-block descriptor
        // digest for every block of the OUTER image. Because it lives in the CNT body — NOT inside the
        // outer PFS image it describes — there is no self-reference and no fixpoint: the digest count
        // (= outer block count) is known up front from the image size, so the entry is laid out as a
        // correctly-sized placeholder and filled with the signer's captured per-block digests after the
        // image is written, before the container bodies/digests are finalized.
        long fileTime = ToUnixSeconds(props.TimeStamp);
        byte[]? capturedNestedDigest = null;
        ProsperoSiBuildInputs? capturedSi = null;
        BuildImageOnce();
        nestedImageDigest = capturedNestedDigest;
        siInputs = capturedSi;

        log($"Done: {Path.GetFileName(outputPath)} ({new FileInfo(outputPath).Length:N0} bytes).");
        return outputPath;

        // Builds (and writes to outputPath) one complete package.
        void BuildImageOnce()
        {
            if (props.VolumeType == ProsperoVolumeType.AdditionalContentNoData)
            {
                BuildAdditionalContentNoData(props, ekpfs, sourceFolder, outputPath, log);
                capturedNestedDigest = null;
                capturedSi = null;
                return;
            }

            log("Preparing PS5 inner PFS (superblock version 2)...");
            var innerRoot = BuildInnerTree(sourceFolder, props.Passcode, props.VolumeType);
            // PlayGo file/inode count of the inner image: drives playgo-ficm.dat (count) and
            // playgo-hash-table.dat (count / 2), matching reference samples. The total
            // inner content size drives the playgo-chunk.dat size words (self-consistent layout).
            var innerFiles = innerRoot.GetAllChildrenFiles();
            uint playgoFileCount = (uint)Math.Min(innerFiles.Count, 0x100000);
            ulong chunkDataSize = (ulong)Math.Max(0L, innerFiles.Sum(f => f.Size));
            if (props.UsePublisherPprNaps)
            {
                BuildPublisherImage(
                    props, sourceFolder, outputPath, innerRoot, log,
                    out capturedNestedDigest, out capturedSi, splitPublisherImage, preparedFihPath);
                return;
            }
            var innerProps = new PfsProperties
            {
                root = innerRoot,
                BlockSize = BlockSize,
                // PS5 packages size the inner PFS to their content; no artificial block floor is used.
                // Reference PS5 system/app packages are well under 1MiB (e.g. NPXS41139 has a
                // 0xB0000 / 704KiB shared PFS image).
                MinBlocks = 0,
                Version = PfsHeader.VersionPs5,
                Encrypt = false,
                Sign = false,
                FileTime = fileTime,
            };
            var innerPfs = new PfsBuilder(innerProps, s => log($" [inner] {s}"));

            // FIH 0xB0 nested-image-content digest:
            // the finalized-image 0xB0 slot is SHA3-256(map[0xD]) where map[0xD] is the UNCOMPRESSED inner
            // (nested) PFS image at its plain/logical size (*(ctx+0x14e0) bytes) — NOT the outer image and NOT
            // the stored/compressed pfs_image.dat. Render the inner image once into a zero-filled buffer (so
            // sparse blocks match the in-memory logical image) and take its SHA3-256.
            // Rendering is idempotent on disk (every node writes to its fixed inode StartBlock), so the inner
            // file path below re-renders the identical bytes. An inner image too large to buffer (>2 GiB, never
            // a typical nwonly system package) is left null so the FIH header falls back to its best-effort hash.
            byte[]? innerImageDigest = null;
            {
                long innerImageSize = innerPfs.CalculatePfsSize();
                if (innerImageSize > 0 && innerImageSize <= Array.MaxLength)
                {
                    using var innerImageBuf = new MemoryStream(checked((int)innerImageSize));
                    innerImageBuf.SetLength(innerImageSize);
                    innerPfs.WriteImage(innerImageBuf);
                    innerImageDigest = innerImageBuf.TryGetBuffer(out var seg)
                        ? ProsperoImageDigests.Sha3_256(seg.AsSpan(0, (int)innerImageSize))
                        : ProsperoImageDigests.Sha3_256(innerImageBuf.ToArray());
                }
            }
            capturedNestedDigest = innerImageDigest;

            log("Preparing PS5 outer PFS (encrypted + signed)...");
            var outerRoot = new FSDir();
            // The inner image is either stored raw inside a PFSC wrapper (the default)
            // or genuinely PFSC-compressed (the compact form,
            // the dominant size driver). Genuine compression renders the inner image to a temp file and
            // PFSC-encodes it; the temp files live until the outer image has been written.
            string? tmpRawInner = null, tmpPfscInner = null;
            try
            {
                var innerFile = ResolveInnerCompression(props) switch
                {
                    ProsperoInnerCompression.Zlib => BuildCompressedInnerFile(innerPfs, log, out tmpRawInner, out tmpPfscInner),
                    ProsperoInnerCompression.Kraken => BuildKrakenInnerFile(innerPfs, log, out tmpRawInner, out tmpPfscInner),
                    _ => new FSFile(innerPfs),
                };
                innerFile.Parent = outerRoot;
                outerRoot.Files.Add(innerFile);

                // The block-aligned stored size of pfs_image.dat is what the FIH records at 0xA0 in the
                // reference data-first layout and is the sole input to the SI's naps_meta_300 record
                // (R = alignUp(storedSize) - 0x20000). Our outer PFS is superblock-first, so FIH[0xA0] is
                // left 0; capture the value here where the stored inner-file size is known.
                long innerImageAlignedSize =
                    (innerFile.Size + BlockSize - 1) / BlockSize * BlockSize;
                var outerProps = new PfsProperties
                {
                    root = outerRoot,
                    BlockSize = BlockSize,
                    Version = PfsHeader.VersionPs5,
                    Encrypt = true,
                    Sign = true,
                    EKPFS = ekpfs,
                    Seed = new byte[16],
                    FileTime = fileTime,
                };
                var outerPfs = new PfsBuilder(outerProps, s => log($" [outer] {s}")) { CaptureImageDigests = true, CaptureSuperblockIcv = true };
                long pfsSize = outerPfs.CalculatePfsSize();
                // imagedigs.dat (CNT entry 0x040A) = one 32-byte per-block descriptor digest
                // per outer-image block. The outer image size is independent of the CNT body, so this
                // count is known before the container is laid out.
                int imagedigsSize = checked((int)(pfsSize / BlockSize) * 32);

                // --- Outer container (header + entries). ---
                ulong mchunkTotal = checked((ulong)ProsperoImageDigests.FihRelativeImageOffset + (ulong)pfsSize);
                ulong mchunk0Size = Math.Min((ulong)innerImageAlignedSize, mchunkTotal);
                ulong mchunk1Size = mchunkTotal - mchunk0Size;
                var pkg = BuildContainer(
                    props, ekpfs, sourceFolder, (ulong)pfsSize, imagedigsSize,
                    playgoFileCount, mchunk0Size, mchunk1Size);
                var imagedigsEntry = (GenericEntry)pkg.Entries.First(e => (uint)e.Id == ImagedigsEntryId);

                long totalSize = (long)(pkg.Header.body_offset + pkg.Header.body_size + pkg.Header.pfs_image_size);
                using (var fs = new FileStream(outputPath, FileMode.Create, FileAccess.ReadWrite, FileShare.None))
                {
                    fs.SetLength(totalSize);
                    log($"Writing outer PFS image at 0x{pkg.Header.pfs_image_offset:X} ({pfsSize:N0} bytes)...");
                    fs.Position = (long)pkg.Header.pfs_image_offset;
                    outerPfs.WriteImage(new OffsetStream(fs, (long)pkg.Header.pfs_image_offset));

                    // Fill the imagedigs placeholder with the signer's captured per-block digests (same
                    // length as the placeholder, so the container layout is unchanged) before the bodies
                    // and digest tables are written.
                    byte[]? captured = outerPfs.ImageDigests;
                    if (captured is { Length: > 0 } && captured.Length == imagedigsEntry.FileData.Length)
                        imagedigsEntry.FileData = ProsperoImageDigests.ToStoredImageDigestTable(captured);
                    ProsperoPfsImageXmlOptions siXml = FinishContainer(pkg, fs, props, innerImageDigest, log);

                    // Capture the reproducible SI inputs so the finalizer can build the sce_suppl segment:
                    // the pfsimage.xml options (with the now-computed self-consistent digests) plus a verbatim
                    // copy of the PlayGo chunk descriptor (CNT entry 0x1001).
                    byte[]? playGoChunkDat = (pkg.Entries.FirstOrDefault(e => (uint)e.Id == PlayGoChunkDatEntryId) as GenericEntry)?.FileData;

                    // Inode-tree introspection (self-consistent): snapshot the outer + inner PFS
                    // inode trees and the PlayGo chunk map so pfsimage.xml describes the exact image
                    // that was produced.
                    long mountImageTotal = siXml.PfsImageOffset + siXml.PfsImageSize;
                    siXml.OuterPfsTree = outerPfs.CaptureImageTree();
                    siXml.NestedPfsTree = innerPfs.CaptureImageTree();
                    siXml.ChunkInfo = new ProsperoChunkInfoModel
                    {
                        PlayGoChunkDatSize = playGoChunkDat?.Length ?? 0,
                        TotalSize = mountImageTotal,
                        Outer0Size = innerImageAlignedSize,
                        Outer1Size = mountImageTotal - innerImageAlignedSize,
                    };
                    capturedSi = new ProsperoSiBuildInputs { Xml = siXml, PlayGoChunkDat = playGoChunkDat, InnerImageSize = innerImageAlignedSize, NapsLayoutSize = 0 };
                }
            }
            finally
            {
                TryDeleteTemp(tmpRawInner);
                TryDeleteTemp(tmpPfscInner);
            }
        }
    }

    /// <summary>
    /// Builds PSAL as a direct CNT followed by SI. It has no FIH, outer/nested PFS,
    /// IMAGE_KEY, PlayGo descriptor, or NAPS layout.
    /// </summary>
    private static void BuildAdditionalContentNoData(
        ProsperoPkgBuildProperties props, byte[] ekpfs, string sourceFolder, string outputPath,
        Action<string> log)
    {
        log("Preparing PS5 Additional Content (PSAL) metadata-only CNT...");
        Pkg pkg = BuildContainer(
            props, ekpfs, sourceFolder,
            pfsSize: 0, imagedigsSize: 0, playgoFileCount: 0,
            mchunk0Size: 0, mchunk1Size: 0);

        long cntSize = checked((long)(pkg.Header.body_offset + pkg.Header.body_size));
        using var fs = new FileStream(outputPath, FileMode.Create, FileAccess.ReadWrite, FileShare.None);
        fs.SetLength(cntSize);
        FinishAdditionalContentNoDataContainer(pkg, fs, props);

        // Publishing Tools also puts verify.log into SI. It is diagnostic, so only the reproducible
        // per-64-KiB CRC table is emitted here.
        fs.Position = 0;
        byte[] cnt = new byte[cntSize];
        fs.ReadExactly(cnt);
        byte[] si = ProsperoSiArchive.WriteZip(ProsperoSiArchive.BuildMembers(
            props.ContentId, pfsImageXml: null, finalizedMountImage: cnt));
        fs.Position = cntSize;
        fs.Write(si);
        log($"Appended PSAL SI segment: 0x{si.Length:X} bytes.");
    }

    private static void BuildPublisherImage(
        ProsperoPkgBuildProperties props, string sourceFolder, string outputPath,
        FSDir innerRoot, Action<string> log,
        out byte[] nestedImageDigest, out ProsperoSiBuildInputs? siInputs,
        bool splitPublisherImage, string? preparedFihPath)
    {
        siInputs = null;
        log("Preparing publisher data-first PPR-PFS and NAPS image...");
        long fileTime = ToUnixSeconds(props.TimeStamp);
        string publisherTempStem = Path.Combine(
            Path.GetTempPath(), "libprospero-publisher-" + Guid.NewGuid().ToString("N"));
        string packedImagePath = publisherTempStem + ".pfs_image.dat";
        string napsLayoutPath = publisherTempStem + ".naps_pkg_layout.dat";
        bool directFih = preparedFihPath is not null;
        if (directFih && (props.EncryptOuterPfs || !splitPublisherImage))
            throw new ArgumentException(
                "Direct FIH output requires a split plaintext publisher image.", nameof(preparedFihPath));
        string outerImagePath = preparedFihPath ?? publisherTempStem + ".outer.pfs";
        string innerImagePath = directFih ? outerImagePath : packedImagePath;
        var innerAssembler = new ProsperoPs5InnerImageAssembler(
            fileTime, 0, props.PublisherAfidAssignments,props.Progress);
        ProsperoPs5InnerImageResult inner = directFih
            ? innerAssembler.BuildFromFsTreeToFileAtOffset(
                innerRoot, innerImagePath, ProsperoPkgLayout.FihHeaderRegionSize)
            : innerAssembler.BuildFromFsTreeToFile(innerRoot, innerImagePath);
        byte[] napsLayout = ProsperoNwonlyNapsGenerator.Generate(
            inner,
            outerBlockCmacKey: props.NapsOuterBlockCmacKey);

        // FIH+0xA8 is the exact NAPS layout length; +0xB0 is SHA3-256 of those bytes.
        nestedImageDigest = ProsperoImageDigests.Sha3_256(napsLayout);
        // Publisher PlayGo's FLT hash table has one path hash per real afid file. FICM uses two map
        // bytes per such file, hence its count is twice the path count.
        List<string> playgoPaths = inner.Nodes
            .Where(n => !n.IsDirectory && n.ParentInode >= 0)
            .OrderBy(n => n.Afid)
            .Select(n => n.FullPath)
            .ToList();
        uint playgoFileCount = checked((uint)playgoPaths.Count * 2u);
        // FIH +0x94 stores the serialized NAPS NumFiles-1. Derive the value from the finished
        // layout rather than duplicating FIDX boundary rules here:
        // in particular, the final dataEnd boundary is omitted only when an existing empty-file
        // boundary already has the same logical offset.
        NapsLayoutDocument completedNaps = ProsperoNapsLayout.Parse(napsLayout);
        uint napsFileCount = checked((uint)completedNaps.Counts.NumFiles - 1u);
        int appFileCount = inner.Nodes.Count(
            n => !n.IsDirectory && n.ParentInode >= 0 && n.Mode == 0x816D);
        uint contentVersionHigh = ContentVersionHigh(ReadParamJsonInfo(sourceFolder).ContentVersion);
        long nestedMetaBaseBlocks = inner.MetaBaseLogical / BlockSize;

        if (props.OuterPfsSeed is { Length: not 16 })
            throw new ArgumentException("Outer PFS seed must contain exactly 16 bytes.", nameof(props));
        byte[] outerSeed = props.NapsPfsImageSeed?.AsSpan().ToArray()
            ?? props.OuterPfsSeed?.AsSpan().ToArray()
            ?? (props.DeterministicBuild
                ? DeriveDeterministicOuterSeed(props.ContentId, props.Passcode)
                : System.Security.Cryptography.RandomNumberGenerator.GetBytes(16));
        byte[] pfsImageKey = ProsperoPfsKeys.DerivePublisherPfsImageKey(
            props.PrimaryId ?? props.ContentId, props.Passcode, outerSeed);
        if (props.NapsPfsImageKey is not null &&
            !CryptographicOperations.FixedTimeEquals(props.NapsPfsImageKey, pfsImageKey))
        {
            throw new InvalidDataException(
                "The supplied NAPS pfs-image-key does not match primary id, passcode and " +
                "the effective outer-PFS seed.");
        }
        byte[] ekpfs = ProsperoPfsKeys.DeriveEkpfs(props.ContentId, props.Passcode);
        ProsperoOuterPackageFileResult outer;
        File.WriteAllBytes(napsLayoutPath, napsLayout);
        bool outerReady = false;
        try
        {
            var outerFiles = new ProsperoOuterFileSource[]
            {
                    new ProsperoOuterFileSource
                    {
                        Name = "pfs_image.dat",
                        Path = innerImagePath,
                        SizeCompressed = inner.Ndblock * BlockSize,
                        Signed = false,
                    },
                    new ProsperoOuterFileSource
                    {
                        Name = ProsperoNapsLayout.FileName,
                        Path = napsLayoutPath,
                        Signed = true,
                    },
            };
            var outerParameters = new ProsperoOuterPfsBuildParameters
                {
                    TimestampSeconds = fileTime,
                    Seed = outerSeed,
                };
            outer = directFih
                ? ProsperoOuterPfsBuilder.BuildForPackageToFileAtOffset(
                    outerFiles, outerParameters, outerImagePath,
                    ProsperoPkgLayout.FihHeaderRegionSize,
                    reusedFirstFileLength: inner.ImageLength)
                : ProsperoOuterPfsBuilder.BuildForPackageToFile(
                    outerFiles, outerParameters, ekpfs, outerImagePath,
                    encryptOutput: props.EncryptOuterPfs);
            outerReady = true;
        }
        finally
        {
            TryDeleteTemp(napsLayoutPath);
            if (!outerReady)
                TryDeleteTemp(packedImagePath);
        }

        long packedSize = inner.ImageLength;
        ulong packedAlignedSize = Align((ulong)packedSize, BlockSize);
        ulong mchunkTotal = checked((ulong)ProsperoImageDigests.FihRelativeImageOffset + (ulong)outer.PfsSize);
        // Publisher nwonly splits PlayGo at the inner pfs_image.dat data extent:
        // mchunk0 = stored inner image minus its final 64-KiB block; mchunk1 reaches the CNT.
        // Verified values: APP 0x40000+0x80000, AC 0x20000+0x80000.
        ulong mchunk0Size = Math.Min(
            packedAlignedSize >= BlockSize ? packedAlignedSize - BlockSize : 0,
            mchunkTotal);
        ulong mchunk1Size = mchunkTotal - mchunk0Size;
        var pkg = BuildContainer(
            props, ekpfs, sourceFolder, (ulong)outer.PfsSize, outer.ImageDigests.Length,
            playgoFileCount, mchunk0Size, mchunk1Size, playgoPaths,
            publisherNwonly: true, publisherPfsImageKey: pfsImageKey);
        var imagedigsEntry = (GenericEntry)pkg.Entries.First(e => (uint)e.Id == ImagedigsEntryId);

        // imagedigs stores each SHA3 digest with its byte order reversed.
        imagedigsEntry.FileData = ProsperoImageDigests.ToStoredImageDigestTable(outer.ImageDigests);

        var contentFiles = inner.Nodes
            // Empty files have inode/dirent metadata but no data-bearing AFID and are omitted
            // from the publisher NAPS meta18 "file" records.
            .Where(n => !n.IsDirectory && n.ParentInode >= 0 && n.Size != 0)
            .OrderBy(n => n.Afid)
            .Select(n => (Path: n.FullPath.TrimStart('/'), Size: n.Size))
            .ToList();
        contentFiles.Add(("*PFSmetadata", outer.PfsSize));

        byte[]? napsMeta18 = props.NapsMeta18;
        ProsperoPs5InnerImageResult? retainedInner = inner;
        if (splitPublisherImage)
        {
            if (napsMeta18 is null)
            {
                long mountImageSize = checked(
                    ProsperoPkgLayout.FihHeaderRegionSize + outer.PfsSize +
                    (long)pkg.Header.pfs_image_offset);
                byte[] generated = directFih
                    ? ProsperoNapsMeta.BuildMeta18WithPhysicalBlockDigests(
                        packedAlignedSize, mountImageSize, contentFiles, inner,
                        outer.ImageDigests.AsMemory(
                            0, checked((int)(packedAlignedSize / BlockSize) * 32)),
                        props.NapsIntegrityProvider, pfsImageKey, outerSeed)
                    : ProsperoNapsMeta.BuildMeta18(
                        packedAlignedSize, mountImageSize, contentFiles, inner,
                        props.NapsIntegrityProvider, pfsImageKey, outerSeed);
                if (generated.Length != 0) napsMeta18 = generated;
            }
            retainedInner = null;
            TryDeleteTemp(packedImagePath);
        }

        bool transferredOuterFile = false;
        try
        {
            long metadataSize = checked((long)pkg.Header.pfs_image_offset);
            long totalSize = splitPublisherImage
                ? metadataSize
                : checked(metadataSize + (long)pkg.Header.pfs_image_size);
            using var fs = new FileStream(
                outputPath, FileMode.Create, FileAccess.ReadWrite, FileShare.None);
            fs.SetLength(totalSize);
            using var outerStream = new FileStream(
                outerImagePath, FileMode.Open, FileAccess.Read, FileShare.Read,
                bufferSize: 1 << 20,
                splitPublisherImage ? FileOptions.RandomAccess : FileOptions.SequentialScan);
            if (!splitPublisherImage)
            {
                fs.Position = metadataSize;
                outerStream.CopyTo(fs);
                log(
                    $"Writing publisher outer PFS at 0x{pkg.Header.pfs_image_offset:X} " +
                    $"({outer.PfsSize:N0} bytes)...");
            }
            else
            {
                log(directFih
                    ? $"Wrote the {outer.PfsSize:N0}-byte outer PFS directly into the final package."
                    : $"Prepared split publisher metadata; finalizing from the {outer.PfsSize:N0}-byte outer PFS.");
            }

            ProsperoPfsImageXmlOptions siXml = FinishContainer(
                pkg, fs, props, nestedImageDigest, log, napsLayout.Length, nestedMetaBaseBlocks,
                contentVersionHigh, (int)napsFileCount, appFileCount,
                inner.SparseAfidHoles.Count, inner.EmptyFileLogicalOffsets.Count,
                outer.SuperblockIndex,
                separatePfsImage: splitPublisherImage ? outerStream : null,
                separatePfsOffset: directFih ? ProsperoPkgLayout.FihHeaderRegionSize : 0);
            if (directFih) siXml.PfsBlockCrc32C = outer.BlockCrc32C;
            byte[]? playGoChunkDat =
                (pkg.Entries.FirstOrDefault(e => (uint)e.Id == PlayGoChunkDatEntryId)
                    as GenericEntry)?.FileData;
            long mountImageTotal = siXml.PfsImageOffset + siXml.PfsImageSize;
            siXml.OuterPfsTree = outer.Tree;
            siXml.ChunkInfo = new ProsperoChunkInfoModel
            {
                PlayGoChunkDatSize = playGoChunkDat?.Length ?? 0,
                TotalSize = mountImageTotal,
                Outer0Size = checked((long)packedAlignedSize),
                Outer1Size = mountImageTotal - (long)packedAlignedSize,
            };

            siInputs = new ProsperoSiBuildInputs
            {
                Xml = siXml,
                PlayGoChunkDat = playGoChunkDat,
                InnerImageSize = (long)packedAlignedSize,
                NapsLayoutSize = (ulong)napsLayout.Length,
                FihNapsFileCount = napsFileCount,
                SparseAfidCount = inner.SparseAfidHoles.Count,
                EmptyFileCount = inner.EmptyFileLogicalOffsets.Count,
                NapsMeta18 = napsMeta18,
                NapsIntegrityProvider = props.NapsIntegrityProvider,
                NapsPfsImageKey = pfsImageKey,
                NapsPfsImageSeed = outerSeed,
                // Verified prospero-pub-cmd 2.79 APP and AC nwonly SI profiles both contain the
                // seven NAPS/PlayGo records and no common/etc/pfsimage.xml.
                IncludePfsImageXml = false,
                ContentFiles = contentFiles,
                InnerImage = retainedInner,
                TemporaryInnerImagePath = directFih ? null : packedImagePath,
                TemporaryOuterImagePath = splitPublisherImage && !directFih ? outerImagePath : null,
                PreparedFihPath = directFih ? outerImagePath : null,
                NestedMetaBaseBlocks = nestedMetaBaseBlocks,
                ContentVersionHigh = contentVersionHigh,
                AppFileCount = appFileCount,
                OuterSuperblockIndex = outer.SuperblockIndex,
            };
            transferredOuterFile = splitPublisherImage && !directFih;
        }
        finally
        {
            if (!directFih && !transferredOuterFile) TryDeleteTemp(outerImagePath);
            if (directFih && siInputs is null) TryDeleteTemp(outerImagePath);
            if (siInputs is null) TryDeleteTemp(packedImagePath);
        }
    }

    private static IReadOnlyList<(string Path, long Size)> ReadPfsContentFiles(string imagePath)
    {
        using var stream = File.OpenRead(imagePath);
        using var source = new LibProsperoPkg.Util.StreamReader(stream);
        var pfs = new PfsReader(source, encryptedDataAlreadyDecrypted: true);
        return pfs.GetAllFiles()
            .Select(file =>
            {
                string path = file.FullName.Replace('\\', '/').TrimStart('/');
                if (path.StartsWith("uroot/", StringComparison.Ordinal)) path = path[6..];
                return (Path: path, Size: file.size);
            })
            .ToList();
    }

    // Resolves the effective inner-image codec, honouring the legacy CompressInnerImage flag when the
    // explicit InnerCompression property is left at its default.
    private static ProsperoInnerCompression ResolveInnerCompression(ProsperoPkgBuildProperties props)
        => props.InnerCompression != ProsperoInnerCompression.None
            ? props.InnerCompression
            : props.CompressInnerImage ? ProsperoInnerCompression.Zlib : ProsperoInnerCompression.None;

    /// <summary>
    /// Renders <paramref name="innerPfs"/> to a temp file and wraps it as a PS5 PFSv3 Kraken
    /// "PFSC" container, returning an <see cref="FSFile"/>
    /// that stores the self-describing container as <c>pfs_image.dat</c> — a regular outer-PFS file (the
    /// Kraken compression lives inside the file, not in the outer inode). The produced container is
    /// round-trip-validated in-process with the Kraken decoder before use; if it does not shrink
    /// the image, or validation fails, the raw <see cref="FSFile(PfsBuilder)"/> wrapper is returned
    /// instead. On-console package acceptance depends on console mode and firmware.
    /// </summary>
    private static FSFile BuildKrakenInnerFile(PfsBuilder innerPfs, Action<string> log, out string? tmpRaw, out string? tmpKraken)
    {
        tmpRaw = null;
        tmpKraken = null;
        long rawSize = innerPfs.CalculatePfsSize();
        if (rawSize > Array.MaxLength)
        {
            log($"Inner image is {rawSize:N0} bytes; too large for the in-memory Kraken packer — storing it raw.");
            return new FSFile(innerPfs);
        }

        string raw = Path.Combine(Path.GetTempPath(), "psmt_pfs_" + Guid.NewGuid().ToString("N") + ".raw");
        string kraken = Path.Combine(Path.GetTempPath(), "psmt_pfs_" + Guid.NewGuid().ToString("N") + ".kpfs");

        log($"Compressing inner pfs_image.dat ({rawSize:N0} bytes raw) with Kraken (PFSv3)...");
        byte[] rawBytes;
        using (var rawStream = new FileStream(raw, FileMode.Create, FileAccess.ReadWrite, FileShare.None))
        {
            innerPfs.WriteImage(rawStream);
            tmpRaw = raw;
            rawStream.Flush();
            long actual = rawStream.Length;
            rawStream.Position = 0;
            rawBytes = new byte[actual];
            rawStream.ReadExactly(rawBytes, 0, rawBytes.Length);
        }

        byte[] container = ProsperoCompressedPfsImage.Pack(rawBytes);

        // In-process acceptance gate: the decoder must reconstruct the raw image byte-exact.
        byte[] restored = CompressedPfsFile.Parse(container).Decompress();
        bool roundTripOk = restored.Length == rawBytes.Length && restored.AsSpan().SequenceEqual(rawBytes);
        if (!roundTripOk || container.Length >= rawBytes.Length)
        {
            log(roundTripOk
                ? "Inner image is incompressible with Kraken; storing it raw."
                : "Kraken round-trip validation failed; storing the inner image raw.");
            TryDeleteTemp(tmpRaw); tmpRaw = null;
            return new FSFile(innerPfs);
        }

        File.WriteAllBytes(kraken, container);
        tmpKraken = kraken;
        TryDeleteTemp(tmpRaw); tmpRaw = null; // the raw image is no longer needed

        log($"Inner pfs_image.dat Kraken-compressed to {container.Length:N0} bytes "
            + $"({(double)container.Length / rawBytes.Length:P1} of raw).");

        long onDisk = container.Length;
        string krakenPath = kraken;
        return new FSFile(
            s => { using var f = File.OpenRead(krakenPath); f.CopyTo(s); },
            "pfs_image.dat",
            size: onDisk);
    }

    /// <summary>
    /// Renders <paramref name="innerPfs"/> to a temp file, PFSC-compresses it (block size matched to
    /// the outer PFS) into a second temp file and returns an <see cref="FSFile"/> that stores the
    /// genuinely compressed image as <c>pfs_image.dat</c>. If the image is incompressible (the encoder
    /// reports <c>StoredRaw</c> or yields no size benefit) the raw <see cref="FSFile(PfsBuilder)"/>
    /// wrapper is returned and the temp files are released immediately.
    /// </summary>
    private static FSFile BuildCompressedInnerFile(PfsBuilder innerPfs, Action<string> log, out string? tmpRaw, out string? tmpPfsc)
    {
        tmpRaw = null;
        tmpPfsc = null;
        long rawSize = innerPfs.CalculatePfsSize();

        string raw = Path.Combine(Path.GetTempPath(), "psmt_pfs_" + Guid.NewGuid().ToString("N") + ".raw");
        string pfsc = Path.Combine(Path.GetTempPath(), "psmt_pfs_" + Guid.NewGuid().ToString("N") + ".pfsc");

        log($"Compressing inner pfs_image.dat ({rawSize:N0} bytes raw)...");
        using (var rawStream = new FileStream(raw, FileMode.Create, FileAccess.ReadWrite, FileShare.None))
        {
            innerPfs.WriteImage(rawStream);
            tmpRaw = raw;

            PfscEncodeStats stats;
            using (var pfscStream = new FileStream(pfsc, FileMode.Create, FileAccess.ReadWrite, FileShare.None))
            {
                rawStream.Position = 0;
                stats = PfscEncoder.Encode(rawStream, rawSize, pfscStream, new PfscEncoderOptions { BlockSize = BlockSize });
            }
            tmpPfsc = pfsc;

            long pfscSize = new FileInfo(pfsc).Length;
            if (stats.StoredRaw || pfscSize >= rawSize)
            {
                log("Inner image is incompressible; storing it raw (size-stable PFSC wrapper).");
                TryDeleteTemp(tmpRaw); tmpRaw = null;
                TryDeleteTemp(tmpPfsc); tmpPfsc = null;
                return new FSFile(innerPfs);
            }

            log($"Inner pfs_image.dat compressed to {pfscSize:N0} bytes "
                + $"({(double)pfscSize / rawSize:P1} of raw, {stats.CompressedBlocks}/{stats.BlockCount} blocks).");
        }

        string pfscPath = pfsc;
        long onDisk = new FileInfo(pfscPath).Length;
        return new FSFile(
            s => { using var f = File.OpenRead(pfscPath); f.CopyTo(s); },
            "pfs_image.dat",
            size: onDisk,
            compressedSize: rawSize,
            compress: true);
    }

    private static void TryDeleteTemp(string? path)
    {
        if (string.IsNullOrEmpty(path)) return;
        try { if (File.Exists(path)) File.Delete(path); }
        catch (IOException) { /* best-effort temp cleanup */ }
        catch (UnauthorizedAccessException) { /* best-effort temp cleanup */ }
    }

    private static void TryDeleteTempDirectory(string path)
    {
        try
        {
            string full = Path.GetFullPath(path);
            string temporaryRoot = Path.GetFullPath(Path.GetTempPath());
            if (full.StartsWith(temporaryRoot, StringComparison.OrdinalIgnoreCase) && Directory.Exists(full))
                Directory.Delete(full, recursive: true);
        }
        catch (IOException) { /* best-effort temp cleanup */ }
        catch (UnauthorizedAccessException) { /* best-effort temp cleanup */ }
    }

    // Builds the FSDir tree from the source folder, injecting the inner-only auxiliary sce_sys files
    // that the publishing pipeline generates during PKG building (these are NOT part of the loose
    // input): sce_sys/pfs-version.dat and, for GD, sce_sys/keystone + sce_sys/about/right.sprx.
    // imagedigs.dat and the PlayGo descriptors
    // are OUTER CNT entries (see BuildContainer), not inner-PFS files.
    private static FSDir BuildInnerTree(string sourceFolder, string passcode, ProsperoVolumeType volumeType)
    {
        var root = new FSDir();
        string? project = Directory.EnumerateFiles(sourceFolder, "*.gp5", SearchOption.TopDirectoryOnly)
            .OrderBy(path => Path.GetFileName(path), StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();
        if (project is null)
        {
            Populate(root, sourceFolder);
        }
        else
        {
            Gp5Project manifest = Gp5Project.ReadFrom(project);
            string projectDirectory = Path.GetDirectoryName(project)!;
            if (manifest.Layout == Gp5Layout.Flat)
            {
                // Flat GP5 is an explicit manifest. Loose files beside it are build inputs or backups,
                // not implicit package members.
                foreach (Gp5File file in manifest.Files)
                    AddManifestFile(root, file, projectDirectory, destinationPrefix: "");
                foreach (Gp5Dir directory in manifest.Folders)
                    ApplyManifestDirectory(root, directory, projectDirectory, destinationPrefix: "");
            }
            else
            {
                // Normal GP5 recursively maps rootdir. An omitted src_path means the project directory,
                // which is the profile used by unpacked-game projects such as ds.GP5.
                string rootSource = ResolveManifestPath(
                    projectDirectory,
                    manifest.RootDir.SourcePath,
                    projectDirectory);
                if (!Directory.Exists(rootSource))
                    throw new DirectoryNotFoundException(
                        $"GP5 rootdir source was not found: {rootSource}");
                string[] dirExcludes = ParseExcludeMasks(manifest.RootDir.DirExclude);
                string[] fileExcludes = ParseExcludeMasks(manifest.RootDir.FileExclude);
                string[] globalExcludes = ParseExcludeMasks(manifest.GlobalExclude);
                Populate(
                    root,
                    rootSource,
                    rootSource,
                    dirExcludes,
                    fileExcludes,
                    globalExcludes);

                // Rootdir children are publisher overlays. A non-virtual directory replaces the
                // recursively discovered destination; virtual directories merge into it.
                foreach (Gp5Dir directory in manifest.RootDir.Directories)
                    ApplyManifestDirectory(root, directory, projectDirectory, destinationPrefix: "");
                foreach (Gp5File file in manifest.RootDir.Files)
                    AddManifestFile(
                        root, file, projectDirectory, destinationPrefix: "", replaceExisting: true);
            }
        }

        // img_create converts loose ELF executables to debug FSELF before assigning AFIDs and
        // calculating PPR/NAPS geometry.  Keeping the original ELF bytes changes both the logical
        // file size and every following FIDX boundary (a 4.51 eboot sample is 0x33F40 as ELF and
        // 0x28248 after the publisher conversion).
        if (volumeType == ProsperoVolumeType.Application)
            ConvertLooseElfExecutables(root);

        var sceSys = root.Dirs.FirstOrDefault(d => d.name == "sce_sys");
        if (sceSys != null)
        {
            // Publisher inner PFS always carries the ten-byte content-version marker. In AC reference
            // output this is the first afid and the first fidx extent: 0 .. 0xA for "01.000.000".
            if (!sceSys.Files.Any(f => f.name == "pfs-version.dat"))
            {
                byte[] version = Encoding.ASCII.GetBytes(ReadParamJsonInfo(sourceFolder).ContentVersion);
                AddFile(sceSys, "pfs-version.dat", version);
            }

            // The DRM keystone belongs to application/GD images. Publisher AC does not synthesize it.
            if (volumeType == ProsperoVolumeType.Application &&
                !sceSys.Files.Any(f => f.name == "keystone"))
            {
                var keystone = Crypto.CreateKeystone(passcode, 3); // PS5 keystone header version
                AddFile(sceSys, "keystone", keystone);
            }

            // The about entitlement module is part of the application/GD profile.
            if (volumeType == ProsperoVolumeType.Application)
                EnsureAboutRightSprx(sceSys);
            EnsureUcpArchives(sceSys);

            // NOTE: imagedigs.dat and the PlayGo descriptors (playgo-chunk.dat, playgo-hash-table.dat,
            // playgo-ficm.dat) are NOT inner-PFS files. They are OUTER CNT entries — ids 0x040A, 0x1001,
            // 0x2010, 0x2011 — and the inner-PFS builder deliberately filters any sce_sys file whose name
            // is a known CNT id out of the inner image. They are generated as CNT entries in
            // BuildContainer instead.
        }
        return root;

        static void AddFile(FSDir dir, string name, byte[] data) =>
            dir.Files.Add(new FSFile(s => s.Write(data, 0, data.Length), name, data.Length) { Parent = dir });

        static string ResolveManifestPath(
            string projectDirectory,
            string? source,
            string fallback)
        {
            string value = string.IsNullOrWhiteSpace(source) ? fallback : source;
            value = Environment.ExpandEnvironmentVariables(value)
                .Replace('\\', Path.DirectorySeparatorChar);
            return Path.GetFullPath(Path.IsPathRooted(value)
                ? value
                : Path.Combine(projectDirectory, value));
        }

        static void AddManifestFile(
            FSDir rootDir,
            Gp5File file,
            string projectDirectory,
            string destinationPrefix,
            bool replaceExisting = false)
        {
            string destination = CombineDestination(destinationPrefix, file.DestinationPath);
            if (string.IsNullOrWhiteSpace(destination))
                return;
            string sourcePath = ResolveManifestPath(
                projectDirectory,
                file.SourcePath,
                Path.Combine(projectDirectory, destination.Replace('/', Path.DirectorySeparatorChar)));
            if (!File.Exists(sourcePath))
                throw new FileNotFoundException(
                    $"GP5 source file was not found for '{destination}'.", sourcePath);
            AddMappedFile(rootDir, destination, sourcePath, replaceExisting);
        }

        static void ApplyManifestDirectory(
            FSDir rootDir,
            Gp5Dir mapping,
            string projectDirectory,
            string destinationPrefix)
        {
            string destination = CombineDestination(destinationPrefix, mapping.DestinationPath);
            FSDir target = EnsureMappedDirectory(
                rootDir,
                destination,
                replaceLeaf: !mapping.Virtual);
            if (!string.IsNullOrWhiteSpace(mapping.SourcePath))
            {
                string sourcePath = ResolveManifestPath(
                    projectDirectory,
                    mapping.SourcePath,
                    projectDirectory);
                if (!Directory.Exists(sourcePath))
                    throw new DirectoryNotFoundException(
                        $"GP5 source directory was not found for '{destination}': {sourcePath}");
                Populate(target, sourcePath);
            }
            foreach (Gp5Dir child in mapping.Directories)
                ApplyManifestDirectory(
                    rootDir, child, projectDirectory, destination);
            foreach (Gp5File file in mapping.Files)
                AddManifestFile(
                    rootDir, file, projectDirectory, destination, replaceExisting: true);
        }

        static FSDir EnsureMappedDirectory(
            FSDir rootDir,
            string destination,
            bool replaceLeaf)
        {
            string[] parts = SplitDestination(destination);
            FSDir dir = rootDir;
            for (int i = 0; i < parts.Length; i++)
            {
                FSDir? next = dir.Dirs.FirstOrDefault(
                    child => string.Equals(child.name, parts[i], StringComparison.Ordinal));
                if (next is not null && replaceLeaf && i == parts.Length - 1)
                {
                    dir.Dirs.Remove(next);
                    next = null;
                }
                if (next is null)
                {
                    next = new FSDir { name = parts[i], Parent = dir };
                    dir.Dirs.Add(next);
                }
                dir = next;
            }
            return dir;
        }

        static void AddMappedFile(
            FSDir rootDir,
            string destination,
            string sourcePath,
            bool replaceExisting = false)
        {
            string[] parts = SplitDestination(destination);
            if (parts.Length == 0) return;
            FSDir dir = rootDir;
            for (int i = 0; i < parts.Length - 1; i++)
            {
                FSDir? next = dir.Dirs.FirstOrDefault(d => d.name == parts[i]);
                if (next is null)
                {
                    next = new FSDir { name = parts[i], Parent = dir };
                    dir.Dirs.Add(next);
                }
                dir = next;
            }
            string name = parts[^1];
            FSFile? existing = dir.Files.FirstOrDefault(
                file => string.Equals(file.name, name, StringComparison.Ordinal));
            if (existing is not null && !replaceExisting)
                throw new InvalidDataException($"GP5 declares destination '{destination}' more than once.");
            if (existing is not null)
                dir.Files.Remove(existing);
            dir.Files.Add(new FSFile(sourcePath) { name = name, Parent = dir });
        }

        static string CombineDestination(string prefix, string child) =>
            string.Join(
                '/',
                new[] { prefix, child }
                    .Where(value => !string.IsNullOrWhiteSpace(value))
                    .Select(value => value.Replace('\\', '/').Trim('/')));

        static string[] SplitDestination(string destination) =>
            destination.Replace('\\', '/').Trim('/')
                .Split('/', StringSplitOptions.RemoveEmptyEntries);

        static string[] ParseExcludeMasks(string? value) =>
            string.IsNullOrWhiteSpace(value)
                ? Array.Empty<string>()
                : value.Split(
                    [';', ','],
                    StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

        static bool IsExcluded(
            string name,
            string relativePath,
            IReadOnlyList<string> masks)
        {
            string normalized = relativePath.Replace('\\', '/');
            return masks.Any(mask =>
                FileSystemName.MatchesSimpleExpression(mask, name, ignoreCase: true) ||
                FileSystemName.MatchesSimpleExpression(
                    mask.Replace('\\', '/'), normalized, ignoreCase: true));
        }

        static void Populate(
            FSDir node,
            string path,
            string? sourceRoot = null,
            IReadOnlyList<string>? dirExcludes = null,
            IReadOnlyList<string>? fileExcludes = null,
            IReadOnlyList<string>? globalExcludes = null)
        {
            sourceRoot ??= path;
            dirExcludes ??= Array.Empty<string>();
            fileExcludes ??= Array.Empty<string>();
            globalExcludes ??= Array.Empty<string>();
            foreach (var sub in Directory.EnumerateDirectories(path).OrderBy(Path.GetFileName, StringComparer.Ordinal))
            {
                string relative = Path.GetRelativePath(sourceRoot, sub);
                if (IsExcluded(Path.GetFileName(sub), relative, dirExcludes) ||
                    IsExcluded(Path.GetFileName(sub), relative, globalExcludes))
                {
                    continue;
                }
                var child = new FSDir { name = Path.GetFileName(sub), Parent = node };
                node.Dirs.Add(child);
                Populate(
                    child,
                    sub,
                    sourceRoot,
                    dirExcludes,
                    fileExcludes,
                    globalExcludes);
            }
            foreach (var file in Directory.EnumerateFiles(path).OrderBy(Path.GetFileName, StringComparer.Ordinal))
            {
                var name = Path.GetFileName(file);
                if (name.EndsWith(".gp4", StringComparison.OrdinalIgnoreCase) ||
                    name.EndsWith(".gp5", StringComparison.OrdinalIgnoreCase))
                    continue;
                string relative = Path.GetRelativePath(sourceRoot, file);
                if (IsExcluded(name, relative, fileExcludes) ||
                    IsExcluded(name, relative, globalExcludes))
                {
                    continue;
                }
                node.Files.Add(new FSFile(file) { name = name, Parent = node });
            }
        }

        static void ConvertLooseElfExecutables(FSDir rootDir)
        {
            byte[]? applicationSceVersion = null;
            FSFile? executable = rootDir.GetAllChildrenFiles().FirstOrDefault(
                file => file.FullPath().Replace('\\', '/')
                    .Equals("/eboot.bin", StringComparison.Ordinal));
            if (executable is not null)
            {
                byte[] executableBytes = ReadNode(executable);
                ProsperoFself.TryGetSceVersionRecord(
                    executableBytes, out applicationSceVersion);
                if (applicationSceVersion.Length == 0)
                    applicationSceVersion = null;
            }
            ConvertDirectory(rootDir);

            void ConvertDirectory(FSDir directory)
            {
                for (int i = 0; i < directory.Files.Count; i++)
                {
                    FSFile file = directory.Files[i];
                    string path = file.FullPath().Replace('\\', '/');
                    bool executableDestination =
                        path.Equals("/eboot.bin", StringComparison.Ordinal) ||
                        path.StartsWith("/sce_module/", StringComparison.Ordinal) ||
                        path.StartsWith("/sce_sys/about/", StringComparison.Ordinal);
                    if (!executableDestination)
                        continue;

                    byte[] bytes = ReadNode(file);
                    if (!ProsperoFself.IsElf(bytes))
                        continue;
                    FselfOptions? fselfOptions = null;
                    bool isLibrary = !path.Equals(
                        "/eboot.bin", StringComparison.Ordinal);
                    if (isLibrary &&
                        applicationSceVersion is not null &&
                        !ProsperoFself.TryGetSceVersionRecord(
                            bytes, out _))
                    {
                        fselfOptions = new FselfOptions
                        {
                            SceVersionName =
                                Path.GetFileNameWithoutExtension(file.name),
                            SceVersionRecord = applicationSceVersion,
                        };
                    }
                    byte[] fself = ProsperoFself.MakeFself(
                        bytes, fselfOptions);
                    directory.Files[i] = new FSFile(
                        output => output.Write(fself, 0, fself.Length),
                        file.name,
                        fself.Length)
                    {
                        Parent = directory,
                        LayoutPriority = file.LayoutPriority,
                    };
                }

                foreach (FSDir child in directory.Dirs)
                    ConvertDirectory(child);
            }
        }
    }

    // sce_sys/about/right.sprx — the entitlement module the runtime loads from the package's about
    // directory. A supplied file always wins; when the project does not ship one, the embedded debug
    // module is injected so the package layout is complete. The publishing tool selects this module
    // by content type from a fixed embedded set; the library ships one debug default and never
    // rewrites a caller-supplied module.
    private static void EnsureAboutRightSprx(FSDir sceSys)
    {
        var about = FindDir(sceSys, "about");
        if (about != null && about.Files.Any(f => f.name == "right.sprx"))
            return;

        byte[]? module = LibProsperoPkg.PlayGo.ProsperoPlayGo.GetRightSprx();
        if (module is not { Length: > 0 })
            return;

        if (about == null)
        {
            about = new FSDir { name = "about", Parent = sceSys };
            sceSys.Dirs.Add(about);
        }
        AddInMemoryFile(about, "right.sprx", module);
    }

    // sce_sys/trophy2 and sce_sys/uds carry UCP archives (trophyNN.ucp / udsNN.ucp). A supplied
    // archive is packed as-is, but its whole-file digest is refreshed first so a re-assembled or
    // edited archive still validates on load. Fresh archives are produced from loose assets with
    // ProsperoUcp.BuildFromDirectory and placed here by the caller.
    private static void EnsureUcpArchives(FSDir sceSys)
    {
        foreach (var dirName in new[] { "trophy2", "uds" })
        {
            var dir = FindDir(sceSys, dirName);
            if (dir == null) continue;
            for (int i = 0; i < dir.Files.Count; i++)
            {
                var file = dir.Files[i];
                if (!file.name.EndsWith(".ucp", StringComparison.OrdinalIgnoreCase)) continue;
                byte[] bytes = ReadNode(file);
                if (!ProsperoUcp.IsUcp(bytes) || ProsperoUcp.VerifyDigest(bytes)) continue;
                byte[] repaired = ProsperoUcp.WithRepairedDigest(bytes);
                dir.Files[i] = new FSFile(s => s.Write(repaired, 0, repaired.Length), file.name, repaired.Length) { Parent = dir };
            }
        }
    }

    private static FSDir? FindDir(FSDir parent, string name) =>
        parent.Dirs.FirstOrDefault(d => d.name == name);

    private static void AddInMemoryFile(FSDir dir, string name, byte[] data) =>
        dir.Files.Add(new FSFile(s => s.Write(data, 0, data.Length), name, data.Length) { Parent = dir });

    private static byte[] ReadNode(FSFile file)
    {
        using var ms = new MemoryStream();
        file.Write(ms);
        return ms.ToArray();
    }

    private static Pkg BuildContainer(
        ProsperoPkgBuildProperties props, byte[] ekpfs, string sourceFolder,
        ulong pfsSize, int imagedigsSize, uint playgoFileCount,
        ulong mchunk0Size, ulong mchunk1Size,
        IReadOnlyList<string>? playgoPaths = null, bool publisherNwonly = false,
        byte[]? publisherPfsImageKey = null)
    {
        bool noData = props.VolumeType == ProsperoVolumeType.AdditionalContentNoData;
        bool upgradableApplication =
            props.VolumeType == ProsperoVolumeType.Application &&
            ReadParamJsonInfo(sourceFolder).ApplicationDrmType.Equals(
                "upgradable", StringComparison.OrdinalIgnoreCase);
        uint contentType = ContentTypeFor(props.VolumeType);
        var pkg = new Pkg
        {
            Header = new Header
            {
                CNTMagic = "\u007fCNT",
                flags = (PKGFlags)FlagsPs5,
                ps5_profile_marker = 0x80000000,
                header_profile_code = HeaderProfileCodePs5,
                entry_count = 0,
                sc_entry_count = (ushort)(noData ? 5 : 6),
                entry_count_2 = 0,
                entry_table_offset = 0,
                main_ent_data_size = 0,
                body_offset = BodyOffset,
                body_size = 0,
                content_id = props.ContentId,
                drm_type = props.VolumeType == ProsperoVolumeType.Application &&
                           !upgradableApplication
                    ? 0u
                    : DrmTypePs5,
                content_type = contentType,
                content_flags = ContentFlagsFor(props.VolumeType) |
                    (props.UsePublisherPprNaps && !noData ? (ContentFlags)0x00020000 : 0) |
                    (upgradableApplication ? (ContentFlags)0x08000000 : 0),
                promote_size = 0,
                // prospero-pub-cmd 2.79 producer identity used by the current publisher corpus.
                version_date = 0x20240508,
                version_hash = 0x090FBFC1,
                iro_tag = IROTag.None,
                ekc_version = props.VolumeType is ProsperoVolumeType.Application
                    or ProsperoVolumeType.AdditionalContentNoData
                    ? upgradableApplication ? 1u : 0u
                    : 1u,
                sc_entries1_hash = new byte[32],
                sc_entries2_hash = new byte[32],
                digest_table_hash = new byte[32],
                body_digest = new byte[32],
                pfs_descriptor_presence = noData ? 0u : 1u,
                pfs_image_count = noData ? 0u : 1u,
                pfs_flags = noData ? 0 : props.UsePublisherPprNaps ? PublisherPfsFlags : LegacyPfsFlags,
                pfs_image_offset = noData ? 0 : PfsImageOffset,
                pfs_image_size = pfsSize,
                mount_image_offset = 0,
                mount_image_size = 0,
                package_size = noData ? 0 : PfsImageOffset + pfsSize,
                pfs_signed_size = noData ? 0u : BlockSize,
                pfs_cache_size = noData ? 0u : props.UsePublisherPprNaps ? 0u : 0xD0000u,
                pfs_image_digest = new byte[32],
                pfs_signed_digest = new byte[32],
                pfs_split_size_nth_0 = 0,
                pfs_split_size_nth_1 = 0,
                image_seed = new byte[16],
                cnt_region_offset = 0,
                cnt_region_size = 0,
                desc_digest = new byte[64],
            },
            HeaderDigest = new byte[32],
            HeaderSignature = new byte[ProsperoPublisherRsa.ModulusSize],
        };

        // System-container entries (the 6 SC entries), ids 0x1/0x10/0x20/0x80/0x100/0x200.
        pkg.EntryKeys = props.PublisherEntryKeys is not null
            ? KeysEntry.FromPublisherBytes(props.PublisherEntryKeys)
            : new KeysEntry(
                props.ContentId, props.Passcode, props.UsePublisherPprNaps,
                props.UsePublisherPprNaps || props.DeterministicBuild, props.PrimaryId);
        byte[]? imageKeyBody = null;
        if (!noData && props.UsePublisherPprNaps)
        {
            if (publisherPfsImageKey is not { Length: 32 })
                throw new InvalidDataException(
                    "The publisher IMAGE_KEY producer requires the derived 32-byte pfs-image-key.");
            imageKeyBody = props.PublisherImageKey?.AsSpan().ToArray()
                ?? ProsperoPfsKeys.BuildPublisherImageKey(publisherPfsImageKey);
        }
        else if (!noData)
        {
            imageKeyBody = Crypto.RSA2048EncryptKey(
                LibProsperoPkg.Util.RSAKeyset.FakeKeyset.Modulus, ekpfs);
        }
        if (imageKeyBody is not null)
        {
            pkg.ImageKey = new GenericEntry(EntryId.IMAGE_KEY)
            {
                FileData = imageKeyBody,
            };
        }
        pkg.GeneralDigests = new GeneralDigestsEntry { type = ProsperoImageDigests.GeneralDigestsTypeFull };
        pkg.Metas = new MetasEntry();
        pkg.Digests = new GenericEntry(EntryId.DIGESTS);
        pkg.EntryNames = new NameTableEntry();

        // param.json (PS5 entry id 0x2000).  The publishing tool does not copy the project
        // file verbatim: it stamps pubtools metadata, fills profile-specific defaults, pads the
        // version URI to its fixed 255-character field, orders properties, and emits CRLF JSON.
        byte[] paramJson = BuildPublisherParamJson(sourceFolder, props);
        var paramEntry = new GenericEntry((EntryId)0x2000, "param.json") { FileData = paramJson };

        pkg.Entries = new List<Entry>
        {
            pkg.EntryKeys,
            pkg.GeneralDigests,
            pkg.Metas,
            pkg.Digests,
            pkg.EntryNames,
            paramEntry,
        };
        if (pkg.ImageKey is not null)
            pkg.Entries.Insert(1, pkg.ImageKey);

        // sce_sys media entries (icon0.png, pic0.png, pic1.png, snd0.at9, ...) present in the folder.
        foreach (var media in CollectMediaEntries(
                     sourceFolder, props.VolumeType, props.ContentId,
                     props.LicenseProvider, generateDds: !noData))
            if (!pkg.Entries.Any(existing => (uint)existing.Id == (uint)media.Id))
                pkg.Entries.Add(media);

        // PS5 image-digest + PlayGo descriptor CNT entries. Reference package layout shows
        // these are OUTER CNT entries — imagedigs.dat
        // (id 0x040A, UNNAMED), playgo-chunk.dat (0x1001), playgo-hash-table.dat (0x2010) and
        // playgo-ficm.dat (0x2011) — NOT inner-PFS files. imagedigs is laid out as a placeholder sized
        // to the outer block count and filled with the captured per-block digests after the image is
        // written. The PlayGo file/inode count drives playgo-ficm.dat (count) and playgo-hash-table.dat
        // (count / 2), matching reference samples. Source PlayGo metadata is never reused because
        // its geometry belongs to the old image.
        if (!noData)
        {
            const int playgoChunkCount = LibProsperoPkg.PlayGo.ProsperoPlayGo.DefaultChunkCount;
            foreach (var (id, name, data) in new (uint Id, string? Name, byte[] Data)[]
            {
                (ImagedigsEntryId, null, new byte[imagedigsSize]),
                (0x1001u, "playgo-chunk.dat", LibProsperoPkg.PlayGo.ProsperoPlayGo.BuildChunkDat(
                    props.ContentId, mchunk0Size, mchunk1Size, publisherNwonly,
                    includePublisherLabels:
                        publisherNwonly && props.VolumeType == ProsperoVolumeType.Application,
                    chunkCount: playgoChunkCount)),
                (0x2010u, "playgo-hash-table.dat", playgoPaths is not null
                    ? LibProsperoPkg.PlayGo.ProsperoPlayGo.BuildHashTable(playgoPaths)
                    : LibProsperoPkg.PlayGo.ProsperoPlayGo.BuildHashTable(playgoFileCount / 2)),
                (0x2011u, "playgo-ficm.dat", publisherNwonly
                    ? LibProsperoPkg.PlayGo.ProsperoPlayGo.BuildFicm(
                        LibProsperoPkg.PlayGo.ProsperoPlayGo.BuildAutomaticFileChunkIds(
                            checked((int)(playgoFileCount / 2)), playgoChunkCount))
                    : LibProsperoPkg.PlayGo.ProsperoPlayGo.BuildFicm(playgoFileCount)),
                (0x3000u, "playgo-scenario.json", LibProsperoPkg.PlayGo.ProsperoPlayGo.BuildScenarioJson()),
            })
            {
                if (!pkg.Entries.Any(e => (uint)e.Id == id))
                    pkg.Entries.Add(new GenericEntry((EntryId)id, name) { FileData = data });
            }
        }

        // Publisher CNT bodies use a semantic storage order which is independent of the sorted
        // metadata table: param, backend system blobs, imagedigs/chunk, presentation media, then
        // the PlayGo hash/FICM tails. Keep the six SC records fixed at the front.
        Entry[] sc = pkg.Entries.Take(6).ToArray();
        Entry[] bodies = pkg.Entries.Skip(6)
            .OrderBy(PublisherBodyRank)
            .ThenBy(e => (uint)e.Id)
            .ToArray();
        pkg.Entries = sc.Concat(bodies).ToList();

        pkg.Digests.FileData = new byte[pkg.Entries.Count * Pkg.HASH_SIZE];

        LayOutEntries(
            pkg, paramJson, props.VolumeType,
            ReadParamJsonInfo(sourceFolder).ApplicationDrmType);
        return pkg;
    }

    private static int PublisherBodyRank(Entry entry)
    {
        uint id = (uint)entry.Id;
        if (id == 0x2000) return 0;                    // param.json
        if (id is 0x040A or 0x1001) return 2;          // image digests + chunk descriptor
        if (id is 0x2010 or 0x2011 or 0x3000) return 4; // PlayGo tails
        if (id is >= 0x1200 and < 0x2000 || id is 0x1006 or 0x100D) return 3; // media
        return 1;                                      // backend-authored sce_sys blobs
    }

    private static void LayOutEntries(
        Pkg pkg, byte[] paramJson, ProsperoVolumeType volumeType,
        string applicationDrmType)
    {
        // Publisher ENTRY_NAMES follows the sorted MetaEntry table, not lexical filename order.
        // The table therefore starts with playgo-chunk.dat (id 0x1001), followed by presentation
        // media and the 0x2000/0x2010/0x2011 records in id order. NameTableOffset values are assigned
        // against this canonical sequence before the independent semantic body layout is calculated.
        foreach (var entry in pkg.Entries.OrderBy(e => (uint)e.Id))
        {
            ProsperoCntEntryProfile profile = ProsperoCntEntryPolicy.Resolve(
                (uint)entry.Id, volumeType, entry.Name, applicationDrmType);
            if (profile.IncludeName)
                pkg.EntryNames.GetOffset(entry.Name);
        }

        // 2nd pass: assign 16-byte-aligned data offsets and build the meta table.
        ulong dataOffset = pkg.Header.body_offset;
        foreach (var entry in pkg.Entries)
        {
            ProsperoCntEntryProfile profile = ProsperoCntEntryPolicy.Resolve(
                (uint)entry.Id, volumeType, entry.Name, applicationDrmType);
            var meta = new MetaEntry
            {
                id = entry.Id,
                NameTableOffset = profile.IncludeName
                    ? pkg.EntryNames.GetOffset(entry.Name)
                    : 0,
                DataOffset = (uint)dataOffset,
                DataSize = entry.Length,
                Flags1 = profile.Flags1,
                Flags2 = profile.Flags2,
            };
            pkg.Metas.Metas.Add(meta);
            if (entry == pkg.Metas)
                meta.DataSize = (uint)pkg.Entries.Count * 32;

            dataOffset = Align(dataOffset + meta.DataSize, 16);
            entry.meta = meta;
        }

        ulong bodySize = dataOffset - pkg.Header.body_offset;
        pkg.Metas.Metas.Sort((a, b) => a.id.CompareTo(b.id));
        pkg.Header.entry_count = (uint)pkg.Entries.Count;
        pkg.Header.entry_count_2 = (ushort)pkg.Entries.Count;
        pkg.Header.entry_table_offset = pkg.Metas.meta.DataOffset;
        // Publisher CNT bodies are rounded to a 64-KiB boundary. The former
        // 0x80000 alignment inflated a reference-sized AC container from
        // 0xC0000 to 0x100000 and changed every finalized-image locator.
        ulong bodyAlignment = pkg.EntryKeys.Length == 0xB80 ? 0x10000UL : 0x80000UL;
        pkg.Header.body_size = Align(pkg.Header.body_offset + bodySize, bodyAlignment) - pkg.Header.body_offset;
        if (pkg.Header.content_type == ContentTypeAl)
            pkg.Header.body_size = Math.Max(pkg.Header.body_size, 0x1E000);
        pkg.Header.main_ent_data_size = checked((uint)pkg.Entries
            .Take(pkg.Header.sc_entry_count - 1)
            .Sum(x => x.Length));

        bool noData = pkg.Header.content_type == ContentTypeAl;
        pkg.Header.pfs_image_offset = noData ? 0 : pkg.Header.body_offset + pkg.Header.body_size;
        ulong containerSize = pkg.Header.pfs_image_offset;
        if (pkg.Header.content_type == ContentTypeGd)
            pkg.Header.promote_size = checked((uint)containerSize);
        ulong leadingFihSize = noData ? 0 : ProsperoImageDigests.FihRelativeImageOffset;
        pkg.Header.package_size = pkg.Header.mount_image_size = noData
            ? 0
            : leadingFihSize + pkg.Header.pfs_image_size + containerSize;

        if (noData)
        {
            pkg.Header.mandatory_size = pkg.Metas.Metas
                .Where(m => (uint)m.id is >= 0x1000 and < 0x2000)
                .OrderBy(m => m.DataOffset)
                .Select(m => (ulong)m.DataOffset)
                .DefaultIfEmpty(pkg.Header.body_offset + pkg.Header.body_size)
                .First();
        }
        else
        {
            MetaEntry mandatory = pkg.Metas.Metas.First(m => (uint)m.id == ImagedigsEntryId);
            pkg.Header.mandatory_size = mandatory.DataOffset;
            pkg.Header.cnt_region_offset =
                ProsperoImageDigests.FihRelativeImageOffset + pkg.Header.pfs_image_size;
            pkg.Header.cnt_region_size = containerSize;
            pkg.Header.desc_image_key_offset = pkg.ImageKey.meta.DataOffset;
            pkg.Header.desc_image_key_size = pkg.ImageKey.meta.DataSize;
            pkg.Header.desc_mandatory_offset = mandatory.DataOffset;
            pkg.Header.desc_mandatory_size = mandatory.DataSize;
        }
    }

    private static void FinishAdditionalContentNoDataContainer(
        Pkg pkg, Stream stream, ProsperoPkgBuildProperties props)
    {
        foreach (var kv in ComputeGeneralDigests(pkg))
            pkg.GeneralDigests.Set(kv.Key, kv.Value);

        var writer = new PkgWriter(stream);
        writer.WriteBody(pkg, props.ContentId, props.Passcode);
        CalcBodyDigests(pkg, stream);

        stream.Position = 0;
        writer.WriteHeader(pkg.Header);
        stream.Position = 0;
        byte[] cntHead = new byte[ProsperoImageDigests.PackageDigestRegionSize];
        stream.ReadExactly(cntHead);
        pkg.HeaderDigest = ProsperoImageDigests.ComputePackageDigest(cntHead);
        stream.Position = ProsperoImageDigests.PackageDigestStoredOffset;
        stream.Write(pkg.HeaderDigest);

        stream.Position = 0;
        byte[] wrapPreimage = new byte[0x1000];
        stream.ReadExactly(wrapPreimage);
        pkg.HeaderSignature = ProsperoPublisherRsa.BuildCntHeaderWrap(wrapPreimage);
        stream.Position = 0x1000;
        stream.Write(pkg.HeaderSignature);
    }

    private static ProsperoPfsImageXmlOptions FinishContainer(
        Pkg pkg, Stream s, ProsperoPkgBuildProperties props, byte[]? nestedImageDigest,
        Action<string> log, long nestedImageSize = 0, long nestedMetaBaseBlocks = 0,
        uint nwonlyContentVersionHi = 0, int nwonlyNapsFileCount = 0,
        int nwonlyAppFileCount = 0, int nwonlySparseAfidCount = 0,
        int nwonlyEmptyFileCount = 0, int knownOuterSuperblockIndex = -1,
        Stream? separatePfsImage = null, long separatePfsOffset = 0)
    {
        // Read the outer PFS image (encrypted blocks + plaintext superblock) so the PS5 mount digests can be
        // computed for the mount image — both are SHA3-256, NOT SHA-256:
        //   game-digest  (pfs_image_digest @0x440) = SHA3-256(plaintext outer superblock block)
        //   fixed-info   (pfs_signed_digest @0x460) = SHA3-256(the FIH header block that wraps this CNT)
        // The FIH block is cycle-free here (it depends only on the image + sizes, never on the CNT digest
        // table) so it is identical to the one ProsperoFihBuilder.BuildFromCnt writes when finalizing.
        log("Calculating PFS image digests (SHA3-256)...");
        Stream imageStream = separatePfsImage ?? s;
        long imageOffset = separatePfsImage is null
            ? checked((long)pkg.Header.pfs_image_offset)
            : separatePfsOffset;
        long imageSize = checked((long)pkg.Header.pfs_image_size);
        long sbOffset = knownOuterSuperblockIndex >= 0
            ? checked((long)knownOuterSuperblockIndex * ProsperoImageDigests.BlockSize)
            : LocateSuperblockInRange(imageStream, imageOffset, imageSize);
        byte[]? sblockDigest = null;
        byte[] imageDigest;
        if (sbOffset >= 0)
        {
            byte[] superblock = ReadStreamRange(
                imageStream, checked(imageOffset + sbOffset), ProsperoImageDigests.BlockSize);
            sblockDigest = ProsperoImageDigests.ComputeSblockDigest(superblock);
            imageDigest = sblockDigest;
            pkg.Header.image_seed = superblock.AsSpan(PfsSeedOffset, 16).ToArray();
        }
        else
        {
            imageDigest = HashStreamRange(imageStream, imageOffset, imageSize);
        }
        pkg.Header.pfs_image_digest = imageDigest;
        byte[] fihBlock = ProsperoFihBuilder.BuildFihHeaderBlock(
            ProsperoFihVariant.Debug, pkg.Header.pfs_image_size,
            ProsperoImageDigests.FihRelativeImageOffset + pkg.Header.pfs_image_size,
            sbOffset, sblockDigest, imageDigest,
            warnings: null, nestedImageDigest: nestedImageDigest, nestedImageSize: nestedImageSize,
            nestedMetaBaseBlocks: nestedMetaBaseBlocks,
            nwonlyContentVersionHi: nwonlyContentVersionHi,
            nwonlyNapsFileCount: nwonlyNapsFileCount,
            nwonlyAppFileCount: nwonlyAppFileCount,
            nwonlySparseAfidCount: nwonlySparseAfidCount,
            nwonlyEmptyFileCount: nwonlyEmptyFileCount);
        pkg.Header.pfs_signed_digest = ProsperoImageDigests.ComputeFixedInfoDigest(fihBlock);

        // General digests (PS5 nwonly scheme: type 0x102 [set at creation so the layout reserves 0x1E0],
        // set_digests 0x10DE = content|game|header|system|param|playgo|target, all SHA3-256). game/fixed-info
        // above must already be set: the header-digest preimage (CNT[0x400:0x480]) includes both.
        foreach (var kv in ComputeGeneralDigests(pkg))
            pkg.GeneralDigests.Set(kv.Key, kv.Value);

        // Write the body (entries) now so the per-entry hashes can be computed from the stream.
        var writer = new PkgWriter(s);
        writer.WriteBody(pkg, props.ContentId, props.Passcode);
        CalcBodyDigests(pkg, s);

        if (pkg.Header.desc_image_key_size != 0 && pkg.Header.desc_mandatory_size != 0)
            pkg.Header.desc_digest = ComputeDescriptorDigest(s, pkg.Header);

        // Header, package digest and the PS5 RSA-3072 public wrap.
        s.Position = 0;
        writer.WriteHeader(pkg.Header);
        // Package-digest (the CNT self-seal at +0xFE0): PS5 uses SHA3-256(CNT[0:0xFE0]), NOT SHA-256.
        // The preimage spans 0x410 (pfs_image_offset); BuildFromCnt rewrites that field to the FIH-relative
        // 0x10000 when it finalizes the image, so force 0x10000 here too — otherwise the stored seal would be
        // over the physical offset and would not match a verifier reading the finalized package. Validated
        // byte-exact against reference output (this is the value reported as "Package Digest").
        s.Position = 0;
        byte[] cntHead = new byte[ProsperoImageDigests.PackageDigestRegionSize];
        s.ReadExactly(cntHead);
        BinaryPrimitives.WriteUInt64BigEndian(
            cntHead.AsSpan(ProsperoImageDigests.CntPfsImageOffsetField, 8), ProsperoImageDigests.FihRelativeImageOffset);
        pkg.HeaderDigest = ProsperoImageDigests.ComputePackageDigest(cntHead);
        s.Position = ProsperoImageDigests.PackageDigestStoredOffset;
        s.Write(pkg.HeaderDigest, 0, pkg.HeaderDigest.Length);
        // Wrap the bytes exactly as they will appear in the finalized FIH. BuildFromCnt changes
        // CNT+0x410 from the standalone physical image offset to the shared FIH offset 0x10000;
        // wrapping the pre-finalized value makes CNT+0x1000 invalid after that rewrite.
        s.Position = 0;
        byte[] wrapPreimage = new byte[0x1000];
        s.ReadExactly(wrapPreimage);
        BinaryPrimitives.WriteUInt64BigEndian(
            wrapPreimage.AsSpan(ProsperoImageDigests.CntPfsImageOffsetField, 8),
            ProsperoImageDigests.FihRelativeImageOffset);
        s.Position = 0x1000;
        pkg.HeaderSignature = ProsperoPublisherRsa.BuildCntHeaderWrap(wrapPreimage);
        s.Write(pkg.HeaderSignature, 0, pkg.HeaderSignature.Length);

        // Every digest, the geometry and the entry table are now finalized on this CNT, so the reproducible
        // SI pfsimage.xml options can be assembled from the builder's own output. The inner-PFS seed is read
        // from the plaintext outer superblock at sbOffset+0x370.
        return BuildSiXmlOptions(
            pkg, pkg.Header.image_seed, Path.GetFullPath(props.SourceFolder!),
            props.PrimaryId ?? props.ContentId);
    }

    private static byte[] ComputeDescriptorDigest(Stream stream, in Header header)
    {
        byte[] imageKey = new byte[header.desc_image_key_size];
        stream.Position = header.desc_image_key_offset;
        stream.ReadExactly(imageKey);

        byte[] mandatory = new byte[header.desc_mandatory_size];
        stream.Position = header.desc_mandatory_offset;
        stream.ReadExactly(mandatory);

        byte[] result = new byte[64];
        ProsperoImageDigests.Sha3_256(imageKey).CopyTo(result, 0);
        ProsperoImageDigests.Sha3_256(mandatory).CopyTo(result, 32);
        return result;
    }

    // ---- SI (sce_suppl) pfsimage.xml option assembly ----------------------------------------------

    /// <summary>
    /// Builds the reproducible <see cref="ProsperoPfsImageXmlOptions"/> for the trailing debug SI segment
    /// from the finalized CNT (<paramref name="pkg"/>) and the captured outer-image seed. Every
    /// value maps to something the builder already produced — the general digests, the header/body/
    /// fixed-info digests, the container geometry and the CNT entry table — so the emitted pfsimage.xml is
    /// self-consistent with the produced package.
    /// </summary>
    private static ProsperoPfsImageXmlOptions BuildSiXmlOptions(
        Pkg pkg, byte[] imageSeed, string sourceFolder, string primaryId)
    {
        byte[] seed = imageSeed is { Length: 16 } ? imageSeed.ToArray() : new byte[16];

        ParamJsonInfo pj = ReadParamJsonInfo(sourceFolder);

        long pfsImageSize = (long)pkg.Header.pfs_image_size;
        long containerSize = (long)pkg.Header.pfs_image_offset;   // CNT-internal value = CNT body end = CNT size.
        long bodyOffset = (long)pkg.Header.body_offset;
        long mandatorySize = (long)pkg.Metas.Metas.First(m => (uint)m.id == ImagedigsEntryId).DataOffset;
        // Mount-image size = FIH (0x10000) + shared PFS image + container. pkg.Header.mount_image_size omits
        // the leading FIH block, so it is reconstructed here.
        long packageSize = (long)ProsperoImageDigests.FihRelativeImageOffset + pfsImageSize + containerSize;

        // The <entries> table = the file-class CNT entries (id >= 0x400), ordered by container offset.
        var entries = pkg.Metas.Metas
            .Where(m => (uint)m.id >= 0x400)
            .Select(m => new ProsperoPfsImageEntry(EntryDisplayName(pkg, m.id), (long)m.DataOffset, m.DataSize))
            .OrderBy(e => e.Offset)
            .ToList();

        byte[]? Dig(GeneralDigest d) => pkg.GeneralDigests.Digests.TryGetValue(d, out byte[]? v) ? v : null;

        return new ProsperoPfsImageXmlOptions
        {
            ContentId = pkg.Header.content_id,
            PrimaryId = primaryId,
            TitleName = pj.TitleName,
            ContentVersion = pj.ContentVersion,
            DrmType = "none",
            ApplicationDrmType = pj.ApplicationDrmType,
            ContentType = ContentTypeString(pkg.Header.content_type),
            ApplicationType = "free",
            MasterVersion = pj.MasterVersion,
            RequiredSystemSoftwareVersion = pj.RequiredSystemSoftwareVersion,
            SdkVersion = pj.SdkVersion,
            PackageSize = packageSize,
            PfsImageOffset = (long)ProsperoImageDigests.FihRelativeImageOffset,
            PfsImageSize = pfsImageSize,
            PfsImageSeed = seed,
            ContainerSize = containerSize,
            MandatorySize = mandatorySize,
            BodyOffset = bodyOffset,
            SupplementalOffset = containerSize,
            Entries = entries,
            ContentDigest = Dig(GeneralDigest.ContentDigest),
            GameDigest = pkg.Header.pfs_image_digest,
            HeaderDigest = Dig(GeneralDigest.HeaderDigest),
            SystemDigest = Dig(GeneralDigest.SystemDigest),
            ParamDigest = Dig(GeneralDigest.ParamDigest),
            PackageDigest = pkg.HeaderDigest,
            BodyDigest = pkg.Header.body_digest,
            SblockDigest = pkg.Header.pfs_image_digest,
            FixedInfoDigest = pkg.Header.pfs_signed_digest,
        };
    }

    private static long LocateSuperblockInRange(Stream stream, long offset, long size)
    {
        if (!stream.CanRead || !stream.CanSeek)
            throw new ArgumentException("Image stream must be readable and seekable.", nameof(stream));
        Span<byte> identity = stackalloc byte[12];
        for (long relative = 0;
             relative <= size - ProsperoImageDigests.BlockSize;
             relative += ProsperoImageDigests.BlockSize)
        {
            stream.Position = checked(offset + relative);
            stream.ReadExactly(identity);
            if (BinaryPrimitives.ReadUInt64LittleEndian(identity) == 2UL &&
                identity[8] == 0x0B && identity[9] == 0x2A &&
                identity[10] == 0x33 && identity[11] == 0x01)
                return relative;
        }
        return -1;
    }

    private static byte[] ReadStreamRange(Stream stream, long offset, int size)
    {
        if (offset < 0 || size < 0 || offset > stream.Length || size > stream.Length - offset)
            throw new InvalidDataException("Requested image range is outside the stream.");
        byte[] value = new byte[size];
        stream.Position = offset;
        stream.ReadExactly(value);
        return value;
    }

    private static byte[] HashStreamRange(Stream stream, long offset, long size)
    {
        if (offset < 0 || size < 0 || offset > stream.Length || size > stream.Length - offset)
            throw new InvalidDataException("Requested image range is outside the stream.");
        var hash = new ProsperoSha3.Incremental();
        byte[] buffer = new byte[1024 * 1024];
        stream.Position = offset;
        while (size != 0)
        {
            int requested = (int)Math.Min(buffer.Length, size);
            int read = stream.Read(buffer, 0, requested);
            if (read == 0) throw new EndOfStreamException();
            hash.AppendData(buffer.AsSpan(0, read));
            size -= read;
        }
        return hash.GetHashAndReset();
    }

    /// <summary>Plaintext superblock offset of the 16-byte inner-PFS seed (superblock+0x370).</summary>
    private const int PfsSeedOffset = 0x370;

    // pfsimage.xml content-type string, selected from the CNT header content-type code.
    private static string ContentTypeString(uint contentType) => contentType switch
    {
        ContentTypeAc => "PS5AC",
        ContentTypeAl => "PS5AL",
        _ => "PS5GD",
    };

    // Display name for one <entry> of the pfsimage.xml <entries> table. imagedigs (0x040A) is stored
    // UNNAMED in the CNT, so it is special-cased; every other file-class entry carries its CNT name (or a
    // canonical id->name fallback).
    private static string EntryDisplayName(Pkg pkg, EntryId id)
    {
        if ((uint)id == ImagedigsEntryId) return "imagedigs.dat";
        var e = pkg.Entries.FirstOrDefault(x => x.Id == id);
        if (e?.Name is { Length: > 0 } named) return named;
        return EntryNames.IdToName.TryGetValue(id, out string? nm) ? nm : $"0x{(uint)id:x4}.bin";
    }

    // Reproducible pfsimage.xml string fields sourced from param.json.
    private readonly record struct ParamJsonInfo(
        string ContentVersion, string MasterVersion, string SdkVersion,
        string RequiredSystemSoftwareVersion, string ApplicationDrmType, string TitleName);

    private static uint ContentVersionHigh(string contentVersion)
    {
        if (string.IsNullOrWhiteSpace(contentVersion)) return 0;
        string digits = string.Concat(contentVersion.Where(char.IsDigit));
        if (digits.Length != 8)
            return 0;
        uint bcd = 0;
        foreach (char digit in digits)
            bcd = (bcd << 4) | (uint)(digit - '0');
        return bcd;
    }

    // Best-effort param.json reader for the pfsimage.xml string fields. Any parse failure falls back to
    // the neutral defaults (the produced XML stays structurally valid and self-consistent).
    private static ParamJsonInfo ReadParamJsonInfo(string sourceFolder)
    {
        string contentVersion = "01.000.000", masterVersion = "01.00",
               sdkVersion = "0x0000000000000000", reqSys = "0x0000000000000000",
               appDrm = "free", title = "";
        try
        {
            byte[] pj = ReadParamJson(sourceFolder);
            if (pj is { Length: > 0 })
            {
                using var doc = JsonDocument.Parse(pj);
                JsonElement root = doc.RootElement;
                if (root.ValueKind == JsonValueKind.Object)
                {
                    static string? Str(JsonElement o, string name) =>
                        o.TryGetProperty(name, out JsonElement v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

                    contentVersion = Str(root, "contentVersion") ?? contentVersion;
                    masterVersion = Str(root, "masterVersion") ?? masterVersion;
                    sdkVersion = Str(root, "sdkVersion") ?? sdkVersion;
                    reqSys = Str(root, "requiredSystemSoftwareVersion") ?? reqSys;
                    appDrm = Str(root, "applicationDrmType") ?? appDrm;

                    if (root.TryGetProperty("localizedParameters", out JsonElement lp) && lp.ValueKind == JsonValueKind.Object)
                    {
                        string lang = Str(lp, "defaultLanguage") ?? "en-US";
                        if (lp.TryGetProperty(lang, out JsonElement le) && le.ValueKind == JsonValueKind.Object &&
                            Str(le, "titleName") is { Length: > 0 } tn)
                        {
                            title = tn;
                        }
                        else
                        {
                            foreach (JsonProperty prop in lp.EnumerateObject())
                            {
                                if (prop.Value.ValueKind == JsonValueKind.Object &&
                                    Str(prop.Value, "titleName") is { Length: > 0 } t2)
                                {
                                    title = t2;
                                    break;
                                }
                            }
                        }
                    }
                }
            }
        }
        catch (Exception ex) when (ex is JsonException or IOException or ArgumentException)
        {
            // Best-effort: keep the neutral defaults.
        }
        return new ParamJsonInfo(contentVersion, masterVersion, sdkVersion, reqSys, appDrm, title);
    }

    // Per-entry CNT ids that contribute to the system-digest (the sce_sys visual/audio media + their *.dds
    // re-encodes) and the playgo-digest (the PlayGo stream files). Validated against reference output:
    // system = SHA3-256( ed(icon0.png 0x1200) ‖ ed(icon0.dds 0x1280) );
    // playgo = SHA3-256( ed(playgo-chunk.dat 0x1001) ‖ ed(playgo-hash-table.dat 0x2010) ‖ ed(playgo-ficm.dat 0x2011) ).
    private static readonly uint[] SystemMediaIds =
        [0x1006, 0x100D, 0x1200, 0x1220, 0x1240, 0x1280, 0x12A0, 0x12C0, 0x2040, 0x2060];
    private static readonly uint[] PlaygoIds = [0x1001, 0x2010, 0x2011];

    private static Dictionary<GeneralDigest, byte[]> ComputeGeneralDigests(Pkg pkg)
    {
        byte[] game = pkg.Header.pfs_image_digest;
        bool includeGame = pkg.Header.content_type != ContentTypeAl;

        var digests = new Dictionary<GeneralDigest, byte[]>
        {
            { GeneralDigest.HeaderDigest, ComputeHeaderDigest(pkg) },
            { GeneralDigest.ContentDigest, ComputeContentDigest(pkg, game, includeGame) },
        };
        if (includeGame)
        {
            // game-digest (= pfs_image_digest) and its copy in the target slot (target == game for nwonly).
            digests[GeneralDigest.GameDigest] = game;
            digests[GeneralDigest.TargetDigest] = game;
        }

        // system-digest / playgo-digest = SHA3-256 over the concatenated per-entry SHA3 digests of the
        // relevant entries, in ascending id order. Computed over whatever such entries the package carries
        // (self-consistent); the byte-exact formula is validated against reference output.
        byte[]? system = ComputeConcatOverEntries(pkg, SystemMediaIds);
        if (system is not null) digests[GeneralDigest.SystemDigest] = system;
        byte[]? playgo = ComputeConcatOverEntries(pkg, PlaygoIds);
        if (playgo is not null) digests[GeneralDigest.PlaygoDigest] = playgo;

        // param.json drives the param-digest (SHA3-256 of the entry payload) on PS5.
        var paramEntry = pkg.Entries.FirstOrDefault(e => (uint)e.Id == 0x2000);
        if (paramEntry is GenericEntry { FileData: { } pj })
            digests[GeneralDigest.ParamDigest] = ProsperoImageDigests.ComputeEntryDigest(pj);

        return digests;
    }

    private static byte[]? ComputeConcatOverEntries(Pkg pkg, uint[] ids)
    {
        var set = new HashSet<uint>(ids);
        var perEntry = pkg.Entries
            .Where(e => set.Contains((uint)e.Id) && e is GenericEntry { FileData: not null })
            .OrderBy(e => (uint)e.Id)
            .Select(e => ProsperoImageDigests.ComputeEntryDigest(((GenericEntry)e).FileData!))
            .ToList();
        return perEntry.Count == 0 ? null : ProsperoImageDigests.ComputeConcatDigest(perEntry);
    }

    private static byte[] ComputeHeaderDigest(Pkg pkg)
    {
        // header-digest = SHA3-256( CNT[0x00:0x40] ‖ CNT[0x400:0x480] ). The mount descriptor must carry the
        // finalized FIH-relative pfs_image_offset (0x10000) at CNT+0x410 — BuildFromCnt rewrites it on disk
        // after this runs, so force it in the preimage so the stored digest matches the finalized image.
        using var ms = new MemoryStream();
        new PkgWriter(ms).WriteHeader(pkg.Header);
        byte[] prefix = new byte[ProsperoImageDigests.HeaderDigestPrefixSize];
        ms.Position = 0;
        ms.ReadExactly(prefix);
        byte[] mount = new byte[ProsperoImageDigests.HeaderDigestMountDescriptorSize];
        ms.Position = 0x400;
        ms.ReadExactly(mount);
        return ProsperoImageDigests.ComputeHeaderDigest(prefix, ProsperoImageDigests.ForceFihRelativeImageOffset(mount));
    }

    private static byte[] ComputeContentDigest(Pkg pkg, byte[] game, bool includeGame)
    {
        // content-digest = SHA3-256( CNT[0x40:0x78] ‖ game-digest(32, when present) ‖ major-param-digest(32) ).
        // CNT[0x40:0x78] = content_id(36) + 12 reserved + drm_type(BE32 @0x30) + content_type(BE32 @0x34).
        // The major-param-digest is all-zero for the nwonly package class, as validated against reference output.
        byte[] descriptor = new byte[ProsperoImageDigests.ContentDescriptorSize];
        byte[] cid = Encoding.ASCII.GetBytes(pkg.Header.content_id);
        Array.Copy(cid, 0, descriptor, 0, Math.Min(cid.Length, 36));
        BinaryPrimitives.WriteUInt32BigEndian(descriptor.AsSpan(0x30, 4), pkg.Header.drm_type);
        BinaryPrimitives.WriteUInt32BigEndian(descriptor.AsSpan(0x34, 4), pkg.Header.content_type);
        return ProsperoImageDigests.ComputeContentDigest(
            descriptor, includeGame ? game : default, new byte[ProsperoImageDigests.DigestSize], includeGame);
    }

    private static void CalcBodyDigests(Pkg pkg, Stream s)
    {
        // All CNT body digests are SHA3-256 on PS5 (the per-entry table, body-digest, digest-table hash and
        // the two sc-entry rollups). This is the same primitive the digest layer above uses.
        var digests = pkg.Digests;
        var digestsOffset = pkg.Metas.Metas.First(m => m.id == EntryId.DIGESTS).DataOffset;
        for (int i = 1; i < pkg.Metas.Metas.Count; i++)
        {
            var meta = pkg.Metas.Metas[i];
            long digestSize = meta.Encrypted
                ? checked((long)((meta.DataSize + 15u) & ~15u))
                : meta.DataSize;
            var hash = Crypto.Sha3_256(s, meta.DataOffset, digestSize);
            Buffer.BlockCopy(hash, 0, digests.FileData, 32 * i, 32);
            s.Position = digestsOffset + 32 * i;
            s.Write(hash, 0, 32);
        }

        pkg.Header.body_digest = Crypto.Sha3_256(s, (long)pkg.Header.body_offset, (long)pkg.Header.body_size);
        pkg.Header.digest_table_hash = Crypto.Sha3_256(pkg.Digests.FileData);

        using var ms = new MemoryStream();
        // These header digests use the canonical SC semantic order, not the serialized
        // entry-table order. The latter starts with DIGESTS, so Take(sc_entry_count - 1)
        // silently produced a different preimage once sc2 began enforcing this field.
        var scEntries = new List<Entry> { pkg.EntryKeys };
        if (pkg.ImageKey is not null)
            scEntries.Add(pkg.ImageKey);
        scEntries.Add(pkg.GeneralDigests);
        scEntries.Add(pkg.Metas);
        scEntries.Add(pkg.Digests);
        foreach (Entry entry in scEntries)
            new SubStream(s, entry.meta.DataOffset, entry.meta.DataSize).CopyTo(ms);
        pkg.Header.sc_entries1_hash = Crypto.Sha3_256(ms);

        ms.SetLength(0);
        foreach (Entry entry in scEntries.Take(scEntries.Count - 1))
        {
            long size = entry.Id == EntryId.METAS ? pkg.Header.sc_entry_count * 0x20 : entry.meta.DataSize;
            new SubStream(s, entry.meta.DataOffset, size).CopyTo(ms);
        }
        pkg.Header.sc_entries2_hash = Crypto.Sha3_256(ms);
    }

    private static byte[] ReadParamJson(string sourceFolder)
    {
        string? path = ResolveSourceFile(sourceFolder, "sce_sys/param.json");
        if (path is null)
            throw new FileNotFoundException(
                "sce_sys/param.json is required to build a PS5 package (either as a loose file or a GP5 mapping).");
        return File.ReadAllBytes(path);
    }

    private static byte[] BuildPublisherParamJson(
        string sourceFolder,
        ProsperoPkgBuildProperties props)
    {
        byte[] source = ReadParamJson(sourceFolder);
        JsonNode? parsed;
        try
        {
            parsed = JsonNode.Parse(source);
        }
        catch (JsonException ex)
        {
            throw new InvalidDataException("sce_sys/param.json is not valid JSON.", ex);
        }

        if (parsed is not JsonObject root)
            throw new InvalidDataException("sce_sys/param.json must contain a JSON object.");

        if (props.VolumeType != ProsperoVolumeType.AdditionalContentNoData)
        {
            string versionFileUri = root["versionFileUri"]?.GetValue<string>() ?? string.Empty;
            if (versionFileUri.Length > 255)
                throw new InvalidDataException(
                    $"param.json versionFileUri is {versionFileUri.Length} characters; the publisher field is limited to 255.");
            root["versionFileUri"] = versionFileUri.PadRight(255, ' ');
        }

        DateTime timestampUtc = props.TimeStamp.Kind switch
        {
            DateTimeKind.Utc => props.TimeStamp,
            DateTimeKind.Local => props.TimeStamp.ToUniversalTime(),
            _ => DateTime.SpecifyKind(props.TimeStamp, DateTimeKind.Utc),
        };
        JsonNode? measuredSnd0Loudness =
            (root["pubtools"] as JsonObject)?["loudnessSnd0"]?.DeepClone();
        var pubtools = new JsonObject
        {
            ["creationDate"] = timestampUtc.ToString(
                "yyyy-MM-dd HH:mm:ss",
                System.Globalization.CultureInfo.InvariantCulture),
            ["toolVersion"] = "2.79",
        };
        // The value is the producer's actual audio measurement. Preserve it when rebuilding an
        // extracted project; never invent a generic value for a different snd0.at9.
        if (measuredSnd0Loudness is not null)
            pubtools["loudnessSnd0"] = measuredSnd0Loudness;
        root["pubtools"] = pubtools;

        if (props.VolumeType == ProsperoVolumeType.AdditionalContentNoData)
        {
            // Publishing Tools reject these data/application-only properties in a PSAL param.
            root.Remove("applicationCategoryType");
            root.Remove("contentVersion");
            root.Remove("versionFileUri");
            root["conceptId"] ??= "10000000";
            root["requiredSystemSoftwareVersion"] ??= "0x0500000000000000";
            ((JsonObject)root["pubtools"]!)["submission"] = true;
        }
        else if (props.VolumeType == ProsperoVolumeType.Application)
        {
            // Native img_create stamps the executable's .sceversion SDK into param.json and raises
            // the required-system floor to the same value. The bundled debug profile falls back to
            // 4.51 only for stripped ELF inputs that carry no version trailer. Leaving sdkVersion
            // at zero makes img_verify reject an otherwise mountable package.
            const ulong FallbackPublisherSdkVersion = 0x0451000000000000;
            static ulong HexVersion(JsonNode? value)
            {
                string? text = value?.GetValue<string>();
                return text is not null &&
                       text.StartsWith("0x", StringComparison.OrdinalIgnoreCase) &&
                       ulong.TryParse(
                           text.AsSpan(2),
                           System.Globalization.NumberStyles.AllowHexSpecifier,
                           System.Globalization.CultureInfo.InvariantCulture,
                           out ulong parsed)
                    ? parsed
                    : 0;
            }
            static string VersionText(ulong value) =>
                $"0x{value:X16}".ToLowerInvariant();

            ulong executableSdkVersion = 0;
            bool hasExecutableSdkVersion = false;
            bool executableIsLooseElf = false;
            string? executablePath = ResolveSourceFile(sourceFolder, "eboot.bin");
            if (executablePath is not null)
            {
                byte[] executable = File.ReadAllBytes(executablePath);
                executableIsLooseElf = ProsperoFself.IsElf(executable);
                hasExecutableSdkVersion = ProsperoFself.TryGetSdkVersion(
                    executable, out executableSdkVersion);
            }
            // A loose stripped ELF needs the compatibility fallback because img_create will turn it
            // into an FSELF. An existing SELF with a valid all-zero trailer is different: publisher
            // preserves sdkVersion=0 instead of inventing 4.51.
            if (!hasExecutableSdkVersion && executableIsLooseElf)
                executableSdkVersion = FallbackPublisherSdkVersion;

            // Publisher treats the executable, not a stale extracted param.json value, as the SDK
            // authority. Publishing Tools 2.79 also normalizes a future required-system value to the
            // newest version understood by that producer (9.00 in the observed corpus).
            ulong sdkVersion = executableSdkVersion;
            root["sdkVersion"] = VersionText(sdkVersion);
            const ulong Publisher279RequiredSystemCeiling = 0x0900000000000000;
            ulong requiredSystemVersion = Math.Max(
                Math.Min(
                    HexVersion(root["requiredSystemSoftwareVersion"]),
                    Publisher279RequiredSystemCeiling),
                sdkVersion);
            root["requiredSystemSoftwareVersion"] =
                VersionText(requiredSystemVersion);

            // These fields are mandatory in the 2.79 application schema even when their neutral
            // values were omitted by an older SDK sample.  img_create supplies the same defaults
            // while canonicalizing param.json.
            root["applicationDrmType"] ??= "standard";
            root["attribute"] ??= 0;
            root["attribute2"] ??= 0;
            root["attribute3"] ??= 0;
            root["conceptId"] ??= "10000000";
            root["masterVersion"] ??= "01.00";
            root["contentVersion"] ??= "01.000.000";
            root["ageLevel"] ??= new JsonObject
            {
                ["JP"] = 0,
                ["US"] = 0,
                ["default"] = 0,
            };
            root["contentBadgeType"] ??= 1;
            // Extracted update params may carry install-time origin/target markers and concrete
            // sharing service ids. img_create consumes those inputs but does not copy them into the
            // canonical CNT param entry.
            root.Remove("originContentVersion");
            root.Remove("targetContentVersion");
            root["addcont"] = new JsonObject
            {
                ["serviceIdForSharing"] = new JsonArray(
                    Enumerable.Range(0, 7)
                        .Select(_ => (JsonNode?)JsonValue.Create(new string(' ', 19)))
                        .ToArray()),
            };
        }

        JsonNode canonical = SortJsonNode(root)!;
        string json = canonical.ToJsonString(new JsonSerializerOptions
        {
            WriteIndented = true,
            Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        });
        // prospero-pub-cmd writes CRLF and a final line terminator regardless of the source JSON.
        json = json.Replace("\r\n", "\n", StringComparison.Ordinal)
            .Replace("\n", "\r\n", StringComparison.Ordinal) + "\r\n";
        return new UTF8Encoding(false).GetBytes(json);
    }

    private static JsonNode? SortJsonNode(JsonNode? node)
    {
        if (node is JsonObject obj)
        {
            var sorted = new JsonObject();
            foreach (KeyValuePair<string, JsonNode?> property in
                     obj.OrderBy(p => p.Key, StringComparer.Ordinal))
            {
                sorted[property.Key] = SortJsonNode(property.Value);
            }
            return sorted;
        }

        if (node is JsonArray array)
        {
            var sorted = new JsonArray();
            foreach (JsonNode? item in array)
                sorted.Add(SortJsonNode(item));
            return sorted;
        }

        return node?.DeepClone();
    }

    /// <summary>
    /// Resolves a package-relative source path. When a GP5 exists it is the authoritative manifest,
    /// matching <see cref="BuildInnerTree"/>; otherwise the loose source tree is used.
    /// </summary>
    internal static string? ResolveSourceFile(string sourceFolder, string packagePath)
    {
        string normalized = packagePath.Replace('\\', '/').Trim('/');
        string? project = Directory.EnumerateFiles(sourceFolder, "*.gp5", SearchOption.TopDirectoryOnly)
            .OrderBy(path => Path.GetFileName(path), StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();
        if (project is null)
        {
            string loose = Path.Combine(
                sourceFolder, normalized.Replace('/', Path.DirectorySeparatorChar));
            return File.Exists(loose) ? Path.GetFullPath(loose) : null;
        }

        Gp5Project manifest = Gp5Project.ReadFrom(project);
        string projectDirectory = Path.GetDirectoryName(project)!;
        if (manifest.Layout == Gp5Layout.Normal)
        {
            string rootSource = ResolveGp5SourcePath(
                projectDirectory,
                manifest.RootDir.SourcePath,
                projectDirectory);
            string candidate = Path.Combine(
                rootSource,
                normalized.Replace('/', Path.DirectorySeparatorChar));
            return File.Exists(candidate) ? Path.GetFullPath(candidate) : null;
        }

        string? resolved = null;
        foreach (Gp5File file in manifest.Files)
        {
            string destination = file.DestinationPath;
            if (string.IsNullOrWhiteSpace(destination)
                || !string.Equals(
                    destination.Replace('\\', '/').Trim('/'),
                    normalized,
                    StringComparison.OrdinalIgnoreCase))
            {
                continue;
            }

            string candidate = ResolveGp5SourcePath(
                projectDirectory,
                file.SourcePath,
                Path.Combine(
                    projectDirectory,
                    destination.Replace('/', Path.DirectorySeparatorChar)));
            if (!File.Exists(candidate))
                throw new FileNotFoundException(
                    $"GP5 source file was not found for '{destination}'.", candidate);
            if (resolved is not null)
                throw new InvalidDataException($"GP5 contains duplicate destination '{normalized}'.");
            resolved = candidate;
        }
        return resolved;
    }

    private static IReadOnlyDictionary<string, string> ResolveSceSysFiles(string sourceFolder)
    {
        var result = new SortedDictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        string? project = Directory.EnumerateFiles(sourceFolder, "*.gp5", SearchOption.TopDirectoryOnly)
            .OrderBy(path => Path.GetFileName(path), StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();
        if (project is null)
        {
            string sceSys = Path.Combine(sourceFolder, "sce_sys");
            if (!Directory.Exists(sceSys))
                return result;
            foreach (string file in Directory.EnumerateFiles(sceSys, "*", SearchOption.AllDirectories))
            {
                string relative = Path.GetRelativePath(sceSys, file).Replace('\\', '/');
                result.Add(relative, Path.GetFullPath(file));
            }
            return result;
        }

        Gp5Project manifest = Gp5Project.ReadFrom(project);
        string projectDirectory = Path.GetDirectoryName(project)!;
        if (manifest.Layout == Gp5Layout.Normal)
        {
            string rootSource = ResolveGp5SourcePath(
                projectDirectory,
                manifest.RootDir.SourcePath,
                projectDirectory);
            string sceSys = Path.Combine(rootSource, "sce_sys");
            string[] dirExcludes = ParseGp5ExcludeMasks(manifest.RootDir.DirExclude);
            string[] fileExcludes = ParseGp5ExcludeMasks(manifest.RootDir.FileExclude);
            string[] globalExcludes = ParseGp5ExcludeMasks(manifest.GlobalExclude);
            if (Directory.Exists(sceSys))
            {
                foreach (string file in Directory.EnumerateFiles(
                             sceSys, "*", SearchOption.AllDirectories))
                {
                    string rootRelative = Path.GetRelativePath(rootSource, file)
                        .Replace('\\', '/');
                    string fileName = Path.GetFileName(file);
                    if (MatchesGp5Exclude(fileName, rootRelative, fileExcludes) ||
                        MatchesGp5Exclude(fileName, rootRelative, globalExcludes) ||
                        IsInGp5ExcludedDirectory(
                            rootRelative, dirExcludes, globalExcludes))
                    {
                        continue;
                    }
                    string relative = Path.GetRelativePath(sceSys, file).Replace('\\', '/');
                    result[relative] = Path.GetFullPath(file);
                }
            }
        }
        else
        {
            foreach (Gp5File file in manifest.Files)
            {
                string destination = file.DestinationPath;
                if (string.IsNullOrWhiteSpace(destination))
                    continue;
                string normalized = destination.Replace('\\', '/').Trim('/');
                if (!normalized.StartsWith("sce_sys/", StringComparison.OrdinalIgnoreCase))
                    continue;
                string relative = normalized["sce_sys/".Length..];
                string candidate = ResolveGp5SourcePath(
                    projectDirectory,
                    file.SourcePath,
                    Path.Combine(
                        projectDirectory,
                        normalized.Replace('/', Path.DirectorySeparatorChar)));
                if (!File.Exists(candidate))
                    throw new FileNotFoundException(
                        $"GP5 source file was not found for '{destination}'.", candidate);
                if (!result.TryAdd(relative, candidate))
                    throw new InvalidDataException($"GP5 contains duplicate destination '{normalized}'.");
            }
        }

        // Publishing Tools obtain AC/AL licenses from their backend rather than ordinary GP5 file
        // mappings. For an offline rebuild the caller supplies already-issued plaintext sidecars
        // beside the project; include them even though the GP5 remains authoritative for payload.
        string looseSceSys = Path.Combine(sourceFolder, "sce_sys");
        foreach (string sidecar in new[] { "license.dat", "license.info" })
        {
            string candidate = Path.Combine(looseSceSys, sidecar);
            if (!result.ContainsKey(sidecar) && File.Exists(candidate))
                result.Add(sidecar, Path.GetFullPath(candidate));
        }
        return result;
    }

    private static string[] ParseGp5ExcludeMasks(string? value) =>
        string.IsNullOrWhiteSpace(value)
            ? Array.Empty<string>()
            : value.Split(
                [';', ','],
                StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries);

    private static bool MatchesGp5Exclude(
        string name,
        string relativePath,
        IReadOnlyList<string> masks)
    {
        string normalized = relativePath.Replace('\\', '/');
        return masks.Any(mask =>
            FileSystemName.MatchesSimpleExpression(mask, name, ignoreCase: true) ||
            FileSystemName.MatchesSimpleExpression(
                mask.Replace('\\', '/'), normalized, ignoreCase: true));
    }

    private static bool IsInGp5ExcludedDirectory(
        string fileRelativePath,
        IReadOnlyList<string> dirMasks,
        IReadOnlyList<string> globalMasks)
    {
        string[] parts = fileRelativePath.Replace('\\', '/')
            .Split('/', StringSplitOptions.RemoveEmptyEntries);
        string relative = "";
        for (int i = 0; i < parts.Length - 1; i++)
        {
            relative = relative.Length == 0 ? parts[i] : relative + "/" + parts[i];
            if (MatchesGp5Exclude(parts[i], relative, dirMasks) ||
                MatchesGp5Exclude(parts[i], relative, globalMasks))
            {
                return true;
            }
        }
        return false;
    }

    private static byte[]? ResolveGp5EntitlementKey(string sourceFolder)
    {
        string? project = Directory.EnumerateFiles(sourceFolder, "*.gp5", SearchOption.TopDirectoryOnly)
            .OrderBy(path => Path.GetFileName(path), StringComparer.OrdinalIgnoreCase)
            .FirstOrDefault();
        if (project is null)
            return null;

        Gp5Project manifest = Gp5Project.ReadFrom(project);
        string? value = manifest.Volume.Package.EntitlementKey;
        if (string.IsNullOrWhiteSpace(value))
            return null;
        byte[] key;
        try
        {
            key = Convert.FromHexString(value);
        }
        catch (FormatException ex)
        {
            throw new InvalidDataException(
                "GP5 package entitlement_key must contain hexadecimal bytes.", ex);
        }
        if (key.Length != 16)
            throw new InvalidDataException(
                $"GP5 package entitlement_key must be 16 bytes (got {key.Length}).");
        return key;
    }

    private static string ResolveGp5SourcePath(
        string projectDirectory,
        string? source,
        string fallback)
    {
        string value = string.IsNullOrWhiteSpace(source) ? fallback : source;
        value = Environment.ExpandEnvironmentVariables(value)
            .Replace('\\', Path.DirectorySeparatorChar);
        return Path.GetFullPath(Path.IsPathRooted(value)
            ? value
            : Path.Combine(projectDirectory, value));
    }

    private static byte[] DeriveDeterministicOuterSeed(string contentId, string passcode)
    {
        byte[] material = Encoding.ASCII.GetBytes(
            "LibProsperoPkg deterministic outer seed\0" + contentId + "\0" + passcode);
        return ProsperoImageDigests.Sha3_256(material).AsSpan(0, 16).ToArray();
    }

    // Known sce_sys media files and their PS5 entry ids (the inspection-relevant subset).
    private static readonly (string Name, uint Id)[] MediaFiles =
    [
        ("icon0.png", 0x1200),
        ("pic0.png", 0x1220),
        ("pic1.png", 0x1006),
        ("pic2.png", 0x2040),
        ("snd0.at9", 0x1240),
        ("save_data.png", 0x100D),
    ];

    // sce_sys images that are re-encoded as a same-named *.dds (BC7) sibling,
    // with the PS5 entry id of the generated *.dds. Decoded from reference
    // packages: icon0.png->icon0.dds (0x1280), pic0.png->pic0.dds (0x12A0), pic1.png->pic1.dds
    // (0x12C0), pic2.png->pic2.dds (0x2060).
    private static readonly (string Png, string Dds, uint Id)[] DdsMedia =
    [
        ("icon0.png", "icon0.dds", 0x1280),
        ("pic0.png", "pic0.dds", 0x12A0),
        ("pic1.png", "pic1.dds", 0x12C0),
        ("pic2.png", "pic2.dds", 0x2060),
    ];

    // Entry ids that are produced by dedicated builders and must not be re-emitted from a
    // supplied sce_sys file: param.sfo (PS4, unused on PS5) and PlayGo metadata, whose ranges
    // must describe the newly packed image rather than the source dump's previous geometry.
    private static readonly HashSet<uint> GeneratedEntryIds = [0x1000, 0x1001, 0x2010, 0x2011, 0x3000];

    private static IEnumerable<Entry> CollectMediaEntries(
        string sourceFolder, ProsperoVolumeType volumeType, string contentId,
        IProsperoLicenseProvider? licenseProvider, bool generateDds = true)
    {
        IReadOnlyDictionary<string, string> sceSysFiles = ResolveSceSysFiles(sourceFolder);
        byte[]? entitlementKey = IsAdditionalContent(volumeType)
            ? ResolveGp5EntitlementKey(sourceFolder)
            : null;
        ProsperoLicenseArtifacts? providedLicense = null;
        if (licenseProvider is not null)
        {
            var request = new ProsperoLicenseRequest
            {
                VolumeType = volumeType,
                ContentId = contentId,
                EntitlementKey = entitlementKey,
            };
            providedLicense = licenseProvider.GetLicense(request)
                ?? throw new InvalidDataException("The license provider returned no artifacts.");
            providedLicense.Validate(request);
        }
        if (IsAdditionalContent(volumeType) && providedLicense is null)
        {
            foreach (string required in new[] { "license.dat", "license.info" })
            {
                if (!sceSysFiles.ContainsKey(required))
                    throw new FileNotFoundException(
                        $"{volumeType} requires an existing backend-issued sce_sys/{required}. " +
                        "Place the decrypted sidecar beside the GP5/source tree; LibProsperoPkg " +
                        "can validate and re-encrypt it but cannot issue a new backend license.");
            }
        }
        var emitted = new HashSet<uint>();

        if (providedLicense is not null)
        {
            emitted.Add((uint)EntryId.LICENSE_DAT);
            yield return new GenericEntry(EntryId.LICENSE_DAT)
            {
                FileData = providedLicense.LicenseDat.ToArray(),
            };
            emitted.Add((uint)EntryId.LICENSE_INFO);
            yield return new GenericEntry(EntryId.LICENSE_INFO)
            {
                FileData = providedLicense.LicenseInfo.ToArray(),
            };
        }

        foreach (var (name, id) in MediaFiles)
        {
            if (!sceSysFiles.TryGetValue(name, out string? path)) continue;
            emitted.Add(id);
            var data = File.ReadAllBytes(path);
            yield return new GenericEntry((EntryId)id, name) { FileData = data };
        }

        // DDS re-encodes of the icon/pic images: use an on-disk *.dds if the caller already supplied
        // one (e.g. extracted from a package); otherwise generate it from the *.png.
        foreach (var (png, dds, id) in generateDds ? DdsMedia : [])
        {
            byte[]? data = null;
            if (sceSysFiles.TryGetValue(dds, out string? ddsPath))
            {
                data = File.ReadAllBytes(ddsPath);
            }
            else
            {
                if (!sceSysFiles.TryGetValue(png, out string? pngPath)) continue;
                try
                {
                    data = ProsperoDdsEncoder.EncodePngToDds(File.ReadAllBytes(pngPath));
                }
                catch
                {
                    // Not a decodable image (e.g. a placeholder input); skip the DDS sibling.
                    continue;
                }
            }
            emitted.Add(id);
            yield return new GenericEntry((EntryId)id, dds) { FileData = data };
        }

        // System files: every remaining supplied sce_sys file whose relative path maps to a known
        // CNT id becomes an outer CNT entry. The inner-PFS builder deliberately keeps these named
        // system files out of the inner image (PFSBuilder skips known-id sce_sys files), so they
        // must be carried in the outer container instead. Covers the backend-authored license,
        // network-platform, self-info, delta-info, keymap_rp, changeinfo, pronunciation and trophy
        // files. These blobs are packed as supplied; the library never fabricates them.
        foreach ((string rel, string file) in sceSysFiles)
        {
            if (!EntryNames.NameToId.TryGetValue(rel, out var id)) continue;
            var idv = (uint)id;
            if (rel.EndsWith(".dds", StringComparison.Ordinal)) continue; // handled by the DDS pass
            if (GeneratedEntryIds.Contains(idv)) continue;
            if (!emitted.Add(idv)) continue; // already emitted above
            var data = File.ReadAllBytes(file);
            string? error;
            bool valid = rel switch
            {
                "license.dat" => ProsperoSystemFiles.ValidateLicenseDat(
                    data, contentId, out error),
                "license.info" => ProsperoSystemFiles.ValidateLicenseInfo(
                    data, contentId, entitlementKey, out error),
                _ => ProsperoSystemFiles.Validate(rel, data, out error),
            };
            if (!valid)
                throw new InvalidDataException($"sce_sys/{rel}: {error}");
            // Publisher AC license records are identified exclusively by id. Reference packages
            // keep NameTableOffset at zero for 0x0400/0x0401; adding their friendly names grows
            // ENTRY_NAMES by 0x19 bytes and shifts the semantic CNT body layout.
            ProsperoCntEntryProfile profile = ProsperoCntEntryPolicy.Resolve(
                idv, volumeType, rel);
            string? entryName = profile.IncludeName ? rel : null;
            yield return new GenericEntry(id, entryName) { FileData = data };
        }
    }

    private static ulong Align(ulong value, ulong align)
    {
        var rem = value % align;
        return rem == 0 ? value : value + (align - rem);
    }

    private static long ToUnixSeconds(DateTime time) =>
        (long)time.ToUniversalTime().Subtract(DateTime.UnixEpoch).TotalSeconds;
}
