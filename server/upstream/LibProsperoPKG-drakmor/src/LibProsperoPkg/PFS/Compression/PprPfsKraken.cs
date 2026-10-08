// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// Streaming writer for the PFSC version-2 per-file container consumed by ppr_pfs.
#nullable enable
using LibProsperoPkg.PFS.Compression.Oodle;
using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;

namespace LibProsperoPkg.PFS.Compression;

/// <summary>Statistics returned by <c>PprPfsKraken.Write</c>.</summary>
public sealed class PprPfsKrakenWriteResult
{
    /// <summary>Logical, decompressed file size.</summary>
    public required long UncompressedSize { get; init; }

    /// <summary>Complete PFSC v2 container size.</summary>
    public required long StoredSize { get; init; }

    /// <summary>Number of logical 128 KiB blocks.</summary>
    public required int BlockCount { get; init; }

    /// <summary>Number of blocks stored as Kraken streams.</summary>
    public required int CompressedBlockCount { get; init; }

    /// <summary>Number of incompressible blocks stored verbatim.</summary>
    public int StoredBlockCount => BlockCount - CompressedBlockCount;

    /// <summary>Number of blocks deliberately kept raw by a read-optimization range.</summary>
    public int ForcedRawBlockCount { get; init; }

    /// <summary>Number of blocks kept raw because Kraken did not save the configured minimum.</summary>
    public int LowGainRawBlockCount { get; init; }
}

/// <summary>A logical byte range that must be represented by raw PFSC table entries.</summary>
public readonly record struct PprPfsRawRange(long Offset, long Length);

/// <summary>Controls the runtime-I/O tradeoff of a PFSC v2/Kraken stream.</summary>
public sealed class PprPfsKrakenWriteOptions
{
    /// <summary>Kraken level written into the PFSC header.</summary>
    public int Level { get; set; } = PprPfsKraken.DefaultLevel;

    /// <summary>Decode and compare every emitted Kraken group while building.</summary>
    public bool VerifyBlocks { get; set; }

    /// <summary>
    /// Minimum percentage of logical bytes Kraken must save for a group to remain compressed.
    /// Groups below this threshold are stored raw to avoid decompression for negligible I/O gain.
    /// </summary>
    public int MinimumSavingsPercent { get; set; }

    /// <summary>Logical ranges whose intersecting 256 KiB groups are forced to raw storage.</summary>
    public IReadOnlyCollection<PprPfsRawRange> RawRanges { get; set; } = Array.Empty<PprPfsRawRange>();
}

/// <summary>
/// Creates the legacy PFSC version-2 Kraken files embedded in a PPR-PFS filesystem.
/// This is the layout used by the kernel's <c>ppr_pfs_cmp_bread</c> path, not the
/// section-directory PFSC version-3 layout used by NAPS package metadata.
/// </summary>
public static class PprPfsKraken
{
    /// <summary>PFSC magic (<c>"PFSC"</c> as a little-endian integer).</summary>
    public const uint Magic = 0x43534650;

    /// <summary>PFSC container version used by per-file publisher PPR-PFS compression.</summary>
    public const uint Version = 2;

    /// <summary>The only block size accepted by the ppr_pfs Kraken path.</summary>
    public const int BlockSize = 0x20000;

    // ppr_pfs exposes 128 KiB logical blocks in the PFSC table, but submits two adjacent
    // entries to the I/O controller as one 256 KiB Kraken package whenever possible.  The
    // first chunk is seeded; the second chunk is a seedless continuation that may refer to
    // bytes produced by the first.  Encoding the two table entries independently produces a
    // superficially valid PFSC file, but the ZDE rejects the second seed as an invalid stream.
    public const int CompressionGroupSize = 2 * BlockSize;

    /// <summary>Default encoder level observed in publisher-produced PFSC v2 files.</summary>
    public const int DefaultLevel = 8;

    private const int HeaderSize = 0x400;
    private const int TableAlignment = 0x20;
    private const ulong Low48Mask = 0x0000FFFFFFFFFFFFUL;
    private const ulong GroupBoundaryFlag = 0x8000UL;
    private const ulong CompressedFlag = 0x4000UL;

    // Constant 16-byte encoder identifier found at header +0x78 in publisher-produced files.
    private static readonly byte[] EncoderIdentifier =
    [
        0xD5, 0x75, 0x50, 0xFB, 0x29, 0x22, 0x76, 0xBF,
        0x57, 0xAE, 0xAE, 0xEA, 0x26, 0x31, 0x93, 0xA2,
    ];

    /// <summary>Compresses an input file into a ppr_pfs-compatible PFSC v2 file.</summary>
    /// <param name="inputPath">Path to the logical input file.</param>
    /// <param name="outputPath">Destination PFSC v2 path.</param>
    /// <param name="level">Kraken level recorded in the header. Publisher output normally uses 8.</param>
    /// <param name="verifyBlocks">Decode every emitted Kraken block and compare it with the source.</param>
    /// <returns>Container and block statistics.</returns>
    public static PprPfsKrakenWriteResult PackFile(
        string inputPath,
        string outputPath,
        int level = DefaultLevel,
        bool verifyBlocks = false)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(inputPath);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);

        return PackFile(inputPath, outputPath, new PprPfsKrakenWriteOptions
        {
            Level = level,
            VerifyBlocks = verifyBlocks,
        });
    }

    /// <summary>Compresses a file with explicit runtime-read optimization options.</summary>
    public static PprPfsKrakenWriteResult PackFile(
        string inputPath,
        string outputPath,
        PprPfsKrakenWriteOptions options)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(inputPath);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);
        ArgumentNullException.ThrowIfNull(options);

        string inputFullPath = Path.GetFullPath(inputPath);
        string outputFullPath = Path.GetFullPath(outputPath);
        if (PathsEqual(inputFullPath, outputFullPath))
            throw new IOException("PFSC input and output paths must be different.");

        string outputDirectory = Path.GetDirectoryName(outputFullPath) ?? Directory.GetCurrentDirectory();
        Directory.CreateDirectory(outputDirectory);
        string temporaryPath = Path.Combine(
            outputDirectory, ".pfsc-write-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            PprPfsKrakenWriteResult result;
            using (var input = new FileStream(
                inputFullPath, FileMode.Open, FileAccess.Read, FileShare.Read,
                bufferSize: 1 << 20, FileOptions.SequentialScan))
            using (var output = new FileStream(
                temporaryPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None,
                bufferSize: 1 << 20, FileOptions.SequentialScan))
            {
                result = Write(input, input.Length, output, options);
            }
            File.Move(temporaryPath, outputFullPath, overwrite: true);
            return result;
        }
        finally
        {
            try { File.Delete(temporaryPath); }
            catch { /* best-effort cleanup */ }
        }
    }

    /// <summary>Decompresses a standalone PFSC v2 file.</summary>
    /// <param name="inputPath">PFSC v2 input path.</param>
    /// <param name="outputPath">Destination logical file path.</param>
    /// <returns>Number of decompressed bytes written.</returns>
    public static long UnpackFile(string inputPath, string outputPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(inputPath);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);
        string inputFullPath = Path.GetFullPath(inputPath);
        string outputFullPath = Path.GetFullPath(outputPath);
        if (PathsEqual(inputFullPath, outputFullPath))
            throw new IOException("PFSC input and output paths must be different.");
        string outputDirectory = Path.GetDirectoryName(outputFullPath) ?? Directory.GetCurrentDirectory();
        Directory.CreateDirectory(outputDirectory);
        string temporaryPath = Path.Combine(
            outputDirectory, ".pfsc-unpack-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            long result;
            using (var input = new FileStream(
                inputFullPath, FileMode.Open, FileAccess.Read, FileShare.Read,
                bufferSize: 1 << 20, FileOptions.SequentialScan))
            using (var output = new FileStream(
                temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                bufferSize: 1 << 20, FileOptions.SequentialScan))
            {
                result = Unpack(input, containerOffset: 0, output);
            }
            File.Move(temporaryPath, outputFullPath, overwrite: true);
            return result;
        }
        finally
        {
            try { File.Delete(temporaryPath); }
            catch { /* best-effort cleanup */ }
        }
    }

    /// <summary>Decompresses a PFSC v2 container embedded at an arbitrary stream offset.</summary>
    /// <param name="source">Seekable stream containing the PFSC v2 bytes.</param>
    /// <param name="containerOffset">Absolute stream offset of the <c>PFSC</c> magic.</param>
    /// <param name="destination">Writable destination for the logical file.</param>
    /// <returns>Number of decompressed bytes written.</returns>
    public static long Unpack(Stream source, long containerOffset, Stream destination)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(destination);
        ArgumentOutOfRangeException.ThrowIfNegative(containerOffset);
        if (!source.CanRead || !source.CanSeek)
            throw new ArgumentException("Source stream must be readable and seekable.", nameof(source));
        if (!destination.CanWrite)
            throw new ArgumentException("Destination stream must be writable.", nameof(destination));
        if (containerOffset > source.Length - 0x80)
            throw new InvalidDataException("PFSC header extends past the source stream.");

        var header = new byte[0x80];
        source.Position = containerOffset;
        ReadExactly(source, header, header.Length);
        ReadOnlySpan<byte> h = header;
        uint magic = BinaryPrimitives.ReadUInt32LittleEndian(h[0x00..]);
        uint version = BinaryPrimitives.ReadUInt32LittleEndian(h[0x04..]);
        uint algorithm = BinaryPrimitives.ReadUInt32LittleEndian(h[0x08..]);
        uint blockSize = BinaryPrimitives.ReadUInt32LittleEndian(h[0x0C..]);
        uint entrySize = BinaryPrimitives.ReadUInt32LittleEndian(h[0x10..]);
        int blockCount = checked((int)BinaryPrimitives.ReadUInt32LittleEndian(h[0x14..]));
        long logicalSize = checked((long)BinaryPrimitives.ReadUInt64LittleEndian(h[0x18..]));
        long totalSize = checked((long)BinaryPrimitives.ReadUInt64LittleEndian(h[0x20..]));
        long tableOffset = checked((long)BinaryPrimitives.ReadUInt64LittleEndian(h[0x30..]));
        long dataOffset = checked((long)BinaryPrimitives.ReadUInt64LittleEndian(h[0x40..]));

        if (magic != Magic || version != Version || algorithm != (uint)CompressionAlgorithm.Kraken
            || blockSize != BlockSize || entrySize != TableAlignment)
        {
            throw new InvalidDataException(
                $"Unsupported PFSC header: magic=0x{magic:X8}, version={version}, algorithm={algorithm}, block=0x{blockSize:X}.");
        }
        if (blockCount != Math.Max(1, (logicalSize + BlockSize - 1) / BlockSize))
            throw new InvalidDataException("PFSC block count does not match the logical size.");
        long expectedDataOffset = Align(
            HeaderSize + checked((long)(blockCount + 1) * sizeof(ulong)), TableAlignment);
        if (tableOffset != HeaderSize || dataOffset != expectedDataOffset
            || totalSize < dataOffset || totalSize > source.Length - containerOffset)
            throw new InvalidDataException("PFSC offset table or data offset is invalid.");

        var tableBytes = new byte[checked((blockCount + 1) * sizeof(ulong))];
        source.Position = containerOffset + tableOffset;
        ReadExactly(source, tableBytes, tableBytes.Length);
        ulong sentinel = BinaryPrimitives.ReadUInt64LittleEndian(
            tableBytes.AsSpan(blockCount * sizeof(ulong)));
        if (sentinel != (GroupBoundaryFlag << 48 | (ulong)totalSize))
            throw new InvalidDataException("PFSC final offset-table entry is invalid.");
        var outputBuffer = new byte[CompressionGroupSize];
        long produced = 0;

        for (int index = 0; index < blockCount;)
        {
            ulong current = BinaryPrimitives.ReadUInt64LittleEndian(tableBytes.AsSpan(index * sizeof(ulong)));
            ulong next = BinaryPrimitives.ReadUInt64LittleEndian(tableBytes.AsSpan((index + 1) * sizeof(ulong)));
            long storedOffset = checked((long)(current & Low48Mask));
            long nextOffset = checked((long)(next & Low48Mask));
            if (storedOffset < dataOffset || nextOffset < storedOffset || nextOffset > totalSize)
                throw new InvalidDataException($"PFSC block {index} has an invalid stored range.");

            ushort flags = checked((ushort)(current >> 48));
            bool compressed = (flags & CompressedFlag) != 0;
            if (compressed)
            {
                bool groupStart = flags == GroupBoundaryFlag + CompressedFlag;
                bool hasContinuation = index + 1 < blockCount
                    && (ushort)(next >> 48) == CompressedFlag;
                if (!groupStart)
                    throw new InvalidDataException($"PFSC block {index} is an orphaned Kraken continuation.");

                int blocksInGroup = hasContinuation ? 2 : 1;
                ulong endEntry = BinaryPrimitives.ReadUInt64LittleEndian(
                    tableBytes.AsSpan((index + blocksInGroup) * sizeof(ulong)));
                long endOffset = checked((long)(endEntry & Low48Mask));
                if (endOffset <= storedOffset || endOffset > totalSize)
                    throw new InvalidDataException($"PFSC Kraken group at block {index} has an invalid stored range.");

                int storedSize = checked((int)(endOffset - storedOffset));
                var payload = new byte[storedSize];
                source.Position = containerOffset + storedOffset;
                ReadExactly(source, payload, payload.Length);

                int outputSize = checked((int)Math.Min(
                    blocksInGroup * (long)BlockSize, logicalSize - produced));
                int decoderFlags = blocksInGroup == 2 ? 0x02 | 0x20 : 0x02;
                int firstChunkComp = blocksInGroup == 2
                    ? checked((int)(nextOffset - storedOffset))
                    : 0;
                Span<byte> outputBlock = outputBuffer.AsSpan(0, outputSize);
                KrakenDecodeStatus status = KrakenDecoder.DecodeBlock(
                    payload, decoderFlags, firstChunkComp, outputBlock);
                if (status != KrakenDecodeStatus.Success)
                    throw new InvalidDataException($"PFSC Kraken group at block {index} decode failed ({status}).");
                destination.Write(outputBlock);
                produced += outputSize;
                index += blocksInGroup;
            }
            else
            {
                if (flags != GroupBoundaryFlag)
                    throw new InvalidDataException(
                        $"PFSC block {index} has unsupported flags 0x{flags:X4}.");
                int storedSize = checked((int)(nextOffset - storedOffset));
                int outputSize = checked((int)Math.Min(BlockSize, logicalSize - produced));
                var payload = new byte[storedSize];
                source.Position = containerOffset + storedOffset;
                ReadExactly(source, payload, payload.Length);

                // Publisher PFSC v2 represents an empty file as one full stored zero block.
                if (logicalSize == 0 && index == 0)
                {
                    if (storedSize != BlockSize || Array.Exists(payload, static value => value != 0))
                        throw new InvalidDataException("An empty PFSC file must contain one stored zero block.");
                }
                else if (storedSize != outputSize)
                    throw new InvalidDataException($"PFSC block {index} stored size does not match its logical size.");
                else
                    destination.Write(payload);

                produced += outputSize;
                index++;
            }
        }

        if (produced != logicalSize)
            throw new InvalidDataException(
                $"PFSC produced {produced:N0} bytes, expected {logicalSize:N0} bytes.");
        return produced;
    }

    /// <summary>Writes a seekable PFSC v2 container while keeping only one block in memory.</summary>
    /// <param name="source">Readable source stream positioned at the logical file start.</param>
    /// <param name="length">Number of logical bytes to consume.</param>
    /// <param name="destination">Seekable, writable destination stream.</param>
    /// <param name="level">Kraken level stored at header byte <c>+0x29</c>.</param>
    /// <param name="verifyBlocks">Decode and byte-compare each emitted compressed block.</param>
    /// <returns>Container and block statistics.</returns>
    /// <exception cref="InvalidDataException">The source ends early or an encoded block fails verification.</exception>
    public static PprPfsKrakenWriteResult Write(
        Stream source,
        long length,
        Stream destination,
        int level = DefaultLevel,
        bool verifyBlocks = false)
    {
        return Write(source, length, destination, new PprPfsKrakenWriteOptions
        {
            Level = level,
            VerifyBlocks = verifyBlocks,
        });
    }

    /// <summary>Writes PFSC v2 using explicit runtime-read optimization options.</summary>
    public static PprPfsKrakenWriteResult Write(
        Stream source,
        long length,
        Stream destination,
        PprPfsKrakenWriteOptions options)
    {
        ArgumentNullException.ThrowIfNull(source);
        ArgumentNullException.ThrowIfNull(destination);
        ArgumentNullException.ThrowIfNull(options);
        ArgumentOutOfRangeException.ThrowIfNegative(length);
        if (!source.CanRead)
            throw new ArgumentException("Source stream must be readable.", nameof(source));
        if (!destination.CanWrite || !destination.CanSeek)
            throw new ArgumentException("Destination stream must be writable and seekable.", nameof(destination));
        if (options.Level is < -4 or > 9)
            throw new ArgumentOutOfRangeException(nameof(options.Level), "Kraken level must be in the range -4..9.");
        if (options.MinimumSavingsPercent is < 0 or > 100)
            throw new ArgumentOutOfRangeException(
                nameof(options.MinimumSavingsPercent), "Minimum savings must be in the range 0..100 percent.");

        long sourceStart = source.CanSeek ? source.Position : 0;
        // Publisher output always has at least one table entry and materializes an empty file as a
        // full stored zero block. This also keeps data_offset/total_size identical to the references.
        int blockCount = Math.Max(1, checked((int)((length + BlockSize - 1) / BlockSize)));
        long tableSize = checked((long)(blockCount + 1) * sizeof(ulong));
        long dataOffset = Align(HeaderSize + tableSize, TableAlignment);
        if (dataOffset > (long)Low48Mask)
            throw new ArgumentOutOfRangeException(nameof(length), "PFSC metadata exceeds the 48-bit offset field.");

        var offsets = new List<ulong>(blockCount + 1);
        var inputBuffer = new byte[CompressionGroupSize];
        var decodedBuffer = options.VerifyBlocks ? new byte[CompressionGroupSize] : null;
        PprPfsRawRange[] rawRanges = NormalizeRawRanges(options.RawRanges, length);
        int rawRangeIndex = 0;
        int compressedBlocks = 0;
        int forcedRawBlocks = 0;
        int lowGainRawBlocks = 0;
        long consumed = 0;

        destination.Position = dataOffset;

        // The offset table is expressed in 128 KiB blocks, while Kraken is encoded in 256 KiB
        // groups.  A full group becomes two concatenated headerless chunks: chunk 0 includes the
        // eight-byte seed and chunk 1 is a seedless continuation.  This is the C000 -> 4000 ->
        // C000 boundary pattern used by publisher PFSC v2 files and consumed by
        // ppr_pfs_cmp_bread_kraken as one 0x40000-byte I/O request.
        int groupCount = Math.Max(1, checked((int)((length + CompressionGroupSize - 1) / CompressionGroupSize)));
        for (int groupIndex = 0; groupIndex < groupCount; groupIndex++)
        {
            int groupSize = checked((int)Math.Min(CompressionGroupSize, length - consumed));
            ReadExactly(source, inputBuffer, groupSize);
            ReadOnlySpan<byte> inputGroup = inputBuffer.AsSpan(0, groupSize);

            long groupStart = consumed;
            long groupEnd = checked(groupStart + groupSize);
            while (rawRangeIndex < rawRanges.Length
                && checked(rawRanges[rawRangeIndex].Offset + rawRanges[rawRangeIndex].Length) <= groupStart)
            {
                rawRangeIndex++;
            }
            bool forceRaw = rawRangeIndex < rawRanges.Length
                && rawRanges[rawRangeIndex].Offset < groupEnd;

            EncodedBlock? encoded = groupSize == 0 || forceRaw
                ? null
                : OodleKrakenEncoder.EncodeBlock(
                    inputGroup,
                    useHuffmanArrays: true,
                    compressionLevel: options.Level,
                    allowSubLiterals: false,
                    allowStoredHalves: false);
            int requiredSavings = checked(
                (groupSize * options.MinimumSavingsPercent + 99) / 100);
            int encodedSize = encoded?.Payload.Length ?? int.MaxValue;
            bool candidateSmaller = encoded.HasValue && encodedSize < groupSize;
            bool compressed = candidateSmaller
                && encodedSize <= groupSize - requiredSavings;
            int blocksInLogicalGroup = Math.Max(1, (groupSize + BlockSize - 1) / BlockSize);
            if (forceRaw)
                forcedRawBlocks += blocksInLogicalGroup;
            else if (candidateSmaller && !compressed)
                lowGainRawBlocks += blocksInLogicalGroup;

            if (compressed)
            {
                EncodedBlock block = encoded!.Value;
                byte[] payload = block.Payload;
                bool twoChunks = groupSize > BlockSize;
                if (twoChunks != block.MultiChunk
                    || (twoChunks && (block.FirstChunkCompSize <= 0
                        || block.FirstChunkCompSize >= payload.Length)))
                {
                    throw new InvalidDataException("Kraken encoder returned invalid PPR-PFS chunk geometry.");
                }

                if (options.VerifyBlocks)
                    VerifyEncodedBlock(
                        payload,
                        inputGroup,
                        block.FirstChunkCompSize,
                        block.BoundaryFlags,
                        decodedBuffer!);

                AddOffset(offsets, destination.Position, GroupBoundaryFlag | CompressedFlag);
                if (twoChunks)
                {
                    destination.Write(payload.AsSpan(0, block.FirstChunkCompSize));
                    AddOffset(offsets, destination.Position, CompressedFlag);
                    destination.Write(payload.AsSpan(block.FirstChunkCompSize));
                    compressedBlocks += 2;
                }
                else
                {
                    destination.Write(payload);
                    compressedBlocks++;
                }
            }
            else
            {
                // A group that cannot be represented as two compatible Kraken chunks is stored as
                // independent 128 KiB table blocks.  Each stored entry is its own group boundary.
                if (groupSize == 0)
                {
                    AddOffset(offsets, destination.Position, GroupBoundaryFlag);
                    destination.Write(inputBuffer.AsSpan(0, BlockSize));
                }
                else
                {
                    int groupOffset = 0;
                    while (groupOffset < groupSize)
                    {
                        int blockSize = Math.Min(BlockSize, groupSize - groupOffset);
                        AddOffset(offsets, destination.Position, GroupBoundaryFlag);
                        destination.Write(inputGroup.Slice(groupOffset, blockSize));
                        groupOffset += blockSize;
                    }
                }
            }

            consumed += groupSize;
        }

        if (offsets.Count != blockCount)
            throw new InvalidDataException("PFSC encoder produced an unexpected number of block boundaries.");

        // The final boundary always carries bit 63, including files with an odd block count.
        long endOffset = destination.Position;
        if ((ulong)endOffset > Low48Mask)
            throw new InvalidDataException("PFSC payload exceeds the 48-bit offset field.");
        offsets.Add((GroupBoundaryFlag << 48) | (ulong)endOffset);

        // Backfill the fixed header and the absolute-offset table.
        var header = new byte[HeaderSize];
        Span<byte> h = header;
        BinaryPrimitives.WriteUInt32LittleEndian(h[0x00..], Magic);
        BinaryPrimitives.WriteUInt32LittleEndian(h[0x04..], Version);
        BinaryPrimitives.WriteUInt32LittleEndian(h[0x08..], (uint)CompressionAlgorithm.Kraken);
        BinaryPrimitives.WriteUInt32LittleEndian(h[0x0C..], BlockSize);
        BinaryPrimitives.WriteUInt32LittleEndian(h[0x10..], TableAlignment);
        BinaryPrimitives.WriteUInt32LittleEndian(h[0x14..], (uint)blockCount);
        BinaryPrimitives.WriteUInt64LittleEndian(h[0x18..], (ulong)length);
        BinaryPrimitives.WriteUInt64LittleEndian(h[0x20..], (ulong)endOffset);
        ulong encodeParams = (ulong)CompressionAlgorithm.Kraken
            | ((ulong)(byte)(sbyte)options.Level << 8)
            | ((ulong)PfsCompressionConstants.KrakenWindowBits << 16);
        BinaryPrimitives.WriteUInt64LittleEndian(h[0x28..], encodeParams);
        BinaryPrimitives.WriteUInt64LittleEndian(h[0x30..], HeaderSize);
        BinaryPrimitives.WriteUInt64LittleEndian(h[0x40..], (ulong)dataOffset);
        EncoderIdentifier.CopyTo(h[0x78..]);

        destination.Position = 0;
        destination.Write(header);
        Span<byte> entryBytes = stackalloc byte[sizeof(ulong)];
        foreach (ulong entry in offsets)
        {
            BinaryPrimitives.WriteUInt64LittleEndian(entryBytes, entry);
            destination.Write(entryBytes);
        }
        if (destination.Position < dataOffset)
        {
            Span<byte> padding = stackalloc byte[TableAlignment];
            destination.Write(padding[..checked((int)(dataOffset - destination.Position))]);
        }
        destination.SetLength(endOffset);
        destination.Position = endOffset;

        if (source.CanSeek && source.Position != sourceStart + length)
            throw new InvalidDataException("PFSC writer consumed an unexpected number of source bytes.");

        return new PprPfsKrakenWriteResult
        {
            UncompressedSize = length,
            StoredSize = endOffset,
            BlockCount = blockCount,
            CompressedBlockCount = compressedBlocks,
            ForcedRawBlockCount = forcedRawBlocks,
            LowGainRawBlockCount = lowGainRawBlocks,
        };
    }

    private static PprPfsRawRange[] NormalizeRawRanges(
        IReadOnlyCollection<PprPfsRawRange>? ranges,
        long logicalLength)
    {
        if (ranges is null || ranges.Count == 0 || logicalLength == 0)
            return Array.Empty<PprPfsRawRange>();

        var normalized = new List<PprPfsRawRange>(ranges.Count);
        foreach (PprPfsRawRange range in ranges)
        {
            if (range.Offset < 0 || range.Length < 0)
                throw new ArgumentOutOfRangeException(nameof(ranges), "Raw ranges cannot be negative.");
            if (range.Length == 0 || range.Offset >= logicalLength)
                continue;
            long end = Math.Min(logicalLength, checked(range.Offset + range.Length));
            long start = range.Offset / CompressionGroupSize * CompressionGroupSize;
            end = Math.Min(logicalLength, Align(end, CompressionGroupSize));
            normalized.Add(new PprPfsRawRange(start, end - start));
        }

        if (normalized.Count == 0)
            return Array.Empty<PprPfsRawRange>();

        normalized.Sort(static (left, right) => left.Offset.CompareTo(right.Offset));
        var merged = new List<PprPfsRawRange>(normalized.Count);
        foreach (PprPfsRawRange range in normalized)
        {
            if (merged.Count == 0)
            {
                merged.Add(range);
                continue;
            }

            PprPfsRawRange previous = merged[^1];
            long previousEnd = checked(previous.Offset + previous.Length);
            long rangeEnd = checked(range.Offset + range.Length);
            if (range.Offset <= previousEnd)
                merged[^1] = new PprPfsRawRange(previous.Offset, Math.Max(previousEnd, rangeEnd) - previous.Offset);
            else
                merged.Add(range);
        }
        return merged.ToArray();
    }

    private static void AddOffset(List<ulong> offsets, long storedOffset, ulong highFlags)
    {
        if ((ulong)storedOffset > Low48Mask)
            throw new InvalidDataException("PFSC payload exceeds the 48-bit offset field.");
        offsets.Add((highFlags << 48) | (ulong)storedOffset);
    }

    private static void VerifyEncodedBlock(
        byte[] payload,
        ReadOnlySpan<byte> expected,
        int firstChunkCompSize,
        int boundaryFlags,
        byte[] decodedBuffer)
    {
        Span<byte> decoded = decodedBuffer.AsSpan(0, expected.Length);
        bool multiChunk = expected.Length > BlockSize;
        KrakenDecodeStatus status = KrakenDecoder.DecodeBlock(
            payload,
            boundaryFlags,
            firstChunkComp: multiChunk ? firstChunkCompSize : 0,
            decoded);
        if (status != KrakenDecodeStatus.Success || !decoded.SequenceEqual(expected))
            throw new InvalidDataException($"Kraken encoder round-trip failed ({status}).");
    }

    private static void ReadExactly(Stream source, byte[] buffer, int count)
    {
        int read = 0;
        while (read < count)
        {
            int current = source.Read(buffer, read, count - read);
            if (current == 0)
                throw new InvalidDataException("Source stream ended before the declared logical length.");
            read += current;
        }
    }

    private static long Align(long value, int alignment) =>
        checked((value + alignment - 1) / alignment * alignment);

    private static bool PathsEqual(string left, string right) =>
        string.Equals(
            Path.GetFullPath(left),
            Path.GetFullPath(right),
            OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);
}
