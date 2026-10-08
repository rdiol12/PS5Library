// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// Produces the PS5 finalized image (\x7FFIH), in the "debug" variant
// (signed byte 0x00) used by consoles whose debug mode relaxes finalized-image verification.
//
// A finalized image is built from four consecutive segments:
// FIH / PFS / SC / SI:
//
//   FIH  [0x00000 .. 0x10000)                     header (LITTLE-endian fields) + finalization
//                                                  digest table. FIH offset (0) and FIH size
//                                                  (0x10000) are ALWAYS constant, as is the PFS
//                                                  offset (0x10000); only the sizes below vary.
//   PFS  [0x10000 .. 0x10000+pfs_image_size)      the shared, AES-XTS-encrypted outer PFS image.
//   SC   [pfs_end .. pfs_end+sc_size)             the embedded \x7FCNT metadata container; its own
//                                                  pfs_image_offset points back to the shared image
//                                                  at 0x10000.
//   SI   [sc_end .. EOF)                           a ZIP archive of install-time metadata
//                                                  (common/etc/*_meta_*.dat, pfsimage.xml,
//                                                  playgo-chunk.dat, config/<cid>/playgo-chunk.crc).
//
// The signed byte at offset 0x05 distinguishes the two finalized variants: 0x00 = debug,
// 0x80 = retail / submitted. This is THE single byte that separates a retail-submitted package
// from a debug one in a complete FIH .pkg file.
//
// The FIH header's structural fields are magic, signed byte, PFS image offset/size, and
// embedded-CNT/SC offset and size. The embedded CNT and shared PFS image are the output of
// ProsperoPkgBuilder, so the produced file is parsed and validated by ProsperoPkgReader
// (Type=FullDebug, embedded CNT round-trips). FIH 0x30 is SHA3-256 of the plaintext outer
// superblock; 0x70/0xD0 are the GeneralDigests Game/Target slots (the debug profile commonly
// makes them equal). The CNT package-digest self-seal at CNT+0xFE0
// is SHA3-256 of CNT[0:0xFE0]. The CNT GeneralDigests block and per-entry digest table are
// SHA3-256 of plaintext CNT regions and entries. For publisher PPR/NAPS, the distinct FIH slot
// at 0xB0 is SHA3-256(naps_pkg_layout.dat), and FIH 0xA8 stores that blob's exact byte length.
// The CNT build path threads that exact preimage in. The standalone-finalize path has
// only a finished encrypted CNT, so it falls back to SHA3-256 of the outer image. The trailing
// SI ZIP is generated only when the caller passes one through the siArchive parameter; its
// container is deterministic and its keyed members are caller-supplied. A console in debug mode
// that does not enforce those keyed members accepts the image.

using System;
using System.Buffers.Binary;
using System.IO;
using System.Linq;

namespace LibProsperoPkg.PKG;

/// <summary>The finalized-image variant to emit.</summary>
public enum ProsperoFihVariant
{
    /// <summary>Debug finalized image (signed byte 0x00) for debug-mode consoles.</summary>
    Debug,

    /// <summary>
    /// Official finalized image (signed byte 0x80). A trusted
    /// <see cref="IProsperoRetailFinalizationProvider"/> is mandatory.
    /// </summary>
    Official,
}

/// <summary>
/// Wraps a PS5 CNT metadata package into a finalized (FIH) image. See the file
/// header for the exact format and the reproduced fields.
/// </summary>
public static class ProsperoFihBuilder
{
    // CNT header field offsets (big-endian) reused to locate the shared PFS image.
    private const int CntPfsImageOffsetField = 0x410;
    private const int CntPfsImageSizeField = 0x418;

    /// <summary>
    /// Reads a CNT package and writes the corresponding finalized (FIH) image to
    /// <paramref name="fihOutputPath"/>. Returns the list of non-fatal warnings (notably that the
    /// finalization digest table is structurally populated for the selected variant).
    /// </summary>
    /// <param name="cntPath">Path to the PS5 CNT metadata package to finalize.</param>
    /// <param name="fihOutputPath">Path the finalized (FIH) image is written to.</param>
    /// <param name="variant">Finalized-image variant (Debug or Official).</param>
    /// <param name="logger">Optional progress callback.</param>
    /// <param name="siArchive">
    /// Optional trailing SI (install-metadata) segment to append after the embedded CNT, closing
    /// the four-segment FIH/PFS/SC/SI layout. Build it with <see cref="ProsperoSiArchive"/>. When
    /// null (the default) the image is written without an SI segment, exactly as before; a
    /// debug-mode console that does not enforce the SI accepts both forms.
    /// </param>
    /// <param name="siArchiveFactory">
    /// Optional alternative to <paramref name="siArchive"/>: a factory that receives the assembled,
    /// finalized mount image (FIH header + PFS image + embedded CNT — i.e. exactly the region the
    /// finalization process reduces for <c>playgo-chunk.crc</c>) and returns the SI bytes to append. This
    /// lets the SI be built with a deterministic <c>playgo-chunk.crc</c> derived from the finalized
    /// image. Ignored when <paramref name="siArchive"/> is non-null.
    /// </param>
    /// <param name="siArchiveStreamFactory">
    /// File-backed alternative to <paramref name="siArchiveFactory"/>. It receives a readable,
    /// seekable stream containing FIH + PFS + CNT and supports mount images larger than 2 GiB.
    /// </param>
    /// <param name="nestedImageDigest">
    /// Optional 32-byte FIH 0xB0 publisher nested-layout digest.
    /// layout blob. In the publisher PPR/NAPS path it is SHA3-256(<c>naps_pkg_layout.dat</c>), while
    /// <paramref name="nestedImageSize"/> is the exact byte length of that same blob. When null,
    /// standalone finalize falls back to a best-effort SHA3-256 of the outer image.
    /// </param>
    /// <param name="nestedImageSize">Plain (uncompressed) size of the inner PFS image, or 0 when not nwonly.</param>
    /// <param name="nestedMetaBaseBlocks">Inner mount metadata-base block index (MetaBaseLogical / block size), or 0.</param>
    /// <param name="nwonlyContentVersionHi">High 32 bits of the content-version word stamped into the FIH header.</param>
    /// <param name="nwonlyNapsFileCount">
    /// Number of nonterminal NAPS FIDX/file extents (<c>NumFiles - 1</c>).
    /// </param>
    /// <param name="nwonlyAppFileCount">Application-payload file count for the FIH file-count field.</param>
    /// <param name="nwonlySparseAfidCount">Number of unused AFID slots represented by FIDX holes.</param>
    /// <param name="nwonlyEmptyFileCount">Number of zero-length files with explicit FIDX end boundaries.</param>
    /// <param name="outerSuperblockIndex">
    /// Optional known 64-KiB block index of the outer superblock. Publisher builds pass it to avoid
    /// scanning a potentially hundreds-of-gigabytes PFS image.
    /// </param>
    /// <param name="retailFinalizationProvider">
    /// Trusted provider for the standard 0x300-byte Retail FIH material. Required for
    /// <see cref="ProsperoFihVariant.Official"/> and ignored for Debug.
    /// </param>
    public static System.Collections.Generic.IReadOnlyList<string> BuildFromCnt(
        string cntPath, string fihOutputPath, ProsperoFihVariant variant = ProsperoFihVariant.Debug,
        Action<string>? logger = null, byte[]? siArchive = null,
        Func<byte[], byte[]>? siArchiveFactory = null,
        Func<Stream, byte[]>? siArchiveStreamFactory = null,
        byte[]? nestedImageDigest = null,
        long nestedImageSize = 0, long nestedMetaBaseBlocks = 0,
        uint nwonlyContentVersionHi = 0, int nwonlyNapsFileCount = 0, int nwonlyAppFileCount = 0,
        int nwonlySparseAfidCount = 0, int nwonlyEmptyFileCount = 0,
        int outerSuperblockIndex = -1,
        IProsperoRetailFinalizationProvider? retailFinalizationProvider = null)
        => BuildFromSources(
            cntPath, fihOutputPath, variant, logger, siArchive,
            siArchiveFactory, siArchiveStreamFactory, nestedImageDigest,
            nestedImageSize, nestedMetaBaseBlocks, nwonlyContentVersionHi,
            nwonlyNapsFileCount, nwonlyAppFileCount, nwonlySparseAfidCount,
            nwonlyEmptyFileCount, outerSuperblockIndex, retailFinalizationProvider,
            separatePfsPath: null, pfsAlreadyAtOutput: false);

    internal static System.Collections.Generic.IReadOnlyList<string> BuildFromSources(
        string cntPath, string fihOutputPath, ProsperoFihVariant variant,
        Action<string>? logger, byte[]? siArchive,
        Func<byte[], byte[]>? siArchiveFactory,
        Func<Stream, byte[]>? siArchiveStreamFactory,
        byte[]? nestedImageDigest,
        long nestedImageSize, long nestedMetaBaseBlocks,
        uint nwonlyContentVersionHi, int nwonlyNapsFileCount, int nwonlyAppFileCount,
        int nwonlySparseAfidCount, int nwonlyEmptyFileCount,
        int outerSuperblockIndex,
        IProsperoRetailFinalizationProvider? retailFinalizationProvider,
        string? separatePfsPath, bool pfsAlreadyAtOutput)
    {
        ArgumentException.ThrowIfNullOrEmpty(cntPath);
        ArgumentException.ThrowIfNullOrEmpty(fihOutputPath);
        if (variant == ProsperoFihVariant.Official && retailFinalizationProvider is null)
        {
            throw new InvalidOperationException(
                "Official FIH generation requires a Retail finalization provider. " +
                "Writing signed byte 0x80 without protected FIH material is refused.");
        }
        var log = logger ?? (_ => { });
        var warnings = new System.Collections.Generic.List<string>();

        string inputFullPath = Path.GetFullPath(cntPath);
        string outputFullPath = Path.GetFullPath(fihOutputPath);
        string? pfsFullPath = separatePfsPath is null ? null : Path.GetFullPath(separatePfsPath);
        if (string.Equals(
                inputFullPath, outputFullPath,
                OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            throw new ArgumentException("CNT input and FIH output paths must be different.");
        if (!pfsAlreadyAtOutput && pfsFullPath is not null && string.Equals(
                pfsFullPath, outputFullPath,
                OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            throw new ArgumentException("PFS input and FIH output paths must be different.");
        if (pfsAlreadyAtOutput && (pfsFullPath is null || !string.Equals(
                pfsFullPath, outputFullPath,
                OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal)))
            throw new ArgumentException("An in-place PFS must be the FIH output file.");

        using var cntStream = new FileStream(
            inputFullPath, FileMode.Open, FileAccess.Read, FileShare.Read,
            bufferSize: 1 << 20, FileOptions.RandomAccess);
        byte[] cntHeader = ReadStreamRange(cntStream, 0, ProsperoPkgLayout.HeaderSize);
        if (cntHeader[0] != ProsperoPkgLayout.CntMagic[0] ||
            cntHeader[1] != ProsperoPkgLayout.CntMagic[1] ||
            cntHeader[2] != ProsperoPkgLayout.CntMagic[2] ||
            cntHeader[3] != ProsperoPkgLayout.CntMagic[3])
            throw new InvalidDataException("Input is not a PS5 CNT metadata package.");

        ulong pfsImageOffset = BinaryPrimitives.ReadUInt64BigEndian(
            cntHeader.AsSpan(CntPfsImageOffsetField));
        ulong pfsImageSize = BinaryPrimitives.ReadUInt64BigEndian(
            cntHeader.AsSpan(CntPfsImageSizeField));
        if (pfsImageOffset == 0 || pfsImageSize == 0)
            throw new InvalidDataException("CNT package has no embedded PFS image to finalize.");
        if (pfsImageOffset > int.MaxValue)
            throw new InvalidDataException(
                "CNT metadata preceding the PFS image exceeds the supported 2-GiB metadata limit.");

        using FileStream? separatePfs = pfsFullPath is null
            ? null
            : new FileStream(
                pfsFullPath, FileMode.Open,
                pfsAlreadyAtOutput ? FileAccess.ReadWrite : FileAccess.Read,
                pfsAlreadyAtOutput ? FileShare.None : FileShare.Read,
                bufferSize: 1 << 20, FileOptions.RandomAccess);
        Stream pfsStream = separatePfs ?? cntStream;
        long pfsStreamOffset;
        if (separatePfs is null)
        {
            if (pfsImageOffset > (ulong)cntStream.Length ||
                pfsImageSize > (ulong)cntStream.Length - pfsImageOffset)
                throw new InvalidDataException("CNT package has no embedded PFS image to finalize.");
            pfsStreamOffset = checked((long)pfsImageOffset);
        }
        else
        {
            if ((ulong)cntStream.Length != pfsImageOffset)
                throw new InvalidDataException("Split CNT metadata length does not match pfs_image_offset.");
            long expectedLength = checked((long)pfsImageSize +
                (pfsAlreadyAtOutput ? ProsperoPkgLayout.FihHeaderRegionSize : 0));
            if (separatePfs.Length != expectedLength)
                throw new InvalidDataException("Separate PFS length does not match pfs_image_size.");
            pfsStreamOffset = pfsAlreadyAtOutput ? ProsperoPkgLayout.FihHeaderRegionSize : 0;
        }

        // Split the CNT into its metadata blob (header + entries + body, everything before the
        // image) and the shared encrypted PFS image.
        byte[] metadata = ReadStreamRange(cntStream, 0, checked((int)pfsImageOffset));

        // In the finalized image the embedded CNT's pfs_image_offset must point at the shared
        // image stored at the start of the body region (FIH offset 0x10000).
        BinaryPrimitives.WriteUInt64BigEndian(metadata.AsSpan(CntPfsImageOffsetField),
            ProsperoPkgLayout.FihHeaderRegionSize);

        ulong embeddedCntOffset = (ulong)ProsperoPkgLayout.FihHeaderRegionSize + pfsImageSize;
        var (sbOffsetInImage, gameDigest, imageDigest) = AnalyzeImageRange(
            pfsStream, pfsStreamOffset, checked((long)pfsImageSize),
            outerSuperblockIndex);
        byte[] header = BuildFihHeaderBlock(
            variant, pfsImageSize, embeddedCntOffset,
            sbOffsetInImage, gameDigest, imageDigest, warnings,
            nestedImageDigest: nestedImageDigest, nestedImageSize: nestedImageSize,
            nestedMetaBaseBlocks: nestedMetaBaseBlocks,
            nwonlyContentVersionHi: nwonlyContentVersionHi,
            nwonlyNapsFileCount: nwonlyNapsFileCount,
            nwonlyAppFileCount: nwonlyAppFileCount,
            nwonlySparseAfidCount: nwonlySparseAfidCount,
            nwonlyEmptyFileCount: nwonlyEmptyFileCount);
        if (variant == ProsperoFihVariant.Official)
            ApplyOfficialDigestSlots(header, metadata);

        log($"Writing finalized {(variant == ProsperoFihVariant.Debug ? "debug" : "official")} (FIH) image: " +
            $"image=0x{pfsImageSize:X} @0x{ProsperoPkgLayout.FihHeaderRegionSize:X}, CNT @0x{embeddedCntOffset:X}.");

        byte[]? si = siArchive;

        if (variant == ProsperoFihVariant.Official)
        {
            ProsperoRetailFinalizationResult result = retailFinalizationProvider!.FinalizeFih(
                new ProsperoRetailFinalizationRequest
                {
                    FihHeader = header,
                }) ?? throw new InvalidOperationException("The Retail finalization provider returned null.");

            if (result.FihFinalizationMaterial is null ||
                result.FihFinalizationMaterial.Length != ProsperoPkgLayout.FihRetailFinalizationSize)
            {
                throw new InvalidDataException(
                    $"The Retail FIH finalization material must contain exactly " +
                    $"0x{ProsperoPkgLayout.FihRetailFinalizationSize:X} bytes.");
            }
            if (IsAllZero(result.FihFinalizationMaterial))
                throw new InvalidDataException("The Retail FIH finalization material is all zero.");

            result.FihFinalizationMaterial.CopyTo(
                header, ProsperoPkgLayout.FihRetailFinalizationOffset);
            si = result.SupplementalData
                ?? throw new InvalidDataException(
                    "The Retail finalization provider returned null supplemental data.");
            ResealOfficialCnt(metadata, header, retailFinalizationProvider);
            log(
                $"Applied Retail finalization: FIH+0x{ProsperoPkgLayout.FihRetailFinalizationOffset:X} " +
                $"size=0x{ProsperoPkgLayout.FihRetailFinalizationSize:X}, " +
                $"CNT authentication=0x{ProsperoPublisherRsa.ModulusSize:X}, supplemental=0x{si.Length:X}.");
        }
        FileStream? createdOutput = null;
        try
        {
            Stream fs = pfsAlreadyAtOutput
                ? separatePfs!
                : createdOutput = new FileStream(
                    outputFullPath, FileMode.Create, FileAccess.ReadWrite, FileShare.None,
                    bufferSize: 1 << 20, FileOptions.SequentialScan);
            fs.Position = 0;
            fs.Write(header, 0, header.Length);                 // 0x00000 .. 0x10000
            if (!pfsAlreadyAtOutput)
                CopyStreamRange(
                    pfsStream, fs, pfsStreamOffset, checked((long)pfsImageSize));
            else
                fs.Position = checked((long)embeddedCntOffset);
            fs.Write(metadata, 0, metadata.Length);             // embedded CNT
            fs.SetLength(checked((long)embeddedCntOffset + metadata.Length));
            fs.Flush();

            if (variant == ProsperoFihVariant.Debug && si is null &&
                siArchiveStreamFactory is not null)
            {
                fs.Position = 0;
                si = siArchiveStreamFactory(fs);
            }
            else if (variant == ProsperoFihVariant.Debug && si is null &&
                     siArchiveFactory is not null)
            {
                if (fs.Length > int.MaxValue)
                {
                    throw new InvalidOperationException(
                        "The byte-array SI factory cannot process a mount image larger than 2 GiB. " +
                        "Use siArchiveStreamFactory.");
                }
                fs.Position = 0;
                byte[] mountImage = new byte[checked((int)fs.Length)];
                fs.ReadExactly(mountImage);
                si = siArchiveFactory(mountImage);
            }

            if (si is { Length: > 0 })
            {
                fs.Position = fs.Length;
                fs.Write(si, 0, si.Length);                     // trailing SI segment
                log($"Appended SI segment: 0x{si.Length:X} bytes after the embedded CNT.");
            }
        }
        finally
        {
            createdOutput?.Dispose();
        }

        warnings.Add(
            "The finalized image carries a valid embedded CNT and PFS image: FIH 0x30 is " +
            "SHA3-256 of the plaintext outer superblock and 0x70/0xD0 carry GeneralDigests " +
            "Game/Target, the CNT package-digest " +
            "self-seal sits at CNT+0xFE0, and the GeneralDigests block (content/header/system/param/" +
            "playgo/target) plus the per-entry digest table are SHA3-256 of the plaintext CNT regions " +
            "and entries. " +
            (nestedImageDigest is { Length: 32 }
                ? "The FIH 0xB0 slot holds the publisher nested-layout digest from the build pass: " +
                  "SHA3-256 of naps_pkg_layout.dat; FIH 0xA8 stores that blob's exact byte length."
                : "The FIH 0xB0 slot holds a fallback SHA3-256 of the outer image: a standalone finalize " +
                  "has only the encrypted CNT and cannot recover the plaintext inner image; the CNT build " +
                  "path emits the nested-image-content digest.") +
            (variant == ProsperoFihVariant.Debug
                ? " The image targets debug-mode consoles."
                : " The image carries provider-issued standard Retail FIH finalization material."));
        log("Done (FIH).");
        return warnings;
    }

    internal static System.Collections.Generic.IReadOnlyList<string> BuildFromParts(
        string cntMetadataPath, string pfsImagePath, string fihOutputPath,
        ProsperoFihVariant variant = ProsperoFihVariant.Debug,
        Action<string>? logger = null, byte[]? siArchive = null,
        Func<byte[], byte[]>? siArchiveFactory = null,
        Func<Stream, byte[]>? siArchiveStreamFactory = null,
        byte[]? nestedImageDigest = null,
        long nestedImageSize = 0, long nestedMetaBaseBlocks = 0,
        uint nwonlyContentVersionHi = 0, int nwonlyNapsFileCount = 0,
        int nwonlyAppFileCount = 0, int nwonlySparseAfidCount = 0,
        int nwonlyEmptyFileCount = 0, int outerSuperblockIndex = -1,
        IProsperoRetailFinalizationProvider? retailFinalizationProvider = null,
        bool pfsAlreadyAtOutput = false)
        => BuildFromSources(
            cntMetadataPath, fihOutputPath, variant, logger, siArchive,
            siArchiveFactory, siArchiveStreamFactory, nestedImageDigest,
            nestedImageSize, nestedMetaBaseBlocks, nwonlyContentVersionHi,
            nwonlyNapsFileCount, nwonlyAppFileCount, nwonlySparseAfidCount,
            nwonlyEmptyFileCount, outerSuperblockIndex, retailFinalizationProvider,
            separatePfsPath: pfsImagePath, pfsAlreadyAtOutput);

    /// <summary>
    /// Builds the 0x10000-byte finalized-image (FIH) header block. This is a SHARED, cycle-free helper used
    /// by both the standalone FIH writer (<see cref="BuildFromCnt"/>) and the PS5 CNT builder so the
    /// fixed-info-digest (SHA3-256 of this block) is self-consistent. The image-content slot 0xB0 is the
    /// publisher nested-layout digest: when <paramref name="nestedImageDigest"/> is supplied by the
    /// PPR/NAPS CNT build path it is SHA3-256(<c>naps_pkg_layout.dat</c>); when it
    /// is null (the standalone finalize path, which only has the finished encrypted CNT) it falls back to the
    /// best-effort SHA3-256(outer image). Cycle-free either way: both inputs are final before the CNT digest
    /// table is computed (using the embedded CNT metadata here would create a digest cycle).
    /// </summary>
    internal static byte[] BuildFihHeaderBlock(
        ProsperoFihVariant variant, ulong pfsImageSize, ulong embeddedCntOffset,
        byte[] image, System.Collections.Generic.List<string>? warnings = null,
        byte[]? nestedImageDigest = null, long nestedImageSize = 0, long nestedMetaBaseBlocks = 0,
        uint nwonlyContentVersionHi = 0, int nwonlyNapsFileCount = 0, int nwonlyAppFileCount = 0,
        int nwonlySparseAfidCount = 0, int nwonlyEmptyFileCount = 0)
    {
        var (sbOffsetInImage, gameDigest) =
            ProsperoImageDigests.ComputeSblockDigestFromImage(image);
        byte[] imageDigest = gameDigest ?? ProsperoImageDigests.Sha3_256(image);
        return BuildFihHeaderBlock(
            variant, pfsImageSize, embeddedCntOffset,
            sbOffsetInImage, gameDigest, imageDigest, warnings,
            nestedImageDigest, nestedImageSize, nestedMetaBaseBlocks,
            nwonlyContentVersionHi, nwonlyNapsFileCount, nwonlyAppFileCount,
            nwonlySparseAfidCount, nwonlyEmptyFileCount);
    }

    internal static byte[] BuildFihHeaderBlock(
        ProsperoFihVariant variant, ulong pfsImageSize, ulong embeddedCntOffset,
        long sbOffsetInImage, byte[]? gameDigest, byte[] imageDigest,
        System.Collections.Generic.List<string>? warnings = null,
        byte[]? nestedImageDigest = null, long nestedImageSize = 0,
        long nestedMetaBaseBlocks = 0, uint nwonlyContentVersionHi = 0,
        int nwonlyNapsFileCount = 0, int nwonlyAppFileCount = 0,
        int nwonlySparseAfidCount = 0, int nwonlyEmptyFileCount = 0)
    {
        ArgumentNullException.ThrowIfNull(imageDigest);
        if (imageDigest.Length != ProsperoImageDigests.DigestSize)
            throw new ArgumentException("Image digest must contain exactly 32 bytes.", nameof(imageDigest));

        byte[] h = new byte[ProsperoPkgLayout.FihHeaderRegionSize];

        // ---- Structural fields (little-endian). ----
        h[0] = ProsperoPkgLayout.FihMagic[0];
        h[1] = ProsperoPkgLayout.FihMagic[1];
        h[2] = ProsperoPkgLayout.FihMagic[2];
        h[3] = ProsperoPkgLayout.FihMagic[3];
        h[4] = 0x01;
        h[ProsperoPkgLayout.FihSignedByteOffset] = (byte)(variant == ProsperoFihVariant.Official ? 0x80 : 0x00);
        h[6] = 0x03;
        BinaryPrimitives.WriteUInt32LittleEndian(h.AsSpan(0x08), 1);
        BinaryPrimitives.WriteUInt64LittleEndian(h.AsSpan(ProsperoPkgLayout.FihPfsImageOffsetField), (ulong)ProsperoPkgLayout.FihHeaderRegionSize);
        BinaryPrimitives.WriteUInt64LittleEndian(h.AsSpan(ProsperoPkgLayout.FihPfsImageSizeField), pfsImageSize);
        BinaryPrimitives.WriteUInt64LittleEndian(h.AsSpan(0x28), (ulong)ProsperoPkgLayout.FihHeaderRegionSize);
        BinaryPrimitives.WriteUInt64LittleEndian(h.AsSpan(ProsperoPkgLayout.FihEmbeddedCntOffsetField), embeddedCntOffset);
        BinaryPrimitives.WriteUInt64LittleEndian(h.AsSpan(0x60), (ulong)ProsperoPkgLayout.FihHeaderRegionSize);
        BinaryPrimitives.WriteUInt64LittleEndian(h.AsSpan(0x68), 0x800000000000UL);

        // 0x50 = the inner mount's data-region block count (= metaBase block index = MetaBaseLogical / 64KiB).
        // The installer's transfer reads this to size the mount's data region; a zero value is rejected.
        if (nestedMetaBaseBlocks > 0)
            BinaryPrimitives.WriteUInt64LittleEndian(h.AsSpan(ProsperoPkgLayout.FihDataRegionBlockCountField), (ulong)nestedMetaBaseBlocks);

        // ---- Finalized-image digest table. ----
        // sblock-digest = SHA3-256(plaintext outer superblock block, 0x10000 bytes), stored at
        // 0x30. Debug initializes 0x70/0xD0 to the same value; Official finalization replaces
        // those slots from CNT GeneralDigests Game/Target before the provider signs the FIH.
        // The FIH also records the
        // superblock's absolute offset (0x20) and size (0x28) so the loader can locate the hashed
        // block. See ProsperoImageDigests for the full digest construction.
        if (sbOffsetInImage >= 0 && gameDigest is not null)
        {
            ulong sbAbsoluteOffset = (ulong)ProsperoPkgLayout.FihHeaderRegionSize + (ulong)sbOffsetInImage;
            BinaryPrimitives.WriteUInt64LittleEndian(h.AsSpan(0x20), sbAbsoluteOffset);
            BinaryPrimitives.WriteUInt64LittleEndian(h.AsSpan(0x28), (ulong)ProsperoImageDigests.BlockSize);
            CopyDigest(h, 0x30, gameDigest);
            CopyDigest(h, 0x70, gameDigest);
            CopyDigest(h, 0xD0, gameDigest);

            // ---- Outer-PFS / nested-image accounting. ----
            // The nwonly outer PFS uses the "data-first" layout
            //   [pfs_image.dat blocks][naps_pkg_layout.dat blocks][superblock][structural metadata...].
            // Small layouts occupy one block, but dense APP layouts span many blocks.
            //   0x90 inner-image block count = sbBlockIndex - ceil(napsLayoutSize/blockSize)
            //   0x94 nonterminal NAPS FIDX count              = NumFiles-1 (nwonly), threaded in
            //   0x98 nonterminal count + empty-file boundaries
            //   0x9C content-version echo                     = full 8-digit BCD contentVersion
            //   0xA0 block-aligned inner-image size           = 0x90 * blockSize
            //   0xA8 naps_pkg_layout.dat (map[0xD]) length    = nestedImageSize (the 0xB0 digest preimage length)
            //   0xB0 nested-image-content digest              = SHA3-256(naps_pkg_layout.dat) [written below]
            //   0xF0 app-payload (non-sce_sys) file count
            //   0xF4 sparse AFID-hole count / 0xF8 flat-path-table accounting (=2)
            //   0xFC empty-file boundary count
            int blockSize = ProsperoPkgLayout.FihHeaderRegionSize;
            long sbBlockIndex = (long)sbOffsetInImage / blockSize;
            long totalBlocks = (long)pfsImageSize / blockSize;
            if (sbBlockIndex >= 1 && (long)sbOffsetInImage % blockSize == 0 &&
                (long)pfsImageSize % blockSize == 0 && totalBlocks > sbBlockIndex)
            {
                bool nwonly = nwonlyNapsFileCount > 0;
                long napsLayoutBlocks = nwonly && nestedImageSize > 0
                    ? checked((nestedImageSize + blockSize - 1) / blockSize)
                    : 1;
                if (napsLayoutBlocks <= 0 || napsLayoutBlocks > sbBlockIndex)
                    throw new InvalidDataException(
                        "The NAPS layout extent crosses the outer-PFS superblock.");
                uint innerBlocks = checked((uint)(sbBlockIndex - napsLayoutBlocks));
                // 0x94 is the number of nonterminal NAPS FIDX/file extents (NumFiles-1).
                // 0x98 mirrors it for ordinary files and additionally counts each zero-length
                // file boundary. It is not NumFiles: zero-empty fixtures have +0x94 == +0x98,
                // while one empty file produces +0x98 == +0x94 + 1. The legacy non-nwonly path
                // keeps its outer metadata-block count in both fields.
                uint metaOrNapsFiles = nwonly ? (uint)nwonlyNapsFileCount : (uint)(totalBlocks - innerBlocks);
                uint mirroredNapsFiles = nwonly
                    ? checked(metaOrNapsFiles + (uint)nwonlyEmptyFileCount)
                    : metaOrNapsFiles;
                BinaryPrimitives.WriteUInt32LittleEndian(h.AsSpan(ProsperoPkgLayout.FihInnerImageBlockCountField), innerBlocks);
                BinaryPrimitives.WriteUInt32LittleEndian(h.AsSpan(ProsperoPkgLayout.FihMetaBlockCountField), metaOrNapsFiles);
                BinaryPrimitives.WriteUInt32LittleEndian(h.AsSpan(ProsperoPkgLayout.FihMetaBlockCountMirrorField), mirroredNapsFiles);
                BinaryPrimitives.WriteUInt64LittleEndian(h.AsSpan(ProsperoPkgLayout.FihInnerImageSizeField), (ulong)innerBlocks * (ulong)blockSize);

                // 0x9C: content-version echo (high 32 bits of the param/content_ver u64; major BCD in the top byte).
                if (nwonlyContentVersionHi != 0)
                    BinaryPrimitives.WriteUInt32LittleEndian(h.AsSpan(ProsperoPkgLayout.FihContentVersionField), nwonlyContentVersionHi);

                // 0xA8: naps_pkg_layout.dat length (= ctx.0x14e0 = size of map[0xD], the 0xB0 digest preimage).
                if (nestedImageSize > 0)
                    BinaryPrimitives.WriteUInt64LittleEndian(h.AsSpan(ProsperoPkgLayout.FihInnerImageLogicalSizeField), (ulong)nestedImageSize);

                // 0xF0..0xFC: publisher AFID/inode accounting.
                uint outerFileCount = nwonly && nwonlyAppFileCount > 0 ? (uint)nwonlyAppFileCount : ProsperoPkgLayout.FihOuterFileCount;
                BinaryPrimitives.WriteUInt32LittleEndian(h.AsSpan(ProsperoPkgLayout.FihOuterFileCountField), outerFileCount);
                if (nwonly)
                {
                    BinaryPrimitives.WriteUInt32LittleEndian(
                        h.AsSpan(ProsperoPkgLayout.FihSparseAfidCountField),
                        checked((uint)nwonlySparseAfidCount));
                    BinaryPrimitives.WriteUInt32LittleEndian(
                        h.AsSpan(ProsperoPkgLayout.FihEmptyFileCountField),
                        checked((uint)nwonlyEmptyFileCount));
                }
                BinaryPrimitives.WriteUInt32LittleEndian(h.AsSpan(ProsperoPkgLayout.FihFlatPathTableBlockCountField), ProsperoPkgLayout.FihFlatPathTableBlockCount);
            }

            warnings?.Add(
                "FIH 0x30 is SHA3-256 of the plaintext outer superblock; 0x70/0xD0 are " +
                "GeneralDigests Game/Target, and the superblock offset/size are recorded at " +
                "0x20/0x28. The CNT package-digest " +
                "(CNT+0xFE0), content/header/system/param/playgo GeneralDigests and the per-entry digest " +
                "table are SHA3-256 of the plaintext CNT regions and entries. The FIH " +
                "0xB0 slot holds SHA3-256(naps_pkg_layout.dat) when the publisher builder threads it in, " +
                "otherwise a fallback " +
                "SHA3-256 of the outer image.");
        }
        else
        {
            // No data-first plaintext superblock in this image (e.g. the legacy zlib inner path):
            // fall back to a well-formed, parseable best-effort game-digest.
            CopyDigest(h, 0x30, imageDigest);
            CopyDigest(h, 0x70, imageDigest);
            CopyDigest(h, 0xD0, imageDigest);
            warnings?.Add(
                "FIH game-digest filled best-effort: no plaintext outer superblock was found in the " +
                "image (the SHA3-256(superblock) path applies to the nwonly outer-PFS image).");
        }

        // The distinct 0xB0 slot is the nested-image-content digest:
        // 0xB0 = SHA3-256(map[0xD]) where map[0xD] is the naps_pkg_layout.dat content. FIH 0xA8
        // is its length. The CNT build path threads that digest in via nestedImageDigest; the standalone
        // finalize path, which only has the finished encrypted CNT, falls back to SHA3-256(outer image).
        // Cycle-free either way: the naps is final before the CNT digest table is computed.
        CopyDigest(h, 0xB0, nestedImageDigest is { Length: 32 }
            ? nestedImageDigest
            : imageDigest);

        return h;
    }

    private static void CopyDigest(byte[] dst, int offset, byte[] digest32)
    {
        Array.Copy(digest32, 0, dst, offset, Math.Min(32, digest32.Length));
    }

    private static bool IsAllZero(ReadOnlySpan<byte> value)
    {
        foreach (byte b in value)
        {
            if (b != 0)
                return false;
        }
        return true;
    }

    private static void ApplyOfficialDigestSlots(byte[] fih, byte[] cnt)
    {
        ProsperoPkg package = ReadMetadataPackage(cnt);
        ProsperoPkgEntry? general = package.Entries.FirstOrDefault(
            entry => entry.RawId == (uint)ProsperoEntryId.GeneralDigests);
        if (general is null)
            throw new InvalidDataException("Official CNT has no GeneralDigests entry.");

        int dataOffset = checked((int)general.DataOffset);
        int dataSize = checked((int)general.DataSize);
        const int gameSlotOffset = 0x40;
        const int targetSlotOffset = 0x180;
        if (dataOffset < 0 || dataSize < targetSlotOffset + ProsperoImageDigests.DigestSize ||
            dataOffset > cnt.Length - dataSize)
        {
            throw new InvalidDataException("CNT GeneralDigests payload is outside the metadata region.");
        }

        cnt.AsSpan(dataOffset + gameSlotOffset, ProsperoImageDigests.DigestSize)
            .CopyTo(fih.AsSpan(0x70, ProsperoImageDigests.DigestSize));
        cnt.AsSpan(dataOffset + targetSlotOffset, ProsperoImageDigests.DigestSize)
            .CopyTo(fih.AsSpan(0xD0, ProsperoImageDigests.DigestSize));
    }

    private static void ResealOfficialCnt(
        byte[] cnt, byte[] finalizedFih, IProsperoRetailFinalizationProvider provider)
    {
        if (cnt.Length < 0x1000 + ProsperoPublisherRsa.ModulusSize)
            throw new InvalidDataException("CNT metadata is too short for the header authentication block.");

        // Standard finalization replaces fixed-info-digest with SHA3-256 of the completed FIH.
        // The GeneralDigests header slot is intentionally preserved: both observed Retail profiles
        // retain the build-stage value rather than the debug-profile formula over the final mount
        // descriptor. Consequently the GeneralDigests entry and its per-entry digest do not change.
        ProsperoImageDigests.ComputeFixedInfoDigest(finalizedFih)
            .CopyTo(cnt, 0x460);

        byte[] rollup = ProsperoImageDigests.ComputeCntHeaderRollupDigest(cnt);
        rollup.CopyTo(cnt, ProsperoImageDigests.CntHeaderRollupStoredOffset);

        byte[] packageDigest = ProsperoImageDigests.ComputePackageDigest(cnt);
        packageDigest.CopyTo(cnt, ProsperoImageDigests.PackageDigestStoredOffset);

        byte[] authentication = provider.FinalizeCntHeader(
            new ProsperoRetailCntFinalizationRequest
            {
                CntHeader = cnt.AsMemory(0, 0x1000),
            }) ?? throw new InvalidOperationException(
                "The Retail finalization provider returned null CNT authentication material.");
        if (authentication.Length != ProsperoPublisherRsa.ModulusSize || IsAllZero(authentication))
        {
            throw new InvalidDataException(
                $"The Retail CNT authentication material must contain exactly " +
                $"0x{ProsperoPublisherRsa.ModulusSize:X} non-zero bytes.");
        }
        authentication.CopyTo(cnt, 0x1000);
    }

    private static ProsperoPkg ReadMetadataPackage(byte[] cnt)
    {
        using var stream = new MemoryStream(cnt, writable: false);
        ProsperoPkg package = ProsperoPkgReader.Read(stream);
        if (package.Type != ProsperoPkgType.Meta)
            throw new InvalidDataException("Embedded metadata is not a CNT package.");
        return package;
    }

    private static (long SuperblockOffset, byte[]? GameDigest, byte[] ImageDigest)
        AnalyzeImageRange(Stream stream, long offset, long size, int knownSuperblockIndex)
    {
        if (knownSuperblockIndex >= 0)
        {
            long relative = checked((long)knownSuperblockIndex * ProsperoImageDigests.BlockSize);
            if (relative > size - ProsperoImageDigests.BlockSize)
                throw new InvalidDataException("Known outer superblock index is outside the PFS image.");
            byte[] superblock = ReadStreamRange(
                stream, checked(offset + relative), ProsperoImageDigests.BlockSize);
            if (BinaryPrimitives.ReadUInt64LittleEndian(superblock) != 2UL ||
                superblock[8] != 0x0B || superblock[9] != 0x2A ||
                superblock[10] != 0x33 || superblock[11] != 0x01)
            {
                throw new InvalidDataException(
                    "Known outer superblock index does not point to a PFS superblock.");
            }
            byte[] digest = ProsperoImageDigests.ComputeSblockDigest(superblock);
            return (relative, digest, digest);
        }

        Span<byte> identity = stackalloc byte[12];
        for (long relative = 0;
             relative <= size - ProsperoImageDigests.BlockSize;
             relative += ProsperoImageDigests.BlockSize)
        {
            stream.Position = checked(offset + relative);
            stream.ReadExactly(identity);
            if (BinaryPrimitives.ReadUInt64LittleEndian(identity) != 2UL ||
                identity[8] != 0x0B || identity[9] != 0x2A ||
                identity[10] != 0x33 || identity[11] != 0x01)
                continue;

            byte[] superblock = ReadStreamRange(
                stream, checked(offset + relative), ProsperoImageDigests.BlockSize);
            byte[] digest = ProsperoImageDigests.ComputeSblockDigest(superblock);
            return (relative, digest, digest);
        }

        var hash = new LibProsperoPkg.Util.ProsperoSha3.Incremental();
        byte[] buffer = new byte[1024 * 1024];
        stream.Position = offset;
        long remaining = size;
        while (remaining != 0)
        {
            int requested = (int)Math.Min(buffer.Length, remaining);
            int read = stream.Read(buffer, 0, requested);
            if (read == 0) throw new EndOfStreamException();
            hash.AppendData(buffer.AsSpan(0, read));
            remaining -= read;
        }
        return (-1, null, hash.GetHashAndReset());
    }

    private static byte[] ReadStreamRange(Stream stream, long offset, int size)
    {
        if (offset < 0 || size < 0 || offset > stream.Length || size > stream.Length - offset)
            throw new InvalidDataException("Requested CNT range is outside the input stream.");
        byte[] value = new byte[size];
        stream.Position = offset;
        stream.ReadExactly(value);
        return value;
    }

    private static void CopyStreamRange(Stream input, Stream output, long offset, long size)
    {
        if (offset < 0 || size < 0 || offset > input.Length || size > input.Length - offset)
            throw new InvalidDataException("Requested PFS range is outside the CNT input.");
        input.Position = offset;
        byte[] buffer = new byte[1024 * 1024];
        while (size != 0)
        {
            int requested = (int)Math.Min(buffer.Length, size);
            int read = input.Read(buffer, 0, requested);
            if (read == 0) throw new EndOfStreamException();
            output.Write(buffer, 0, read);
            size -= read;
        }
    }

}
