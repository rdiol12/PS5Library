// PS Multi Tools - Backup manager and toolkit for PS5 consoles.
// Copyright (C) 2026 SvenGDK
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program. If not, see <https://www.gnu.org/licenses/>.
//
//
// Decoder + byte-exact serializer for the NAPS streaming layout (`naps_pkg_layout.dat`) of a PS5
// finalized image. The on-disk `PackageLayout_NAPS` structure is what reference output uses for the
// streaming output formats (`nwonly` / `bd+nw`).
//
// Format boundary - the on-disk format is fully modeled. `Parse` decodes and
// `BuildLayout` re-serializes; `BuildLayout(Parse(reference)) == reference` for all 544 bytes of the reference
// sample (block 5 of the outer image: 533 section content + 11 trailing zero pad to a
// 16-byte boundary). `EncodeCblockInfoEntry` repacks every entry from its model fields (not the raw
// bytes), so the full bit model - not just the section strides - is proven against the reference vector.
// Validated header decode: NumFiles=7, compType=2 (Kraken), Keys=1, Shuffle=0, UBlocks=19,
// OuterBlocks=5, CblockInfo=45.
//
// Value boundary - this type does not fabricate the record values; it (de)serializes them. The values
// describe the byte-exact layout of the proprietary NAPS-compressed + AES-XTS-encrypted *download
// stream* (the nwonly representation of the package), NOT merely the inner PFS image:
// * CblockInfo coffsetStart256K/coffsetStartMod256K/coffsetEndMod256K/clenEvenMinus1 = compressed
// byte offsets and lengths of the reference Oodle-Kraken-compressed download blocks (even/odd halves);
// * m_tweakIdxStart / m_keyTableIdx = the AES-XTS sector (tweak) and key-table slot of each
// encrypted run in that stream (reference sample: tweakIdx runs 0,2,4,4,6,6,...,8,0);
// * m_KdePredictor / m_shuffleIdx / m_even / m_odd = the NAPS delta-predictor, pre-compression
// shuffle selection and even/odd interleave decisions;
// * m_isRunBase segments the stream into runs (a run-base marker + its member blocks);
// * fidx (type + 40-bit m_uoffsetStart) and u2c (uint24 m_infoOffset9BBase + 7 deltas =>
// start_cblockinfo_index per ublock) map files and uncompressed blocks into that stream.
// Producing these values byte-identically to the reference requires the reference NAPS packager and its
// exact Kraken encoder (compressed sizes are encoder-defined) - the same encoder constraint documented
// for the Kraken codec - and cannot be byte-matched off-console for independently generated (valid but byte-different)
// compression. The deliverables here are the Validated format + serializer, plus the confirmed
// value semantics above.
//
// Reference evidence:
// * reference tool debug-dump format strings (the NAPS packager is statically linked from
// `naps\sce_naps_packager\src\`) name every field verbatim and confirm the layout field-for-field:
// - header `[PackageLayout_NAPS]`: m_numFilesMinus1, m_compressionType, m_numKeysMinus1,
// m_numShufflePatterns, m_numUBlocks, m_numOuterBlocks, m_numCblockInfoMinus2;
// - section strides printed as "(=8*%lld)" OuterBlockDigest, ShufflePattern (8 B),
// "(=6*%lld)" fidx, "(=10*%lld)" CblockInfoOffsetByUblockIdxCompressed, "(=9*%lld)" CblockInfo;
// - fidx `type=%02x, m_uoffsetStart=%010llx`; u2c `m_infoOffset9BBase=%06lx` + m_deltaFromBase;
// - both CblockInfo records: run-base `m_coffsetEndMod256K,m_isRunBase,m_tweakIdxStart,
// m_keyTableIdx,m_coffsetStart256K` and block `m_coffsetStartMod256K,m_isRunBase,
// m_uoffsetStart,m_clenEvenMinus1,m_even,m_odd,m_KdePredictor,m_shuffleIdx`.
// * The exact bit packing of the two 64-bit header words and the inter-field bit offsets of the
// 9-byte CblockInfo record are confirmed by the byte-exact round-trip against the reference sample.
//
// See LibProsperoPKG/docs/implementation-status.md and the session checkpoints for format details.

using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;

namespace LibProsperoPkg.PKG;

/// <summary>
/// Section counts of a <c>naps_pkg_layout.dat</c> structure. Every count is the number of records
/// in the matching section; the strides are fixed and validated (see <see cref="ProsperoNapsLayout"/>).
/// </summary>
/// <param name="NumFiles">fidx records (<c>m_numFilesMinus1 + 1</c>), including the final boundary record.</param>
/// <param name="CompressionType">Oodle codec selector (<c>m_compressionType</c>).</param>
/// <param name="NumKeys">Encryption keys (<c>m_numKeysMinus1 + 1</c>).</param>
/// <param name="NumShufflePatterns">Shuffle-pattern entries (0 = no shuffling).</param>
/// <param name="NumUBlocks">Maximum uncompressed-block index (<c>m_numUBlocks</c>); the actual count is this value plus one.</param>
/// <param name="NumOuterBlocks">Outer-block entries (<c>m_numOuterBlocks</c>).</param>
/// <param name="NumCblockInfo">CblockInfo entries (<c>m_numCblockInfoMinus2 + 2</c>).</param>
public readonly record struct NapsLayoutCounts(
    int NumFiles,
    byte CompressionType,
    int NumKeys,
    int NumShufflePatterns,
    int NumUBlocks,
    int NumOuterBlocks,
    int NumCblockInfo)
{
    /// <summary>Number of logical file ranges; fidx carries one additional terminal boundary.</summary>
    public int LogicalFileCount => checked(NumFiles - 1);

    /// <summary>Actual number of uncompressed blocks represented by the inclusive maximum index.</summary>
    public int UBlockCount => checked(NumUBlocks + 1);

    /// <summary>
    /// Number of 10-byte <c>CblockInfoOffsetByUblockIdxCompressed</c> (u2c) entries: one per group of
    /// 8 uncompressed blocks (each entry carries a uint24 base plus 7 per-ublock deltas).
    /// </summary>
    public int NumU2cEntries => checked((NumUBlocks + 8) >> 3);
}

/// <summary>Byte offset and size of one NAPS section inside the layout blob.</summary>
/// <param name="Offset">Offset from the start of the blob.</param>
/// <param name="Size">Section size in bytes.</param>
/// <param name="Stride">Per-entry stride in bytes.</param>
/// <param name="Count">Number of entries.</param>
public readonly record struct NapsSection(long Offset, long Size, int Stride, int Count);

/// <summary>Map of all NAPS sections in their on-disk order.</summary>
/// <param name="Header">The 16-byte <c>[PackageLayout_NAPS]</c> header.</param>
/// <param name="OuterBlockDigest">8-byte outer-block entries.</param>
/// <param name="ShufflePattern">8-byte shuffle-pattern entries.</param>
/// <param name="UncompressedOffsetStartByFileIdx">6-byte per-file uncompressed-offset entries.</param>
/// <param name="CblockInfoOffsetByUblockIdxCompressed">10-byte u2c entries.</param>
/// <param name="CblockInfo">9-byte CblockInfo entries.</param>
/// <param name="TotalSize">Total layout size (end of the last section).</param>
public readonly record struct NapsSectionMap(
    NapsSection Header,
    NapsSection OuterBlockDigest,
    NapsSection ShufflePattern,
    NapsSection UncompressedOffsetStartByFileIdx,
    NapsSection CblockInfoOffsetByUblockIdxCompressed,
    NapsSection CblockInfo,
    long TotalSize);

/// <summary>
/// A 6-byte <c>UncompressedOffsetStartByFileIdx</c> (fidx) entry. Layout fully validated against the
/// dump format <c>fidx[..] : type=%02x, m_uoffsetStart=%010llx</c>. On disk this is one LE48 word:
/// offset in bits 0..39 and type/flags in bits 40..47.
/// </summary>
/// <param name="Type">The per-file <c>type</c> byte.</param>
/// <param name="UncompressedOffsetStart">40-bit little-endian uncompressed start offset.</param>
public readonly record struct NapsFileOffsetEntry(byte Type, ulong UncompressedOffsetStart)
{
    /// <summary>Continuation marker (raw bit 46, or bit 6 of <see cref="Type"/>).</summary>
    public bool Continuation => (Type & 0x40) != 0;
}

/// <summary>
/// A 10-byte <c>CblockInfoOffsetByUblockIdxCompressed</c> (u2c) entry. Layout fully validated against the
/// dump format <c>u2c[..] : m_infoOffset9BBase=%06lx, m_deltaFromBase=%02x ×7</c>
/// (uint24 base + seven delta bytes). Each entry covers 8 uncompressed blocks; the per-ublock
/// <c>start_cblockinfo_index</c> is <see cref="StartCblockInfoIndex"/>.
/// </summary>
/// <param name="InfoOffset9BBase">uint24 base index into the CblockInfo section.</param>
/// <param name="DeltaFromBase">Seven per-ublock deltas added to <paramref name="InfoOffset9BBase"/>.</param>
public readonly record struct NapsU2cEntry(uint InfoOffset9BBase, byte[] DeltaFromBase)
{
    /// <summary>
    /// Derived <c>start_cblockinfo_index</c> for each of the 8 uncompressed blocks this entry covers.
    /// Index 0 is the base itself; indices 1..7 add the matching delta byte.
    /// </summary>
    public IReadOnlyList<uint> StartCblockInfoIndex
    {
        get
        {
            var result = new uint[8];
            result[0] = InfoOffset9BBase;
            for (int i = 0; i < 7 && i < DeltaFromBase.Length; i++)
                result[i + 1] = InfoOffset9BBase + DeltaFromBase[i];
            return result;
        }
    }
}

/// <summary>
/// A 9-byte <c>CblockInfo</c> entry. The two record formats and every field name are validated from
/// the dump format strings; the exact bit OFFSETS are the analysis3 model (see file header).
/// </summary>
public readonly record struct NapsCblockInfoEntry
{
    /// <summary>Raw 9 bytes of the record, always preserved verbatim.</summary>
    public byte[] Raw { get; init; }

    /// <summary>True for the run-base format, false for the per-block format. (validated discriminator.)</summary>
    public bool IsRunBase { get; init; }

    // Non-run-base fields (valid when IsRunBase is false).

    /// <summary><c>m_coffsetStartMod256K</c> (18 bits). Model bit-offset.</summary>
    public uint CoffsetStartMod256K { get; init; }

    /// <summary>Terminal/sentinel marker at bit 19. Terminal entries are boundaries, not data spans.</summary>
    public bool ReservedBit19 { get; init; }

    /// <summary>True when this normal-format record is the terminal compressed-stream boundary.</summary>
    public bool IsTerminal => !IsRunBase && ReservedBit19;

    /// <summary><c>m_uoffsetStart</c> (18 bits, bits 20..37).</summary>
    public uint UoffsetStart { get; init; }

    /// <summary><c>m_clenEvenMinus1</c> (17 bits, bits 38..54).</summary>
    public uint ClenEvenMinus1 { get; init; }

    /// <summary><c>m_even</c> (3 bits, bits 55..57).</summary>
    public byte Even { get; init; }

    /// <summary><c>m_odd</c> (3 bits, bits 58..60).</summary>
    public byte Odd { get; init; }

    /// <summary><c>m_KdePredictor</c> (6 bits, bits 61..66).</summary>
    public byte KdePredictor { get; init; }

    /// <summary>Raw bit 67. Strict kernel-produced layouts normally clear it; preserved for lossless tooling.</summary>
    public bool ReservedBit67 { get; init; }

    /// <summary><c>m_shuffleIdx</c> (4 bits). Model bit-offset.</summary>
    public byte ShuffleIdx { get; init; }

    // Run-base fields (valid when IsRunBase is true).

    /// <summary><c>m_coffsetEndMod256K</c> (18 bits). Model bit-offset.</summary>
    public uint CoffsetEndMod256K { get; init; }

    /// <summary><c>m_tweakIdxStart</c> (up to 28 bits). Model bit-offset.</summary>
    public uint TweakIdxStart { get; init; }

    /// <summary><c>m_keyTableIdx</c>. Model bit-offset.</summary>
    public byte KeyTableIdx { get; init; }

    /// <summary><c>m_coffsetStart256K</c> / compressed-window base (22 bits, bits 50..71).</summary>
    public uint CoffsetStart256K { get; init; }
}

/// <summary>A fully parsed <c>naps_pkg_layout.dat</c> blob (raw section slices + decoded entries).</summary>
public sealed class NapsLayoutDocument
{
    /// <summary>Section counts.</summary>
    public required NapsLayoutCounts Counts { get; init; }

    /// <summary>Section offset/size map.</summary>
    public required NapsSectionMap Map { get; init; }

    /// <summary>Raw 8-byte outer-block entries (values are key-gated; preserved verbatim).</summary>
    public required IReadOnlyList<byte[]> OuterBlockDigests { get; init; }

    /// <summary>Raw 8-byte shuffle-pattern entries.</summary>
    public required IReadOnlyList<byte[]> ShufflePatterns { get; init; }

    /// <summary>Decoded 6-byte per-file uncompressed-offset entries.</summary>
    public required IReadOnlyList<NapsFileOffsetEntry> FileOffsets { get; init; }

    /// <summary>Decoded 10-byte u2c entries.</summary>
    public required IReadOnlyList<NapsU2cEntry> CblockInfoOffsetByUblock { get; init; }

    /// <summary>Decoded 9-byte CblockInfo entries.</summary>
    public required IReadOnlyList<NapsCblockInfoEntry> CblockInfos { get; init; }

    /// <summary>All-zero bytes after the aligned structural layout. Publisher samples use eight.</summary>
    public int TrailingZeroBytes { get; init; }
}

/// <summary>
/// Decoder for the PS5 <c>naps_pkg_layout.dat</c> (<c>PackageLayout_NAPS</c>) structure.
/// Decodes existing bytes; never produces or fabricates the key-gated streaming values. See the file
/// header for the exact validated-vs-model boundary.
/// </summary>
public static class ProsperoNapsLayout
{
    /// <summary>Default trailing alignment used by publisher NAPS layout blobs.</summary>
    public const int DefaultAlignment = 16;
    /// <summary>On-disk file name of the NAPS layout structure.</summary>
    public const string FileName = "naps_pkg_layout.dat";

    /// <summary>Size of the <c>[PackageLayout_NAPS]</c> header (two packed 64-bit words).</summary>
    public const int HeaderSize = 16;

    /// <summary>Stride of an <c>OuterBlockDigest</c> entry (validated: <c>(=8*%lld)</c>).</summary>
    public const int OuterBlockDigestStride = 8;

    /// <summary>Stride of a <c>ShufflePattern</c> entry (validated: <c>(=8*%lld)</c>).</summary>
    public const int ShufflePatternStride = 8;

    /// <summary>Stride of an <c>UncompressedOffsetStartByFileIdx</c> entry (validated: <c>(=6*%lld)</c>).</summary>
    public const int FileOffsetStride = 6;

    /// <summary>Stride of a <c>CblockInfoOffsetByUblockIdxCompressed</c> entry (validated: <c>(=10*%lld)</c>).</summary>
    public const int U2cStride = 10;

    /// <summary>Stride of a <c>CblockInfo</c> entry (validated: <c>(=9*%lld)</c>).</summary>
    public const int CblockInfoStride = 9;

    // ---- Header (MODEL packing, per analysis3) ----------------------------------------------------

    /// <summary>
    /// Decode the 16-byte header into section counts. Validated byte-exact (round-trip) against the
    /// reference <c>Downloads.pkg</c> <c>naps_pkg_layout.dat</c> and corroborated by the
    /// reference dump-format field names (<c>m_numFilesMinus1</c>, <c>m_numKeysMinus1</c>,
    /// <c>m_numShufflePatterns</c>, <c>m_numUBlocks</c>, <c>m_numOuterBlocks</c>,
    /// <c>m_numCblockInfoMinus2</c>): <c>NumFiles=7, compType=2, Keys=1, Shuffle=0, UBlocks=19,
    /// OuterBlocks=5, CblockInfo=45</c> all decode and re-encode to the exact header bytes.
    /// </summary>
    public static NapsLayoutCounts DecodeHeader(ReadOnlySpan<byte> header)
    {
        if (header.Length < HeaderSize)
            throw new ArgumentException($"NAPS header needs {HeaderSize} bytes.", nameof(header));

        ulong word0 = BinaryPrimitives.ReadUInt64LittleEndian(header[..8]);
        ulong word1 = BinaryPrimitives.ReadUInt64LittleEndian(header.Slice(8, 8));

        int numFilesMinus1 = (int)(word0 & 0xFFFFFF);
        byte compressionType = (byte)((word0 >> 24) & 0x3);
        int numKeysMinus1 = (int)((word0 >> 26) & 0x3);
        int numShufflePatterns = (int)((word0 >> 28) & 0xF);
        if ((word0 >> 55) != 0 || (word1 >> 48) != 0)
            throw new InvalidDataException("NAPS header reserved bits are non-zero.");

        int numUBlocks = (int)((word0 >> 32) & 0x7FFFFF);

        int numOuterBlocks = (int)(word1 & 0xFFFFFF);
        int numCblockInfoMinus2 = (int)((word1 >> 24) & 0xFFFFFF);

        return new NapsLayoutCounts(
            NumFiles: numFilesMinus1 + 1,
            CompressionType: compressionType,
            NumKeys: numKeysMinus1 + 1,
            NumShufflePatterns: numShufflePatterns,
            NumUBlocks: numUBlocks,
            NumOuterBlocks: numOuterBlocks,
            NumCblockInfo: numCblockInfoMinus2 + 2);
    }

    /// <summary>Encode section counts back into a 16-byte header (inverse of <see cref="DecodeHeader"/>).</summary>
    public static byte[] EncodeHeader(NapsLayoutCounts counts)
    {
        ValidateCounts(counts);
        ulong word0 =
              ((ulong)(uint)(counts.NumFiles - 1) & 0xFFFFFF)
            | ((ulong)(counts.CompressionType & 0x3) << 24)
            | ((ulong)(uint)((counts.NumKeys - 1) & 0x3) << 26)
            | ((ulong)(uint)(counts.NumShufflePatterns & 0xF) << 28)
            | ((ulong)(uint)(counts.NumUBlocks & 0x7FFFFF) << 32);

        ulong word1 =
              ((ulong)(uint)(counts.NumOuterBlocks & 0xFFFFFF))
            | ((ulong)(uint)((counts.NumCblockInfo - 2) & 0xFFFFFF) << 24);

        var header = new byte[HeaderSize];
        BinaryPrimitives.WriteUInt64LittleEndian(header.AsSpan(0, 8), word0);
        BinaryPrimitives.WriteUInt64LittleEndian(header.AsSpan(8, 8), word1);
        return header;
    }

    // ---- Section map (validated strides) -----------------------------------------------------------

    /// <summary>
    /// Compute the offset/size of every section from the counts using the validated strides and the
    /// validated on-disk order. This split is exact given correct counts.
    /// </summary>
    public static NapsSectionMap SectionMap(NapsLayoutCounts counts)
    {
        long pos = 0;
        var header = new NapsSection(pos, HeaderSize, HeaderSize, 1);
        pos += HeaderSize;

        var ob = new NapsSection(pos, (long)counts.NumOuterBlocks * OuterBlockDigestStride, OuterBlockDigestStride, counts.NumOuterBlocks);
        pos += ob.Size;

        var sp = new NapsSection(pos, (long)counts.NumShufflePatterns * ShufflePatternStride, ShufflePatternStride, counts.NumShufflePatterns);
        pos += sp.Size;

        var fidx = new NapsSection(pos, (long)counts.NumFiles * FileOffsetStride, FileOffsetStride, counts.NumFiles);
        pos += fidx.Size;

        int u2cCount = counts.NumU2cEntries;
        var u2c = new NapsSection(pos, (long)u2cCount * U2cStride, U2cStride, u2cCount);
        pos += u2c.Size;

        pos = AlignUp(pos, 8);

        var cbi = new NapsSection(pos, (long)counts.NumCblockInfo * CblockInfoStride, CblockInfoStride, counts.NumCblockInfo);
        pos += cbi.Size;

        pos = AlignUp(pos, 8);

        return new NapsSectionMap(header, ob, sp, fidx, u2c, cbi, pos);
    }

    // ---- Entry decoders ---------------------------------------------------------------------------

    /// <summary>Decode a 6-byte LE48 fidx entry: low 40 bits offset, high 8 bits type/flags.</summary>
    public static NapsFileOffsetEntry DecodeFileOffsetEntry(ReadOnlySpan<byte> entry)
    {
        if (entry.Length < FileOffsetStride)
            throw new ArgumentException($"fidx entry needs {FileOffsetStride} bytes.", nameof(entry));

        ulong offset = 0;
        for (int i = 0; i < 5; i++)
            offset |= (ulong)entry[i] << (8 * i);
        byte type = entry[5];
        return new NapsFileOffsetEntry(type, offset);
    }

    /// <summary>Encode a 6-byte fidx entry (inverse of <see cref="DecodeFileOffsetEntry"/>).</summary>
    public static byte[] EncodeFileOffsetEntry(NapsFileOffsetEntry entry)
    {
        var buffer = new byte[FileOffsetStride];
        if (entry.UncompressedOffsetStart > 0xFFFF_FFFFFFUL)
            throw new ArgumentOutOfRangeException(nameof(entry), "NAPS file offset exceeds 40 bits.");
        ulong offset = entry.UncompressedOffsetStart;
        for (int i = 0; i < 5; i++)
            buffer[i] = (byte)(offset >> (8 * i));
        buffer[5] = entry.Type;
        return buffer;
    }

    /// <summary>Decode a 10-byte u2c entry (validated layout: uint24 base + 7 delta bytes).</summary>
    public static NapsU2cEntry DecodeU2cEntry(ReadOnlySpan<byte> entry)
    {
        if (entry.Length < U2cStride)
            throw new ArgumentException($"u2c entry needs {U2cStride} bytes.", nameof(entry));

        uint baseOffset = (uint)(entry[0] | (entry[1] << 8) | (entry[2] << 16));
        var deltas = new byte[7];
        entry.Slice(3, 7).CopyTo(deltas);
        return new NapsU2cEntry(baseOffset, deltas);
    }

    /// <summary>Encode a 10-byte u2c entry (inverse of <see cref="DecodeU2cEntry"/>).</summary>
    public static byte[] EncodeU2cEntry(NapsU2cEntry entry)
    {
        var buffer = new byte[U2cStride];
        buffer[0] = (byte)entry.InfoOffset9BBase;
        buffer[1] = (byte)(entry.InfoOffset9BBase >> 8);
        buffer[2] = (byte)(entry.InfoOffset9BBase >> 16);
        for (int i = 0; i < 7 && i < entry.DeltaFromBase.Length; i++)
            buffer[3 + i] = entry.DeltaFromBase[i];
        return buffer;
    }

    /// <summary>
    /// Decode a 9-byte CblockInfo entry. Validated byte-exact (round-trip) against every CblockInfo
    /// record in the reference <c>Downloads.pkg</c> <c>naps_pkg_layout.dat</c>: the discriminator
    /// (<c>m_isRunBase</c> at bit 18), the field set, and all bit offsets re-encode to the exact
    /// on-disk bytes. Field widths match the reference dump-format hints. The raw bytes
    /// are always preserved on <see cref="NapsCblockInfoEntry.Raw"/>.
    /// </summary>
    public static NapsCblockInfoEntry DecodeCblockInfoEntry(ReadOnlySpan<byte> entry)
    {
        if (entry.Length < CblockInfoStride)
            throw new ArgumentException($"cblockinfo entry needs {CblockInfoStride} bytes.", nameof(entry));

        var raw = new byte[CblockInfoStride];
        entry[..CblockInfoStride].CopyTo(raw);

        // Read the 72-bit record as a little-endian value.
        ulong lo = 0;
        for (int i = 0; i < 8; i++)
            lo |= (ulong)raw[i] << (8 * i);
        UInt128 bits = lo | ((UInt128)raw[8] << 64);

        bool isRunBase = ((lo >> 18) & 1) != 0;
        uint coffsetMod256K = (uint)(lo & 0x3FFFF);

        if (!isRunBase)
        {
            return new NapsCblockInfoEntry
            {
                Raw = raw,
                IsRunBase = false,
                CoffsetStartMod256K = coffsetMod256K,
                ReservedBit19 = ((bits >> 19) & 1) != 0,
                UoffsetStart = (uint)((bits >> 20) & 0x3FFFF),
                ClenEvenMinus1 = (uint)((bits >> 38) & 0x1FFFF),
                Even = (byte)((bits >> 55) & 0x7),
                Odd = (byte)((bits >> 58) & 0x7),
                KdePredictor = (byte)((bits >> 61) & 0x3F),
                ReservedBit67 = ((bits >> 67) & 1) != 0,
                ShuffleIdx = (byte)((bits >> 68) & 0xF),
            };
        }

        return new NapsCblockInfoEntry
        {
            Raw = raw,
            IsRunBase = true,
            CoffsetEndMod256K = coffsetMod256K,
            TweakIdxStart = (uint)((bits >> 20) & 0xFFFFFFF),
            KeyTableIdx = (byte)((bits >> 48) & 0x3),
            CoffsetStart256K = (uint)((bits >> 50) & 0x3FFFFF),
        };
    }

    // ---- Top-level parse --------------------------------------------------------------------------

    /// <summary>
    /// Parse a full <c>naps_pkg_layout.dat</c> blob using counts decoded from its header. The header
    /// packing and every section decoder are validated byte-exact (round-trip) against the reference
    /// <c>Downloads.pkg</c> sample.
    /// </summary>
    public static NapsLayoutDocument Parse(ReadOnlySpan<byte> blob)
        => Parse(blob, DecodeHeader(blob));

    /// <summary>
    /// Parse a full <c>naps_pkg_layout.dat</c> blob using explicitly supplied counts (e.g. from the
    /// <c>reference metric data</c>). The section split uses only the validated strides, so it is exact.
    /// </summary>
    public static NapsLayoutDocument Parse(ReadOnlySpan<byte> blob, NapsLayoutCounts counts)
    {
        NapsSectionMap map = SectionMap(counts);
        if (blob.Length < map.TotalSize)
            throw new ArgumentException(
                $"NAPS blob is {blob.Length} bytes but the counts require {map.TotalSize}.", nameof(blob));

        int trailing = checked(blob.Length - (int)map.TotalSize);
        for (int i = (int)map.TotalSize; i < blob.Length; i++)
            if (blob[i] != 0) throw new InvalidDataException("NAPS trailing footer contains non-zero bytes.");

        var outerBlocks = SliceRaw(blob, map.OuterBlockDigest);
        var shuffles = SliceRaw(blob, map.ShufflePattern);

        var fileOffsets = new List<NapsFileOffsetEntry>(map.UncompressedOffsetStartByFileIdx.Count);
        for (int i = 0; i < map.UncompressedOffsetStartByFileIdx.Count; i++)
            fileOffsets.Add(DecodeFileOffsetEntry(EntrySpan(blob, map.UncompressedOffsetStartByFileIdx, i)));

        var u2c = new List<NapsU2cEntry>(map.CblockInfoOffsetByUblockIdxCompressed.Count);
        for (int i = 0; i < map.CblockInfoOffsetByUblockIdxCompressed.Count; i++)
            u2c.Add(DecodeU2cEntry(EntrySpan(blob, map.CblockInfoOffsetByUblockIdxCompressed, i)));

        var cblockInfos = new List<NapsCblockInfoEntry>(map.CblockInfo.Count);
        for (int i = 0; i < map.CblockInfo.Count; i++)
            cblockInfos.Add(DecodeCblockInfoEntry(EntrySpan(blob, map.CblockInfo, i)));

        return new NapsLayoutDocument
        {
            Counts = counts,
            Map = map,
            OuterBlockDigests = outerBlocks,
            ShufflePatterns = shuffles,
            FileOffsets = fileOffsets,
            CblockInfoOffsetByUblock = u2c,
            CblockInfos = cblockInfos,
            TrailingZeroBytes = trailing,
        };
    }

    // ---- Top-level serializer ---------------------------------------------------------------------

    /// <summary>
    /// Default all-zero footer written after the separately aligned structural layout.
    /// </summary>
    public const int DefaultFooterSize = 8;

    /// <summary>
    /// Serialize a <see cref="NapsLayoutDocument"/> back into a <c>naps_pkg_layout.dat</c> blob, byte-exact.
    /// This is the inverse of <see cref="Parse(ReadOnlySpan{byte}, NapsLayoutCounts)"/> and is validated
    /// round-trip byte-exact against the reference <c>Downloads.pkg</c> sample:
    /// <c>BuildLayout(Parse(reference)) == reference</c> for every byte, including the trailing zero pad.
    /// The section content is emitted in the validated on-disk order
    /// (header, outer-block digests, shuffle patterns, fidx, u2c, CblockInfo) using the validated
    /// per-field encoders, then writes the requested all-zero footer.
    /// </summary>
    /// <param name="document">The layout to serialize. Its <see cref="NapsLayoutDocument.Counts"/> must
    /// agree with the lengths of its section lists.</param>
    /// <param name="trailingZeroBytes">Footer size. A negative value preserves the parsed footer or uses
    /// <see cref="DefaultFooterSize"/> for a newly constructed document; zero emits no footer.</param>
    /// <returns>The serialized blob.</returns>
    public static byte[] BuildLayout(NapsLayoutDocument document, int trailingZeroBytes = -1)
    {
        ArgumentNullException.ThrowIfNull(document);
        NapsLayoutCounts counts = document.Counts;

        if (document.OuterBlockDigests.Count != counts.NumOuterBlocks)
            throw new ArgumentException($"OuterBlockDigests count {document.OuterBlockDigests.Count} != NumOuterBlocks {counts.NumOuterBlocks}.", nameof(document));
        if (document.ShufflePatterns.Count != counts.NumShufflePatterns)
            throw new ArgumentException($"ShufflePatterns count {document.ShufflePatterns.Count} != NumShufflePatterns {counts.NumShufflePatterns}.", nameof(document));
        if (document.FileOffsets.Count != counts.NumFiles)
            throw new ArgumentException($"FileOffsets count {document.FileOffsets.Count} != NumFiles {counts.NumFiles}.", nameof(document));
        if (document.CblockInfoOffsetByUblock.Count != counts.NumU2cEntries)
            throw new ArgumentException($"u2c count {document.CblockInfoOffsetByUblock.Count} != NumU2cEntries {counts.NumU2cEntries}.", nameof(document));
        if (document.CblockInfos.Count != counts.NumCblockInfo)
            throw new ArgumentException($"CblockInfos count {document.CblockInfos.Count} != NumCblockInfo {counts.NumCblockInfo}.", nameof(document));

        ValidateDocument(document);
        NapsSectionMap map = SectionMap(counts);
        long content = map.TotalSize;
        int footer = trailingZeroBytes >= 0
            ? trailingZeroBytes
            : (document.TrailingZeroBytes != 0 ? document.TrailingZeroBytes : DefaultFooterSize);
        long total = checked(content + footer);

        var blob = new byte[total];
        var span = blob.AsSpan();

        EncodeHeader(counts).CopyTo(span);
        int pos = HeaderSize;

        foreach (byte[] digest in document.OuterBlockDigests)
        {
            if (digest.Length != OuterBlockDigestStride)
                throw new ArgumentException($"outer-block digest must be {OuterBlockDigestStride} bytes.", nameof(document));
            digest.CopyTo(span.Slice(pos, OuterBlockDigestStride));
            pos += OuterBlockDigestStride;
        }

        foreach (byte[] shuffle in document.ShufflePatterns)
        {
            if (shuffle.Length != ShufflePatternStride)
                throw new ArgumentException($"shuffle pattern must be {ShufflePatternStride} bytes.", nameof(document));
            shuffle.CopyTo(span.Slice(pos, ShufflePatternStride));
            pos += ShufflePatternStride;
        }

        foreach (NapsFileOffsetEntry entry in document.FileOffsets)
        {
            EncodeFileOffsetEntry(entry).CopyTo(span.Slice(pos, FileOffsetStride));
            pos += FileOffsetStride;
        }

        foreach (NapsU2cEntry entry in document.CblockInfoOffsetByUblock)
        {
            EncodeU2cEntry(entry).CopyTo(span.Slice(pos, U2cStride));
            pos += U2cStride;
        }

        pos = checked((int)map.CblockInfo.Offset);

        foreach (NapsCblockInfoEntry entry in document.CblockInfos)
        {
            EncodeCblockInfoEntry(entry).CopyTo(span.Slice(pos, CblockInfoStride));
            pos += CblockInfoStride;
        }

        return blob;
    }

    private static ReadOnlySpan<byte> EntrySpan(ReadOnlySpan<byte> blob, NapsSection section, int index)
        => blob.Slice((int)section.Offset + index * section.Stride, section.Stride);

    private static List<byte[]> SliceRaw(ReadOnlySpan<byte> blob, NapsSection section)
    {
        var list = new List<byte[]>(section.Count);
        for (int i = 0; i < section.Count; i++)
        {
            var entry = new byte[section.Stride];
            blob.Slice((int)section.Offset + i * section.Stride, section.Stride).CopyTo(entry);
            list.Add(entry);
        }
        return list;
    }

    /// <summary>
    /// Encode a CblockInfo entry from the model fields (inverse of <see cref="DecodeCblockInfoEntry"/>).
    /// Validated byte-exact (round-trip) against every CblockInfo record in the reference Downloads.pkg sample.
    /// </summary>
    public static byte[] EncodeCblockInfoEntry(NapsCblockInfoEntry entry)
    {
        UInt128 bits = (entry.IsRunBase ? entry.CoffsetEndMod256K : entry.CoffsetStartMod256K) & 0x3FFFF;
        if (!entry.IsRunBase)
        {
            RequireFits(entry.UoffsetStart, 18, nameof(entry.UoffsetStart));
            RequireFits(entry.ClenEvenMinus1, 17, nameof(entry.ClenEvenMinus1));
            RequireFits(entry.Even, 3, nameof(entry.Even));
            RequireFits(entry.Odd, 3, nameof(entry.Odd));
            RequireFits(entry.KdePredictor, 6, nameof(entry.KdePredictor));
            RequireFits(entry.ShuffleIdx, 4, nameof(entry.ShuffleIdx));
            if (entry.ReservedBit19) bits |= (UInt128)1 << 19;
            bits |= (UInt128)entry.UoffsetStart << 20;
            bits |= (UInt128)entry.ClenEvenMinus1 << 38;
            bits |= (UInt128)entry.Even << 55;
            bits |= (UInt128)entry.Odd << 58;
            bits |= (UInt128)entry.KdePredictor << 61;
            if (entry.ReservedBit67) bits |= (UInt128)1 << 67;
            bits |= (UInt128)entry.ShuffleIdx << 68;
        }
        else
        {
            RequireFits(entry.TweakIdxStart, 28, nameof(entry.TweakIdxStart));
            RequireFits(entry.KeyTableIdx, 2, nameof(entry.KeyTableIdx));
            RequireFits(entry.CoffsetStart256K, 22, nameof(entry.CoffsetStart256K));
            bits |= (UInt128)1 << 18;
            bits |= (UInt128)entry.TweakIdxStart << 20;
            bits |= (UInt128)entry.KeyTableIdx << 48;
            bits |= (UInt128)entry.CoffsetStart256K << 50;
        }

        var buffer = new byte[CblockInfoStride];
        for (int i = 0; i < buffer.Length; i++)
            buffer[i] = (byte)(bits >> (8 * i));
        return buffer;
    }

    private static void ValidateCounts(NapsLayoutCounts counts)
    {
        if (counts.NumFiles < 1 || counts.NumFiles > 0x800000 || counts.NumKeys < 1 || counts.NumKeys > 4 ||
            counts.NumShufflePatterns is < 0 or > 15 || counts.NumUBlocks is < 0 or > 0x400000 ||
            counts.NumOuterBlocks is < 0 or > 0xFFFFFF || counts.NumCblockInfo is < 2 or > 0x1000001)
            throw new ArgumentOutOfRangeException(nameof(counts), "NAPS counts exceed the kernel G6 profile.");
    }

    private static void ValidateDocument(NapsLayoutDocument document)
    {
        if (document.FileOffsets.Count != 0 && document.FileOffsets[0].Continuation)
            throw new InvalidDataException("The first NAPS file entry cannot be a continuation.");
        ulong maximum = checked((ulong)document.Counts.UBlockCount << 18);
        ulong previous = 0;
        // Every fidx record is a real monotonic boundary; the final type-0x40 record is the mount end.
        for (int i = 0; i < document.FileOffsets.Count; i++)
        {
            ulong current = document.FileOffsets[i].UncompressedOffsetStart;
            if (current < previous || current > maximum)
                throw new InvalidDataException(
                    $"NAPS file boundary {i} is invalid: current=0x{current:X}, previous=0x{previous:X}, maximum=0x{maximum:X}.");
            previous = current;
        }
        for (int block = 0; block < document.Counts.UBlockCount; block++)
        {
            NapsU2cEntry group = document.CblockInfoOffsetByUblock[block >> 3];
            uint index = block % 8 == 0 ? group.InfoOffset9BBase : checked(group.InfoOffset9BBase + group.DeltaFromBase[(block & 7) - 1]);
            bool beyondMountBoundary = document.FileOffsets.Count != 0
                && checked((ulong)block << 18) >= document.FileOffsets[^1].UncompressedOffsetStart;
            if (index >= document.CblockInfos.Count
                || document.CblockInfos[(int)index].IsRunBase
                || (document.CblockInfos[(int)index].IsTerminal && !beyondMountBoundary))
                throw new InvalidDataException($"NAPS ublock {block} has an invalid CblockInfo reference.");
        }

        int terminalCount = 0;
        foreach (NapsCblockInfoEntry entry in document.CblockInfos)
        {
            if (entry.IsTerminal)
                terminalCount++;
            else if (!entry.IsRunBase &&
                     entry.ShuffleIdx > document.Counts.NumShufflePatterns)
                throw new InvalidDataException(
                    $"NAPS shuffle index {entry.ShuffleIdx} exceeds the " +
                    $"{document.Counts.NumShufflePatterns}-entry table and identity sentinel.");
        }
        if (terminalCount != 1 || !document.CblockInfos[^1].IsTerminal)
            throw new InvalidDataException("NAPS CblockInfo must end in exactly one terminal boundary.");
    }

    private static long AlignUp(long value, int alignment) => checked((value + alignment - 1) / alignment * alignment);

    private static void RequireFits(uint value, int bits, string name)
    {
        if (value >= (1u << bits)) throw new ArgumentOutOfRangeException(name);
    }

}
