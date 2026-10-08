// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// ---------------------------------------------------------------------------------------------------
// PS5 naps_pkg_layout.dat generator. Given the inner image's per-block compression plan, it
// produces a NapsLayoutDocument whose ProsperoNapsLayout.BuildLayout() serializes the CblockInfo,
// u2c, fidx, and header sections from the modeled fields.
// ---------------------------------------------------------------------------------------------------
#nullable enable
using LibProsperoPkg.PFS;
using System;
using System.Collections.Generic;
using System.Linq;

namespace LibProsperoPkg.PKG;

/// <summary>
/// One logical PFS block in the naps generation plan. Each entry becomes one <c>STD</c> (per-block)
/// CblockInfo record, optionally preceded by a <c>RUN</c> base record when <see cref="StartRun"/> is set.
/// The fields mirror the compressor's per-block output; see <see cref="ProsperoNapsLayoutBuilder"/>.
/// </summary>
public sealed class NapsCblockPlanEntry
{
    /// <summary>Emit a RUN-base CblockInfo record before this block (re-bases the compressed-offset space).</summary>
    public bool StartRun { get; init; }

    /// <summary>The block's on-disk (compressed-image) byte offset. Only used when <see cref="StartRun"/> is set,
    /// where it drives the RUN base fields (<c>CoffsetStart256K</c>, <c>TweakIdxStart</c>) and the cursor reset.</summary>
    public long OnDiskOffset { get; init; }

    /// <summary>The block's uncompressed logical start offset (drives <c>UoffsetStart</c> and the u2c index map).</summary>
    public long LogicalOffset { get; init; }

    /// <summary>Compressed length of the block's even (or sole) chunk; drives <c>ClenEvenMinus1</c>.</summary>
    public long EvenChunkCompressedLength { get; init; }

    /// <summary>Bytes the compressed-offset cursor advances after this block (even + odd chunk stream length).</summary>
    public long StreamLength { get; init; }

    /// <summary>Even-chunk-present flag (1 for a full 256 KiB raw block, else 0).</summary>
    public byte Even { get; init; }

    /// <summary>Odd-chunk-present flag (1 for every real block, 0 only for the terminator).</summary>
    public byte Odd { get; init; }

    /// <summary>KDE predictor selector. The verified Publishing Tools 2.79 profile uses zero.</summary>
    public byte KdePredictor { get; init; }

    /// <summary>
    /// Zero-based shuffle-pattern index; the value equal to the table count selects identity.
    /// </summary>
    public byte ShuffleIndex { get; init; }

    /// <summary>True for the single trailing terminator block (special sentinel fields).</summary>
    public bool Terminator { get; init; }
}

/// <summary>
/// Inputs for generating a <c>naps_pkg_layout.dat</c> from a built inner image. The block plan
/// (<see cref="Blocks"/>) encodes the compressor's per-block output; <see cref="FileLogicalOffsets"/>
/// is the assembler's afid-order logical offset table (the fidx values). The remaining counts are
/// inner-image geometry.
/// </summary>
public sealed class NapsGenerationRequest
{
    /// <summary>Compression type (2 = Kraken for the nwonly format).</summary>
    public byte CompressionType { get; init; } = 2;

    /// <summary>Number of 256 KiB uncompressed blocks: <c>ceil(totalLogicalSize / 0x40000)</c>.</summary>
    public required int NumUBlocks { get; init; }

    /// <summary>Number of on-disk outer blocks in the built image (superblock block count).</summary>
    public required int NumOuterBlocks { get; init; }

    /// <summary>Number of distinct keys (1 for the debug format).</summary>
    public int NumKeys { get; init; } = 1;

    /// <summary>The afid-order uncompressed logical start offsets (the fidx offsets). The final entry is the
    /// total inner logical size and is emitted with <see cref="FinalFileOffsetType"/>.</summary>
    public required IReadOnlyList<long> FileLogicalOffsets { get; init; }

    /// <summary>
    /// Optional per-entry FIDX types. When present it must have exactly
    /// <see cref="FileLogicalOffsets"/>.Count elements. Publisher sparse AFID slots use type
    /// <c>0x40</c>; ordinary file and metadata-boundary entries use zero.
    /// </summary>
    public IReadOnlyList<byte>? FileOffsetTypes { get; init; }

    /// <summary>Type byte for the final (total-size) fidx entry.</summary>
    public byte FinalFileOffsetType { get; init; } = 0x40;

    /// <summary>The ordered block plan.</summary>
    public required IReadOnlyList<NapsCblockPlanEntry> Blocks { get; init; }

    /// <summary>Optional explicit 8-byte outer-block digest entries. Defaults to <see cref="NumOuterBlocks"/>
    /// all-zero entries (the debug format leaves them key-gated/zeroed).</summary>
    public IReadOnlyList<byte[]>? OuterBlockDigests { get; init; }

    /// <summary>Optional 8-byte shuffle-pattern entries (defaults to none).</summary>
    public IReadOnlyList<byte[]>? ShufflePatterns { get; init; }
}

internal sealed class NapsU2cOverflowException(
    int value, long groupStartLogicalOffset, long targetLogicalOffset)
    : NotSupportedException(
        $"NAPS u2c delta value {value} exceeds the single-byte field; this layout size is not supported.")
{
    public int Value { get; } = value;
    public long GroupStartLogicalOffset { get; } = groupStartLogicalOffset;
    public long TargetLogicalOffset { get; } = targetLogicalOffset;
}

/// <summary>
/// One placed DATA-region file, as laid out by <c>ProsperoPs5InnerImageAssembler</c>. The naps builder
/// derives this file's CblockInfo blocks from its geometry: a raw file becomes
/// <c>floor(UncompressedSize/0x40000)</c> full 256 KiB blocks plus a tail block; a compressed file
/// becomes a single block. Whether each block opens a new RUN base is decided by the flush schedule
/// (<c>runStartOnDiskOffsets</c>), which is a compressor artifact and is supplied separately.
/// </summary>
public sealed class NapsFilePlacement
{
    /// <summary>The file's on-disk (compressed-image) start offset.</summary>
    public required long OnDiskOffset { get; init; }

    /// <summary>The file's uncompressed logical start offset.</summary>
    public required long LogicalOffset { get; init; }

    /// <summary>The file's on-disk byte size (raw size when <see cref="StoreRaw"/>, else the Kraken payload size).</summary>
    public required long OnDiskSize { get; init; }

    /// <summary>The file's uncompressed byte size (drives the raw block split).</summary>
    public required long UncompressedSize { get; init; }

    /// <summary>True when the file is stored raw (block-split), false when Kraken-compressed (single block).</summary>
    public required bool StoreRaw { get; init; }

    /// <summary>KDE predictor for a compressed file's block (zero in the verified profile).</summary>
    public byte CompressedKde { get; init; }

    /// <summary>Per-256 KiB compression blocks for a Kraken-compressed file.</summary>
    public IReadOnlyList<ProsperoInnerDataBlockChunk> CompressionBlocks { get; init; } = Array.Empty<ProsperoInnerDataBlockChunk>();
}

/// <summary>
/// Generator for the PS5 <c>naps_pkg_layout.dat</c> CblockInfo/u2c/fidx sections. Walks a
/// per-block compression plan with a compressed-offset cursor and emits a <see cref="NapsLayoutDocument"/>
/// that <see cref="ProsperoNapsLayout.BuildLayout"/> serializes from modeled fields.
/// </summary>
/// <remarks>
/// <para>Generation rules:</para>
/// <list type="bullet">
/// <item>A RUN-base record re-bases the compressed cursor: <c>coffEnd = cursor mod 0x40000</c> (captured
/// before the reset), <c>CoffsetStart256K = floor(onDisk/0x40000)</c>,
/// <c>TweakIdxStart = onDisk &gt;&gt; 16</c> (0 for the terminator), then the cursor resets to
/// <c>onDisk</c>.</item>
/// <item>A STD record: <c>CoffsetStartMod256K = cursor mod 0x40000</c>,
/// <c>UoffsetStart = logical mod 0x40000</c>,
/// <c>ClenEvenMinus1 = min(evenComp-1, 0x1FFFF)</c>, plus the even/odd/kde/shuf
/// flags. The cursor then advances by the block's stream length.</item>
/// <item>The terminator STD is a sentinel at the mount boundary: reserved bit 19 is set,
/// <c>ClenEvenMinus1 = 0</c>, and all mode flags are zero.</item>
/// <item>u2c packs a per-ublock "first CblockInfo index" table <c>I[u]</c> = the index of the first STD whose
/// logical start &gt;= <c>u*0x40000</c> (missing ublocks point at the terminator index), in a phase-shifted
/// 8-block grouping.</item>
/// </list>
/// </remarks>
public static class ProsperoNapsLayoutBuilder
{
    private const long UBlock = 0x40000;          // 256 KiB uncompressed block
    private const uint Mod256K = 0x3FFFF;         // 18-bit mod-0x40000 mask
    private const uint ClenEvenCap = 0x1FFFF;     // (full 128 KiB even chunk) - 1

    /// <summary>
    /// Generate the full <see cref="NapsLayoutDocument"/> from an inner-image block plan. The result
    /// serializes via <see cref="ProsperoNapsLayout.BuildLayout"/>.
    /// </summary>
    public static NapsLayoutDocument BuildDocument(NapsGenerationRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.Blocks is null || request.Blocks.Count == 0)
            throw new ArgumentException("A naps generation request needs at least one block.", nameof(request));
        if (request.FileLogicalOffsets is null || request.FileLogicalOffsets.Count == 0)
            throw new ArgumentException("A naps generation request needs the afid logical offset table.", nameof(request));
        if (request.FileOffsetTypes is not null &&
            request.FileOffsetTypes.Count != request.FileLogicalOffsets.Count)
        {
            throw new ArgumentException(
                "The optional FIDX type table must match the logical-offset table.",
                nameof(request));
        }

        (List<NapsCblockInfoEntry> cblockInfos, List<(int Index, long Logical)> stdLogical) = WalkBlocks(request.Blocks);

        var counts = new NapsLayoutCounts(
            // m_numFilesMinus1 covers the real fidx records, including the final mount boundary.
            // There is no extra trailer record in publisher AC output.
            NumFiles: request.FileLogicalOffsets.Count,
            CompressionType: request.CompressionType,
            NumKeys: request.NumKeys,
            NumShufflePatterns: request.ShufflePatterns?.Count ?? 0,
            // Header stores the inclusive maximum ublock index, while the generation request uses
            // the natural block count.
            NumUBlocks: checked(request.NumUBlocks - 1),
            NumOuterBlocks: request.NumOuterBlocks,
            NumCblockInfo: cblockInfos.Count);

        List<NapsFileOffsetEntry> fileOffsets = BuildFileOffsets(request);
        List<NapsU2cEntry> u2c = BuildU2c(stdLogical, counts.UBlockCount, counts.NumCblockInfo, counts.NumU2cEntries);

        IReadOnlyList<byte[]> outerDigests = request.OuterBlockDigests
            ?? Enumerable.Range(0, request.NumOuterBlocks)
                         .Select(_ => new byte[ProsperoNapsLayout.OuterBlockDigestStride])
                         .ToList();

        IReadOnlyList<byte[]> shuffles = request.ShufflePatterns ?? Array.Empty<byte[]>();

        return new NapsLayoutDocument
        {
            Counts = counts,
            Map = ProsperoNapsLayout.SectionMap(counts),
            OuterBlockDigests = outerDigests,
            ShufflePatterns = shuffles,
            FileOffsets = fileOffsets,
            CblockInfoOffsetByUblock = u2c,
            CblockInfos = cblockInfos,
        };
    }

    /// <summary>
    /// Generate and serialize a <c>naps_pkg_layout.dat</c> blob from an inner-image block plan.
    /// </summary>
    public static byte[] Build(NapsGenerationRequest request, int alignment = ProsperoNapsLayout.DefaultAlignment)
        => ProsperoNapsLayout.BuildLayout(BuildDocument(request), alignment);

    // ---- DATA-region derivation from file geometry ------------------------------------------------

    /// <summary>
    /// Derive the DATA-region CblockInfo block plan from placed files. Each raw file is split into
    /// <c>floor(UncompressedSize/0x40000)</c> full 256 KiB blocks (even/odd raw, kde 4) plus a tail block
    /// (kde 0); each compressed file becomes a single block (kde <see cref="NapsFilePlacement.CompressedKde"/>).
    /// A block opens a RUN base iff its on-disk offset is in <paramref name="runStartOnDiskOffsets"/> — the
    /// compressor's flush schedule, which is not statically derivable and must be supplied by the caller.
    /// </summary>
    public static List<NapsCblockPlanEntry> DeriveDataRegionBlocks(
        IReadOnlyList<NapsFilePlacement> files, IReadOnlyCollection<long> runStartOnDiskOffsets)
    {
        ArgumentNullException.ThrowIfNull(files);
        ArgumentNullException.ThrowIfNull(runStartOnDiskOffsets);
        var runSet = new HashSet<long>(runStartOnDiskOffsets);
        var blocks = new List<NapsCblockPlanEntry>();

        foreach (NapsFilePlacement f in files)
        {
            // Empty files still have an AFID/FIDX entry, but occupy no bytes in the logical or
            // physical stream.  The publisher therefore emits no STD CblockInfo for them.  Trying
            // to describe an empty stored tail would encode (length - 1) as 0xFFFFFFFF.
            if (f.UncompressedSize == 0 && f.OnDiskSize == 0)
                continue;

            if (f.StoreRaw)
            {
                long full = f.UncompressedSize / UBlock;
                long tail = f.UncompressedSize - full * UBlock;
                for (long k = 0; k < full; k++)
                {
                    long onDisk = f.OnDiskOffset + k * UBlock;
                    blocks.Add(new NapsCblockPlanEntry
                    {
                        StartRun = runSet.Contains(onDisk),
                        OnDiskOffset = onDisk,
                        LogicalOffset = f.LogicalOffset + k * UBlock,
                        EvenChunkCompressedLength = 0x20000,
                        StreamLength = UBlock,
                        Even = 1,
                        Odd = 1,
                        KdePredictor = 0,
                        ShuffleIndex = 0,
                    });
                }
                if (tail > 0)
                {
                    long onDisk = f.OnDiskOffset + full * UBlock;
                    blocks.Add(new NapsCblockPlanEntry
                    {
                        StartRun = runSet.Contains(onDisk),
                        OnDiskOffset = onDisk,
                        LogicalOffset = f.LogicalOffset + full * UBlock,
                        EvenChunkCompressedLength = Math.Min(tail, 0x20000),
                        StreamLength = tail,
                        Even = 1,
                        Odd = (byte)(tail > 0x20000 ? 1 : 0),
                        KdePredictor = 0,
                        ShuffleIndex = 0,
                    });
                }
            }
            else if (f.CompressionBlocks.Count != 0)
            {
                long physical = f.OnDiskOffset;
                long logical = f.LogicalOffset;
                foreach (ProsperoInnerDataBlockChunk chunk in f.CompressionBlocks)
                {
                    int evenLength = chunk.IsStored
                        ? Math.Min(chunk.CompressedSize, 0x20000)
                        : chunk.IsMultiChunk ? chunk.FirstChunkCompressedSize : chunk.CompressedSize;
                    blocks.Add(new NapsCblockPlanEntry
                    {
                        StartRun = runSet.Contains(physical),
                        OnDiskOffset = physical,
                        LogicalOffset = logical,
                        EvenChunkCompressedLength = evenLength,
                        StreamLength = chunk.CompressedSize,
                        Even = chunk.IsStored
                            ? (byte)1
                            : ToNapsHalfMode(chunk.BoundaryFlags, firstHalf: true),
                        Odd = chunk.IsStored
                            ? (byte)(chunk.CompressedSize > 0x20000 ? 1 : 0)
                            : (byte)(chunk.IsMultiChunk
                                ? ToNapsHalfMode(chunk.BoundaryFlags, firstHalf: false)
                                : 0),
                        KdePredictor = 0,
                        ShuffleIndex = 0,
                    });
                    physical += chunk.CompressedSize;
                    logical += chunk.UncompressedSize;
                }
            }
            else
            {
                blocks.Add(new NapsCblockPlanEntry
                {
                    StartRun = runSet.Contains(f.OnDiskOffset),
                    OnDiskOffset = f.OnDiskOffset,
                    LogicalOffset = f.LogicalOffset,
                    EvenChunkCompressedLength = f.OnDiskSize,
                    StreamLength = f.OnDiskSize,
                    Even = 5,
                    Odd = 0,
                    KdePredictor = 0,
                    ShuffleIndex = 0,
                });
            }
        }

        return blocks;
    }

    private static byte ToNapsHalfMode(int boundaryFlags, bool firstHalf)
    {
        // PFSC boundary flags and NAPS CBI encode the same two choices in
        // different bit positions. NAPS mode 5/4 is newLZ with raw literals;
        // 7/6 is newLZ with sub/delta literals. A zero flag is the legacy
        // managed-encoder default (newLZ + raw literals).
        int newLzMask = firstHalf ? 0x02 : 0x20;
        int subLiteralMask = firstHalf ? 0x01 : 0x10;
        if (boundaryFlags == 0)
            return (byte)(4 | (firstHalf ? 1 : 0));
        // For the second half, a clear newLZ bit means a present stored/raw half (mode 1).
        // Mode 0 is reserved for an actually absent odd half and is selected by the caller when
        // the block is not multi-chunk.
        int mode = (boundaryFlags & newLzMask) != 0 ? 4 : (firstHalf ? 0 : 1);
        if ((boundaryFlags & subLiteralMask) != 0)
            mode |= 2;
        if (firstHalf)
            mode |= 1;
        return checked((byte)mode);
    }

    /// <summary>
    /// Build a <c>naps_pkg_layout.dat</c> document from a built inner image: derive the DATA-region blocks
    /// from <paramref name="files"/> + the flush schedule, append the compressor-derived
    /// <paramref name="tailBlocks"/> (padding + metadata + terminator), then run the cursor generator.
    /// </summary>
    /// <param name="numUBlocks">ceil(total logical size / 0x40000).</param>
    /// <param name="numOuterBlocks">On-disk block count of the built image.</param>
    /// <param name="files">Placed DATA-region files, in afid order.</param>
    /// <param name="runStartOnDiskOffsets">On-disk offsets that open a RUN base (compressor flush schedule).</param>
    /// <param name="tailBlocks">The padding + metadata + terminator blocks (compressor-derived).</param>
    /// <param name="fileLogicalOffsets">The afid-order fidx offsets (incl. padding/metadata/total).</param>
    /// <param name="outerBlockDigests">Optional eight-byte CMAC tags in physical outer-block order.</param>
    /// <param name="finalFileOffsetType">Type byte on the final (total-size) fidx entry.</param>
    public static NapsLayoutDocument BuildFromInnerImage(
        int numUBlocks,
        int numOuterBlocks,
        IReadOnlyList<NapsFilePlacement> files,
        IReadOnlyCollection<long> runStartOnDiskOffsets,
        IReadOnlyList<NapsCblockPlanEntry> tailBlocks,
        IReadOnlyList<long> fileLogicalOffsets,
        IReadOnlyList<byte[]>? outerBlockDigests = null,
        byte finalFileOffsetType = 0x40)
    {
        ArgumentNullException.ThrowIfNull(tailBlocks);
        var blocks = DeriveDataRegionBlocks(files, runStartOnDiskOffsets);
        blocks.AddRange(tailBlocks);

        return BuildDocument(new NapsGenerationRequest
        {
            NumUBlocks = numUBlocks,
            NumOuterBlocks = numOuterBlocks,
            FileLogicalOffsets = fileLogicalOffsets,
            FinalFileOffsetType = finalFileOffsetType,
            Blocks = blocks,
            OuterBlockDigests = outerBlockDigests,
        });
    }

    // ---- CblockInfo cursor walk -------------------------------------------------------------------

    private static (List<NapsCblockInfoEntry> Entries, List<(int Index, long Logical)> StdLogical) WalkBlocks(
        IReadOnlyList<NapsCblockPlanEntry> blocks)
    {
        var entries = new List<NapsCblockInfoEntry>(blocks.Count * 2);
        var stdLogical = new List<(int, long)>(blocks.Count);
        long cursor = 0;

        for (int blockIndex = 0; blockIndex < blocks.Count; blockIndex++)
        {
            NapsCblockPlanEntry blk = blocks[blockIndex];
            bool nextStartsRun =
                blockIndex + 1 < blocks.Count && blocks[blockIndex + 1].StartRun;

            // A semantic RUN may not occupy the final slot of a 16-entry CBI window. When the
            // current normal entry would be slot 14 and the next block opens a RUN, Publishing
            // Tools inserts a cursor-preserving RUN now: current moves to slot 15 and the next
            // semantic RUN starts the following window at slot 0. Without this look-ahead,
            // img_verify rejects data-dependent layouts whose section/terminator RUN lands at
            // index 15 (observed with 1, 8 and 16 short-file boundary corpora).
            if (!blk.StartRun && nextStartsRun && entries.Count % 16 == 14)
            {
                uint coffEnd = (uint)(cursor & Mod256K);
                entries.Add(new NapsCblockInfoEntry
                {
                    Raw = new byte[ProsperoNapsLayout.CblockInfoStride],
                    IsRunBase = true,
                    CoffsetEndMod256K = coffEnd,
                    TweakIdxStart = (uint)(cursor >> 16),
                    KeyTableIdx = 0,
                    CoffsetStart256K = (uint)(cursor / UBlock),
                });
            }

            // Every 16-entry CblockInfo window begins with a RUN base. A physical discontinuity may
            // open a RUN earlier; if it lands exactly on the window boundary only one RUN is emitted.
            if (blk.StartRun || entries.Count % 16 == 0)
            {
                uint coffEnd = (uint)(cursor & Mod256K);
                long runOffset = blk.StartRun ? blk.OnDiskOffset : cursor;
                cursor = runOffset;
                uint tweak = blk.Terminator ? 0u : (uint)(runOffset >> 16);
                uint c256K = (uint)(runOffset / UBlock);
                entries.Add(new NapsCblockInfoEntry
                {
                    Raw = new byte[ProsperoNapsLayout.CblockInfoStride],
                    IsRunBase = true,
                    CoffsetEndMod256K = coffEnd,
                    TweakIdxStart = tweak,
                    KeyTableIdx = 0,
                    CoffsetStart256K = c256K,
                });
            }

            uint coffMod = (uint)(cursor & Mod256K);
            uint uoff = (uint)(blk.LogicalOffset & Mod256K);
            uint clenEvenMinus1 = blk.Terminator
                ? 0u
                : (uint)Math.Min(blk.EvenChunkCompressedLength - 1, ClenEvenCap);

            int stdIndex = entries.Count;
            entries.Add(new NapsCblockInfoEntry
            {
                Raw = new byte[ProsperoNapsLayout.CblockInfoStride],
                IsRunBase = false,
                CoffsetStartMod256K = coffMod,
                ReservedBit19 = blk.Terminator,
                UoffsetStart = uoff,
                ClenEvenMinus1 = clenEvenMinus1,
                Even = blk.Even,
                Odd = blk.Odd,
                KdePredictor = blk.KdePredictor,
                ShuffleIdx = blk.ShuffleIndex,
            });
            stdLogical.Add((stdIndex, blk.LogicalOffset));

            cursor += blk.StreamLength;
        }

        return (entries, stdLogical);
    }

    // ---- fidx --------------------------------------------------------------------------------------

    private static List<NapsFileOffsetEntry> BuildFileOffsets(NapsGenerationRequest request)
    {
        int fileCount = request.FileLogicalOffsets.Count;
        var list = new List<NapsFileOffsetEntry>(fileCount);
        for (int i = 0; i < fileCount; i++)
        {
            byte type = request.FileOffsetTypes is not null
                ? request.FileOffsetTypes[i]
                : (i == fileCount - 1) ? request.FinalFileOffsetType : (byte)0;
            list.Add(new NapsFileOffsetEntry(type, (ulong)request.FileLogicalOffsets[i]));
        }
        return list;
    }

    // ---- u2c ---------------------------------------------------------------------------------------

    private static List<NapsU2cEntry> BuildU2c(
        List<(int Index, long Logical)> stdLogical, int numUBlocks, int numCblockInfo, int numGroups)
    {
        (int Index, long Logical)[] sorted = stdLogical.OrderBy(t => t.Logical).ToArray();

        // Publisher output defines I[u] as the first non-terminal STD whose logical start is at or
        // after u*0x40000. It is a lower-bound index into CblockInfo, not the extent containing the
        // target byte. If the final accounting ublock starts beyond the mount boundary it points at
        // the terminal sentinel.
        int[] first = new int[numUBlocks];
        int p = 0;
        for (int u = 0; u < numUBlocks; u++)
        {
            long target = (long)u * UBlock;
            while (p < sorted.Length && !IsTerminal(sorted[p].Index) && sorted[p].Logical < target)
                p++;
            first[u] = p < sorted.Length && !IsTerminal(sorted[p].Index) && sorted[p].Logical >= target
                ? sorted[p].Index
                : numCblockInfo - 1;
        }

        bool IsTerminal(int index) => index == numCblockInfo - 1;

        int Delta(int ublock, int baseIndex)
        {
            if (ublock < numUBlocks) return first[ublock] - baseIndex;
            return (numCblockInfo - 1) - baseIndex;             // beyond last ublock -> terminator
        }

        var u2c = new List<NapsU2cEntry>(numGroups);
        for (int g = 0; g < numGroups; g++)
        {
            int baseG = first[8 * g];
            var deltas = new byte[7];
            for (int j = 0; j < deltas.Length; j++)
            {
                int delta = Delta(8 * g + 1 + j, baseG);
                if (delta is < 0 or > byte.MaxValue)
                    throw new NapsU2cOverflowException(
                        delta,
                        (long)g * 8 * UBlock,
                        (long)(8 * g + 1 + j) * UBlock);
                deltas[j] = (byte)delta;
            }
            u2c.Add(new NapsU2cEntry((uint)baseG, deltas));
        }

        return u2c;
    }
}
