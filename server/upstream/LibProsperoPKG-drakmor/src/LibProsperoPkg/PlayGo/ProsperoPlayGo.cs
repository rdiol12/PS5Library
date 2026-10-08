// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// Generators for the PS5 PlayGo / about helper files that the publishing
// pipeline creates during PKG building (they are not part of the loose input folder): namely
// sce_sys/about/right.sprx, sce_sys/playgo-chunk.dat and sce_sys/playgo-manifest.xml. These
// generators ensure the produced inner PFS carries the full expected file set.
//
// The PS5 PlayGo "chunk" file uses the 'plgx' container (version 0x1000). For the single-image / single-chunk /
// single-scenario system-application profile that these system packages use, every byte is
// constant except the 36-char content id (at 0x40) and the two manifest-chunk size words
// (at 0x148 / 0x158), which describe the chunk data layout and are supplied by the builder.

#nullable enable
using LibProsperoPkg.Util;
using LibProsperoPkg.PFS;
using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Reflection;
using System.Text;

namespace LibProsperoPkg.PlayGo;

/// <summary>
/// Generators for the PS5 PlayGo / "about" files produced by the publishing
/// pipeline. See the file header for the layouts and the boundary.
/// </summary>
public static class ProsperoPlayGo
{
    public const int DefaultChunkCount = 100;

    /// <summary>The fixed size of a PS5 <c>playgo-chunk.dat</c> for the single-chunk profile.</summary>
    public const int ChunkDatSize = 0x1A0; // 416

    /// <summary>The fixed size of a PS5 <c>playgo-ficm.dat</c> header (per-file array follows).</summary>
    public const int FicmHeaderSize = 0x10; // 16

    private const string RightSprxResource = "LibProsperoPkg.PlayGo.Data.right.sprx";

    /// <summary>The PlayGo CRC block size: the finalized mount image is reduced in 64KiB blocks.</summary>
    public const int ChunkCrcBlockSize = 0x10000;

    /// <summary>
    /// Builds the PS5 <c>sce_suppl/config/&lt;content-id&gt;/playgo-chunk.crc</c> by reducing the
    /// finalized mount image with CRC-32C (Castagnoli) in 64KiB blocks and serialising each block's
    /// checksum as a little-endian uint32, in block order. This reproduces the reference
    /// output byte-for-byte (validated against every debug sample in
    /// TestFiles/PS5/PKG/Debug). The <paramref name="finalizedMountImage"/> is the FIH+PFS+SC region
    /// that precedes the SI segment (i.e. everything from offset 0 up to the SI archive); a reference
    /// mount image is always a whole number of 64KiB blocks, but a trailing partial block (if any)
    /// is reduced over its actual length for robustness.
    /// </summary>
    /// <param name="finalizedMountImage">The finalized mount image bytes (FIH header + PFS image + embedded CNT).</param>
    /// <returns>The <c>playgo-chunk.crc</c> payload: 4 bytes per 64KiB block.</returns>
    public static byte[] BuildChunkCrc(ReadOnlySpan<byte> finalizedMountImage)
    {
        if (finalizedMountImage.Length == 0)
            return [];

        int blockCount = (finalizedMountImage.Length + ChunkCrcBlockSize - 1) / ChunkCrcBlockSize;
        byte[] crc = new byte[blockCount * 4];
        for (int i = 0; i < blockCount; i++)
        {
            int start = i * ChunkCrcBlockSize;
            int len = Math.Min(ChunkCrcBlockSize, finalizedMountImage.Length - start);
            uint value = ProsperoCrc32C.Compute(finalizedMountImage.Slice(start, len));
            BinaryPrimitives.WriteUInt32LittleEndian(crc.AsSpan(i * 4), value);
        }
        return crc;
    }

    /// <summary>
    /// Streamed equivalent of <see cref="BuildChunkCrc(ReadOnlySpan{byte})"/>. The bytes from the
    /// stream's current position through <paramref name="length"/> are reduced without buffering the
    /// complete mount image; the original position is restored.
    /// </summary>
    public static byte[] BuildChunkCrc(Stream finalizedMountImage, long length)
    {
        ArgumentNullException.ThrowIfNull(finalizedMountImage);
        if (!finalizedMountImage.CanRead || !finalizedMountImage.CanSeek)
            throw new ArgumentException(
                "Finalized mount-image stream must be readable and seekable.",
                nameof(finalizedMountImage));
        if (length < 0 || length > finalizedMountImage.Length - finalizedMountImage.Position)
            throw new ArgumentOutOfRangeException(nameof(length));
        if (length == 0) return [];

        long blockCount64 = checked(
            (length + ChunkCrcBlockSize - 1) / ChunkCrcBlockSize);
        if (blockCount64 > int.MaxValue / 4)
            throw new InvalidDataException("Mount image has too many blocks for a CRC table.");
        byte[] crc = new byte[checked((int)blockCount64 * 4)];
        byte[] block = new byte[ChunkCrcBlockSize];
        long originalPosition = finalizedMountImage.Position;
        try
        {
            long remaining = length;
            for (int i = 0; i < (int)blockCount64; i++)
            {
                int count = (int)Math.Min(block.Length, remaining);
                finalizedMountImage.ReadExactly(block.AsSpan(0, count));
                uint value = ProsperoCrc32C.Compute(block.AsSpan(0, count));
                BinaryPrimitives.WriteUInt32LittleEndian(crc.AsSpan(i * 4), value);
                remaining -= count;
            }
        }
        finally
        {
            finalizedMountImage.Position = originalPosition;
        }
        return crc;
    }

    internal static byte[] BuildChunkCrc(
        Stream finalizedMountImage, long length, long knownOffset, ReadOnlySpan<byte> knownCrc)
    {
        ArgumentNullException.ThrowIfNull(finalizedMountImage);
        if (!finalizedMountImage.CanRead || !finalizedMountImage.CanSeek)
            throw new ArgumentException(
                "Finalized mount-image stream must be readable and seekable.",
                nameof(finalizedMountImage));
        if (length < 0 || length > finalizedMountImage.Length - finalizedMountImage.Position)
            throw new ArgumentOutOfRangeException(nameof(length));
        if (knownOffset < 0 || knownOffset % ChunkCrcBlockSize != 0 || knownCrc.Length % 4 != 0)
            throw new ArgumentOutOfRangeException(nameof(knownOffset));

        long blockCount64 = checked(
            (length + ChunkCrcBlockSize - 1) / ChunkCrcBlockSize);
        int knownStart = checked((int)(knownOffset / ChunkCrcBlockSize));
        int knownBlocks = knownCrc.Length / 4;
        if ((long)knownStart + knownBlocks > blockCount64 ||
            knownOffset + (long)knownBlocks * ChunkCrcBlockSize > length)
            throw new ArgumentOutOfRangeException(nameof(knownCrc));
        if (blockCount64 > int.MaxValue / 4)
            throw new InvalidDataException("Mount image has too many blocks for a CRC table.");

        byte[] crc = new byte[checked((int)blockCount64 * 4)];
        knownCrc.CopyTo(crc.AsSpan(knownStart * 4));
        byte[] block = new byte[ChunkCrcBlockSize];
        long originalPosition = finalizedMountImage.Position;
        try
        {
            for (int i = 0; i < (int)blockCount64; i++)
            {
                if (i >= knownStart && i < knownStart + knownBlocks) continue;
                int count = (int)Math.Min(
                    block.Length, length - (long)i * ChunkCrcBlockSize);
                finalizedMountImage.Position = checked(
                    originalPosition + (long)i * ChunkCrcBlockSize);
                finalizedMountImage.ReadExactly(block.AsSpan(0, count));
                uint value = ProsperoCrc32C.Compute(block.AsSpan(0, count));
                BinaryPrimitives.WriteUInt32LittleEndian(crc.AsSpan(i * 4), value);
            }
        }
        finally
        {
            finalizedMountImage.Position = originalPosition;
        }
        return crc;
    }

    /// <summary>
    /// Builds the PS5 <c>sce_sys/playgo-chunk.dat</c> (<c>plgx</c> container, version 0x1000) for the
    /// single-image / single-chunk / single-scenario profile used by PS5 system applications.
    /// </summary>
    /// <param name="contentId">The 36-character content id stamped at offset 0x40.</param>
    /// <param name="chunkDataSize">
    /// The size of chunk #0's primary manifest-chunk (mchunk) region (word at 0x148). When unknown,
    /// the inner PFS image size is a principled value.
    /// </param>
    /// <param name="chunkTailSize">
    /// The size of chunk #0's secondary mchunk region (word at 0x158). When unknown, pass 0.
    /// </param>
    /// <param name="publisherNwonly">
    /// Selects the publisher nwonly labels and mount-range convention used by PPR/NAPS packages.
    /// </param>
    /// <param name="includePublisherLabels">
    /// Keeps the standard <c>Chunk #0</c>/<c>Scenario #0</c> labels for publisher APP. Publisher
    /// AC uses one-byte empty label tables.
    /// </param>
    /// <returns>The 416-byte <c>playgo-chunk.dat</c> payload.</returns>
    public static byte[] BuildChunkDat(
        string contentId, ulong chunkDataSize = 0, ulong chunkTailSize = 0,
        bool publisherNwonly = false, bool includePublisherLabels = false)
        => BuildChunkDat(
            contentId, chunkDataSize, chunkTailSize,
            publisherNwonly, includePublisherLabels, 1);

    /// <summary>Builds <c>playgo-chunk.dat</c> with an explicit chunk count.</summary>
    public static byte[] BuildChunkDat(
        string contentId, ulong chunkDataSize, ulong chunkTailSize,
        bool publisherNwonly, bool includePublisherLabels, int chunkCount)
    {
        ArgumentException.ThrowIfNullOrEmpty(contentId);
        if (contentId.Length != 36)
            throw new ArgumentException("Content id must be exactly 36 characters.", nameof(contentId));
        if (chunkCount is < 1 or > 255)
            throw new ArgumentOutOfRangeException(nameof(chunkCount));
        if (chunkCount > 1)
            return BuildMultiChunkDat(
                contentId, SplitMainExtent(chunkDataSize, chunkCount), chunkTailSize,
                publisherNwonly, includePublisherLabels);

        byte[] d = new byte[ChunkDatSize];
        var s = d.AsSpan();

        // ---- Header (0x00 .. 0x40). ----
        Encoding.ASCII.GetBytes("plgx").CopyTo(s);                  // 0x00 magic
        BinaryPrimitives.WriteUInt16LittleEndian(s[0x04..], 0x1000); // version_major (PS5)
        BinaryPrimitives.WriteUInt16LittleEndian(s[0x06..], 0x0000); // version_minor
        BinaryPrimitives.WriteUInt16LittleEndian(s[0x08..], 1);      // image_count
        BinaryPrimitives.WriteUInt16LittleEndian(s[0x0A..], 1);      // chunk_count
        BinaryPrimitives.WriteUInt16LittleEndian(s[0x0C..], 0);      // mchunk_count (in this profile)
        BinaryPrimitives.WriteUInt16LittleEndian(s[0x0E..], 1);      // scenario_count
        BinaryPrimitives.WriteUInt32LittleEndian(s[0x10..], ChunkDatSize); // file_size
        BinaryPrimitives.WriteUInt16LittleEndian(s[0x14..], 0);      // default_scenario_id
        BinaryPrimitives.WriteUInt16LittleEndian(s[0x16..], 1);      // attrib
        BinaryPrimitives.WriteUInt32LittleEndian(s[0x18..], 0);      // sdk_ver
        // 0x1C .. 0x40: fixed preamble decoded from the reference samples.
        s[0x1E] = 0x85;                                             // layer/flags constant
        s[0x20] = 0x02;
        s[0x24] = 0x01;
        s[0x30] = 0x11;
        s[0x38] = 0xFF; s[0x39] = 0xFF; s[0x3A] = 0xFF; s[0x3B] = 0xFF;
        s[0x3C] = 0xFF; s[0x3D] = 0xFF; s[0x3E] = 0xFF; s[0x3F] = 0xFF;

        // ---- Content id (0x40, 36 bytes ASCII). ----
        Encoding.ASCII.GetBytes(contentId).CopyTo(s[0x40..]);

        // ---- Section pointer table (0xC0): (offset, size) pairs. ----
        WritePtr(s, 0xC0, 0x100, 0x20); // chunk_attrs
        WritePtr(s, 0xC8, 0x120, 0x08); // chunk_mchunks
        bool emptyLabels = publisherNwonly && !includePublisherLabels;
        WritePtr(s, 0xD0, 0x130, emptyLabels ? 0x01u : 0x09u); // empty label or "Chunk #0\0"
        WritePtr(s, 0xD8, 0x140, 0x20); // mchunk_attrs
        WritePtr(s, 0xE0, 0x160, 0x20); // inner mchunk_attrs
        WritePtr(s, 0xE8, 0x180, 0x02); // scenario_attrs
        WritePtr(s, 0xF0, 0x190, emptyLabels ? 0x01u : 0x0Cu); // empty label or "Scenario #0\0"

        // ---- Chunk attribute (0x100). ----
        s[0x100] = 0x80; // flag
        s[0x102] = 0x03; // req_locus
        s[0x104] = 0x02; // mchunk_count for the chunk
        s[0x108] = 0x11; // language/attr constant
        // language_mask: all-languages (0xFFFFFFFFFFFFFFFF) at 0x110.
        BinaryPrimitives.WriteUInt64LittleEndian(s[0x110..], ulong.MaxValue);

        // ---- chunk_mchunks (0x120): chunk #0 references mchunk index 1. ----
        BinaryPrimitives.WriteUInt32LittleEndian(s[0x124..], 1);

        // ---- chunk_labels (0x130). ----
        if (!emptyLabels)
            Encoding.ASCII.GetBytes("Chunk #0").CopyTo(s[0x130..]);

        // ---- mchunk_attrs (0x140): two 16-byte {offset, size} entries. ----
        // entry0 = {0, chunkDataSize}; entry1 = {chunkDataSize, chunkTailSize}.
        BinaryPrimitives.WriteUInt64LittleEndian(s[0x140..], 0);
        BinaryPrimitives.WriteUInt64LittleEndian(s[0x148..], chunkDataSize);
        BinaryPrimitives.WriteUInt64LittleEndian(s[0x150..], chunkDataSize);
        BinaryPrimitives.WriteUInt64LittleEndian(s[0x158..], chunkTailSize);

        // ---- inner mchunk_attrs (0x160): {0x21, 0} then a constant {1,1} marker at 0x174. ----
        BinaryPrimitives.WriteUInt64LittleEndian(s[0x160..], 0x21);
        s[0x174] = 0x01;
        s[0x176] = 0x01;

        // ---- scenario_labels (0x190). ----
        if (!emptyLabels)
            Encoding.ASCII.GetBytes("Scenario #0").CopyTo(s[0x190..]);

        return d;
    }

    private static byte[] BuildMultiChunkDat(
        string contentId, IReadOnlyList<ulong> mainSizes, ulong tailSize,
        bool publisherNwonly, bool includePublisherLabels)
    {
        int chunkCount = mainSizes.Count;
        int[] mainIndexes = new int[chunkCount];
        int mainCount = 0;
        for (int i = 0; i < chunkCount; i++)
            mainIndexes[i] = mainSizes[i] == 0 ? -1 : mainCount++;
        int mchunkCount = checked(mainCount + 1);

        bool emptyLabels = publisherNwonly && !includePublisherLabels;
        string[] chunkLabels = Enumerable.Range(0, chunkCount).Select(i => $"Chunk #{i}").ToArray();
        int[] labelOffsets = new int[chunkCount];
        int chunkLabelsSize = emptyLabels ? 1 : 0;
        if (!emptyLabels)
            for (int i = 0; i < chunkCount; i++)
            {
                labelOffsets[i] = chunkLabelsSize;
                chunkLabelsSize = checked(chunkLabelsSize + Encoding.ASCII.GetByteCount(chunkLabels[i]) + 1);
            }

        int chunkAttrsOffset = 0x100;
        int chunkAttrsSize = checked(chunkCount * 0x20);
        int chunkMchunksOffset = checked(chunkAttrsOffset + chunkAttrsSize);
        int chunkMchunksSize = checked(mchunkCount * 4);
        int chunkLabelsOffset = Align16(checked(chunkMchunksOffset + chunkMchunksSize));
        int mchunkAttrsOffset = Align16(checked(chunkLabelsOffset + chunkLabelsSize));
        int mchunkAttrsSize = checked(mchunkCount * 0x10);
        int scenarioAttrsOffset = checked(mchunkAttrsOffset + mchunkAttrsSize);
        int scenarioChunksOffset = checked(scenarioAttrsOffset + 0x20);
        int scenarioChunksSize = checked(chunkCount * 2);
        int scenarioLabelsOffset = Align16(checked(scenarioChunksOffset + scenarioChunksSize));
        int scenarioLabelsSize = emptyLabels ? 1 : "Scenario #0".Length + 1;
        int fileSize = Align16(checked(scenarioLabelsOffset + scenarioLabelsSize));

        byte[] d = new byte[fileSize];
        Span<byte> s = d;
        Encoding.ASCII.GetBytes("plgx").CopyTo(s);
        BinaryPrimitives.WriteUInt16LittleEndian(s[0x04..], 0x1000);
        BinaryPrimitives.WriteUInt16LittleEndian(s[0x08..], 1);
        BinaryPrimitives.WriteUInt16LittleEndian(s[0x0A..], checked((ushort)chunkCount));
        BinaryPrimitives.WriteUInt16LittleEndian(s[0x0E..], 1);
        BinaryPrimitives.WriteUInt32LittleEndian(s[0x10..], checked((uint)fileSize));
        BinaryPrimitives.WriteUInt16LittleEndian(s[0x16..], 1);
        s[0x1E] = 0x85;
        BinaryPrimitives.WriteUInt32LittleEndian(s[0x20..], checked((uint)mchunkCount));
        s[0x24] = 1;
        s[0x30] = 0x11;
        BinaryPrimitives.WriteUInt64LittleEndian(s[0x38..], ulong.MaxValue);
        Encoding.ASCII.GetBytes(contentId).CopyTo(s[0x40..]);

        WritePtr(s, 0xC0, checked((uint)chunkAttrsOffset), checked((uint)chunkAttrsSize));
        WritePtr(s, 0xC8, checked((uint)chunkMchunksOffset), checked((uint)chunkMchunksSize));
        WritePtr(s, 0xD0, checked((uint)chunkLabelsOffset), checked((uint)chunkLabelsSize));
        WritePtr(s, 0xD8, checked((uint)mchunkAttrsOffset), checked((uint)mchunkAttrsSize));
        WritePtr(s, 0xE0, checked((uint)scenarioAttrsOffset), 0x20);
        WritePtr(s, 0xE8, checked((uint)scenarioChunksOffset), checked((uint)scenarioChunksSize));
        WritePtr(s, 0xF0, checked((uint)scenarioLabelsOffset), checked((uint)scenarioLabelsSize));

        int refsOffset = 0;
        for (int i = 0; i < chunkCount; i++)
        {
            int at = checked(chunkAttrsOffset + i * 0x20);
            s[at] = 0x80;
            s[at + 2] = 3;
            BinaryPrimitives.WriteUInt16LittleEndian(
                s[(at + 4)..], checked((ushort)((mainIndexes[i] >= 0 ? 1 : 0) + (i == 0 ? 1 : 0))));
            s[at + 8] = 0x11;
            BinaryPrimitives.WriteUInt64LittleEndian(s[(at + 0x10)..], ulong.MaxValue);
            BinaryPrimitives.WriteUInt32LittleEndian(s[(at + 0x18)..], checked((uint)refsOffset));
            BinaryPrimitives.WriteUInt32LittleEndian(s[(at + 0x1C)..], checked((uint)labelOffsets[i]));
            if (mainIndexes[i] >= 0)
            {
                BinaryPrimitives.WriteUInt32LittleEndian(
                    s[(chunkMchunksOffset + refsOffset)..], checked((uint)mainIndexes[i]));
                refsOffset += 4;
            }
            if (i == 0)
            {
                BinaryPrimitives.WriteUInt32LittleEndian(
                    s[(chunkMchunksOffset + refsOffset)..], checked((uint)mainCount));
                refsOffset += 4;
            }
            if (!emptyLabels)
                Encoding.ASCII.GetBytes(chunkLabels[i]).CopyTo(s[(chunkLabelsOffset + labelOffsets[i])..]);
        }

        ulong rangeOffset = 0;
        for (int i = 0; i < chunkCount; i++)
            if (mainIndexes[i] >= 0)
            {
                int at = checked(mchunkAttrsOffset + mainIndexes[i] * 0x10);
                BinaryPrimitives.WriteUInt64LittleEndian(s[at..], rangeOffset);
                BinaryPrimitives.WriteUInt64LittleEndian(s[(at + 8)..], mainSizes[i]);
                rangeOffset = checked(rangeOffset + mainSizes[i]);
            }
        int tailAt = checked(mchunkAttrsOffset + mainCount * 0x10);
        BinaryPrimitives.WriteUInt64LittleEndian(s[tailAt..], rangeOffset);
        BinaryPrimitives.WriteUInt64LittleEndian(s[(tailAt + 8)..], tailSize);

        BinaryPrimitives.WriteUInt64LittleEndian(s[scenarioAttrsOffset..], 0x21);
        BinaryPrimitives.WriteUInt16LittleEndian(s[(scenarioAttrsOffset + 0x14)..], checked((ushort)chunkCount));
        BinaryPrimitives.WriteUInt16LittleEndian(s[(scenarioAttrsOffset + 0x16)..], checked((ushort)chunkCount));
        for (int i = 0; i < chunkCount; i++)
            BinaryPrimitives.WriteUInt16LittleEndian(s[(scenarioChunksOffset + i * 2)..], checked((ushort)i));
        if (!emptyLabels)
            Encoding.ASCII.GetBytes("Scenario #0").CopyTo(s[scenarioLabelsOffset..]);
        return d;
    }

    private static ulong[] SplitMainExtent(ulong size, int chunkCount)
    {
        ulong blocks = size / ChunkCrcBlockSize;
        ulong remainder = size % ChunkCrcBlockSize;
        ulong[] sizes = new ulong[chunkCount];
        ulong perChunk = blocks / (ulong)chunkCount;
        ulong extra = blocks % (ulong)chunkCount;
        for (int i = 0; i < chunkCount; i++)
            sizes[i] = checked((perChunk + ((ulong)i < extra ? 1UL : 0UL)) * ChunkCrcBlockSize);
        sizes[^1] = checked(sizes[^1] + remainder);
        return sizes;
    }

    private static int Align16(int value) => checked(value + 15) & ~15;

    /// <summary>
    /// Builds the default one-chunk PlayGo scenario emitted by Publishing Tools 2.79.
    /// Keep the CRLF formatting: the same bytes are stored in both CNT and SI.
    /// </summary>
    public static byte[] BuildScenarioJson() => Encoding.UTF8.GetBytes(
        "{\r\n" +
        "  \"chunkDefaultLanguage\": \"en-US\",\r\n" +
        "  \"chunkSupportedLanguages\": [\r\n" +
        "    \"en-US\"\r\n" +
        "  ],\r\n" +
        "  \"scenarioCount\": 1,\r\n" +
        "  \"scenarioDefaultId\": 0,\r\n" +
        "  \"scenarioDefaultLanguage\": \"en-US\",\r\n" +
        "  \"scenarios\": [\r\n" +
        "    {\r\n" +
        "      \"id\": 0,\r\n" +
        "      \"type\": \"playmode\",\r\n" +
        "      \"en-US\": {\r\n" +
        "        \"title\": \"Scenario #0\",\r\n" +
        "        \"description\": \"Default play scenario\"\r\n" +
        "      }\r\n" +
        "    }\r\n" +
        "  ]\r\n" +
        "}\r\n");

    /// <summary>
    /// Builds the PS5 <c>sce_sys/playgo-ficm.dat</c>. The file is a 16-byte header followed by a
    /// <paramref name="fileCount"/>-byte per-file array (zero-filled in the reference samples), so its
    /// total length is <c>16 + fileCount</c>.
    /// </summary>
    /// <param name="fileCount">The PlayGo file/inode count stamped at 0x0C.</param>
    public static byte[] BuildFicm(uint fileCount)
    {
        // Defensive bound: the per-file array is one byte per file; a reference package has at most a few
        // thousand inodes, so cap well below int.MaxValue to keep the (int) cast and allocation safe.
        if (fileCount > 0x100000)
            throw new ArgumentOutOfRangeException(nameof(fileCount), fileCount, "PlayGo file count is implausibly large.");
        byte[] d = new byte[FicmHeaderSize + (int)fileCount];
        var s = d.AsSpan();
        BinaryPrimitives.WriteUInt32LittleEndian(s[0x00..], 1);              // version
        BinaryPrimitives.WriteUInt32LittleEndian(s[0x08..], FicmHeaderSize); // per-file array offset
        BinaryPrimitives.WriteUInt32LittleEndian(s[0x0C..], fileCount);      // file/inode count
        return d;
    }

    public static byte[] BuildFicm(IReadOnlyList<byte> fileChunkIds)
    {
        ArgumentNullException.ThrowIfNull(fileChunkIds);
        byte[] d = BuildFicm(checked((uint)fileChunkIds.Count * 2));
        for (int i = 0; i < fileChunkIds.Count; i++) d[FicmHeaderSize + i * 2] = fileChunkIds[i];
        return d;
    }

    public static byte[] BuildAutomaticFileChunkIds(int fileCount, int chunkCount)
    {
        if (fileCount < 1) throw new ArgumentOutOfRangeException(nameof(fileCount));
        if (chunkCount is < 1 or > 255) throw new ArgumentOutOfRangeException(nameof(chunkCount));
        byte[] ids = new byte[fileCount];
        for (int i = 0; i < fileCount; i++)
            ids[i] = checked((byte)Math.Min(chunkCount - 1, (long)i * chunkCount / fileCount));
        return ids;
    }

    /// <summary>The fixed size of the <c>playgo-hash-table.dat</c> header + 16-byte prefix
    /// (the per-chunk constant table follows at this offset).</summary>
    public const int HashTableTableOffset = 0x38;

    // The playgo-hash-table.dat payload is content-INDEPENDENT: the 16-byte prefix and every
    // 8-byte per-chunk table entry are byte-identical across all reference PS5 debug samples
    // (Downloads, InternetBrowser, DebugSettings), i.e. they are fixed table constants,
    // not a hash of this package's content. The first five entries below cover the whole observed
    // debug profile (chunk counts 4 and 5); higher counts are extremely unusual for the
    // single-chunk system-application packages this path targets, and can be extracted in full
    // from additional reference packages if ever required.
    private static ReadOnlySpan<byte> HashTablePrefix =>
        [0x51, 0x4F, 0xA2, 0x26, 0xAB, 0x8A, 0xCA, 0x92, 0x4D, 0xC4, 0x1B, 0xA4, 0x61, 0xB7, 0xBB, 0x09];

    private static readonly byte[][] HashTableEntries =
    [
        [0x8E, 0x54, 0xCB, 0x4D, 0x4A, 0xF6, 0x30, 0x0E],
        [0xF2, 0xBF, 0xF6, 0x27, 0xB9, 0x8F, 0x88, 0x53],
        [0xCB, 0xDC, 0xC6, 0x3E, 0xEC, 0xB3, 0xC4, 0xAE],
        [0x0B, 0xF4, 0xE9, 0xC5, 0xDA, 0xF8, 0xC9, 0xAE],
        [0x4C, 0xF7, 0x0C, 0x08, 0x17, 0x4D, 0xCB, 0xD3],
    ];

    /// <summary>
    /// Builds the PS5 <c>sce_sys/playgo-hash-table.dat</c> (CNT entry id <c>0x2010</c>). The file is a
    /// 0x28-byte header, a 16-byte constant prefix, then a <paramref name="chunkCount"/>-entry constant
    /// table (8 bytes each), so its total length is <c>0x38 + chunkCount * 8</c>. The number of
    /// hash-table chunks is half the PlayGo file/inode count stamped in <c>playgo-ficm.dat</c>
    /// (proven across the reference debug samples: ficm 8 -&gt; 4 chunks, ficm 10 -&gt; 5 chunks).
    /// </summary>
    /// <param name="chunkCount">The hash-table chunk count (= <c>ficmFileCount / 2</c>).</param>
    public static byte[] BuildHashTable(uint chunkCount)
    {
        if (chunkCount > 0x10000)
            throw new ArgumentOutOfRangeException(nameof(chunkCount), chunkCount, "PlayGo hash-table chunk count is implausibly large.");
        int tableSize = (int)chunkCount * HashTableEntrySize;
        byte[] d = new byte[HashTableTableOffset + tableSize];
        var s = d.AsSpan();
        BinaryPrimitives.WriteUInt32LittleEndian(s[0x00..], 1);                          // version
        BinaryPrimitives.WriteUInt32LittleEndian(s[0x04..], 0x08000000);                 // const flags
        BinaryPrimitives.WriteUInt32LittleEndian(s[0x08..], HashTableTableOffset);       // table offset
        BinaryPrimitives.WriteUInt32LittleEndian(s[0x0C..], (uint)tableSize);            // table size
        new byte[] { 0x7F, (byte)'F', (byte)'L', (byte)'T' }.CopyTo(s[0x18..]);          // "\x7FFLT" magic
        BinaryPrimitives.WriteUInt32LittleEndian(s[0x24..], chunkCount);                 // chunk count
        HashTablePrefix.CopyTo(s[0x28..]);                                               // 16-byte const prefix
        for (int i = 0; i < chunkCount; i++)
        {
            // The observed debug profile baked these constants for chunk indices 0..4; for the rare
            // higher counts repeat the last known constant (deterministic, self-consistent).
            byte[] entry = HashTableEntries[Math.Min(i, HashTableEntries.Length - 1)];
            entry.CopyTo(s[(HashTableTableOffset + i * HashTableEntrySize)..]);
        }
        return d;
    }

    /// <summary>
    /// Builds the publisher PPR/NAPS FLT hash table from the actual inner-file paths. Each table item is
    /// the PS5 flat-path hash written little-endian; publisher output sorts the hashes numerically.
    /// </summary>
    public static byte[] BuildHashTable(IReadOnlyList<string> innerPaths)
    {
        ArgumentNullException.ThrowIfNull(innerPaths);
        ulong[] hashes = innerPaths
            .Select(ProsperoPs5FlatPathTable.HashPath)
            .OrderBy(value => value)
            .ToArray();
        if (hashes.Length > 0x10000)
            throw new ArgumentOutOfRangeException(nameof(innerPaths), "PlayGo FLT hash-table count is implausibly large.");

        int tableSize = checked(hashes.Length * HashTableEntrySize);
        byte[] d = new byte[HashTableTableOffset + tableSize];
        Span<byte> s = d;
        BinaryPrimitives.WriteUInt32LittleEndian(s[0x00..], 1);
        BinaryPrimitives.WriteUInt32LittleEndian(s[0x04..], 0x08000000);
        BinaryPrimitives.WriteUInt32LittleEndian(s[0x08..], HashTableTableOffset);
        BinaryPrimitives.WriteUInt32LittleEndian(s[0x0C..], (uint)tableSize);
        new byte[] { 0x7F, (byte)'F', (byte)'L', (byte)'T' }.CopyTo(s[0x18..]);
        BinaryPrimitives.WriteUInt32LittleEndian(s[0x24..], (uint)hashes.Length);
        HashTablePrefix.CopyTo(s[0x28..]);
        for (int i = 0; i < hashes.Length; i++)
            BinaryPrimitives.WriteUInt64LittleEndian(s[(HashTableTableOffset + i * HashTableEntrySize)..], hashes[i]);
        return d;
    }

    /// <summary>The size of one <c>playgo-hash-table.dat</c> per-chunk table entry.</summary>
    public const int HashTableEntrySize = 8;

    /// <summary>
    /// The fixed PS5 debug <c>sce_sys/about/right.sprx</c> module embedded in every reference
    /// debug package, or <c>null</c> when the embedded resource is unavailable.
    /// </summary>
    public static byte[]? GetRightSprx()
    {
        using Stream? stream = typeof(ProsperoPlayGo).GetTypeInfo().Assembly
            .GetManifestResourceStream(RightSprxResource);
        if (stream is null) return null;
        using var ms = new MemoryStream();
        stream.CopyTo(ms);
        return ms.ToArray();
    }

    private static void WritePtr(Span<byte> s, int at, uint offset, uint size)
    {
        BinaryPrimitives.WriteUInt32LittleEndian(s[at..], offset);
        BinaryPrimitives.WriteUInt32LittleEndian(s[(at + 4)..], size);
    }
}
