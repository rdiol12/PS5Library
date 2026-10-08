// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// Producer for the trailing SI (install-metadata) segment of a finalized image, in the
// DEBUG variant (FIH signed byte 0x00).
//
// Validated legacy/alternate debug SI format. Decoded byte-for-byte from
// TestFiles/PS5/PKG/Debug/Downloads.pkg (cross-checked against InternetBrowser.pkg and
// DebugSettings.pkg): the SI segment is a plain ZIP (PK\x03\x04, every member STORED /
// uncompressed). Publishing Tools 2.79 APP/AC nwonly uses the same core member set but omits
// pfsimage.xml:
//
// common/etc/naps_meta_18.dat 3440 B (per-package metric blob)
// common/etc/naps_meta_300/301/302/308.dat 72 B each, byte-identical
// common/etc/pfsimage.xml optional rich package-configuration descriptor
// common/etc/playgo-chunk.dat 416 B copied from the inner PFS
// config/<content-id>/playgo-chunk.crc 68 B
// config/<content-id>/playgo-scenario.json 370 B copied byte-identically from the CNT
//
// Records and external inputs:
// * ZIP container framing, STORED entries and the exact member paths -> reproduced.
// * pfsimage.xml structure (the reference <package-configuration type="package-info"> tree with the
// "0xNN 0xNN" digest formatting, <config>/<digests>/<params>/<container>/<mount-image>) ->
// reproduced from values the caller/builder already knows.
// * playgo-chunk.dat -> reproduced (it is copied verbatim from the inner PFS the builder makes).
// * naps_meta_300/301/302/308.dat -> reproduced byte-exact by ProsperoNapsMeta.BuildMeta300 (a
// plaintext 72-byte descriptor derived from the inner-image geometry; validated against the SDK output
// debug packages).
// * Every pfsimage.xml digest is reproducible and is supplied by the high-level builder:
// game-digest (== inner sblock-digest, SHA3-256 of the plaintext outer superblock), param-digest
// (SHA3-256 of the param.json CNT entry), body-digest, fixed-info-digest, package-digest
// (== SHA3-256(CNT[0:0xFE0]), ProsperoImageDigests.ComputePackageDigest, identical to the value the
// produced CNT stores at +0xFE0), and the full GeneralDigests set — content-digest, header-digest,
// system-digest, playgo-digest and the target slot (all SHA3-256 of plaintext CNT regions / per-entry
// digests, ProsperoPkgBuilder.ComputeGeneralDigests, Validated byte-exact against the reference debug
// packages). Direct low-level callers can pass these through ProsperoPfsImageXmlOptions; omission
// produces explicit warnings and zero placeholders.
// * naps_meta_18.dat is generated as the SDK plaintext TLV stream from the built image geometry.
// playgo-chunk.crc is generated from the finalized mount image.
// Publisher-authored values may still be supplied as byte-exact overrides.
// See LibProsperoPKG/docs/implementation-status.md.

using LibProsperoPkg.PFS;
using LibProsperoPkg.PlayGo;
using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Text;

namespace LibProsperoPkg.PKG;

/// <summary>A single member (one stored file) of the SI ZIP.</summary>
/// <param name="Path">ZIP entry path with forward slashes, e.g. <c>common/etc/pfsimage.xml</c>.</param>
/// <param name="Content">Raw, already-final bytes of the member.</param>
public readonly record struct ProsperoSiMember(string Path, byte[] Content);

/// <summary>
/// One <c>&lt;entry&gt;</c> of the <c>pfsimage.xml</c> <c>&lt;entries&gt;</c> table: a single CNT
/// (sce_sys) file with its byte offset and size inside the finalized container body. These values
/// are known to the builder once it has laid out the inner image, so the table is fully
/// reproducible. The high-level package builder also derives the digest values from the completed
/// CNT/FIH; only direct low-level XML construction may need them supplied explicitly.
/// </summary>
/// <param name="Name">CNT entry name, e.g. <c>imagedigs.dat</c>.</param>
/// <param name="Offset">Byte offset of the entry inside the container body.</param>
/// <param name="Size">Entry size in bytes.</param>
public readonly record struct ProsperoPfsImageEntry(string Name, long Offset, long Size);

/// <summary>
/// Self-consistent inputs for the <c>pfsimage.xml</c> <c>&lt;chunkinfo&gt;</c> section, which
/// describes the PlayGo chunk layout of this package (single scenario / single chunk for an
/// <c>nwonly</c> debug package). All sizes are derived from the finalized image geometry the builder
/// already knows.
/// </summary>
public sealed class ProsperoChunkInfoModel
{
    /// <summary>Size in bytes of the copied <c>playgo-chunk.dat</c> (the <c>size</c> attribute).</summary>
    public int PlayGoChunkDatSize { get; set; }

    /// <summary>SDK version stamp (the <c>sdk</c> attribute), 32-bit hex e.g. <c>0x00000000</c>.</summary>
    public string Sdk { get; set; } = "0x00000000";

    /// <summary>Display flags (the <c>disps</c> attribute); <c>0x0011</c> for a single-chunk nwonly image.</summary>
    public string Disps { get; set; } = "0x0011";

    /// <summary>Language mask (the <c>languages</c> value); all-ones for an nwonly image.</summary>
    public ulong LanguageMask { get; set; } = 0xffffffffffffffff;

    /// <summary>Total mount-image size in bytes (scenario/chunk <c>total</c>) = pfs-image-offset + pfs-image-size.</summary>
    public long TotalSize { get; set; }

    /// <summary>Size in bytes of outer #0 (the block-aligned stored inner image).</summary>
    public long Outer0Size { get; set; }

    /// <summary>Size in bytes of outer #1 (<see cref="TotalSize"/> − <see cref="Outer0Size"/>).</summary>
    public long Outer1Size { get; set; }
}

/// <summary>
/// Inputs for <c>common/etc/pfsimage.xml</c>. The high-level package builder fills every value,
/// including the digest rows, from the completed CNT, FIH and PFS image. The digest properties remain
/// optional for callers that use this low-level model directly; a missing value is emitted as an
/// all-zero placeholder and reported through the warning collection.
/// </summary>
public sealed class ProsperoPfsImageXmlOptions
{
    /// <summary>Content id, e.g. <c>IV9999-NPXS41139_00-XXXXXXXXXXXXXXXX</c>.</summary>
    public string ContentId { get; set; } = "";

    /// <summary>
    /// Primary package id. Defaults to <see cref="ContentId"/>.
    /// </summary>
    public string? PrimaryId { get; set; }

    /// <summary>Human-readable title (<c>&lt;titleName&gt;</c> / <c>&lt;chunkinfo&gt;</c>).</summary>
    public string TitleName { get; set; } = "";

    /// <summary>Content version, e.g. <c>01.001.000</c>.</summary>
    public string ContentVersion { get; set; } = "01.000.000";

    /// <summary>DRM type (<c>&lt;drm-type&gt;</c>), e.g. <c>none</c> for debug packages.</summary>
    public string DrmType { get; set; } = "none";

    /// <summary>
    /// Application DRM type (<c>&lt;applicationDrmType&gt;</c> param). This is distinct from the
    /// config <see cref="DrmType"/>: ground-truth debug packages carry <c>none</c> for
    /// <c>drm-type</c> but <c>free</c> here. When <see langword="null"/> it falls back to
    /// <see cref="ApplicationType"/> (so it mirrors <c>application-type</c> by default).
    /// </summary>
    public string? ApplicationDrmType { get; set; }

    /// <summary>Content type (<c>&lt;content-type&gt;</c>), e.g. <c>PS5GD</c>.</summary>
    public string ContentType { get; set; } = "PS5GD";

    /// <summary>Application type (<c>&lt;application-type&gt;</c>), e.g. <c>free</c>.</summary>
    public string ApplicationType { get; set; } = "free";

    /// <summary>Total finalized package size in bytes (<c>&lt;package-size&gt;</c>).</summary>
    public long PackageSize { get; set; }

    /// <summary>Shared PFS image offset (always <c>0x10000</c> in a finalized image).</summary>
    public long PfsImageOffset { get; set; } = 0x10000;

    /// <summary>Shared PFS image size in bytes.</summary>
    public long PfsImageSize { get; set; }

    internal byte[]? PfsBlockCrc32C { get; set; }

    /// <summary>Inner-PFS superblock seed (16 bytes), stamped into the encrypted image header.</summary>
    public byte[]? PfsImageSeed { get; set; }

    // ---- Reproducible structural fields (builder-known; emitted verbatim). ----

    /// <summary>Master version (<c>&lt;masterVersion&gt;</c> and the longname <c>M</c> field).</summary>
    public string MasterVersion { get; set; } = "01.00";

    /// <summary>
    /// Explicit <c>&lt;longname&gt;</c> override. When <see langword="null"/> the value is derived as
    /// <c>{content-id}-C{version-digits}-M{master-16-hex}-{type-code}</c>.
    /// </summary>
    public string? LongName { get; set; }

    /// <summary>64-bit master value used for the <c>M</c> field of the derived longname (default 0).</summary>
    public ulong LongNameMasterValue { get; set; }

    /// <summary>Minimum required system version (<c>&lt;required-system-version&gt;</c>).</summary>
    public string RequiredSystemVersion { get; set; } = "00.000.000.00000000";

    /// <summary><c>&lt;requiredSystemSoftwareVersion&gt;</c> param (64-bit hex).</summary>
    public string RequiredSystemSoftwareVersion { get; set; } = "0x0000000000000000";

    /// <summary><c>&lt;sdkVersion&gt;</c> param (64-bit hex).</summary>
    public string SdkVersion { get; set; } = "0x0000000000000000";

    /// <summary>
    /// Toolchain <c>&lt;version-date&gt;</c> stamp. Defaults to the validated
    /// reference build constant <c>0x20200722</c>.
    /// </summary>
    public uint VersionDate { get; set; } = 0x20200722;

    /// <summary>
    /// Toolchain <c>&lt;version-hash&gt;</c> stamp. Defaults to the validated
    /// reference build constant <c>0x01fe52e9</c>.
    /// </summary>
    public uint VersionHash { get; set; } = 0x01fe52e9;

    /// <summary>Finalized container size in bytes (<c>&lt;container-size&gt;</c> / <c>&lt;promote-size&gt;</c>). Default <c>0x50000</c>.</summary>
    public long ContainerSize { get; set; } = 0x50000;

    /// <summary>Container <c>&lt;mandatory-size&gt;</c> (sum of mandatory CNT entries). Package-specific.</summary>
    public long MandatorySize { get; set; }

    /// <summary>Container <c>&lt;body-offset&gt;</c> (CNT body start inside the container). Default <c>0x2000</c>.</summary>
    public long BodyOffset { get; set; } = 0x2000;

    /// <summary>Supplemental segment offset (<c>&lt;supplemental-offset&gt;</c>). Default <c>0x50000</c>.</summary>
    public long SupplementalOffset { get; set; } = 0x50000;

    /// <summary>
    /// The CNT (sce_sys) entry table for the <c>&lt;entries&gt;</c> section. When non-empty the table
    /// is emitted exactly as the tool does (<c>num</c> attribute plus one <c>&lt;entry&gt;</c> per file);
    /// when empty the section is omitted.
    /// </summary>
    public IReadOnlyList<ProsperoPfsImageEntry> Entries { get; set; } = [];

    // ---- Digest products: builder-derived, or supplied to the low-level XML API. ----

    /// <summary>32-byte container <c>&lt;body-digest&gt;</c>: SHA3-256 of the CNT body.</summary>
    public byte[]? BodyDigest { get; set; }

    /// <summary>32-byte CNT GeneralDigests <c>&lt;content-digest&gt;</c>.</summary>
    public byte[]? ContentDigest { get; set; }
    /// <summary>32-byte <c>&lt;game-digest&gt;</c>; equals the plaintext outer-superblock digest.</summary>
    public byte[]? GameDigest { get; set; }
    /// <summary>32-byte CNT GeneralDigests <c>&lt;header-digest&gt;</c>.</summary>
    public byte[]? HeaderDigest { get; set; }
    /// <summary>32-byte CNT GeneralDigests <c>&lt;system-digest&gt;</c>.</summary>
    public byte[]? SystemDigest { get; set; }
    /// <summary>32-byte SHA3-256 <c>&lt;param-digest&gt;</c> of the CNT param.json payload.</summary>
    public byte[]? ParamDigest { get; set; }
    /// <summary>
    /// 32-byte <c>&lt;package-digest&gt;</c>. Reproducible: equals
    /// <see cref="ProsperoImageDigests.ComputePackageDigest"/> (SHA3-256 of CNT[0:0xFE0]) and the value
    /// the produced CNT stores at +0xFE0. Pass it when the produced CNT bytes are available.
    /// </summary>
    public byte[]? PackageDigest { get; set; }
    /// <summary>32-byte inner <c>&lt;sblock-digest&gt;</c>; equals <see cref="GameDigest"/>.</summary>
    public byte[]? SblockDigest { get; set; }
    /// <summary>32-byte SHA3-256 <c>&lt;fixed-info-digest&gt;</c> of the completed FIH block.</summary>
    public byte[]? FixedInfoDigest { get; set; }

    // ---- Inode-tree introspection (self-consistent; describes the built image). ----

    /// <summary>
    /// Outer PFS image snapshot for the <c>&lt;pfs-image&gt;</c> section. When set, the section is
    /// emitted from our own built image's inode tree + superblock geometry; when <see langword="null"/>
    /// the section is omitted.
    /// </summary>
    public ProsperoPfsImageTreeInfo? OuterPfsTree { get; set; }

    /// <summary>
    /// Nested (inner) PFS image snapshot for the <c>&lt;nested-image&gt;</c> section. When set, the
    /// section is emitted from our own built inner image's inode tree; when <see langword="null"/>
    /// the section is omitted.
    /// </summary>
    public ProsperoPfsImageTreeInfo? NestedPfsTree { get; set; }

    /// <summary>
    /// PlayGo chunk layout for the <c>&lt;chunkinfo&gt;</c> section. When set, the section is emitted
    /// from our own package geometry; when <see langword="null"/> the section is omitted.
    /// </summary>
    public ProsperoChunkInfoModel? ChunkInfo { get; set; }
}

/// <summary>
/// Writes the <b>debug</b>-variant SI install-metadata segment as the reference ZIP container decoded
/// from the reference debug packages. The container, member paths, the <c>pfsimage.xml</c> structure
/// (reproduced byte-for-byte through its config/digests/params/container/mount-image/entries
/// sections) and
/// the copied <c>playgo-chunk.dat</c> are reproduced exactly; keyed members are supplied by the
/// caller and emitted verbatim - never fabricated. The retail-variant SI is console-encrypted and
/// is not handled (see the file header).
/// </summary>
public static class ProsperoSiArchive
{
    /// <summary>Canonical member paths.</summary>
    public const string PfsImageXmlPath = "common/etc/pfsimage.xml";
    /// <summary>Canonical member path for the copied PlayGo chunk descriptor.</summary>
    public const string PlayGoChunkDatPath = "common/etc/playgo-chunk.dat";
    /// <summary>Canonical member path for the 3440-byte metric blob.</summary>
    public const string NapsMeta18Path = "common/etc/naps_meta_18.dat";

    /// <summary>
    /// The four record ids whose files share one byte-identical 72-byte payload within a verified
    /// Publishing Tools 2.79 APP/AC <c>nwonly</c> package, in file order.
    /// </summary>
    public static ReadOnlySpan<int> NapsMeta300Ids => [300, 301, 302, 308];

    /// <summary>
    /// Builds the canonical debug SI member set. The reproducible <paramref name="pfsImageXml"/> is
    /// always written; <paramref name="playGoChunkDat"/> is copied from the inner PFS when present;
    /// the keyed blobs (<paramref name="napsMeta18"/>, <paramref name="napsMeta300"/>) are included
    /// only when supplied and are never fabricated. The per-content-id <c>playgo-chunk.crc</c> is
    /// either supplied verbatim via <paramref name="playGoChunkCrc"/> or, when
    /// <paramref name="finalizedMountImage"/> is given instead, computed reproducibly from it with
    /// CRC-32C (see <c>ProsperoPlayGo.BuildChunkCrc</c>). When PlayGo metadata is present, the same
    /// SDK scenario bytes used by the CNT are also written under the content-specific config path.
    /// </summary>
    public static IReadOnlyList<ProsperoSiMember> BuildMembers(
        string contentId,
        byte[]? pfsImageXml,
        byte[]? playGoChunkDat = null,
        byte[]? napsMeta18 = null,
        byte[]? napsMeta300 = null,
        byte[]? playGoChunkCrc = null,
        byte[]? finalizedMountImage = null)
    {
        ArgumentException.ThrowIfNullOrEmpty(contentId);

        // When the caller passes the finalized mount image but not an explicit CRC blob, compute
        // playgo-chunk.crc reproducibly (CRC-32C of each 64KiB block). An explicitly supplied blob
        // always wins so verbatim keyed/sample inputs are preserved.
        playGoChunkCrc ??= finalizedMountImage is { Length: > 0 }
            ? ProsperoPlayGo.BuildChunkCrc(finalizedMountImage)
            : null;

        var members = new List<ProsperoSiMember>();

        // The reference member order in Downloads.pkg is naps_meta_* first, then pfsimage.xml, then
        // playgo-chunk.dat, then the per-content-id playgo-chunk.crc and scenario metadata.
        if (napsMeta18 is not null)
            members.Add(new(NapsMeta18Path, napsMeta18));
        if (napsMeta300 is not null)
        {
            foreach (int id in NapsMeta300Ids)
                members.Add(new($"common/etc/naps_meta_{id}.dat", napsMeta300));
        }

        if (pfsImageXml is not null)
            members.Add(new(PfsImageXmlPath, pfsImageXml));

        if (playGoChunkDat is not null)
            members.Add(new(PlayGoChunkDatPath, playGoChunkDat));
        if (playGoChunkCrc is not null)
            members.Add(new($"config/{contentId}/playgo-chunk.crc", playGoChunkCrc));
        if (playGoChunkDat is not null)
            members.Add(new($"config/{contentId}/playgo-scenario.json", ProsperoPlayGo.BuildScenarioJson()));

        return members;
    }

    /// <summary>
    /// Builds the complete debug SI segment (the trailing <c>sce_suppl</c> ZIP) for a finalized nwonly
    /// image entirely from values the package build has already produced. This is the high-level entry
    /// point the package builder wires into <see cref="ProsperoFihBuilder.BuildFromCnt"/> through its
    /// <c>siArchiveFactory</c>: given the reproducible <paramref name="pfsImageXml"/> options and the
    /// finalized <paramref name="mountImage"/> (FIH + PFS + CNT) it derives every reproducible member and
    /// returns the raw ZIP bytes.
    /// <list type="bullet">
    ///   <item><c>common/etc/pfsimage.xml</c> from <paramref name="pfsImageXml"/> (real self-consistent
    ///   digests, entries and geometry).</item>
    ///   <item><c>common/etc/naps_meta_300/301/302/308.dat</c> derived byte-exact from the finalized-image
    ///   inner-image size at FIH offset <see cref="ProsperoPkgLayout.FihInnerImageSizeField"/> via
    ///   <see cref="ProsperoNapsMeta.BuildMeta300FromInnerImageSize"/>.</item>
    ///   <item><c>common/etc/playgo-chunk.dat</c> copied verbatim from <paramref name="playGoChunkDat"/>
    ///   (the CNT's PlayGo chunk descriptor) when present.</item>
    ///   <item><c>config/&lt;content-id&gt;/playgo-chunk.crc</c> computed by CRC-32C over the finalized
    ///   mount image.</item>
    ///   <item><c>config/&lt;content-id&gt;/playgo-scenario.json</c> copied byte-identically from the
    ///   generated CNT scenario metadata.</item>
    /// </list>
    /// A caller-supplied publisher <c>naps_meta_18.dat</c> can be preserved verbatim; when omitted,
    /// the reproducible serializer output is used where the selected profile supports it.
    /// </summary>
    /// <param name="pfsImageXml">Fully-populated reproducible pfsimage.xml options from the builder.</param>
    /// <param name="playGoChunkDat">CNT PlayGo chunk descriptor bytes (entry 0x1001), or null.</param>
    /// <param name="mountImage">The finalized FIH+PFS+CNT mount image.</param>
    /// <param name="innerImageSize">
    /// Block-aligned stored size of the inner <c>pfs_image.dat</c> (the FIH-0xA0 value), captured by the
    /// builder. When positive it drives the <c>naps_meta_300</c> record directly. When 0 (e.g. a standalone
    /// caller with only the finalized image) it falls back to reading FIH[0xA0] out of <paramref name="mountImage"/>,
    /// which is only populated for the reference data-first layout.
    /// </param>
    /// <param name="warnings">Optional sink for any all-zero-placeholder notices from the XML builder.</param>
    /// <param name="napsMeta18">Optional publisher-authored type-18 NAPS metric payload.</param>
    /// <param name="includePfsImageXml">Whether to include <c>common/etc/pfsimage.xml</c>.</param>
    /// <param name="contentFiles">Optional inner content-file list used by the metric serializers.</param>
    /// <param name="innerImage">Optional completed inner-image model used for exact geometry metadata.</param>
    /// <param name="integrityProvider">
    /// Optional override for <c>ihsh/rhsh</c> and provider for the AES-XTS-derived
    /// <c>obcc</c> table inside <c>naps_meta_18.dat</c>.
    /// </param>
    /// <param name="pfsImageKey">Optional raw 32-byte publisher PFS image key for exact obcc.</param>
    /// <param name="pfsImageSeed">Optional raw 16-byte publisher PFS image seed for exact obcc.</param>
    public static byte[] BuildDebugSiSegment(
        ProsperoPfsImageXmlOptions pfsImageXml, byte[]? playGoChunkDat, byte[] mountImage,
        long innerImageSize = 0, ICollection<string>? warnings = null,
        byte[]? napsMeta18 = null, bool includePfsImageXml = true,
        IReadOnlyList<(string Path, long Size)>? contentFiles = null,
        LibProsperoPkg.PFS.ProsperoPs5InnerImageResult? innerImage = null,
        IProsperoNapsIntegrityProvider? integrityProvider = null,
        byte[]? pfsImageKey = null,
        byte[]? pfsImageSeed = null)
    {
        ArgumentNullException.ThrowIfNull(pfsImageXml);
        ArgumentNullException.ThrowIfNull(mountImage);

        // naps_meta_300 R = InnerImageSize - 0x20000; the final field is the fixed 0x20000
        // publisher trailing extent.
        // Prefer the builder-captured InnerImageSize; when it is not supplied (standalone callers), read
        // FIH[0xA0] out of the mount image, which is only populated for the reference data-first layout.
        // Below that trailing extent the record cannot be derived, so it is simply omitted.
        byte[]? napsMeta300 = null;
        ulong innerSize = innerImageSize > 0 ? (ulong)innerImageSize : 0;
        if (innerSize == 0)
        {
            int sizeField = ProsperoPkgLayout.FihInnerImageSizeField;
            if (mountImage.Length >= sizeField + 8)
                innerSize = BinaryPrimitives.ReadUInt64LittleEndian(mountImage.AsSpan(sizeField, 8));
        }
        if (innerSize >= ProsperoNapsMeta.Meta300TrailingExtentSize)
            napsMeta300 = ProsperoNapsMeta.BuildMeta300FromInnerImageSize(innerSize);

        if (napsMeta18 is null && innerSize >= ProsperoNapsMeta.Meta300TrailingExtentSize)
        {
            byte[] generated = ProsperoNapsMeta.BuildMeta18(
                innerSize,
                mountImage,
                contentFiles ?? Array.Empty<(string Path, long Size)>(),
                innerImage,
                integrityProvider,
                pfsImageKey,
                pfsImageSeed);
            if (generated.Length != 0) napsMeta18 = generated;
        }

        byte[]? xmlBytes = includePfsImageXml
            ? Encoding.UTF8.GetBytes(BuildPfsImageXml(pfsImageXml, warnings))
            : null;

        IReadOnlyList<ProsperoSiMember> members = BuildMembers(
            pfsImageXml.ContentId,
            xmlBytes,
            playGoChunkDat: playGoChunkDat,
            napsMeta18: napsMeta18,           // preserve a supplied publisher metric blob verbatim.
            napsMeta300: napsMeta300,
            playGoChunkCrc: null,
            finalizedMountImage: mountImage); // computes playgo-chunk.crc reproducibly (CRC-32C).

        return WriteZip(members);
    }

    /// <summary>
    /// File-backed equivalent of <see cref="BuildDebugSiSegment(ProsperoPfsImageXmlOptions,byte[],byte[],long,ICollection{string},byte[],bool,IReadOnlyList{ValueTuple{string,long}},ProsperoPs5InnerImageResult,IProsperoNapsIntegrityProvider,byte[],byte[])"/>.
    /// The mount image is read block-by-block for <c>playgo-chunk.crc</c>; it is never copied into
    /// a single managed byte array.
    /// </summary>
    public static byte[] BuildDebugSiSegment(
        ProsperoPfsImageXmlOptions pfsImageXml, byte[]? playGoChunkDat, Stream mountImage,
        long innerImageSize = 0, ICollection<string>? warnings = null,
        byte[]? napsMeta18 = null, bool includePfsImageXml = true,
        IReadOnlyList<(string Path, long Size)>? contentFiles = null,
        LibProsperoPkg.PFS.ProsperoPs5InnerImageResult? innerImage = null,
        IProsperoNapsIntegrityProvider? integrityProvider = null,
        byte[]? pfsImageKey = null,
        byte[]? pfsImageSeed = null)
    {
        ArgumentNullException.ThrowIfNull(pfsImageXml);
        ArgumentNullException.ThrowIfNull(mountImage);
        if (!mountImage.CanRead || !mountImage.CanSeek)
            throw new ArgumentException(
                "Mount-image stream must be readable and seekable.", nameof(mountImage));

        ulong innerSize = innerImageSize > 0 ? (ulong)innerImageSize : 0;
        if (innerSize == 0 && mountImage.Length >= ProsperoPkgLayout.FihInnerImageSizeField + 8)
        {
            long position = mountImage.Position;
            try
            {
                Span<byte> sizeBytes = stackalloc byte[8];
                mountImage.Position = ProsperoPkgLayout.FihInnerImageSizeField;
                mountImage.ReadExactly(sizeBytes);
                innerSize = BinaryPrimitives.ReadUInt64LittleEndian(sizeBytes);
            }
            finally
            {
                mountImage.Position = position;
            }
        }

        byte[]? napsMeta300 = innerSize >= ProsperoNapsMeta.Meta300TrailingExtentSize
            ? ProsperoNapsMeta.BuildMeta300FromInnerImageSize(innerSize)
            : null;
        if (napsMeta18 is null &&
            innerSize >= ProsperoNapsMeta.Meta300TrailingExtentSize &&
            innerImage is not null)
        {
            byte[] generated = ProsperoNapsMeta.BuildMeta18(
                innerSize,
                mountImage.Length,
                contentFiles ?? Array.Empty<(string Path, long Size)>(),
                innerImage,
                integrityProvider,
                pfsImageKey,
                pfsImageSeed);
            if (generated.Length != 0) napsMeta18 = generated;
        }

        byte[]? xmlBytes = includePfsImageXml
            ? Encoding.UTF8.GetBytes(BuildPfsImageXml(pfsImageXml, warnings))
            : null;
        long originalPosition = mountImage.Position;
        byte[] playGoChunkCrc;
        try
        {
            mountImage.Position = 0;
            playGoChunkCrc = pfsImageXml.PfsBlockCrc32C is { Length: > 0 } pfsCrc
                ? ProsperoPlayGo.BuildChunkCrc(
                    mountImage, mountImage.Length, pfsImageXml.PfsImageOffset, pfsCrc)
                : ProsperoPlayGo.BuildChunkCrc(mountImage, mountImage.Length);
        }
        finally
        {
            mountImage.Position = originalPosition;
        }

        IReadOnlyList<ProsperoSiMember> members = BuildMembers(
            pfsImageXml.ContentId,
            xmlBytes,
            playGoChunkDat,
            napsMeta18,
            napsMeta300,
            playGoChunkCrc);
        return WriteZip(members);
    }

    /// <summary>
    /// Serialises <paramref name="members"/> into the publisher SI ZIP framing: STORED entries,
    /// no extra fields, central-directory <c>version made by = 0</c>, and deterministic DOS time.
    /// </summary>
    public static byte[] WriteZip(IReadOnlyList<ProsperoSiMember> members)
    {
        ArgumentNullException.ThrowIfNull(members);
        const ushort versionNeeded = 20;
        const ushort dosTime = 0;
        const ushort dosDate = 0x0021; // 1980-01-01, the earliest valid DOS date.

        using var ms = new MemoryStream();
        using var writer = new BinaryWriter(ms, Encoding.ASCII, leaveOpen: true);
        var local = new (uint Crc, int Size, long Offset)[members.Count];

        for (int i = 0; i < members.Count; i++)
        {
            ProsperoSiMember member = members[i];
            byte[] name = Encoding.ASCII.GetBytes(member.Path);
            uint crc = ZipCrc32(member.Content);
            local[i] = (crc, member.Content.Length, ms.Position);

            writer.Write(0x04034b50u);
            writer.Write(versionNeeded);
            writer.Write((ushort)0); // flags
            writer.Write((ushort)0); // STORED
            writer.Write(dosTime);
            writer.Write(dosDate);
            writer.Write(crc);
            writer.Write((uint)member.Content.Length);
            writer.Write((uint)member.Content.Length);
            writer.Write((ushort)name.Length);
            writer.Write((ushort)0); // extra length
            writer.Write(name);
            writer.Write(member.Content);
        }

        long centralOffset = ms.Position;
        for (int i = 0; i < members.Count; i++)
        {
            byte[] name = Encoding.ASCII.GetBytes(members[i].Path);
            writer.Write(0x02014b50u);
            writer.Write((ushort)0); // publisher SI: version made by
            writer.Write(versionNeeded);
            writer.Write((ushort)0); // flags
            writer.Write((ushort)0); // STORED
            writer.Write(dosTime);
            writer.Write(dosDate);
            writer.Write(local[i].Crc);
            writer.Write((uint)local[i].Size);
            writer.Write((uint)local[i].Size);
            writer.Write((ushort)name.Length);
            writer.Write((ushort)0); // extra length
            writer.Write((ushort)0); // comment length
            writer.Write((ushort)0); // disk start
            writer.Write((ushort)0); // internal attributes
            writer.Write(0u);        // external attributes
            writer.Write((uint)local[i].Offset);
            writer.Write(name);
        }

        long centralSize = ms.Position - centralOffset;
        if (members.Count > ushort.MaxValue || centralOffset > uint.MaxValue || centralSize > uint.MaxValue)
            throw new InvalidDataException("SI ZIP exceeds the non-Zip64 publisher layout.");

        writer.Write(0x06054b50u);
        writer.Write((ushort)0);
        writer.Write((ushort)0);
        writer.Write((ushort)members.Count);
        writer.Write((ushort)members.Count);
        writer.Write((uint)centralSize);
        writer.Write((uint)centralOffset);
        writer.Write((ushort)0);
        writer.Flush();
        return ms.ToArray();
    }

    private static uint ZipCrc32(ReadOnlySpan<byte> data)
    {
        uint crc = 0xffffffffu;
        foreach (byte value in data)
        {
            crc ^= value;
            for (int bit = 0; bit < 8; bit++)
                crc = (crc >> 1) ^ (0xedb88320u & (uint)-(int)(crc & 1));
        }
        return crc ^ 0xffffffffu;
    }

    /// <summary>
    /// Formats a 32-byte digest exactly the way <c>pfsimage.xml</c> does: lowercase
    /// <c>0xNN 0xNN …</c>, sixteen bytes per line. An empty span yields an all-zero block.
    /// </summary>
    public static string FormatDigest(ReadOnlySpan<byte> digest)
    {
        ReadOnlySpan<byte> src = digest.IsEmpty ? stackalloc byte[32] : digest;
        var sb = new StringBuilder(src.Length * 5);
        for (int i = 0; i < src.Length; i++)
        {
            if (i != 0) sb.Append(i % 16 == 0 ? '\n' : ' ');
            sb.Append("0x").Append(src[i].ToString("x2", CultureInfo.InvariantCulture));
        }
        return sb.ToString();
    }

    /// <summary>
    /// Builds <c>common/etc/pfsimage.xml</c> in the reference format, reproduced byte-for-byte through its
    /// <c>&lt;config&gt;</c>, <c>&lt;digests&gt;</c>, <c>&lt;params&gt;</c>, <c>&lt;container&gt;</c>,
    /// <c>&lt;mount-image&gt;</c> and <c>&lt;entries&gt;</c> sections. Digest fields are emitted verbatim
    /// when present on <paramref name="options"/>, otherwise as all-zero placeholders; every placeholder
    /// is appended to <paramref name="warnings"/>. Normal high-level package construction fills these
    /// values from its completed CNT/FIH; placeholders apply only to incomplete low-level input.
    /// </summary>
    public static string BuildPfsImageXml(ProsperoPfsImageXmlOptions options, ICollection<string>? warnings = null)
    {
        ArgumentNullException.ThrowIfNull(options);
        ArgumentException.ThrowIfNullOrEmpty(options.ContentId);

        void NoteIfPlaceholder(byte[]? value, string field)
        {
            if (value is null || value.Length == 0)
                warnings?.Add(
                    $"pfsimage.xml <{field}> emitted as all-zero placeholder " +
                    "(supply the digest explicitly when using the low-level XML API).");
        }

        NoteIfPlaceholder(options.ContentDigest, "content-digest");
        NoteIfPlaceholder(options.GameDigest, "game-digest");
        NoteIfPlaceholder(options.HeaderDigest, "header-digest");
        NoteIfPlaceholder(options.SystemDigest, "system-digest");
        NoteIfPlaceholder(options.ParamDigest, "param-digest");
        NoteIfPlaceholder(options.PackageDigest, "package-digest");
        NoteIfPlaceholder(options.BodyDigest, "body-digest");
        NoteIfPlaceholder(options.SblockDigest ?? options.GameDigest, "sblock-digest");
        NoteIfPlaceholder(options.FixedInfoDigest, "fixed-info-digest");

        // The inner superblock seed is emitted as a 16-byte 0xNN block, exactly like the digests.
        string seedBlock = Indent(FormatDigest(options.PfsImageSeed is { Length: > 0 } s ? s : default), "      ");

        string Indent(string digest, string pad) => digest.Replace("\n", "\n" + pad);
        static string Hex16(long v) => "0x" + v.ToString("x16", CultureInfo.InvariantCulture);
        static string Hex8(long v) => "0x" + v.ToString("x8", CultureInfo.InvariantCulture);

        // Reproducible container/mount geometry (all derivable from the inner-image layout).
        long containerSize = options.ContainerSize;
        long bodyOffset = options.BodyOffset;
        long bodySize = containerSize - bodyOffset;
        long containerOffset = options.PfsImageOffset + options.PfsImageSize;
        long mountImageSize = containerOffset + containerSize;

        // longname = <content-id>-C<version-digits>-M<master16>-<type-code> (e.g. PS5GD -> GD).
        string longName = options.LongName ?? BuildLongName(options);

        var sb = new StringBuilder(8192);
        sb.Append("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n");
        sb.Append("<package-configuration version=\"1.0\" type=\"package-info\">\n");
        sb.Append($"  <config version=\"{options.ContentVersion}\" metadata=\"0\" primary=\"yes\">\n");
        sb.Append($"    <content-id>{options.ContentId}</content-id>\n");
        sb.Append($"    <primary-id>{options.PrimaryId ?? options.ContentId}</primary-id>\n");
        sb.Append($"    <longname>{longName}</longname>\n");
        sb.Append($"    <required-system-version>{options.RequiredSystemVersion}</required-system-version>\n");
        sb.Append($"    <drm-type>{options.DrmType}</drm-type>\n");
        sb.Append($"    <content-type>{options.ContentType}</content-type>\n");
        sb.Append($"    <application-type>{options.ApplicationType}</application-type>\n");
        sb.Append("    <num-of-images>1</num-of-images>\n");
        sb.Append($"    <package-size>{options.PackageSize}</package-size>\n");
        sb.Append($"    <version-date>0x{options.VersionDate:x8}</version-date>\n");
        sb.Append($"    <version-hash>0x{options.VersionHash:x8}</version-hash>\n");
        sb.Append("  </config>\n");
        sb.Append("  <digests version=\"1.2\" major-param-version=\"0\">\n");
        sb.Append($"    <content-digest>\n      {Indent(FormatDigest(options.ContentDigest), "      ")}\n    </content-digest>\n");
        sb.Append($"    <game-digest>\n      {Indent(FormatDigest(options.GameDigest), "      ")}\n    </game-digest>\n");
        sb.Append($"    <header-digest>\n      {Indent(FormatDigest(options.HeaderDigest), "      ")}\n    </header-digest>\n");
        sb.Append($"    <system-digest>\n      {Indent(FormatDigest(options.SystemDigest), "      ")}\n    </system-digest>\n");
        sb.Append($"    <param-digest>\n      {Indent(FormatDigest(options.ParamDigest), "      ")}\n    </param-digest>\n");
        sb.Append($"    <package-digest>\n      {Indent(FormatDigest(options.PackageDigest), "      ")}\n    </package-digest>\n");
        sb.Append("  </digests>\n");
        sb.Append("  <params>\n");
        sb.Append($"    <applicationDrmType>{options.ApplicationDrmType ?? options.ApplicationType}</applicationDrmType>\n");
        sb.Append($"    <contentId>{options.ContentId}</contentId>\n");
        sb.Append($"    <contentVersion>{options.ContentVersion}</contentVersion>\n");
        sb.Append($"    <masterVersion>{options.MasterVersion}</masterVersion>\n");
        sb.Append($"    <requiredSystemSoftwareVersion>{options.RequiredSystemSoftwareVersion}</requiredSystemSoftwareVersion>\n");
        sb.Append($"    <sdkVersion>{options.SdkVersion}</sdkVersion>\n");
        sb.Append($"    <titleName>{options.TitleName}</titleName>\n");
        sb.Append("  </params>\n");
        sb.Append("  <container nth-of-image=\"1\">\n");
        sb.Append($"    <container-size>{Hex16(containerSize)}</container-size>\n");
        sb.Append($"    <mandatory-size>{Hex16(options.MandatorySize)}</mandatory-size>\n");
        sb.Append($"    <body-offset>{Hex16(bodyOffset)}</body-offset>\n");
        sb.Append($"    <body-size>{Hex16(bodySize)}</body-size>\n");
        sb.Append($"    <body-digest>\n      {Indent(FormatDigest(options.BodyDigest), "      ")}\n    </body-digest>\n");
        sb.Append($"    <promote-size>{Hex8(containerSize)}</promote-size>\n");
        sb.Append("  </container>\n");
        sb.Append("  <mount-image nth-of-image=\"1\" nested-image=\"yes\">\n");
        sb.Append("    <pfs-offset-align>0x0000000000010000</pfs-offset-align>\n");
        sb.Append("    <pfs-size-align>0x0000000000010000</pfs-size-align>\n");
        sb.Append($"    <pfs-image-offset>{Hex16(options.PfsImageOffset)}</pfs-image-offset>\n");
        sb.Append($"    <pfs-image-size>{Hex16(options.PfsImageSize)}</pfs-image-size>\n");
        sb.Append("    <fixed-info-size>0x00010000</fixed-info-size>\n");
        sb.Append($"    <pfs-image-seed>\n      {seedBlock}\n    </pfs-image-seed>\n");
        sb.Append($"    <sblock-digest>\n      {Indent(FormatDigest(options.SblockDigest ?? options.GameDigest), "      ")}\n    </sblock-digest>\n");
        sb.Append($"    <fixed-info-digest>\n      {Indent(FormatDigest(options.FixedInfoDigest), "      ")}\n    </fixed-info-digest>\n");
        sb.Append($"    <mount-image-offset>{Hex16(0)}</mount-image-offset>\n");
        sb.Append($"    <mount-image-size>{Hex16(mountImageSize)}</mount-image-size>\n");
        sb.Append($"    <container-offset>{Hex16(containerOffset)}</container-offset>\n");
        sb.Append($"    <supplemental-offset>{Hex16(options.SupplementalOffset)}</supplemental-offset>\n");
        sb.Append("  </mount-image>\n");
        if (options.Entries is { Count: > 0 } entries)
        {
            sb.Append($"  <entries nth-of-image=\"1\" num=\"{entries.Count}\">\n");
            foreach (ProsperoPfsImageEntry e in entries)
                sb.Append($"    <entry offset=\"{Hex8(e.Offset)}\" size=\"{Hex8(e.Size)}\" name=\"{e.Name}\"/>\n");
            sb.Append("  </entries>\n");
        }
        AppendStageB(sb, options);
        sb.Append("</package-configuration>\n");
        return sb.ToString();
    }

    /// <summary>
    /// Derives the <c>&lt;longname&gt;</c> the tool stamps:
    /// <c>{content-id}-C{version-digits}-M{master-16-hex}-{type-code}</c>, where the version digits
    /// are the dotted <see cref="ProsperoPfsImageXmlOptions.ContentVersion"/> with the dots removed
    /// and the type-code is the content type with any leading <c>PS5</c> dropped (so <c>PS5GD</c>
    /// becomes <c>GD</c>).
    /// </summary>
    private static string BuildLongName(ProsperoPfsImageXmlOptions o)
    {
        string versionDigits = o.ContentVersion.Replace(".", "", StringComparison.Ordinal);
        string typeCode = o.ContentType.StartsWith("PS5", StringComparison.OrdinalIgnoreCase)
            ? o.ContentType[3..]
            : o.ContentType;
        string master16 = o.LongNameMasterValue.ToString("x16", CultureInfo.InvariantCulture);
        return $"{o.ContentId}-C{versionDigits}-M{master16}-{typeCode}";
    }

    // ------------------------------------------------------------------------------------------
    // <chunkinfo> / <pfs-image> / <nested-image> introspection sections.
    //
    // These describe the layout of the image THIS builder produced: the outer + inner PFS inode
    // trees and the PlayGo chunk map, read straight from the build state (PfsBuilder.CaptureImageTree
    // and the finalized geometry). They are self-consistent with the emitted bytes (block indices
    // reflect the superblock-first layout, the outer seed is deterministic all-zeros, and inner files
    // are stored raw so nested files show size == plain). The console loader does not read the
    // supplemental ZIP, so these sections are completeness polish, not an install requirement.
    // ------------------------------------------------------------------------------------------

    /// <summary>
    /// Appends the introspection sections for whichever of
    /// <see cref="ProsperoPfsImageXmlOptions.ChunkInfo"/>, <see cref="ProsperoPfsImageXmlOptions.OuterPfsTree"/>
    /// and <see cref="ProsperoPfsImageXmlOptions.NestedPfsTree"/> are supplied.
    /// </summary>
    private static void AppendStageB(StringBuilder sb, ProsperoPfsImageXmlOptions options)
    {
        if (options.ChunkInfo is { } chunk)
            AppendChunkInfo(sb, options.ContentId, chunk);
        if (options.OuterPfsTree is { } outer)
            AppendPfsImage(sb, outer, options.PfsImageOffset);
        if (options.NestedPfsTree is { } nested)
            AppendNestedImage(sb, nested);
    }

    private static void AppendChunkInfo(StringBuilder sb, string contentId, ProsperoChunkInfoModel c)
    {
        string lang = "0x" + c.LanguageMask.ToString("x16", CultureInfo.InvariantCulture);
        sb.Append($"  <chunkinfo size=\"{c.PlayGoChunkDatSize}\" nested=\"true\" sdk=\"{c.Sdk}\" disps=\"{c.Disps}\">\n");
        sb.Append($"    <contentid>{contentId}</contentid>\n");
        sb.Append($"    <languages default=\"1\">{lang}</languages>\n");
        sb.Append("    <scenarios num=\"1\" default=\"0\" groups=\"0\">\n");
        sb.Append("      <scenario id=\"0\" type=\"33\" name=\"Scenario #0\">\n");
        sb.Append($"        <overall initials=\"1\" num=\"1\" init-size=\"{c.TotalSize}\" total=\"{c.TotalSize}\">0</overall>\n");
        sb.Append($"        <default initials=\"1\" num=\"1\" init-size=\"{c.TotalSize}\" total=\"{c.TotalSize}\">0</default>\n");
        sb.Append("      </scenario>\n");
        sb.Append("    </scenarios>\n");
        sb.Append("    <chunks num=\"1\" default=\"0xffffffffffffffff\">\n");
        sb.Append($"      <chunk id=\"0\" flag=\"0x80\" locus=\"0x03\" language=\"{lang}\" disps=\"{c.Disps}\" num=\"2\" size=\"{c.TotalSize}\" name=\"Chunk #0\">0 1</chunk>\n");
        sb.Append("    </chunks>\n");
        sb.Append("    <outers num=\"2\" overlapped=\"0\" language-overlapped=\"0\">\n");
        sb.Append($"      <outer id=\"0\" image=\"0\" offset=\"{Hex16Blob(0)}\" size=\"{Hex16Blob(c.Outer0Size)}\" chunks=\"1\"/>\n");
        sb.Append($"      <outer id=\"1\" image=\"0\" offset=\"{Hex16Blob(c.Outer0Size)}\" size=\"{Hex16Blob(c.Outer1Size)}\" chunks=\"1\"/>\n");
        sb.Append("    </outers>\n");
        sb.Append("  </chunkinfo>\n");
    }

    private static void AppendPfsImage(StringBuilder sb, ProsperoPfsImageTreeInfo info, long pfsImageOffset)
    {
        long metadata = (long)info.DinodeBlock * info.BlockSize;
        sb.Append($"  <pfs-image version=\"2\" readonly=\"true\" offset=\"{pfsImageOffset}\" metadata=\"{metadata}\">\n");
        string signed = info.Signed ? " signed=\"true\"" : "";
        string encrypted = info.Encrypted ? " encrypted=\"true\"" : "";
        sb.Append($"    <sblock{signed}{encrypted} ignore-case=\"true\" index-size=\"32\" blocks=\"{info.DinodeBlockCount}\" backups=\"0\">\n");
        AppendSuperInode(sb, info);
        sb.Append($"      <seed>{Hex16Blob(info.Seed, 16)}</seed>\n");
        sb.Append($"      <icv>{Hex16Blob(info.SuperblockIcv, 32)}</icv>\n");
        sb.Append("    </sblock>\n");
        AppendOuterNode(sb, info.Root, info.BlockSize, "    ");
        sb.Append("  </pfs-image>\n");
    }

    private static void AppendNestedImage(StringBuilder sb, ProsperoPfsImageTreeInfo info)
    {
        sb.Append("  <nested-image version=\"2\" readonly=\"true\" offset=\"0\">\n");
        sb.Append($"    <sblock ignore-case=\"true\" index-size=\"32\" blocks=\"{info.DinodeBlockCount}\" backups=\"0\">\n");
        AppendSuperInode(sb, info);
        sb.Append("    </sblock>\n");
        int afid = 0;
        AppendNestedNode(sb, info.Root, info.BlockSize, ref afid, "    ");
        sb.Append("  </nested-image>\n");
    }

    private static void AppendSuperInode(StringBuilder sb, ProsperoPfsImageTreeInfo info)
    {
        sb.Append($"      <image-size block-size=\"{info.BlockSize}\" num=\"{info.ImageBlocks}\">{Hex16Blob(info.ImageBlocks * info.BlockSize)}</image-size>\n");
        sb.Append($"      <super-inode blocks=\"{info.DinodeBlockCount}\" inodes=\"{info.InodeCount}\" root=\"{info.RootInodeNumber}\">\n");
        sb.Append($"        <inode size=\"{info.DinodeSize}\" links=\"1\" mode=\"0x0000\" imode=\"{Imode(info.DinodeFlags)}\" index=\"{info.DinodeBlock}\"/>\n");
        sb.Append("      </super-inode>\n");
    }

    // Outer <pfs-image> tree: block-index oriented, imode only (no per-node mode), matching the
    // reference <pfs-image><root> convention.
    private static void AppendOuterNode(StringBuilder sb, ProsperoPfsImageNode n, int blockSize, string pad)
    {
        string child = pad + "  ";
        if (n.IsDirectory)
        {
            string tag = n.Name.Length == 0 ? "root" : "dir";
            sb.Append($"{pad}<{tag} size=\"{n.StoredSize}\" links=\"{n.Nlink}\" imode=\"{Imode(n.Flags)}\" index=\"{n.StartBlock}\" inode=\"{n.InodeNumber}\" name=\"{n.Name}\">\n");
            foreach (var c in n.Children)
                AppendOuterNode(sb, c, blockSize, child);
            sb.Append($"{pad}</{tag}>\n");
        }
        else
        {
            string comp = !n.Internal && n.Compressed
                ? $" plain=\"{n.PlainSize}\" comp=\"{CompLabel(n.StoredSize, n.PlainSize, blockSize)}\""
                : "";
            sb.Append($"{pad}<file size=\"{n.StoredSize}\"{comp} imode=\"{Imode(n.Flags)}\" index=\"{IndexRange(n)}\" inode=\"{n.InodeNumber}\" name=\"{n.Name}\"/>\n");
        }
    }

    // Nested <nested-image> tree: byte-offset oriented, with mode + imode + afid + chunk on user
    // files, matching the reference <nested-image><root> convention. Physical package offsets
    // (poffset) are omitted because they are not stable for our compressed inner image.
    private static void AppendNestedNode(StringBuilder sb, ProsperoPfsImageNode n, int blockSize, ref int afid, string pad)
    {
        string child = pad + "  ";
        if (n.IsDirectory)
        {
            if (n.Name.Length == 0)
            {
                sb.Append($"{pad}<root plain=\"{n.PlainSize}\" links=\"{n.Nlink}\" imode=\"{Imode(n.Flags)}\" inode=\"{n.InodeNumber}\" name=\"\">\n");
                foreach (var c in n.Children)
                    AppendNestedNode(sb, c, blockSize, ref afid, child);
                sb.Append($"{pad}</root>\n");
            }
            else
            {
                sb.Append($"{pad}<dir plain=\"{n.PlainSize}\" links=\"{n.Nlink}\" mode=\"{Mode4(n.Mode)}\" imode=\"{Imode(n.Flags)}\" inode=\"{n.InodeNumber}\" name=\"{n.Name}\">\n");
                foreach (var c in n.Children)
                    AppendNestedNode(sb, c, blockSize, ref afid, child);
                sb.Append($"{pad}</dir>\n");
            }
        }
        else if (n.Internal)
        {
            sb.Append($"{pad}<file plain=\"{n.PlainSize}\" imode=\"{Imode(n.Flags)}\" inode=\"{n.InodeNumber}\" name=\"{n.Name}\"/>\n");
        }
        else
        {
            string comp = n.Compressed ? $" comp=\"{CompLabel(n.StoredSize, n.PlainSize, blockSize)}\"" : "";
            long offset = (long)n.StartBlock * blockSize;
            sb.Append($"{pad}<file size=\"{n.StoredSize}\" plain=\"{n.PlainSize}\"{comp} offset=\"{offset}\" mode=\"{Mode4(n.Mode)}\" imode=\"{Imode(n.Flags)}\" inode=\"{n.InodeNumber}\" afid=\"{afid++}\" chunk=\"0\" name=\"{n.Name}\"/>\n");
        }
    }

    private static string IndexRange(ProsperoPfsImageNode n) =>
        n.Blocks > 1
            ? $"{n.StartBlock}-{n.StartBlock + (int)n.Blocks - 1}"
            : n.StartBlock.ToString(CultureInfo.InvariantCulture);

    private static string CompLabel(long stored, long plain, int blockSize)
    {
        long pct = plain > 0 ? (long)Math.Round(stored * 100.0 / plain) : 0;
        long a = blockSize > 0 ? (stored + blockSize - 1) / blockSize : 0;
        long b = blockSize > 0 ? (plain + blockSize - 1) / blockSize : 0;
        return $"{pct}% ({a}/{b})";
    }

    private static string Imode(uint flags) => "0x" + flags.ToString("x8", CultureInfo.InvariantCulture);
    private static string Mode4(ushort mode) => "0x" + mode.ToString("x4", CultureInfo.InvariantCulture);
    private static string Hex16Blob(long v) => "0x" + v.ToString("x16", CultureInfo.InvariantCulture);

    private static string Hex16Blob(byte[]? data, int len)
    {
        var sb = new StringBuilder(2 + len * 2);
        sb.Append("0x");
        for (int i = 0; i < len; i++)
            sb.Append((data != null && i < data.Length ? data[i] : (byte)0).ToString("X2", CultureInfo.InvariantCulture));
        return sb.ToString();
    }
}
