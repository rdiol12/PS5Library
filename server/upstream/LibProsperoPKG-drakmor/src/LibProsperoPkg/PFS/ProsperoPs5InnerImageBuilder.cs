// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// ---------------------------------------------------------------------------------------------------
// PS5 nwonly INNER pfs_image.dat assembler. Lays out the inner files data-first (raw files block-aligned,
// compressed files packed), followed by the block-info table and the Kraken-compressed metadata block.
// ---------------------------------------------------------------------------------------------------
#nullable enable
using LibProsperoPkg.PFS.Compression;
using System;
using System.Collections.Generic;
using System.IO;

namespace LibProsperoPkg.PFS;

/// <summary>One inner-image payload (a file's data or the metadata block) with its resolved on-disk placement.</summary>
public sealed class ProsperoPs5InnerPayload
{
    /// <summary>The uncompressed payload bytes.</summary>
    public byte[] Data = Array.Empty<byte>();

    /// <summary>When true the payload is stored raw (never compressed) and is placed block-aligned.</summary>
    public bool StoreRaw;

    /// <summary>When true the payload is placed at the next 64 KiB block boundary; otherwise packed contiguously.</summary>
    public bool BlockAligned;

    /// <summary>When true the on-disk cursor is advanced to the next 64 KiB block boundary <em>after</em> this
    /// payload, so it occupies whole blocks and the following payload starts block-aligned. Used for the
    /// sce_sys subtree, which forms a fully block-aligned region.</summary>
    public bool BlockAlignedAfter;
}
/// <summary>
/// Assembles the inner <c>pfs_image.dat</c>: data-first per-file layout (raw files block-aligned,
/// compressed files packed), a 32-byte block-info table, then the compressed metadata.
/// </summary>
public sealed class ProsperoPs5InnerImageBuilder
{
    /// <summary>The inner-image block size (64 KiB).</summary>
    public const int BlockSize = 0x10000;

    /// <summary>The per-file Kraken compression block size (256 KiB).</summary>
    public const int CompressBlockSize = 0x40000;

    private static long AlignUp(long v, long a) => (v + a - 1) & ~(a - 1);

    /// <summary>
    /// Kraken-compresses a payload into its concatenated on-disk bytes (256 KiB blocks). Returns the raw bytes
    /// when compression does not save at least 6.25%, or when <paramref name="storeRaw"/>.
    /// </summary>
    public static byte[] CompressPayload(byte[] raw, bool storeRaw)
        => CompressPayload(raw, storeRaw, out _);

    /// <summary>
    /// As <see cref="CompressPayload(byte[], bool)"/>, but also returns the parsed
    /// <see cref="ProsperoCompressedPfsFile"/> (its per-block chunk table) when the payload is stored
    /// compressed, so callers that need the block boundaries (e.g. the naps generator) do not have to
    /// Kraken-pack the same buffer a second time. <paramref name="compressedFile"/> is <see langword="null"/>
    /// when the payload is stored raw (either <paramref name="storeRaw"/> or the 6.25% keep rule fell back).
    /// </summary>
    public static byte[] CompressPayload(byte[] raw, bool storeRaw, out ProsperoCompressedPfsFile? compressedFile)
    {
        compressedFile = null;
        if (storeRaw) return raw;
        var pf = ProsperoCompressedPfsFile.Parse(ProsperoCompressedPfsImage.Pack(raw, 7, CompressBlockSize));
        using var ms = new MemoryStream();
        foreach (var b in pf.Blocks)
        {
            var d = b.CompressedData.ToArray();
            ms.Write(d, 0, d.Length);
        }
        byte[] comp = ms.ToArray();
        if (comp.Length <= (int)(((long)raw.Length * 15) >> 4))
        {
            compressedFile = pf;
            return comp;
        }
        return raw;
    }

    /// <summary>
    /// Assembles the inner image. <paramref name="payloads"/> are, in on-disk order, the data files followed by
    /// the block-info table payload and the metadata block. Each payload is compressed per its flags and placed
    /// block-aligned or packed. Returns the block-aligned-tail on-disk image.
    /// </summary>
    public byte[] Build(IReadOnlyList<ProsperoPs5InnerPayload> payloads)
    {
        using var output = new MemoryStream();
        Write(output, payloads);
        return output.ToArray();
    }

    /// <summary>
    /// Streaming counterpart of <see cref="Build"/>. Payloads are compressed one at a time and
    /// written directly to a seekable destination; gaps created by alignment remain zero-filled.
    /// Returns the exact unpadded image length.
    /// </summary>
    public long Write(Stream output, IReadOnlyList<ProsperoPs5InnerPayload> payloads)
    {
        ArgumentNullException.ThrowIfNull(output);
        ArgumentNullException.ThrowIfNull(payloads);
        if (!output.CanWrite || !output.CanSeek)
            throw new ArgumentException("Inner-image output must be writable and seekable.", nameof(output));

        output.Position = 0;
        output.SetLength(0);
        long pos = 0;
        foreach (ProsperoPs5InnerPayload payload in payloads)
        {
            ArgumentNullException.ThrowIfNull(payload);
            byte[] data = CompressPayload(payload.Data, payload.StoreRaw);
            if (payload.BlockAligned)
                pos = AlignUp(pos, BlockSize);
            output.Position = pos;
            output.Write(data);
            pos = checked(pos + data.LongLength);
            if (payload.BlockAlignedAfter)
                pos = AlignUp(pos, BlockSize);
        }
        output.SetLength(pos);
        output.Position = 0;
        return pos;
    }
}
