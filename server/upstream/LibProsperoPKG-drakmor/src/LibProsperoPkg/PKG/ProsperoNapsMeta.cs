// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// Builder for the NAPS metadata records (`common/etc/naps_meta_*.dat`) that are
// streamed into the SI (install-metadata) segment of a finalized image for the streaming output
// formats (`nwonly`). The NAPS record dispatcher routes each record id to a stored
// member by the `naps_meta_%d.dat` naming.
//
// Records and inputs:
// * naps_meta_300/301/302/308.dat -> all four ids carry the same 72-byte
// plaintext descriptor record. The record is nine little-endian u64 fields and is fully derived from
// the finalized inner-image geometry (no key, no console secret), so it is produced exactly here.
// * naps_meta_18.dat -> produced by BuildMeta18. The plaintext is a back-to-back TLV record stream
// (per-record 16-byte header: 4-byte tag, 1-byte version, 3 zero, u64 payload length) carrying the
// inner-image geometry (phdr), the content-file table (file/fstr), the per-block info tables
// (ibcl/i2ob/i2op/ihsh/rhsh) with real block digests over the finalized image, the outer digest
// (obdg), a fixed tweak marker (twek) and the four 72-byte descriptor records (pgpl/pgil/pgpi/pgpu,
// identical to naps_meta_300). When needed, a trailing zero record pads the stream to a 16-byte
// multiple. Publishing Tools 2.79 stores the TLV stream as plaintext.
//
// naps_meta_300 RECORD (72 bytes, all values little-endian):
// 0x00 u64 = 0 reserved (record start offset)
// 0x08 u64 = 0 reserved
// 0x10 u64 = R inner-image leading extent size (= innerImageSize - 0x20000)
// 0x18 u64 = 1 descriptor version
// 0x20 u64 = R inner-image leading extent size (repeated)
// 0x28 u64 = 0x10000 PFS block size
// 0x30 u64 = 0x3E9 (1001) constant NAPS-meta kind id
// 0x38 u64 = R + 0x10000
// 0x40 u64 = 0x20000 fixed trailing extent size
// R = innerImageSize - 0x20000 in the verified publisher APP and AC profiles.

using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using LibProsperoPkg.Util;

namespace LibProsperoPkg.PKG;

/// <summary>
/// Public description of one 256-KiB NAPS mapping block supplied to an optional integrity override.
/// The library computes the publisher weak checksum, SHA3-256 and rolling hash from
/// <see cref="Plaintext"/> or its file-backed source. A provider is only needed to override those values or to supply the
/// physical-block <c>obcc</c> table after the publisher AES-XTS transform.
/// </summary>
public readonly record struct ProsperoNapsIntegrityBlock(
    int Index,
    ulong CompressedOffset,
    uint StoredSize,
    uint PlainSize,
    bool IsHole,
    uint OwnerFlag,
    ulong Tail,
    long OnDiskOffset,
    uint OnDiskLength,
    ReadOnlyMemory<byte> Plaintext,
    byte[] Sha3Digest)
{
    /// <summary>Publisher weak checksum over the uncompressed input block.</summary>
    public ulong InputChecksum { get; init; }

    /// <summary>Publisher rolling hash over the uncompressed input block.</summary>
    public ulong RollingHash { get; init; }

    internal string? PlaintextSourcePath { get; init; }
    internal long PlaintextSourceOffset { get; init; }
}

/// <summary>
/// Complete input for producing the protected <c>ihsh</c>, <c>rhsh</c> and <c>obcc</c> portions of
/// <c>naps_meta_18.dat</c>. The provider may inspect both the finalized mount image and the physical
/// inner <c>pfs_image.dat</c>; no hidden package geometry has to be reconstructed by the caller.
/// </summary>
public sealed class ProsperoNapsIntegrityContext
{
    /// <summary>Block-aligned logical inner-image size recorded by the package.</summary>
    public required ulong InnerImageSize { get; init; }

    /// <summary>Finalized FIH + outer-PFS + CNT mount image used to build the SI.</summary>
    public required ReadOnlyMemory<byte> MountImage { get; init; }

    /// <summary>Physical packed <c>pfs_image.dat</c>, or an empty memory for a legacy identity map.</summary>
    public required ReadOnlyMemory<byte> PhysicalInnerImage { get; init; }

    /// <summary>
    /// Physical packed-image path for a file-backed build. Providers should prefer this when
    /// <see cref="PhysicalInnerImage"/> is empty.
    /// </summary>
    public string? PhysicalInnerImagePath { get; init; }

    /// <summary>Byte offset of the physical image within <see cref="PhysicalInnerImagePath"/>.</summary>
    public long PhysicalInnerImageOffset { get; init; }

    /// <summary>
    /// Publisher <c>pfs-image-key</c> returned by <c>sc2 estimate</c> (32 bytes). This is distinct
    /// from the passcode/content-id EKPFS used by the ordinary inner PFS key schedule.
    /// </summary>
    public ReadOnlyMemory<byte> PfsImageKey { get; init; }

    /// <summary>Publisher <c>pfs-image-seed</c> paired with <see cref="PfsImageKey"/> (16 bytes).</summary>
    public ReadOnlyMemory<byte> PfsImageSeed { get; init; }

    /// <summary>Mapping blocks in the exact order used by <c>i2ob/i2op/ihsh/rhsh</c>.</summary>
    public required IReadOnlyList<ProsperoNapsIntegrityBlock> MappingBlocks { get; init; }

    /// <summary>Reads one mapping block when a file-backed build leaves <c>Plaintext</c> empty.</summary>
    public byte[] ReadPlaintextBlock(int index)
    {
        ProsperoNapsIntegrityBlock block = MappingBlocks[index];
        if (!block.Plaintext.IsEmpty || block.PlainSize == 0)
            return block.Plaintext.ToArray();
        bool sourceBacked = !string.IsNullOrWhiteSpace(block.PlaintextSourcePath);
        string? path = sourceBacked ? block.PlaintextSourcePath : PhysicalInnerImagePath;
        if (string.IsNullOrWhiteSpace(path) ||
            (!sourceBacked && block.OnDiskLength != block.PlainSize))
            throw new InvalidDataException("The mapping block has no readable plaintext source.");
        var bytes = new byte[checked((int)block.PlainSize)];
        using var input = new FileStream(
            path, FileMode.Open, FileAccess.Read, FileShare.Read,
            bufferSize: 1 << 20, FileOptions.RandomAccess);
        input.Position = sourceBacked
            ? block.PlaintextSourceOffset
            : checked(PhysicalInnerImageOffset + block.OnDiskOffset);
        input.ReadExactly(bytes);
        return bytes;
    }

    /// <summary>Number of physical 64-KiB blocks represented by <c>obdg/obcc</c>.</summary>
    public int PhysicalInnerBlockCount => checked((int)(InnerImageSize / 0x10000));
}

/// <summary>
/// Optional publisher-profile override for integrity reductions inside <c>naps_meta_18.dat</c>.
/// The library emits the standard APP/AC weak checksums and rolling hashes itself. The provider
/// may override exact <c>obcc</c>; the built-in implementation produces it when the context carries
/// the 32-byte publisher PFS image key and 16-byte seed. Returned arrays are raw table payloads and
/// must have the exact lengths documented by each method. Returning <see langword="null"/> keeps
/// the built-in value.
/// </summary>
public interface IProsperoNapsIntegrityProvider
{
    /// <summary>
    /// Optionally replaces the eight-byte weak checksum prefix per mapping block. The library
    /// appends the SHA3-256 digest and the eight-byte <c>ihsh</c> tail itself.
    /// </summary>
    byte[]? BuildIhshPrefixes(ProsperoNapsIntegrityContext context);

    /// <summary>Optionally replaces one eight-byte <c>rhsh</c> rolling hash per mapping block.</summary>
    byte[]? BuildRollingHashes(ProsperoNapsIntegrityContext context);

    /// <summary>
    /// Returns one four-byte CRC32C value per physical inner block after the publisher AES-XTS
    /// transform, or <see langword="null"/> to leave the table zero-filled.
    /// </summary>
    byte[]? BuildOuterBlockCheckCodes(ProsperoNapsIntegrityContext context);
}

/// <summary>
/// Builder for the PS5 <c>naps_meta_*.dat</c> records emitted into the SI segment of a
/// <c>nwonly</c> finalized image. In the verified Publishing Tools 2.79 APP/AC profile, the
/// four <c>naps_meta_300/301/302/308</c> files contain the same 72-byte descriptor within one
/// package. The descriptor is derived from the inner-image geometry; <c>naps_meta_18.dat</c> is the
/// plaintext TLV metric blob built by <c>BuildMeta18</c> from the finalized image and its
/// content-file set. See <see cref="ProsperoSiArchive"/>.
/// </summary>
public static class ProsperoNapsMeta
{
    /// <summary>On-disk size of the <c>naps_meta_300/301/302/308</c> descriptor record, in bytes.</summary>
    public const int Meta300Length = 72;

    /// <summary>
    /// Constant NAPS-meta kind id stored at offset 0x30 of every verified APP/AC
    /// <c>naps_meta_300</c> record (<c>0x3E9</c> = 1001).
    /// </summary>
    public const ulong Meta300KindId = 0x3E9;

    /// <summary>
    /// PFS block size (64 KiB) used by the type-18 mapping tables and stored at offset 0x28 of
    /// <c>naps_meta_300</c>.
    /// </summary>
    public const ulong PfsBlockSize = 0x10000;

    /// <summary>Fixed 128-KiB trailing extent encoded by the NAPS meta-300 profile.</summary>
    public const ulong Meta300TrailingExtentSize = 0x20000;

    /// <summary>The four <c>naps_meta_*</c> ids that share the 72-byte descriptor.</summary>
    public static ReadOnlySpan<int> Meta300Ids => [300, 301, 302, 308];

    /// <summary>
    /// Builds the 72-byte <c>naps_meta_300</c> descriptor (also used verbatim for ids 301,
    /// 302 and 308) from the inner-image data-region size.
    /// </summary>
    /// <param name="innerImageDataRegionSize">
    /// The inner-image data-region size <c>R</c> (offsets 0x10 and 0x20): the size of the compressed
    /// inner-image content that precedes the inner image's own metadata block. Equals
    /// <c>innerImageSize - 0x20000</c> in the verified publisher profile.
    /// </param>
    /// <returns>A fresh 72-byte array containing the descriptor.</returns>
    public static byte[] BuildMeta300(ulong innerImageDataRegionSize)
    {
        byte[] record = new byte[Meta300Length];
        Span<byte> s = record;
        // 0x00, 0x08 already zero.
        BinaryPrimitives.WriteUInt64LittleEndian(s.Slice(0x10, 8), innerImageDataRegionSize);
        BinaryPrimitives.WriteUInt64LittleEndian(s.Slice(0x18, 8), 1);
        BinaryPrimitives.WriteUInt64LittleEndian(s.Slice(0x20, 8), innerImageDataRegionSize);
        BinaryPrimitives.WriteUInt64LittleEndian(s.Slice(0x28, 8), PfsBlockSize);
        BinaryPrimitives.WriteUInt64LittleEndian(s.Slice(0x30, 8), Meta300KindId);
        BinaryPrimitives.WriteUInt64LittleEndian(s.Slice(0x38, 8), checked(innerImageDataRegionSize + PfsBlockSize));
        BinaryPrimitives.WriteUInt64LittleEndian(s.Slice(0x40, 8), Meta300TrailingExtentSize);
        return record;
    }

    /// <summary>
    /// Builds the <c>naps_meta_300</c> descriptor from the full block-aligned inner-image size (the
    /// value the finalized-image header carries at offset 0xA0). Equivalent to
    /// <see cref="BuildMeta300(ulong)"/> with <c>innerImageSize - 0x20000</c>.
    /// </summary>
    /// <param name="innerImageSize">Block-aligned inner-image size; must be at least one block.</param>
    public static byte[] BuildMeta300FromInnerImageSize(ulong innerImageSize)
    {
        if (innerImageSize < Meta300TrailingExtentSize)
            throw new ArgumentOutOfRangeException(nameof(innerImageSize),
                $"inner-image size 0x{innerImageSize:X} is smaller than the 0x{Meta300TrailingExtentSize:X} trailing extent");
        return BuildMeta300(innerImageSize - Meta300TrailingExtentSize);
    }

    // ---- naps_meta_18 (AES-128-XTS TLV metric blob) ----

    /// <summary>Image block size used for the per-block info tables (64 KiB).</summary>
    private const int Meta18BlockSize = 0x10000;

    // Fixed AES-128-XTS key set for the naps_meta_18 data unit. Constant across all packages.
    private static readonly byte[] Meta18DataKey =
        [0x02, 0x2D, 0xCA, 0xF6, 0xD1, 0x11, 0xE5, 0x8F, 0x25, 0x93, 0x6E, 0xF5, 0x46, 0x93, 0x45, 0xAB];
    private static readonly byte[] Meta18TweakKey =
        [0xAD, 0xAC, 0x16, 0x37, 0x60, 0xDA, 0x51, 0x46, 0x98, 0xC2, 0x45, 0xAB, 0x4C, 0x9C, 0x42, 0x6C];
    private static readonly byte[] Meta18Tweak =
        [0x3C, 0xBA, 0x10, 0x7D, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];

    /// <summary>
    /// Builds the plaintext <c>naps_meta_18.dat</c> metric blob for a finalized image. The TLV
    /// carries the inner-image geometry (phdr), the content-file table (file/fstr), the per-block info
    /// tables (ibcl/i2ob/i2op/ihsh/rhsh) with real block digests over <paramref name="mountImage"/>, the
    /// outer digest (obdg), a fixed marker (twek) and the four 72-byte descriptor records
    /// (pgpl/pgil/pgpi/pgpu). The stream is padded to a 16-byte multiple.
    /// </summary>
    /// <param name="innerImageSize">Block-aligned inner-image size (finalized-image header offset 0xA0).</param>
    /// <param name="mountImage">The finalized FIH+PFS+CNT mount image; block digests are computed over it.</param>
    /// <param name="contentFiles">Inner content files in load order: relative path and plain size.</param>
    /// <param name="inner">
    /// The assembled nwonly inner-image result. When supplied, the per-block info tables
    /// (ibcl/i2ob/i2op/ihsh) and the <c>file</c> record describe the compressed <b>inner</b>-image NAPS
    /// block map (afid raw extents + data-region hole ublocks + metadata ublocks) instead of an identity
    /// map over the outer <paramref name="mountImage"/>. When <see langword="null"/> (legacy inners), the
    /// exact previous outer-block behavior is kept. <c>obdg</c>/<c>rhsh</c> stay over the outer image in
    /// both cases.
    /// </param>
    /// <param name="integrityProvider">
    /// Optional publisher-profile implementation for the protected <c>ihsh</c> prefixes,
    /// <c>rhsh</c> reductions and <c>obcc</c> check codes.
    /// </param>
    /// <param name="pfsImageKey">
    /// Optional 32-byte publisher PFS image key. Supply together with
    /// <paramref name="pfsImageSeed"/> to generate exact <c>obcc</c> values in-process.
    /// </param>
    /// <param name="pfsImageSeed">Optional 16-byte publisher PFS image seed.</param>
    /// <returns>The plaintext blob (length a multiple of 16), or an empty array when inputs are insufficient.</returns>
    public static byte[] BuildMeta18(
        ulong innerImageSize, byte[] mountImage, IReadOnlyList<(string Path, long Size)> contentFiles,
        LibProsperoPkg.PFS.ProsperoPs5InnerImageResult? inner = null,
        IProsperoNapsIntegrityProvider? integrityProvider = null,
        byte[]? pfsImageKey = null,
        byte[]? pfsImageSeed = null)
    {
        ArgumentNullException.ThrowIfNull(mountImage);
        ArgumentNullException.ThrowIfNull(contentFiles);
        return BuildMeta18Core(
            innerImageSize, mountImage.LongLength, mountImage, contentFiles, inner,
            integrityProvider, pfsImageKey, pfsImageSeed, default);
    }

    /// <summary>
    /// Builds type-18 metadata for a file-backed mount image. This overload needs only the mount
    /// length because publisher nwonly integrity mapping is derived from <paramref name="inner"/>;
    /// it avoids retaining a multi-gigabyte FIH/PFS/CNT byte array.
    /// </summary>
    public static byte[] BuildMeta18(
        ulong innerImageSize, long mountImageSize,
        IReadOnlyList<(string Path, long Size)> contentFiles,
        LibProsperoPkg.PFS.ProsperoPs5InnerImageResult inner,
        IProsperoNapsIntegrityProvider? integrityProvider = null,
        byte[]? pfsImageKey = null,
        byte[]? pfsImageSeed = null)
    {
        ArgumentNullException.ThrowIfNull(contentFiles);
        ArgumentNullException.ThrowIfNull(inner);
        return BuildMeta18Core(
            innerImageSize, mountImageSize, [], contentFiles, inner,
            integrityProvider, pfsImageKey, pfsImageSeed, default);
    }

    internal static byte[] BuildMeta18WithPhysicalBlockDigests(
        ulong innerImageSize, long mountImageSize,
        IReadOnlyList<(string Path, long Size)> contentFiles,
        LibProsperoPkg.PFS.ProsperoPs5InnerImageResult inner,
        ReadOnlyMemory<byte> physicalBlockDigests,
        IProsperoNapsIntegrityProvider? integrityProvider = null,
        byte[]? pfsImageKey = null,
        byte[]? pfsImageSeed = null)
    {
        ArgumentNullException.ThrowIfNull(contentFiles);
        ArgumentNullException.ThrowIfNull(inner);
        return BuildMeta18Core(
            innerImageSize, mountImageSize, [], contentFiles, inner,
            integrityProvider, pfsImageKey, pfsImageSeed, physicalBlockDigests);
    }

    private static byte[] BuildMeta18Core(
        ulong innerImageSize, long mountImageSize, byte[] mountImage,
        IReadOnlyList<(string Path, long Size)> contentFiles,
        LibProsperoPkg.PFS.ProsperoPs5InnerImageResult? inner,
        IProsperoNapsIntegrityProvider? integrityProvider,
        byte[]? pfsImageKey,
        byte[]? pfsImageSeed,
        ReadOnlyMemory<byte> physicalBlockDigests)
    {
        if (innerImageSize < PfsBlockSize || mountImageSize < Meta18BlockSize)
            return [];
        if (mountImageSize < 0 || mountImageSize % Meta18BlockSize != 0)
            throw new ArgumentOutOfRangeException(
                nameof(mountImageSize), "Mount-image size must be a non-negative multiple of 64 KiB.");

        uint innerBlocks = (uint)(innerImageSize / PfsBlockSize);
        int outerBlocks = checked((int)(mountImageSize / Meta18BlockSize));
        if (!physicalBlockDigests.IsEmpty &&
            physicalBlockDigests.Length != checked((int)innerBlocks * 32))
            throw new InvalidDataException("The precomputed physical-block digest table has the wrong length.");

        // nwonly: build ibcl/i2ob/i2op/ihsh/file over the compressed INNER-image NAPS block map so the
        // installer derives a nonzero, 0x10000-aligned content package_size and clears the 0x80b21185
        // geometry gate. Legacy inners pass inner==null and keep the outer identity-map behavior.
        List<Meta18Block>? blocks = inner is not null ? BuildInnerBlocks(inner) : null;
        int metaFirstBlockIndex = blocks is null ? -1 : blocks.FindIndex(b => !b.IsHole && b.Tail == Meta300KindId);
        ProsperoNapsIntegrityContext integrityContext =
            BuildIntegrityContext(
                innerImageSize, mountImage, inner, blocks, pfsImageKey, pfsImageSeed);
        byte[] ihshPrefixes = BuildIhshPrefixes(integrityContext);
        byte[] rollingHashes = BuildRollingHashes(integrityContext);
        byte[] outerBlockCheckCodes = BuildOuterBlockCheckCodes(integrityContext);
        byte[]? providerIhshPrefixes = integrityProvider?.BuildIhshPrefixes(integrityContext);
        byte[]? providerRollingHashes = integrityProvider?.BuildRollingHashes(integrityContext);
        byte[]? providerOuterBlockCheckCodes = integrityProvider?.BuildOuterBlockCheckCodes(integrityContext);
        ValidateProtectedTable(
            providerIhshPrefixes, checked(integrityContext.MappingBlocks.Count * 8), "ihsh prefix");
        ValidateProtectedTable(
            providerRollingHashes, checked(integrityContext.MappingBlocks.Count * 8), "rhsh");
        ValidateProtectedTable(
            providerOuterBlockCheckCodes, checked(integrityContext.PhysicalInnerBlockCount * 4), "obcc");
        ihshPrefixes = providerIhshPrefixes ?? ihshPrefixes;
        rollingHashes = providerRollingHashes ?? rollingHashes;
        outerBlockCheckCodes = providerOuterBlockCheckCodes ?? outerBlockCheckCodes;

        var plain = new List<byte>(4096);

        // phdr: [ver=1, 0x50, physical inner blocks, mapping block size, 1,
        // physical block size] (six u32). The mapping unit is always 256 KiB.
        {
            Span<byte> p = stackalloc byte[0x18];
            WriteU32(p, 0x00, 1);
            WriteU32(p, 0x04, 0x50);
            WriteU32(p, 0x08, innerBlocks);
            WriteU32(p, 0x0C, 0x40000);
            WriteU32(p, 0x10, 1);
            WriteU32(p, 0x14, (uint)PfsBlockSize);
            WriteRecord(plain, "phdr", 1, p);
        }

        // file: one 0x18 entry per content file
        // [u64 size, u32 first block index, u32 block count, u32 field10, u32 executable flag].
        // The nwonly "*PFSmetadata" pseudo-file uses its plaintext size, the first metadata i2ob
        // index, block-count marker 3, field10 0x3E9, and flag 0.
        {
            var body = new byte[contentFiles.Count * 0x18];
            uint firstBlock = 0;
            for (int i = 0; i < contentFiles.Count; i++)
            {
                Span<byte> e = body.AsSpan(i * 0x18, 0x18);
                bool isMeta = blocks is not null && contentFiles[i].Path == PfsMetadataFileName;
                uint blockCount = isMeta
                    ? 3u
                    : inner is not null && i < inner.Placements.Count
                        ? checked((uint)PlacementBlockCount(inner.Placements[i]))
                        : 1u;
                uint sparseBlocksBefore = !isMeta &&
                    inner is not null && i < inner.Placements.Count
                    ? checked((uint)inner.SparseAfidHoles.Count(
                        hole => hole.Afid < inner.Placements[i].Afid))
                    : 0u;
                uint idx = isMeta && metaFirstBlockIndex >= 0
                    ? (uint)metaFirstBlockIndex
                    : checked(firstBlock + sparseBlocksBefore);
                uint field10 = isMeta ? (uint)Meta300KindId : 0u;
                uint flag = !isMeta && inner is not null &&
                    i < inner.Placements.Count &&
                    IsExecutableAfid(inner, checked((int)inner.Placements[i].Afid))
                    ? 1u
                    : 0u;
                ulong size = isMeta && inner is not null
                    ? (ulong)inner.MetadataPlaintext.Length
                    : (ulong)contentFiles[i].Size;
                BinaryPrimitives.WriteUInt64LittleEndian(e[..8], size);
                WriteU32(e, 0x08, idx);
                WriteU32(e, 0x0C, blockCount);
                WriteU32(e, 0x10, field10);
                WriteU32(e, 0x14, flag);
                if (!isMeta)
                    firstBlock = checked(firstBlock + blockCount);
            }
            WriteRecord(plain, "file", 2, body);
        }

        // ftyp: one 0x38 entry per content file. Publisher records repeat the logical size and
        // block count and mark real payload files as enabled; *PFSmetadata uses marker 3 and is
        // not enabled.
        if (blocks is not null)
        {
            var body = new byte[contentFiles.Count * 0x38];
            for (int i = 0; i < contentFiles.Count; i++)
            {
                Span<byte> e = body.AsSpan(i * 0x38, 0x38);
                bool isMeta = contentFiles[i].Path == PfsMetadataFileName;
                ulong size = isMeta && inner is not null
                    ? (ulong)inner.MetadataPlaintext.Length
                    : (ulong)contentFiles[i].Size;
                ulong blockCount = isMeta
                    ? 3u
                    : inner is not null && i < inner.Placements.Count
                        ? (ulong)PlacementBlockCount(inner.Placements[i])
                        : 1u;
                BinaryPrimitives.WriteUInt64LittleEndian(e.Slice(0x00, 8), 1);
                BinaryPrimitives.WriteUInt64LittleEndian(e.Slice(0x08, 8), size);
                BinaryPrimitives.WriteUInt64LittleEndian(e.Slice(0x10, 8), size);
                BinaryPrimitives.WriteUInt64LittleEndian(e.Slice(0x18, 8), blockCount);
            }
            WriteRecord(plain, "ftyp", 1, body);
        }

        // ibcl: one class byte per block. Inner path: 0x01 when the block's owning content file has
        // flag==1 (right.sprx/eboot), else 0x0F (keystone + every hole/metadata block).
        {
            if (blocks is not null)
            {
                var body = new byte[blocks.Count];
                for (int i = 0; i < blocks.Count; i++)
                    body[i] = blocks[i].OwnerFlag == 1 ? (byte)0x01 : (byte)0x0F;
                WriteRecord(plain, "ibcl", 1, body);
            }
            else
            {
                var body = new byte[outerBlocks];
                Array.Fill(body, (byte)0x0F);
                WriteRecord(plain, "ibcl", 1, body);
            }
        }
        // The publisher writes a second ibcl plane of the same length.  It is zero for the
        // verified APP and AC nwonly profiles.
        if (blocks is not null)
            WriteRecord(plain, "ibcl", 1, new byte[blocks.Count]);

        // i2ob: 0x28 per block. Inner path:
        //   +0x00 u64 co (compressed offset in pfs_image.dat) +0x08 u32 cs (=c0+c1) +0x0C u32 ps (plaintext
        //   coverage) +0x10 u32 c0 (first 0x20000 sub-chunk) +0x14 u32 c1 (second) +0x18 u32 mb (=co>>16)
        //   +0x1C u32 0 +0x20 u32 1 +0x24 u32 flag (0x40090000 afid|0x40110000 hole|0x40450000 meta-full|
        //   0x40050000 meta-last).
        {
            if (blocks is not null)
            {
                var body = new byte[blocks.Count * 0x28];
                for (int i = 0; i < blocks.Count; i++)
                {
                    Meta18Block b = blocks[i];
                    Span<byte> e = body.AsSpan(i * 0x28, 0x28);
                    BinaryPrimitives.WriteUInt64LittleEndian(e[..8], b.Co);
                    WriteU32(e, 0x08, b.Cs);
                    WriteU32(e, 0x0C, b.Ps);
                    WriteU32(e, 0x10, b.C0);
                    WriteU32(e, 0x14, b.C1);
                    WriteU32(e, 0x18, (uint)(b.Co >> 16));
                    WriteU32(e, 0x20, 1);
                    WriteU32(e, 0x24, b.Flag);
                }
                WriteRecord(plain, "i2ob", 1, body);
            }
            else
            {
                var body = new byte[outerBlocks * 0x28];
                for (int i = 0; i < outerBlocks; i++)
                {
                    Span<byte> e = body.AsSpan(i * 0x28, 0x28);
                    BinaryPrimitives.WriteUInt64LittleEndian(e[..8], (ulong)i * Meta18BlockSize);
                    WriteU32(e, 0x08, (uint)Meta18BlockSize);
                    WriteU32(e, 0x0C, (uint)Meta18BlockSize);
                    WriteU32(e, 0x10, (uint)Meta18BlockSize);
                    WriteU32(e, 0x24, 0x40090000);
                }
                WriteRecord(plain, "i2ob", 1, body);
            }
        }

        // i2op: 0x10 per block [u64 co, u64 co>>16] (a pure projection of i2ob on the inner path; the
        // identity map for a legacy stored image).
        {
            if (blocks is not null)
            {
                var body = new byte[blocks.Count * 0x10];
                for (int i = 0; i < blocks.Count; i++)
                {
                    Span<byte> e = body.AsSpan(i * 0x10, 0x10);
                    BinaryPrimitives.WriteUInt64LittleEndian(e[..8], blocks[i].Co);
                    BinaryPrimitives.WriteUInt64LittleEndian(e.Slice(8, 8), blocks[i].Co >> 16);
                }
                WriteRecord(plain, "i2op", 1, body);
            }
            else
            {
                var body = new byte[outerBlocks * 0x10];
                for (int i = 0; i < outerBlocks; i++)
                {
                    Span<byte> e = body.AsSpan(i * 0x10, 0x10);
                    BinaryPrimitives.WriteUInt64LittleEndian(e[..8], (ulong)i * Meta18BlockSize);
                    BinaryPrimitives.WriteUInt64LittleEndian(e.Slice(8, 8), (ulong)i * Meta18BlockSize);
                }
                WriteRecord(plain, "i2op", 1, body);
            }
        }

        // ihsh: 0x30 per block [u64 weak checksum, SHA3-256(input), u64 tail].
        // Both hashes are over the original uncompressed input block, not the Kraken payload.
        // AFID entries use tail 0; data-region holes and metadata use NAPS id 0x3E9.
        {
            if (blocks is not null)
            {
                var body = new byte[blocks.Count * 0x30];
                for (int i = 0; i < blocks.Count; i++)
                {
                    Meta18Block b = blocks[i];
                    Span<byte> e = body.AsSpan(i * 0x30, 0x30);
                    ihshPrefixes.AsSpan(i * 8, 8).CopyTo(e[..8]);
                    integrityContext.MappingBlocks[i].Sha3Digest.AsSpan(0, 32)
                        .CopyTo(e.Slice(0x08, 32));
                    BinaryPrimitives.WriteUInt64LittleEndian(e.Slice(0x28, 8), b.Tail);
                }
                WriteRecord(plain, "ihsh", 1, body);
            }
            else
            {
                var body = new byte[outerBlocks * 0x30];
                for (int i = 0; i < outerBlocks; i++)
                {
                    Span<byte> e = body.AsSpan(i * 0x30, 0x30);
                    ihshPrefixes.AsSpan(i * 8, 8).CopyTo(e[..8]);
                    integrityContext.MappingBlocks[i].Sha3Digest.AsSpan(0, 32)
                        .CopyTo(e.Slice(0x08, 32));
                }
                WriteRecord(plain, "ihsh", 1, body);
            }
        }

        // rhsh: one producer rolling hash per uncompressed input block. The standard profile uses
        // a 0x10000-byte window, zero-pads a shorter input to that window and combines the two
        // 64-bit accumulators with a 25-bit shift.
        {
            int count = blocks?.Count ?? outerBlocks;
            var body = new byte[checked(count * 8)];
            rollingHashes.CopyTo(body, 0);
            WriteRecord(plain, "rhsh", 1, body);
        }

        // fstr: content-file relative paths, each (including the last) NUL-terminated.
        {
            var sb = new StringBuilder();
            foreach (var (path, _) in contentFiles)
            {
                sb.Append(path.Replace('\\', '/'));
                sb.Append('\0');
            }
            WriteRecord(plain, "fstr", 1, Encoding.ASCII.GetBytes(sb.ToString()));
        }

        // twek: [0, physical inner block count, 0, 0, 0].
        {
            Span<byte> p = stackalloc byte[0x14];
            WriteU32(p, 0x04, innerBlocks);
            WriteRecord(plain, "twek", 1, p);
        }

        // obdg: one SHA3-256 digest per physical block of pfs_image.dat.
        {
            byte[] body = physicalBlockDigests.IsEmpty
                ? new byte[checked((int)innerBlocks * 32)]
                : physicalBlockDigests.ToArray();
            if (physicalBlockDigests.IsEmpty)
            {
                using Stream? image = inner?.OpenImage();
                byte[] block = new byte[Meta18BlockSize];
                for (int i = 0; i < innerBlocks; i++)
                {
                    ReadOnlySpan<byte> input = ReadOnlySpan<byte>.Empty;
                    if (image is not null &&
                        image.Length >= checked((long)(i + 1) * Meta18BlockSize))
                    {
                        image.Position = (long)i * Meta18BlockSize;
                        image.ReadExactly(block);
                        input = block;
                    }
                    ProsperoImageDigests.Sha3_256(input).CopyTo(body, i * 32);
                }
            }
            WriteRecord(plain, "obdg", 1, body);
        }

        // obcc: CRC32C (Castagnoli) of each block after the publisher's temporary AES-XTS
        // transform. It is not CRC32C of the stored pfs_image.dat bytes. The built-in path uses
        // the sc2 pfs-image-key/seed pair; without that pair it intentionally remains zero.
        WriteRecord(
            plain,
            "obcc",
            1,
            outerBlockCheckCodes);

        // pgpl/pgil/pgpi/pgpu: the 72-byte descriptor, identical to naps_meta_300.
        {
            byte[] desc = BuildMeta300FromInnerImageSize(innerImageSize);
            WriteRecord(plain, "pgpl", 1, desc);
            WriteRecord(plain, "pgil", 1, desc);
            WriteRecord(plain, "pgpi", 1, desc);
            WriteRecord(plain, "pgpu", 1, desc);
        }

        WriteRecord(plain, "gitt", 1, Encoding.ASCII.GetBytes("v1.5.0\0"));
        WriteRecord(plain, "gith", 1, Encoding.ASCII.GetBytes(
            "7553c74caeba25754fbd4bee717652da631c08e4\0"));

        // zero: only present when the preceding records do not already end on a 16-byte boundary.
        int pad = (16 - (plain.Count % 16)) % 16;
        if (pad != 0) WriteRecord(plain, "zero", 1, new byte[pad]);

        return plain.ToArray();
    }

    /// <summary>
    /// Returns a publisher plaintext <c>naps_meta_18.dat</c> TLV, while retaining read support for
    /// legacy PS5Library AES-XTS output.
    /// </summary>
    public static byte[] DecryptMeta18(byte[] encrypted)
    {
        ArgumentNullException.ThrowIfNull(encrypted);
        if (encrypted.Length >= 40 && encrypted.AsSpan(0, 4).SequenceEqual("rdhp"u8) &&
            encrypted[4] == 1 && encrypted[5] == 0 && encrypted[6] == 0 && encrypted[7] == 0 &&
            BinaryPrimitives.ReadUInt64LittleEndian(encrypted.AsSpan(8, 8)) == 24)
            return (byte[])encrypted.Clone();
        if (encrypted.Length == 0 || encrypted.Length % 16 != 0)
            throw new InvalidDataException(
                "naps_meta_18.dat must be a non-empty multiple of the 16-byte AES-XTS block size.");
        return AesXtsTransform(encrypted, decrypt: true);
    }

    private static void WriteU32(Span<byte> dst, int offset, uint value) =>
        BinaryPrimitives.WriteUInt32LittleEndian(dst.Slice(offset, 4), value);

    private static void ValidateProtectedTable(byte[]? table, int expectedLength, string name)
    {
        if (table is not null && table.Length != expectedLength)
            throw new InvalidDataException(
                $"NAPS {name} provider returned 0x{table.Length:X} bytes; expected 0x{expectedLength:X}.");
    }

    // Emits one TLV record: 4-byte tag (stored in reverse byte order), 1-byte version, 3 zero, u64 length, payload.
    private static void WriteRecord(List<byte> dst, string tag, byte version, ReadOnlySpan<byte> payload)
    {
        dst.Add((byte)tag[3]);
        dst.Add((byte)tag[2]);
        dst.Add((byte)tag[1]);
        dst.Add((byte)tag[0]);
        dst.Add(version);
        dst.Add(0);
        dst.Add(0);
        dst.Add(0);
        Span<byte> len = stackalloc byte[8];
        BinaryPrimitives.WriteUInt64LittleEndian(len, (ulong)payload.Length);
        for (int i = 0; i < 8; i++) dst.Add(len[i]);
        for (int i = 0; i < payload.Length; i++) dst.Add(payload[i]);
    }

    // AES-128-XTS over the whole buffer as a single data unit (length must be a multiple of 16).
    private static byte[] AesXtsTransform(byte[] input, bool decrypt)
    {
        using var aesData = Aes.Create();
        aesData.Mode = CipherMode.ECB;
        aesData.Padding = PaddingMode.None;
        aesData.Key = Meta18DataKey;
        using var aesTweak = Aes.Create();
        aesTweak.Mode = CipherMode.ECB;
        aesTweak.Padding = PaddingMode.None;
        aesTweak.Key = Meta18TweakKey;

        using ICryptoTransform dataTransform = decrypt
            ? aesData.CreateDecryptor()
            : aesData.CreateEncryptor();
        using ICryptoTransform tweakEnc = aesTweak.CreateEncryptor();

        byte[] t = tweakEnc.TransformFinalBlock(Meta18Tweak, 0, 16);
        var output = new byte[input.Length];
        var block = new byte[16];
        for (int i = 0; i < input.Length; i += 16)
        {
            for (int j = 0; j < 16; j++) block[j] = (byte)(input[i + j] ^ t[j]);
            byte[] transformed = dataTransform.TransformFinalBlock(block, 0, 16);
            for (int j = 0; j < 16; j++) output[i + j] = (byte)(transformed[j] ^ t[j]);
            t = GfMulAlpha(t);
        }
        return output;
    }

    // Multiply a 128-bit little-endian tweak by the element x in GF(2^128), reduction polynomial 0x87.
    private static byte[] GfMulAlpha(byte[] t)
    {
        var r = new byte[16];
        int carry = 0;
        for (int i = 0; i < 16; i++)
        {
            int b = t[i];
            r[i] = (byte)(((b << 1) | carry) & 0xFF);
            carry = (b >> 7) & 1;
        }
        if (carry != 0) r[0] ^= 0x87;
        return r;
    }

    // ---- nwonly inner-image NAPS block map (for ibcl/i2ob/i2op/ihsh/file) --------------------------

    /// <summary>256 KiB uncompressed NAPS block used by the inner-image geometry.</summary>
    private const long Meta18UBlock = 0x40000;

    /// <summary>The pseudo content-file name the nwonly SI appends for the inner PFS metadata region.</summary>
    private const string PfsMetadataFileName = "*PFSmetadata";

    /// <summary>
    /// One entry of the compressed inner-image NAPS block map. <see cref="Co"/> is the block's byte offset
    /// inside the packed <c>pfs_image.dat</c>; <see cref="Cs"/> its stored/compressed size (== C0+C1);
    /// <see cref="Ps"/> the plaintext byte span it covers; <see cref="C0"/>/<see cref="C1"/> the two
    /// 0x20000 sub-chunk compressed sizes; <see cref="Flag"/> the block-class word. <see cref="OwnerFlag"/>
    /// drives ibcl; <see cref="Tail"/> is the ihsh trailer (0x3E9 for metadata). For a real (non-hole)
    /// block, <see cref="OnDiskOffset"/>/<see cref="OnDiskLen"/> locate its compressed bytes in the image.
    /// </summary>
    private readonly record struct Meta18Block(
        ulong Co, uint Cs, uint Ps, uint C0, uint C1, uint Flag,
        bool IsHole, uint OwnerFlag, ulong Tail, long OnDiskOffset, uint OnDiskLen,
        ReadOnlyMemory<byte> Plaintext, long LogicalOffset, long PlaintextImageOffset = -1,
        string? PlaintextSourcePath = null, long PlaintextSourceOffset = -1);

    private static int PlacementBlockCount(LibProsperoPkg.PFS.ProsperoPs5InnerPlacement placement)
    {
        if (placement.CompressionBlocks is { Count: > 0 } chunks)
            return chunks.Count;
        return checked((int)Math.Max(
            1,
            (placement.UncompressedSize + Meta18UBlock - 1) / Meta18UBlock));
    }

    private static bool IsExecutableAfid(
        LibProsperoPkg.PFS.ProsperoPs5InnerImageResult? inner,
        int afid)
    {
        if (inner is null)
            return false;
        return inner.Nodes.Any(n =>
            !n.IsDirectory &&
            n.Afid == (uint)afid &&
            (n.Flags & 0x40u) != 0);
    }

    /// <summary>
    /// Derives the compressed inner-image NAPS block map for <paramref name="inner"/>: the 3-way afid raw
    /// extents (<see cref="LibProsperoPkg.PFS.ProsperoPs5InnerPlacement"/>), the data-region hole ublocks tiling
    /// <c>[DataEndLogical, MetaBaseLogical)</c>, and the metadata ublocks (<c>MetadataBlocks</c>). This is
    /// the same geometry <see cref="ProsperoNwonlyNapsGenerator"/> emits for <c>naps_pkg_layout.dat</c>.
    /// </summary>
    private static List<Meta18Block> BuildInnerBlocks(LibProsperoPkg.PFS.ProsperoPs5InnerImageResult inner)
    {
        var blocks = new List<Meta18Block>();
        var zeroBlocks = new Dictionary<uint, byte[]>();

        // 1) AFID payload extents: one entry per 256-KiB logical block, not one per file.
        //    Compressed files reuse the exact per-block Kraken geometry captured by the inner
        //    assembler; raw files are split into 0x20000 halves.  Only executable modules set
        //    owner flag 1 (right.sprx in the verified APP).
        var placements = inner.Placements;
        for (int i = 0; i < placements.Count; i++)
        {
            LibProsperoPkg.PFS.ProsperoPs5InnerPlacement p = placements[i];
            uint ownerFlag = IsExecutableAfid(inner, checked((int)p.Afid)) ? 1u : 0u;
            if (p.CompressionBlocks is { Count: > 0 } chunks)
            {
                if (p.PlainDataStoredInImage)
                    throw new InvalidDataException("A file-backed inner payload cannot be marked compressed.");
                long onDisk = p.OnDiskOffset;
                long compressedPlainOffset = 0;
                foreach (LibProsperoPkg.PFS.ProsperoInnerDataBlockChunk chunk in chunks)
                {
                    uint cs = checked((uint)chunk.CompressedSize);
                    uint ps = checked((uint)chunk.UncompressedSize);
                    bool sourceBacked = p.PlainDataPath is not null;
                    if (!sourceBacked && compressedPlainOffset > p.PlainData.Length - checked((int)ps))
                        throw new InvalidDataException(
                            $"NAPS placement {i} does not retain the 0x{ps:X}-byte plaintext block at 0x{compressedPlainOffset:X}.");
                    uint c0 = chunk.IsStored ? Math.Min(ps, 0x20000u) : chunk.IsMultiChunk
                        ? checked((uint)chunk.FirstChunkCompressedSize)
                        : cs;
                    uint c1 = chunk.IsStored || chunk.IsMultiChunk ? cs - c0 : 0;
                    uint flag = chunk.IsStored ? (c1 > 0 ? 0x40990000u : 0x40090000u)
                        : c1 > 0 ? 0x40450000u : 0x40050000u;
                    blocks.Add(new Meta18Block(
                        Co: (ulong)onDisk, Cs: cs, Ps: ps, C0: c0, C1: c1,
                        Flag: flag, IsHole: false, OwnerFlag: ownerFlag, Tail: 0,
                        OnDiskOffset: onDisk, OnDiskLen: cs,
                        Plaintext: sourceBacked
                            ? ReadOnlyMemory<byte>.Empty
                            : p.PlainData.Slice(checked((int)compressedPlainOffset), checked((int)ps)),
                        LogicalOffset: checked(p.LogicalOffset + compressedPlainOffset),
                        PlaintextSourcePath: p.PlainDataPath,
                        PlaintextSourceOffset: sourceBacked ? compressedPlainOffset : -1));
                    onDisk += cs;
                    compressedPlainOffset += checked((int)ps);
                }
                continue;
            }

            long plainOffset = 0;
            while (plainOffset < p.UncompressedSize || plainOffset == 0)
            {
                uint ps = checked((uint)Math.Min(
                    Meta18UBlock,
                    Math.Max(0, p.UncompressedSize - plainOffset)));
                uint c0 = Math.Min(ps, 0x20000u);
                uint c1 = ps - c0;
                long onDisk = p.OnDiskOffset + plainOffset;
                ReadOnlyMemory<byte> plaintext = ReadOnlyMemory<byte>.Empty;
                long plaintextImageOffset = -1;
                if (p.PlainDataStoredInImage)
                    plaintextImageOffset = onDisk;
                else
                {
                    if (plainOffset > p.PlainData.Length - checked((int)ps))
                        throw new InvalidDataException(
                            $"NAPS raw placement {i} does not retain the 0x{ps:X}-byte plaintext block at 0x{plainOffset:X}.");
                    plaintext = p.PlainData.Slice(checked((int)plainOffset), checked((int)ps));
                }
                blocks.Add(new Meta18Block(
                    Co: (ulong)onDisk, Cs: ps, Ps: ps, C0: c0, C1: c1,
                    Flag: c1 > 0 ? 0x40990000u : 0x40090000u, IsHole: false, OwnerFlag: ownerFlag, Tail: 0,
                    OnDiskOffset: onDisk, OnDiskLen: ps,
                    Plaintext: plaintext,
                    LogicalOffset: checked(p.LogicalOffset + plainOffset),
                    PlaintextImageOffset: plaintextImageOffset));
                plainOffset += ps;
                if (ps == 0)
                    break;
            }
        }

        // 2) Explicit sparse AFID slots. They are logical 256-KiB zero files interleaved with real
        //    payload files and reuse the same physical block-info token.
        foreach (LibProsperoPkg.PFS.ProsperoPs5SparseAfidHole hole in inner.SparseAfidHoles)
        {
            uint ps = checked((uint)hole.Size);
            if (!zeroBlocks.TryGetValue(ps, out byte[]? zeroBlock))
            {
                zeroBlock = new byte[ps];
                zeroBlocks[ps] = zeroBlock;
            }
            blocks.Add(new Meta18Block(
                Co: checked((ulong)inner.BlockInfoOnDiskOffset),
                Cs: 0x10, Ps: ps, C0: 8, C1: 8, Flag: 0x40110000u,
                IsHole: true, OwnerFlag: 0, Tail: 0,
                OnDiskOffset: 0, OnDiskLen: 0, Plaintext: zeroBlock,
                LogicalOffset: hole.LogicalOffset));
        }

        // 3) data-region hole ublocks tiling [DataEndLogical, MetaBaseLogical) by 256 KiB. Each hole
        //    compresses to 0x10 bytes (two 8-byte 0x20000 sub-chunks); identical-plaintext holes reuse the
        //    same compressed offset (dedup, stride cs from BlockInfoOnDiskOffset). flag 0x40110000.
        long padding = inner.MetaBaseLogical - inner.DataEndLogical;
        if (padding > 0)
        {
            int nblk = (int)((padding + Meta18UBlock - 1) / Meta18UBlock);
            var holeCo = new Dictionary<uint, ulong>();
            ulong cursor = (ulong)inner.BlockInfoOnDiskOffset;
            for (int k = 0; k < nblk; k++)
            {
                uint ps = (uint)Math.Min(Meta18UBlock, padding - (long)k * Meta18UBlock);
                if (!holeCo.TryGetValue(ps, out ulong co))
                {
                    co = cursor;
                    holeCo[ps] = co;
                    cursor += 0x10;
                }
                if (!zeroBlocks.TryGetValue(ps, out byte[]? zeroBlock))
                {
                    zeroBlock = new byte[ps];
                    zeroBlocks[ps] = zeroBlock;
                }
                blocks.Add(new Meta18Block(
                    Co: co, Cs: 0x10, Ps: ps, C0: 8, C1: 8, Flag: 0x40110000u,
                    IsHole: true, OwnerFlag: 0, Tail: Meta300KindId, OnDiskOffset: 0, OnDiskLen: 0,
                    Plaintext: zeroBlock,
                    LogicalOffset: checked(inner.DataEndLogical + (long)k * Meta18UBlock)));
            }
        }

        // 4) metadata ublocks: co = MetadataOnDiskOffset + cumulative cs; c0 = first sub-chunk, c1 = cs-c0
        //    (0 when single-sub-chunk); flag 0x40450000 (two sub-chunks) / 0x40050000 (one); ihsh tail 0x3E9.
        IReadOnlyList<LibProsperoPkg.PFS.ProsperoInnerMetaBlockChunk> metaChunks = inner.MetadataBlocks;
        if (metaChunks.Count == 0 && inner.MetadataPlaintext.Length > 0)
        {
            var mf = LibProsperoPkg.PFS.Compression.ProsperoCompressedPfsFile.Parse(
                LibProsperoPkg.PFS.Compression.ProsperoCompressedPfsImage.Pack(
                    inner.MetadataPlaintext, 7, (int)Meta18UBlock));
            metaChunks = mf.Blocks.Select(b => new LibProsperoPkg.PFS.ProsperoInnerMetaBlockChunk(
                b.CompressedSize, b.UncompressedSize, b.IsMultiChunk,
                b.FirstChunkCompressedSize, b.Flags)).ToList();
        }
        ulong metaCursor = (ulong)inner.MetadataOnDiskOffset;
        int metaPlainOffset = 0;
        foreach (LibProsperoPkg.PFS.ProsperoInnerMetaBlockChunk m in metaChunks)
        {
            uint cs = (uint)m.CompressedSize;
            int ps = m.UncompressedSize;
            if (metaPlainOffset > inner.MetadataPlaintext.Length - ps)
                throw new InvalidDataException(
                    $"NAPS metadata map exceeds its 0x{inner.MetadataPlaintext.Length:X}-byte plaintext.");
            uint c0 = m.IsMultiChunk ? (uint)m.FirstChunkCompressedSize : cs;
            uint c1 = m.IsMultiChunk ? cs - c0 : 0;
            uint flag = c1 > 0 ? 0x40450000u : 0x40050000u;
            blocks.Add(new Meta18Block(
                Co: metaCursor, Cs: cs, Ps: (uint)ps, C0: c0, C1: c1, Flag: flag,
                IsHole: false, OwnerFlag: 0, Tail: Meta300KindId,
                OnDiskOffset: (long)metaCursor, OnDiskLen: cs,
                Plaintext: inner.MetadataPlaintext.AsMemory(metaPlainOffset, ps),
                LogicalOffset: checked(inner.MetaBaseLogical + metaPlainOffset)));
            metaCursor += cs;
            metaPlainOffset += ps;
        }

        return blocks.OrderBy(block => block.LogicalOffset).ToList();
    }

    // ihsh preimage for a hole block: the plaintext (zero-filled) block content of the covered plaintext
    // size. SHA3-256 over it yields the hole digest for that plaintext size.
    private static byte[] InnerHoleDigestPreimage(uint plaintextSize) => new byte[plaintextSize];

    private static ProsperoNapsIntegrityContext BuildIntegrityContext(
        ulong innerImageSize,
        byte[] mountImage,
        LibProsperoPkg.PFS.ProsperoPs5InnerImageResult? inner,
        IReadOnlyList<Meta18Block>? blocks,
        byte[]? pfsImageKey,
        byte[]? pfsImageSeed)
    {
        var mapped = new ProsperoNapsIntegrityBlock[
            blocks?.Count ?? mountImage.Length / Meta18BlockSize];
        if (blocks is not null)
        {
            using Stream? plaintextImage = blocks.Any(block => block.PlaintextImageOffset >= 0)
                ? inner?.OpenImage()
                : null;
            const int BatchBytes = 64 * 1024 * 1024;
            byte[]? plaintextBuffer = blocks.Any(block =>
                    block.PlaintextImageOffset >= 0 || block.PlaintextSourcePath is not null)
                ? new byte[BatchBytes]
                : null;

            static ProsperoNapsIntegrityBlock Reduce(
                int index, Meta18Block block, ReadOnlySpan<byte> plaintext)
            {
                byte[] digest = ProsperoImageDigests.Sha3_256(plaintext);
                return new ProsperoNapsIntegrityBlock(
                    index,
                    block.Co,
                    block.Cs,
                    block.Ps,
                    block.IsHole,
                    block.OwnerFlag,
                    block.Tail,
                    block.OnDiskOffset,
                    block.OnDiskLen,
                    block.Plaintext,
                    digest)
                {
                    InputChecksum = ComputeInputChecksum(plaintext),
                    RollingHash = ComputeRollingHash(plaintext),
                    PlaintextSourcePath = block.PlaintextSourcePath,
                    PlaintextSourceOffset = block.PlaintextSourceOffset,
                };
            }

            FileStream? plaintextSource = null;
            string? plaintextSourcePath = null;
            try
            {
                for (int i = 0; i < blocks.Count;)
                {
                    Meta18Block first = blocks[i];
                    bool fromImage = first.PlaintextImageOffset >= 0;
                    if (!fromImage && first.PlaintextSourcePath is null)
                    {
                        mapped[i] = Reduce(i, first, first.Plaintext.Span);
                        i++;
                        continue;
                    }

                    Stream source;
                    long sourceOffset;
                    if (fromImage)
                    {
                        source = plaintextImage!;
                        sourceOffset = first.PlaintextImageOffset;
                    }
                    else
                    {
                        if (!string.Equals(
                                plaintextSourcePath, first.PlaintextSourcePath,
                                StringComparison.Ordinal))
                        {
                            plaintextSource?.Dispose();
                            plaintextSource = new FileStream(
                                first.PlaintextSourcePath!, FileMode.Open, FileAccess.Read, FileShare.Read,
                                bufferSize: 1 << 20, FileOptions.SequentialScan);
                            plaintextSourcePath = first.PlaintextSourcePath;
                        }
                        source = plaintextSource!;
                        sourceOffset = first.PlaintextSourceOffset;
                    }

                    int end = i;
                    int bytes = 0;
                    long nextOffset = sourceOffset;
                    var offsets = new List<int>();
                    while (end < blocks.Count)
                    {
                        Meta18Block candidate = blocks[end];
                        long candidateOffset = fromImage
                            ? candidate.PlaintextImageOffset
                            : candidate.PlaintextSourceOffset;
                        bool sameSource = fromImage
                            ? candidate.PlaintextImageOffset >= 0
                            : candidate.PlaintextImageOffset < 0 && string.Equals(
                                candidate.PlaintextSourcePath, first.PlaintextSourcePath,
                                StringComparison.Ordinal);
                        int length = checked((int)candidate.Ps);
                        if (!sameSource || candidateOffset != nextOffset ||
                            length > BatchBytes - bytes)
                            break;
                        offsets.Add(bytes);
                        bytes += length;
                        nextOffset += length;
                        end++;
                    }

                    source.Position = sourceOffset;
                    source.ReadExactly(plaintextBuffer!.AsSpan(0, bytes));
                    int batchStart = i;
                    System.Threading.Tasks.Parallel.For(0, end - batchStart, j =>
                    {
                        Meta18Block block = blocks[batchStart + j];
                        mapped[batchStart + j] = Reduce(
                            batchStart + j, block,
                            plaintextBuffer.AsSpan(offsets[j], checked((int)block.Ps)));
                    });
                    i = end;
                }
            }
            finally
            {
                plaintextSource?.Dispose();
            }
        }
        else
        {
            int count = mountImage.Length / Meta18BlockSize;
            for (int i = 0; i < count; i++)
            {
                ReadOnlySpan<byte> plaintext = mountImage.AsSpan(i * Meta18BlockSize, Meta18BlockSize);
                byte[] digest = ProsperoImageDigests.Sha3_256(plaintext);
                mapped[i] = new ProsperoNapsIntegrityBlock(
                    i,
                    (ulong)i * Meta18BlockSize,
                    Meta18BlockSize,
                    Meta18BlockSize,
                    false,
                    0,
                    0,
                    (long)i * Meta18BlockSize,
                    Meta18BlockSize,
                    mountImage.AsMemory(i * Meta18BlockSize, Meta18BlockSize),
                    digest)
                {
                    InputChecksum = ComputeInputChecksum(plaintext),
                    RollingHash = ComputeRollingHash(plaintext),
                };
            }
        }

        return new ProsperoNapsIntegrityContext
        {
            InnerImageSize = innerImageSize,
            MountImage = mountImage,
            PhysicalInnerImage = inner?.Image ?? ReadOnlyMemory<byte>.Empty,
            PhysicalInnerImagePath = inner?.ImagePath,
            PhysicalInnerImageOffset = inner?.ImageOffset ?? 0,
            PfsImageKey = pfsImageKey ?? ReadOnlyMemory<byte>.Empty,
            PfsImageSeed = pfsImageSeed ?? ReadOnlyMemory<byte>.Empty,
            MappingBlocks = mapped,
        };
    }

    private static byte[] BuildIhshPrefixes(ProsperoNapsIntegrityContext context)
    {
        var result = new byte[checked(context.MappingBlocks.Count * 8)];
        for (int i = 0; i < context.MappingBlocks.Count; i++)
        {
            BinaryPrimitives.WriteUInt64LittleEndian(
                result.AsSpan(i * 8, 8), context.MappingBlocks[i].InputChecksum);
        }
        return result;
    }

    private static byte[] BuildRollingHashes(ProsperoNapsIntegrityContext context)
    {
        var result = new byte[checked(context.MappingBlocks.Count * 8)];
        for (int i = 0; i < context.MappingBlocks.Count; i++)
        {
            BinaryPrimitives.WriteUInt64LittleEndian(
                result.AsSpan(i * 8, 8), context.MappingBlocks[i].RollingHash);
        }
        return result;
    }

    /// <summary>
    /// Builds the publisher <c>obcc</c> table for a fresh NAPS image. The native 2.79 path derives
    /// the XTS keys as
    /// <c>D = HMAC-SHA256(pfs-image-key, LE32(1) || pfs-image-seed)</c>, then encrypts every
    /// 64-KiB physical block with <c>dataKey=D[16..31]</c>,
    /// <c>tweakKey=D[0..15]</c>, and data-unit number equal to the physical block index.
    /// Each table entry is CRC32C of that temporary encrypted block in little-endian order.
    /// When no key pair is present, returns the correctly-sized all-zero table so a caller-supplied
    /// integrity provider can still override it.
    /// </summary>
    public static byte[] BuildOuterBlockCheckCodes(ProsperoNapsIntegrityContext context)
    {
        ArgumentNullException.ThrowIfNull(context);
        int count = context.PhysicalInnerBlockCount;
        var result = new byte[checked(count * 4)];
        if (context.PfsImageKey.IsEmpty && context.PfsImageSeed.IsEmpty)
            return result;
        if (context.PfsImageKey.Length != 32 || context.PfsImageSeed.Length != 16)
            throw new InvalidDataException(
                "NAPS pfs-image-key and pfs-image-seed must contain exactly 32 and 16 bytes.");

        Span<byte> label = stackalloc byte[20];
        BinaryPrimitives.WriteUInt32LittleEndian(label[..4], 1);
        context.PfsImageSeed.Span.CopyTo(label[4..]);
        byte[] digest = HMACSHA256.HashData(context.PfsImageKey.Span, label);

        byte[] dataKey = digest.AsSpan(16, 16).ToArray();
        byte[] tweakKey = digest.AsSpan(0, 16).ToArray();
        using Stream image = OpenPhysicalInnerImage(context);
        const int BatchBlocks = 1024;
        var batch = new byte[BatchBlocks * Meta18BlockSize];
        for (int first = 0; first < count; first += BatchBlocks)
        {
            int blocks = Math.Min(BatchBlocks, count - first);
            image.ReadExactly(batch.AsSpan(0, checked(blocks * Meta18BlockSize)));
            int batchFirst = first;
            System.Threading.Tasks.Parallel.For(
                0, blocks,
                () => new XtsBlockTransform(dataKey, tweakKey),
                (i, _, xts) =>
                {
                    Span<byte> block = batch.AsSpan(i * Meta18BlockSize, Meta18BlockSize);
                    xts.CryptSector(block, checked((ulong)(batchFirst + i)), encrypt: true);
                    BinaryPrimitives.WriteUInt32LittleEndian(
                        result.AsSpan(checked((batchFirst + i) * 4)),
                        ProsperoCrc32C.Compute(block));
                    return xts;
                },
                xts => xts.Dispose());
        }
        return result;
    }

    private static Stream OpenPhysicalInnerImage(ProsperoNapsIntegrityContext context)
    {
        if (!string.IsNullOrWhiteSpace(context.PhysicalInnerImagePath))
        {
            var file = new FileStream(
                context.PhysicalInnerImagePath,
                FileMode.Open,
                FileAccess.Read,
                FileShare.Read,
                bufferSize: 1 << 20,
                FileOptions.SequentialScan);
            return new LibProsperoPkg.Util.SubStream(
                file, context.PhysicalInnerImageOffset,
                checked((long)context.InnerImageSize), leaveOpen: false);
        }
        if (!context.PhysicalInnerImage.IsEmpty)
            return new MemoryStream(context.PhysicalInnerImage.ToArray(), writable: false);
        throw new InvalidDataException(
            "NAPS obcc generation requires the physical pfs_image.dat bytes or file path.");
    }

    /// <summary>
    /// Publisher <c>ihsh</c> weak checksum: low dword is the byte sum; high dword starts at the
    /// input length and accumulates the running byte sum. Arithmetic wraps at 32 bits.
    /// </summary>
    public static ulong ComputeInputChecksum(ReadOnlySpan<byte> input)
    {
        uint sum = 0;
        uint weighted = checked((uint)input.Length);
        unchecked
        {
            foreach (byte value in input)
            {
                sum += value;
                weighted += sum;
            }
        }
        return sum | ((ulong)weighted << 32);
    }

    /// <summary>
    /// Publisher <c>rhsh</c> value for one input block. The rolling window is 64 KiB; shorter
    /// inputs are zero-padded and longer inputs use their first 64 KiB. The two 64-bit accumulators
    /// are combined as <c>sum XOR (weighted &lt;&lt; 25)</c>.
    /// </summary>
    public static ulong ComputeRollingHash(ReadOnlySpan<byte> input)
    {
        const int windowSize = Meta18BlockSize;
        ulong sum = 0;
        ulong weighted = 0;
        int inputLength = Math.Min(windowSize, input.Length);
        unchecked
        {
            for (int i = 0; i < inputLength; i++)
            {
                sum += input[i];
                weighted += sum;
            }
            for (int i = inputLength; i < windowSize; i++)
                weighted += sum;
            return sum ^ (weighted << 25);
        }
    }

}
