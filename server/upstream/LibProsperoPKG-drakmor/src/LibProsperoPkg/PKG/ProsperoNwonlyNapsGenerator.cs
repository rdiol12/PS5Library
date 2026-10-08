// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// ---------------------------------------------------------------------------------------------------
// Generates a valid naps_pkg_layout.dat for a nwonly data-first inner image assembled by
// ProsperoPs5InnerImageAssembler. The run/flush schedule is derived statically from block-aligned
// file starts, the block after each Kraken-compressed file, and dedup padding/metadata re-anchors.
// ---------------------------------------------------------------------------------------------------
#nullable enable
using LibProsperoPkg.PFS;
using LibProsperoPkg.PFS.Compression;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace LibProsperoPkg.PKG;

/// <summary>Generates a valid <c>naps_pkg_layout.dat</c> for an assembled nwonly inner image.</summary>
public static class ProsperoNwonlyNapsGenerator
{
    private const int Block64K = 0x10000;
    private const long Ublock256K = 0x40000;

    /// <summary>
    /// Builds the naps bytes for the inner image described by <paramref name="result"/>. The schedule is
    /// derived; pass <paramref name="runOverride"/> to supply explicit on-disk RUN offsets when the
    /// schedule is known.
    /// </summary>
    public static byte[] Generate(
        ProsperoPs5InnerImageResult result,
        IReadOnlyCollection<long>? runOverride = null,
        byte[]? outerBlockCmacKey = null)
    {
        ArgumentNullException.ThrowIfNull(result);
        if (outerBlockCmacKey is { Length: not 16 })
            throw new ArgumentException("NAPS outer-block CMAC key must be exactly 16 bytes.",
                nameof(outerBlockCmacKey));
        var placements = result.Placements;
        long mountSize = result.Ndblock * Block64K;
        long metaBase = result.MetaBaseLogical;
        long dataEnd = result.DataEndLogical;

        // ---- DATA-region placements + derivable run schedule ----------------------------------------
        var files = placements.Select(p => new NapsFilePlacement
        {
            OnDiskOffset = p.OnDiskOffset,
            LogicalOffset = p.LogicalOffset,
            OnDiskSize = p.OnDiskSize,
            UncompressedSize = p.UncompressedSize,
            StoreRaw = p.StoreRaw,
            CompressedKde = 2,
            CompressionBlocks = p.CompressionBlocks ?? Array.Empty<ProsperoInnerDataBlockChunk>(),
        }).ToList();

        HashSet<long> runSet;
        if (runOverride is not null)
        {
            runSet = new HashSet<long>(runOverride);
        }
        else
        {
            // A RUN opens at the first file and whenever physical placement is discontinuous. Contiguous
            // afid files share a run; WalkBlocks adds the mandatory RUN at every 16-entry CBI window.
            runSet = new HashSet<long>();
            long previousEnd = -1;
            for (int i = 0; i < placements.Count; i++)
            {
                if (i == 0 || placements[i].OnDiskOffset != previousEnd)
                    runSet.Add(placements[i].OnDiskOffset);
                previousEnd = placements[i].OnDiskOffset + placements[i].OnDiskSize;
            }
        }
        // ---- Tail: padding blocks + metadata blocks + terminator ------------------------------------
        var tail = new List<NapsCblockPlanEntry>();

        // Padding fills the logical gap [dataEnd, metaBase); each 256K block dedups to the block-info block.
        long paddingBytes = metaBase - dataEnd;
        int paddingBlocks = paddingBytes > 0 ? (int)((paddingBytes + Ublock256K - 1) / Ublock256K) : 0;
        for (int k = 0; k < paddingBlocks; k++)
        {
            long logicalLength = Math.Min(
                Ublock256K,
                paddingBytes - (long)k * Ublock256K);
            bool hasOddHalf = logicalLength > 0x20000;
            tail.Add(new NapsCblockPlanEntry
            {
                // The first padding block re-anchors to the block-info record. Subsequent window RUNs are
                // inserted by WalkBlocks at absolute CBI indices divisible by 16.
                StartRun = k == 0,
                OnDiskOffset = result.BlockInfoOnDiskOffset,
                LogicalOffset = dataEnd + (long)k * Ublock256K,
                EvenChunkCompressedLength = 8,
                // A complete zero ublock reuses two eight-byte compressed-zero chunks.  When the
                // final logical gap contains only its even 128-KiB half, the publisher emits one
                // chunk and clears Odd; declaring the absent odd half overlaps the metadata range.
                StreamLength = hasOddHalf ? 0x10 : 0x08,
                Even = 1,
                Odd = hasOddHalf ? (byte)1 : (byte)0,
                KdePredictor = 0,
                ShuffleIndex = 0,
            });
        }

        // Metadata blocks: the assembler already captured the compressed metadata's per-256K-block chunk
        // table (ProsperoInnerMetaBlockChunk), so reuse it instead of Kraken-packing the metadata again.
        // Fall back to a fresh pack only if the assembler did not supply the table (e.g. raw metadata).
        IReadOnlyList<ProsperoInnerMetaBlockChunk> metaChunks = result.MetadataBlocks;
        if (metaChunks.Count == 0)
        {
            var metaFile = ProsperoCompressedPfsFile.Parse(
                ProsperoCompressedPfsImage.Pack(result.MetadataPlaintext, 7, (int)Ublock256K));
            metaChunks = metaFile.Blocks.Select(b => new ProsperoInnerMetaBlockChunk(
                b.CompressedSize, b.UncompressedSize, b.IsMultiChunk,
                b.FirstChunkCompressedSize, b.Flags)).ToList();
        }
        long metaOnDisk = result.MetadataOnDiskOffset;
        long metaCursor = metaOnDisk;
        int metaCount = metaChunks.Count;
        for (int i = 0; i < metaCount; i++)
        {
            var blk = metaChunks[i];
            bool stored = blk.CompressedSize == blk.UncompressedSize;
            int even = stored
                ? Math.Min(blk.CompressedSize, 0x20000)
                : blk.IsMultiChunk ? blk.FirstChunkCompressedSize : blk.CompressedSize;
            tail.Add(new NapsCblockPlanEntry
            {
                // The metadata section opens a RUN only on its FIRST block; the remaining metadata chunks
                // continue the compressed cursor under that run (the trailing terminator opens its own RUN).
                // A "first and last" rule would insert a spurious RUN before the final metadata chunk.
                StartRun = i == 0,
                OnDiskOffset = metaCursor,
                LogicalOffset = metaBase + (long)i * Ublock256K,
                EvenChunkCompressedLength = even,
                StreamLength = blk.CompressedSize,
                Even = stored
                    ? (byte)1
                    : ToNapsHalfMode(blk.BoundaryFlags, firstHalf: true),
                Odd = stored
                    ? (byte)(blk.CompressedSize > 0x20000 ? 1 : 0)
                    : (byte)(blk.IsMultiChunk
                        ? ToNapsHalfMode(blk.BoundaryFlags, firstHalf: false)
                        : 0),
                KdePredictor = 0,
                ShuffleIndex = 0,
            });
            metaCursor += blk.CompressedSize;
        }

        // Terminator marks the mount end.
        tail.Add(new NapsCblockPlanEntry { StartRun = true, OnDiskOffset = metaCursor, LogicalOffset = mountSize, Terminator = true });

        // ---- fidx: AFID starts + data end + metadata base + mount -----------------------------------
        // A sparse AFID slot is expressed only by FIDX type 0x40. It consumes one logical 256-KiB
        // extent, but does not emit a CblockInfo record of its own: the reader resolves it through
        // the shared zero mapping. Publishing Tools emits a separate dataEnd boundary whenever the
        // final AFID start does not already equal dataEnd. This closes the last real file before the
        // sparse padding span; omitting it produces a FIDX/afid_to_ino count mismatch and is rejected
        // by img_verify for some otherwise valid file-count/layout combinations.
        var fidx = new List<long>(result.AfidLogicalOffsets);
        fidx.AddRange(result.EmptyFileLogicalOffsets);
        if (fidx.Count == 0 || fidx[^1] != dataEnd)
            fidx.Add(dataEnd);
        fidx.Add(metaBase);
        fidx.Add(mountSize);
        var fidxTypes = Enumerable.Repeat((byte)0, fidx.Count).ToArray();
        foreach (ProsperoPs5SparseAfidHole hole in result.SparseAfidHoles)
            fidxTypes[checked((int)hole.Afid)] = 0x40;
        fidxTypes[^1] = 0x40;

        // Publisher header includes one terminal accounting ublock beyond ceil(mount/UBlock).
        int numUBlocks = checked((int)((mountSize + Ublock256K - 1) / Ublock256K) + 1);
        int numOuterBlocks = checked((int)(
            (result.ImageLength + Block64K - 1) / Block64K));
        IReadOnlyList<byte[]>? outerBlockDigests = null;
        if (outerBlockCmacKey is not null)
        {
            var tags = new List<byte[]>(numOuterBlocks);
            using Stream image = result.OpenImage();
            byte[] block = new byte[Block64K];
            for (int i = 0; i < numOuterBlocks; i++)
            {
                Array.Clear(block);
                int available = checked((int)Math.Min(
                    Block64K, result.ImageLength - (long)i * Block64K));
                image.Position = (long)i * Block64K;
                if (available > 0)
                    image.ReadExactly(block.AsSpan(0, available));
                tags.Add(ProsperoNapsImage.ComputeOuterBlockDigest(
                    block,
                    outerBlockCmacKey));
            }
            outerBlockDigests = tags;
        }

        List<NapsCblockPlanEntry> blocks =
            ProsperoNapsLayoutBuilder.DeriveDataRegionBlocks(files, runSet);
        blocks = blocks
            .OrderBy(block => block.LogicalOffset)
            .ToList();
        blocks.AddRange(tail);

        NapsLayoutDocument doc = ProsperoNapsLayoutBuilder.BuildDocument(
            new NapsGenerationRequest
            {
                NumUBlocks = numUBlocks,
                NumOuterBlocks = numOuterBlocks,
                FileLogicalOffsets = fidx,
                FileOffsetTypes = fidxTypes,
                Blocks = blocks,
                OuterBlockDigests = outerBlockDigests,
            });

        return ProsperoNapsLayout.BuildLayout(doc);
    }

    private static byte ToNapsHalfMode(int boundaryFlags, bool firstHalf)
    {
        int newLzMask = firstHalf ? 0x02 : 0x20;
        int subLiteralMask = firstHalf ? 0x01 : 0x10;
        if (boundaryFlags == 0)
            return (byte)(4 | (firstHalf ? 1 : 0));
        // An odd half with no newLZ bit is present as a stored/raw half (mode 1), not absent
        // (mode 0). This matters for 128-KiB-plus-tail blocks where chunk 0 compresses and the
        // short second half is stored verbatim: the publisher emits 7/1, while 7/0 makes the
        // native reader ignore the tail and reject the mounted image.
        int mode = (boundaryFlags & newLzMask) != 0 ? 4 : (firstHalf ? 0 : 1);
        if ((boundaryFlags & subLiteralMask) != 0)
            mode |= 2;
        if (firstHalf)
            mode |= 1;
        return checked((byte)mode);
    }
}
