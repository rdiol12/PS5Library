// LibProsperoPkg - NAPS streaming-image planner and decoder.
#nullable enable
using LibProsperoPkg.PFS.Compression.Oodle;
using LibProsperoPkg.PKG;
using System;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;

namespace LibProsperoPkg.PFS.Compression;

/// <summary>One decoded normal <c>CblockInfo</c> span.</summary>
public readonly record struct ProsperoNapsSpan(
    int Index,
    int CblockInfoIndex,
    long CompressedOffset,
    int CompressedLength,
    int FirstChunkCompressedLength,
    long StoredOffset,
    long UncompressedOffset,
    int UncompressedLength,
    uint TweakIndex,
    byte KeyTableIndex,
    byte Even,
    byte Odd,
    byte KdePredictor,
    byte ShuffleIndex);

/// <summary>Logical file range described by the NAPS fidx boundary table.</summary>
public readonly record struct ProsperoNapsLogicalFile(
    int Index, byte Type, long UncompressedOffset, long Length);

/// <summary>
/// Fully resolved view of the NAPS boundary tables. It is the managed equivalent of the span,
/// ublock and file-view construction performed by <c>ric.exe</c> before image verification.
/// </summary>
public sealed class ProsperoNapsPlan
{
    public required IReadOnlyList<ProsperoNapsSpan> Spans { get; init; }
    public required IReadOnlyList<ProsperoNapsLogicalFile> Files { get; init; }
    public required long UncompressedSize { get; init; }
}

/// <summary>Options for producing a self-contained NAPS packed image and type-13 layout.</summary>
public sealed class ProsperoNapsBuildOptions
{
    /// <summary>Kraken compression level, in the range -4..9.</summary>
    public int CompressionLevel { get; init; } = 7;

    /// <summary>Try Kraken before falling back to a stored 256-KiB span.</summary>
    public bool Compress { get; init; } = true;

    /// <summary>Decode the finished artifacts and compare them with the input before returning.</summary>
    public bool VerifyRoundTrip { get; init; } = true;

    /// <summary>
    /// Optional 16-byte AES-CMAC key used to convert each reversed SHA3-256 outer-block digest to
    /// the truncated eight-byte <c>OuterBlockDigest</c>. When absent those policy-gated slots are zero.
    /// </summary>
    public byte[]? OuterBlockCmacKey { get; init; }

    /// <summary>
    /// Optional logical-file boundaries. The first value must be zero and the final value must equal
    /// the input length. If omitted, NAPS describes one logical file covering the complete image.
    /// </summary>
    public IReadOnlyList<long>? FileBoundaries { get; init; }
}

/// <summary>Artifacts emitted by the in-memory NAPS writer.</summary>
public sealed class ProsperoNapsBuildResult
{
    public required byte[] PackedImage { get; init; }
    public required byte[] LayoutBytes { get; init; }
    public required NapsLayoutDocument Layout { get; init; }
    public required int CompressedSpanCount { get; init; }
    public required int StoredSpanCount { get; init; }
    public long LogicalSize { get; init; }
}

/// <summary>Artifacts emitted by the bounded-memory stream/file NAPS writer.</summary>
public sealed class ProsperoNapsFileBuildResult
{
    public required byte[] LayoutBytes { get; init; }
    public required NapsLayoutDocument Layout { get; init; }
    public required int CompressedSpanCount { get; init; }
    public required int StoredSpanCount { get; init; }
    public required long LogicalSize { get; init; }
    public required long PackedSize { get; init; }
}

/// <summary>Resolves and decodes <c>pfs_image.dat</c> using <c>naps_pkg_layout.dat</c>.</summary>
public static class ProsperoNapsImage
{
    public const int UBlockSize = 0x40000;
    public const int OuterBlockSize = 0x10000;

    /// <summary>
    /// Packs a logical PPR-PFS stream into the NAPS physical representation and generates all
    /// structural type-13 tables. This baseline producer deliberately emits no deduplication,
    /// predictor, or shuffle records; every physical run is monotonic and uses key-table index zero.
    /// </summary>
    public static ProsperoNapsBuildResult Pack(
        ReadOnlySpan<byte> logicalImage, ProsperoNapsBuildOptions? options = null)
    {
        options ??= new ProsperoNapsBuildOptions();
        if (logicalImage.Length == 0)
            throw new ArgumentException("NAPS input cannot be empty.", nameof(logicalImage));
        if (options.CompressionLevel is < -4 or > 9)
            throw new ArgumentOutOfRangeException(nameof(options), "Kraken level must be in -4..9.");
        if (options.OuterBlockCmacKey is { Length: not 16 })
            throw new ArgumentException("NAPS outer-block CMAC key must be exactly 16 bytes.", nameof(options));

        long[] boundaries = ValidateBoundaries(logicalImage.Length, options.FileBoundaries);
        var cblockInfos = new List<NapsCblockInfoEntry>();
        var spanIndexesByUblock = new List<uint>();
        using var packed = new MemoryStream();
        int compressedCount = 0;
        int storedCount = 0;

        // A monotonic producer needs one run base. Physical and compressed offsets are identical.
        cblockInfos.Add(new NapsCblockInfoEntry
        {
            IsRunBase = true,
            CoffsetEndMod256K = 0,
            TweakIdxStart = 0,
            KeyTableIdx = 0,
            CoffsetStart256K = 0,
        });

        int logicalOffset = 0;
        int nextBoundaryIndex = 1;
        while (logicalOffset < logicalImage.Length)
        {
            while (nextBoundaryIndex < boundaries.Length && boundaries[nextBoundaryIndex] <= logicalOffset)
                nextBoundaryIndex++;
            int ublockRemaining = UBlockSize - (logicalOffset & (UBlockSize - 1));
            int fileRemaining = nextBoundaryIndex < boundaries.Length
                ? checked((int)(boundaries[nextBoundaryIndex] - logicalOffset))
                : logicalImage.Length - logicalOffset;
            int uncompressedLength = Math.Min(ublockRemaining, fileRemaining);
            ReadOnlySpan<byte> source = logicalImage.Slice(logicalOffset, uncompressedLength);
            EncodedBlock? encoded = options.Compress
                ? OodleKrakenEncoder.EncodeBlock(source, useHuffmanArrays: true, options.CompressionLevel)
                : null;
            bool compressed = encoded is EncodedBlock block && block.Payload.Length < source.Length;
            byte[] payload = compressed ? encoded!.Value.Payload : source.ToArray();
            int firstChunkLength = compressed
                ? encoded!.Value.FirstChunkCompSize
                : Math.Min(0x20000, uncompressedLength);
            if (firstChunkLength is < 1 or > 0x20000)
                throw new InvalidDataException("NAPS first-chunk length exceeds the 17-bit minus-one field.");

            long compressedOffset = packed.Position;
            if ((logicalOffset & (UBlockSize - 1)) == 0)
                spanIndexesByUblock.Add(checked((uint)cblockInfos.Count));
            packed.Write(payload);
            cblockInfos.Add(new NapsCblockInfoEntry
            {
                CoffsetStartMod256K = checked((uint)(compressedOffset & (UBlockSize - 1))),
                UoffsetStart = checked((uint)(logicalOffset & (UBlockSize - 1))),
                ClenEvenMinus1 = checked((uint)(firstChunkLength - 1)),
                Even = compressed ? encoded!.Value.NapsEvenMode : (byte)1,
                Odd = compressed ? encoded!.Value.NapsOddMode
                    : !compressed && uncompressedLength > 0x20000 ? (byte)1 : (byte)0,
                KdePredictor = 0,
                ShuffleIdx = 0,
            });

            if (compressed) compressedCount++; else storedCount++;
            logicalOffset += uncompressedLength;
        }

        long compressedEnd = packed.Position;
        cblockInfos.Add(new NapsCblockInfoEntry
        {
            ReservedBit19 = true,
            CoffsetStartMod256K = checked((uint)(compressedEnd & (UBlockSize - 1))),
            UoffsetStart = checked((uint)(logicalImage.Length & (UBlockSize - 1))),
            ClenEvenMinus1 = 0,
        });

        int outerBlockCount = checked((int)((compressedEnd + OuterBlockSize - 1) / OuterBlockSize));
        packed.SetLength(checked((long)outerBlockCount * OuterBlockSize));
        byte[] packedBytes = packed.ToArray();
        var outerDigests = new List<byte[]>(outerBlockCount);
        for (int i = 0; i < outerBlockCount; i++)
        {
            ReadOnlySpan<byte> outerBlock = packedBytes.AsSpan(i * OuterBlockSize, OuterBlockSize);
            outerDigests.Add(options.OuterBlockCmacKey is null
                ? new byte[8]
                : ComputeOuterBlockDigest(outerBlock, options.OuterBlockCmacKey));
        }

        var fileOffsets = new List<NapsFileOffsetEntry>(boundaries.Length);
        for (int i = 0; i < boundaries.Length; i++)
            fileOffsets.Add(new NapsFileOffsetEntry(
                i == boundaries.Length - 1 ? (byte)0x40 : (byte)0,
                checked((ulong)boundaries[i])));

        int ublockCount = checked((logicalImage.Length + UBlockSize - 1) / UBlockSize);
        List<NapsU2cEntry> u2c = BuildU2c(
            spanIndexesByUblock, ublockCount, checked((uint)cblockInfos.Count - 1));
        var counts = new NapsLayoutCounts(
            NumFiles: fileOffsets.Count,
            CompressionType: 2,
            NumKeys: 1,
            NumShufflePatterns: 0,
            NumUBlocks: ublockCount - 1,
            NumOuterBlocks: outerBlockCount,
            NumCblockInfo: cblockInfos.Count);
        var document = new NapsLayoutDocument
        {
            Counts = counts,
            Map = ProsperoNapsLayout.SectionMap(counts),
            OuterBlockDigests = outerDigests,
            ShufflePatterns = Array.Empty<byte[]>(),
            FileOffsets = fileOffsets,
            CblockInfoOffsetByUblock = u2c,
            CblockInfos = cblockInfos,
            TrailingZeroBytes = 0,
        };
        byte[] layoutBytes = ProsperoNapsLayout.BuildLayout(document);
        document = ProsperoNapsLayout.Parse(layoutBytes);

        if (options.VerifyRoundTrip)
        {
            using var packedInput = new MemoryStream(packedBytes, writable: false);
            using var restored = new MemoryStream(logicalImage.Length);
            Decompress(packedInput, document, restored);
            if (!restored.GetBuffer().AsSpan(0, checked((int)restored.Length)).SequenceEqual(logicalImage))
                throw new InvalidDataException("Generated NAPS image failed its decode round-trip.");
        }

        return new ProsperoNapsBuildResult
        {
            PackedImage = packedBytes,
            LayoutBytes = layoutBytes,
            Layout = document,
            CompressedSpanCount = compressedCount,
            StoredSpanCount = storedCount,
            LogicalSize = logicalImage.Length,
        };
    }

    /// <summary>
    /// Packs a seekable logical image into a seekable file/stream using at most one 256-KiB source
    /// block plus encoder scratch. The packed stream is truncated and rewritten from offset zero.
    /// </summary>
    public static ProsperoNapsFileBuildResult Pack(
        Stream logicalInput,
        long logicalLength,
        Stream packedOutput,
        ProsperoNapsBuildOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(logicalInput);
        ArgumentNullException.ThrowIfNull(packedOutput);
        options ??= new ProsperoNapsBuildOptions();
        if (!logicalInput.CanRead || !logicalInput.CanSeek)
            throw new ArgumentException("Logical NAPS input must be readable and seekable.", nameof(logicalInput));
        if (!packedOutput.CanRead || !packedOutput.CanWrite || !packedOutput.CanSeek)
            throw new ArgumentException(
                "Packed NAPS output must be readable, writable and seekable.", nameof(packedOutput));
        if (logicalLength <= 0 || logicalLength > logicalInput.Length)
            throw new ArgumentOutOfRangeException(nameof(logicalLength));
        if (options.CompressionLevel is < -4 or > 9)
            throw new ArgumentOutOfRangeException(nameof(options), "Kraken level must be in -4..9.");
        if (options.OuterBlockCmacKey is { Length: not 16 })
            throw new ArgumentException("NAPS outer-block CMAC key must be exactly 16 bytes.", nameof(options));

        long[] boundaries = ValidateBoundaries(logicalLength, options.FileBoundaries);
        logicalInput.Position = 0;
        packedOutput.Position = 0;
        packedOutput.SetLength(0);

        var cblockInfos = new List<NapsCblockInfoEntry>();
        var spanIndexesByUblock = new List<uint>();
        int compressedCount = 0;
        int storedCount = 0;
        cblockInfos.Add(new NapsCblockInfoEntry
        {
            IsRunBase = true,
            CoffsetEndMod256K = 0,
            TweakIdxStart = 0,
            KeyTableIdx = 0,
            CoffsetStart256K = 0,
        });

        byte[] sourceBuffer = new byte[UBlockSize];
        long logicalOffset = 0;
        int nextBoundaryIndex = 1;
        while (logicalOffset < logicalLength)
        {
            while (nextBoundaryIndex < boundaries.Length &&
                   boundaries[nextBoundaryIndex] <= logicalOffset)
                nextBoundaryIndex++;
            int ublockRemaining = UBlockSize - (int)(logicalOffset & (UBlockSize - 1));
            long fileRemaining = nextBoundaryIndex < boundaries.Length
                ? boundaries[nextBoundaryIndex] - logicalOffset
                : logicalLength - logicalOffset;
            int uncompressedLength = checked((int)Math.Min(ublockRemaining, fileRemaining));
            logicalInput.ReadExactly(sourceBuffer.AsSpan(0, uncompressedLength));
            ReadOnlySpan<byte> source = sourceBuffer.AsSpan(0, uncompressedLength);
            EncodedBlock? encoded = options.Compress
                ? OodleKrakenEncoder.EncodeBlock(source, useHuffmanArrays: true, options.CompressionLevel)
                : null;
            bool compressed = encoded is EncodedBlock value && value.Payload.Length < source.Length;
            ReadOnlyMemory<byte> payload = compressed
                ? encoded!.Value.Payload
                : sourceBuffer.AsMemory(0, uncompressedLength);
            int firstChunkLength = compressed
                ? encoded!.Value.FirstChunkCompSize
                : Math.Min(0x20000, uncompressedLength);
            if (firstChunkLength is < 1 or > 0x20000)
                throw new InvalidDataException("NAPS first-chunk length exceeds the 17-bit minus-one field.");

            long compressedOffset = packedOutput.Position;
            if ((logicalOffset & (UBlockSize - 1)) == 0)
                spanIndexesByUblock.Add(checked((uint)cblockInfos.Count));
            packedOutput.Write(payload.Span);
            cblockInfos.Add(new NapsCblockInfoEntry
            {
                CoffsetStartMod256K = checked((uint)(compressedOffset & (UBlockSize - 1))),
                UoffsetStart = checked((uint)(logicalOffset & (UBlockSize - 1))),
                ClenEvenMinus1 = checked((uint)(firstChunkLength - 1)),
                Even = compressed ? encoded!.Value.NapsEvenMode : (byte)1,
                Odd = compressed ? encoded!.Value.NapsOddMode
                    : !compressed && uncompressedLength > 0x20000 ? (byte)1 : (byte)0,
                KdePredictor = 0,
                ShuffleIdx = 0,
            });
            if (compressed) compressedCount++; else storedCount++;
            logicalOffset += uncompressedLength;
        }

        long compressedEnd = packedOutput.Position;
        cblockInfos.Add(new NapsCblockInfoEntry
        {
            ReservedBit19 = true,
            CoffsetStartMod256K = checked((uint)(compressedEnd & (UBlockSize - 1))),
            UoffsetStart = checked((uint)(logicalLength & (UBlockSize - 1))),
            ClenEvenMinus1 = 0,
        });

        int outerBlockCount = checked((int)((compressedEnd + OuterBlockSize - 1) / OuterBlockSize));
        long packedLength = checked((long)outerBlockCount * OuterBlockSize);
        packedOutput.SetLength(packedLength);
        var outerDigests = new List<byte[]>(outerBlockCount);
        if (options.OuterBlockCmacKey is null)
        {
            for (int i = 0; i < outerBlockCount; i++)
                outerDigests.Add(new byte[8]);
        }
        else
        {
            byte[] outerBlock = new byte[OuterBlockSize];
            for (int i = 0; i < outerBlockCount; i++)
            {
                packedOutput.Position = (long)i * OuterBlockSize;
                packedOutput.ReadExactly(outerBlock);
                outerDigests.Add(ComputeOuterBlockDigest(outerBlock, options.OuterBlockCmacKey));
            }
        }

        var fileOffsets = new List<NapsFileOffsetEntry>(boundaries.Length);
        for (int i = 0; i < boundaries.Length; i++)
            fileOffsets.Add(new NapsFileOffsetEntry(
                i == boundaries.Length - 1 ? (byte)0x40 : (byte)0,
                checked((ulong)boundaries[i])));

        int ublockCount = checked((int)((logicalLength + UBlockSize - 1) / UBlockSize));
        List<NapsU2cEntry> u2c = BuildU2c(
            spanIndexesByUblock, ublockCount, checked((uint)cblockInfos.Count - 1));
        var counts = new NapsLayoutCounts(
            NumFiles: fileOffsets.Count,
            CompressionType: 2,
            NumKeys: 1,
            NumShufflePatterns: 0,
            NumUBlocks: ublockCount - 1,
            NumOuterBlocks: outerBlockCount,
            NumCblockInfo: cblockInfos.Count);
        var document = new NapsLayoutDocument
        {
            Counts = counts,
            Map = ProsperoNapsLayout.SectionMap(counts),
            OuterBlockDigests = outerDigests,
            ShufflePatterns = Array.Empty<byte[]>(),
            FileOffsets = fileOffsets,
            CblockInfoOffsetByUblock = u2c,
            CblockInfos = cblockInfos,
            TrailingZeroBytes = 0,
        };
        byte[] layoutBytes = ProsperoNapsLayout.BuildLayout(document);
        document = ProsperoNapsLayout.Parse(layoutBytes);

        if (options.VerifyRoundTrip)
        {
            packedOutput.Position = 0;
            logicalInput.Position = 0;
            using var verifier = new NapsVerifyingWriteStream(logicalInput, logicalLength);
            Decompress(packedOutput, document, verifier);
            verifier.EnsureComplete();
        }
        logicalInput.Position = 0;
        packedOutput.Position = 0;
        return new ProsperoNapsFileBuildResult
        {
            LayoutBytes = layoutBytes,
            Layout = document,
            CompressedSpanCount = compressedCount,
            StoredSpanCount = storedCount,
            LogicalSize = logicalLength,
            PackedSize = packedLength,
        };
    }

    /// <summary>
    /// Computes the publisher type-13 eight-byte outer-block tag:
    /// <c>CMAC-AES128(key, reverse(SHA3-256(block)))[8..16]</c>.
    /// </summary>
    public static byte[] ComputeOuterBlockDigest(ReadOnlySpan<byte> outerBlock, ReadOnlySpan<byte> cmacKey)
    {
        if (outerBlock.Length != OuterBlockSize)
            throw new ArgumentException($"NAPS outer block must be {OuterBlockSize} bytes.", nameof(outerBlock));
        if (cmacKey.Length != 16)
            throw new ArgumentException("AES-CMAC key must be 16 bytes.", nameof(cmacKey));
        byte[] digest = ProsperoImageDigests.Sha3_256(outerBlock);
        Array.Reverse(digest);
        byte[] cmac = AesCmac(cmacKey, digest);
        return cmac.AsSpan(8, 8).ToArray();
    }

    /// <summary>Builds and strictly validates the compressed-span graph.</summary>
    public static ProsperoNapsPlan BuildPlan(NapsLayoutDocument layout)
    {
        ArgumentNullException.ThrowIfNull(layout);
        if (layout.FileOffsets.Count < 1)
            throw new InvalidDataException("NAPS layout has no terminal file boundary.");

        var files = new List<ProsperoNapsLogicalFile>(layout.FileOffsets.Count - 1);
        for (int i = 0; i + 1 < layout.FileOffsets.Count; i++)
        {
            NapsFileOffsetEntry current = layout.FileOffsets[i];
            NapsFileOffsetEntry next = layout.FileOffsets[i + 1];
            if (next.UncompressedOffsetStart < current.UncompressedOffsetStart)
                throw new InvalidDataException($"NAPS file boundary {i + 1} moves backwards.");
            files.Add(new ProsperoNapsLogicalFile(
                i,
                current.Type,
                checked((long)current.UncompressedOffsetStart),
                checked((long)(next.UncompressedOffsetStart - current.UncompressedOffsetStart))));
        }

        var spans = new List<ProsperoNapsSpan>();
        ProsperoNapsSpan? previous = null;

        foreach (ProsperoNapsLogicalFile file in files)
        {
            if ((file.Type & 0x40) != 0)
            {
                if (previous is null)
                    throw new InvalidDataException($"NAPS continuation file {file.Index} has no preceding span.");
                continue;
            }

            long position = file.UncompressedOffset;
            long remaining = file.Length;
            int cblockIndex = ResolveCblockInfoIndex(layout, position);
            while (remaining != 0)
            {
                if ((uint)cblockIndex >= (uint)layout.CblockInfos.Count)
                    throw new InvalidDataException($"NAPS file {file.Index} runs past CblockInfo.");
                NapsCblockInfoEntry current = layout.CblockInfos[cblockIndex];
                if (current.IsRunBase)
                {
                    cblockIndex++;
                    continue;
                }
                if (current.IsTerminal)
                    throw new InvalidDataException($"NAPS file {file.Index} reaches the terminal boundary early.");

                int immediateNextIndex = checked(cblockIndex + 1);
                if ((uint)immediateNextIndex >= (uint)layout.CblockInfos.Count)
                    throw new InvalidDataException("NAPS normal CblockInfo has no following boundary.");
                NapsCblockInfoEntry immediateNext = layout.CblockInfos[immediateNextIndex];
                int logicalNextIndex = immediateNext.IsRunBase
                    ? checked(immediateNextIndex + 1)
                    : immediateNextIndex;
                if ((uint)logicalNextIndex >= (uint)layout.CblockInfos.Count)
                    throw new InvalidDataException("NAPS run-base has no following logical boundary.");
                NapsCblockInfoEntry logicalNext = layout.CblockInfos[logicalNextIndex];

                int compressedLength = Delta18(
                    immediateNext.IsRunBase ? immediateNext.CoffsetEndMod256K : immediateNext.CoffsetStartMod256K,
                    current.CoffsetStartMod256K);
                int uncompressedLength = Delta18(logicalNext.UoffsetStart, current.UoffsetStart);
                if (compressedLength <= 0 || uncompressedLength <= 0 || uncompressedLength > UBlockSize)
                    throw new InvalidDataException($"NAPS span at CblockInfo {cblockIndex} has invalid lengths.");
                if (uncompressedLength > remaining)
                    throw new InvalidDataException($"NAPS span at CblockInfo {cblockIndex} crosses file {file.Index}.");

                long compressedOffset;
                uint tweak;
                byte key;
                if (cblockIndex > 0 && layout.CblockInfos[cblockIndex - 1].IsRunBase)
                {
                    NapsCblockInfoEntry run = layout.CblockInfos[cblockIndex - 1];
                    compressedOffset = checked(((long)run.CoffsetStart256K << 18) | current.CoffsetStartMod256K);
                    tweak = run.TweakIdxStart;
                    key = run.KeyTableIdx;
                }
                else if (previous is ProsperoNapsSpan prior)
                {
                    compressedOffset = checked(prior.CompressedOffset + prior.CompressedLength);
                    long blockDelta = (compressedOffset >> 16) - (prior.CompressedOffset >> 16);
                    tweak = checked((uint)(prior.TweakIndex + blockDelta));
                    key = prior.KeyTableIndex;
                }
                else
                {
                    throw new InvalidDataException("The first NAPS span is not preceded by a run-base.");
                }

                long storedOffset = checked((long)tweak * OuterBlockSize + (compressedOffset & 0xFFFF));
                var span = new ProsperoNapsSpan(
                    spans.Count,
                    cblockIndex,
                    compressedOffset,
                    compressedLength,
                    checked((int)current.ClenEvenMinus1 + 1),
                    storedOffset,
                    position,
                    uncompressedLength,
                    tweak,
                    key,
                    current.Even,
                    current.Odd,
                    current.KdePredictor,
                    current.ShuffleIdx);
                spans.Add(span);
                previous = span;
                position += uncompressedLength;
                remaining -= uncompressedLength;
                cblockIndex++;
            }
        }

        int expectedSpans = 0;
        foreach (NapsCblockInfoEntry entry in layout.CblockInfos)
            if (!entry.IsRunBase && !entry.IsTerminal)
                expectedSpans++;
        if (spans.Count != expectedSpans)
            throw new InvalidDataException($"NAPS span graph used {spans.Count} of {expectedSpans} normal entries.");

        return new ProsperoNapsPlan
        {
            Spans = spans,
            Files = files,
            UncompressedSize = checked((long)layout.FileOffsets[^1].UncompressedOffsetStart),
        };
    }

    /// <summary>Decompresses the complete logical stream to a seekable destination.</summary>
    public static void Decompress(Stream pfsImage, NapsLayoutDocument layout, Stream destination)
    {
        ArgumentNullException.ThrowIfNull(pfsImage);
        ArgumentNullException.ThrowIfNull(destination);
        if (!pfsImage.CanRead || !pfsImage.CanSeek)
            throw new ArgumentException("NAPS pfs_image stream must be readable and seekable.", nameof(pfsImage));
        if (!destination.CanWrite || !destination.CanSeek)
            throw new ArgumentException("NAPS output stream must be writable and seekable.", nameof(destination));

        ProsperoNapsPlan plan = BuildPlan(layout);
        destination.SetLength(plan.UncompressedSize);
        foreach (ProsperoNapsSpan span in plan.Spans)
        {
            if (span.KdePredictor != 0)
                throw new NotSupportedException(
                    $"NAPS span {span.Index} requires KDE predictor {span.KdePredictor}.");
            ProsperoPfsShufflePattern shuffle = ResolveShufflePattern(
                layout, span.ShuffleIndex);
            if (span.StoredOffset < 0 || span.StoredOffset > pfsImage.Length
                || span.CompressedLength > pfsImage.Length - span.StoredOffset)
                throw new InvalidDataException($"NAPS span {span.Index} lies outside pfs_image.dat.");
            var payload = new byte[span.CompressedLength];
            pfsImage.Position = span.StoredOffset;
            pfsImage.ReadExactly(payload);

            var output = new byte[span.UncompressedLength];
            if (IsDeduplicatedZeroSpan(span))
            {
                // NAPS represents a logical zero/hole ublock by pointing at the shared 16-byte
                // block-info record.  The bytes at StoredOffset are a deduplication token, not a
                // Kraken stream and must not be copied to the logical image.
            }
            else if (span.CompressedLength == span.UncompressedLength)
            {
                payload.CopyTo(output, 0);
            }
            else
            {
                int firstChunk = span.UncompressedLength > 0x20000
                    ? span.FirstChunkCompressedLength
                    : 0;
                DecodeKrakenSpan(payload, output, firstChunk, span);
            }
            if (shuffle != ProsperoPfsShufflePattern.None)
            {
                byte[] restored = ProsperoPfsShuffle.Deshuffle(output, shuffle);
                restored.CopyTo(output, 0);
            }

            destination.Position = span.UncompressedOffset;
            destination.Write(output);
        }
        destination.Position = 0;
    }

    private static ProsperoPfsShufflePattern ResolveShufflePattern(
        NapsLayoutDocument layout, byte shuffleIndex)
    {
        int patternCount = layout.ShufflePatterns.Count;
        // The publisher compacts actually used source patterns into indexes 0..count-1.
        // The value equal to count is the no-shuffle sentinel; for the common empty-table
        // profile this naturally makes index zero the identity transform.
        if (shuffleIndex == patternCount)
            return ProsperoPfsShufflePattern.None;
        if (shuffleIndex > patternCount)
            throw new InvalidDataException(
                $"NAPS shuffle index {shuffleIndex} exceeds the " +
                $"{patternCount}-entry pattern table and its identity sentinel.");

        ReadOnlySpan<byte> descriptor = layout.ShufflePatterns[shuffleIndex];
        if (descriptor.Length != ProsperoNapsLayout.ShufflePatternStride)
            throw new InvalidDataException(
                $"NAPS shuffle pattern {shuffleIndex} has invalid size {descriptor.Length}.");
        int fieldCount = descriptor.Length;
        while (fieldCount > 0 && descriptor[fieldCount - 1] == 0)
            fieldCount--;

        for (ProsperoPfsShufflePattern candidate = ProsperoPfsShufflePattern.Shuffle44;
             candidate <= ProsperoPfsShufflePattern.Shuffle2626;
             candidate++)
        {
            (_, int[] fields) = ProsperoPfsShuffle.Describe(candidate);
            bool matches = fields.Length == fieldCount;
            for (int i = 0; matches && i < fields.Length; i++)
                matches = descriptor[i] == fields[i];
            if (matches)
            {
                return candidate;
            }
        }

        throw new NotSupportedException(
            $"NAPS shuffle pattern {shuffleIndex} has unknown descriptor " +
            $"{Convert.ToHexString(descriptor)}.");
    }

    private static bool IsDeduplicatedZeroSpan(ProsperoNapsSpan span)
    {
        // naps_meta_300 describes a complete 256-KiB hole as flag 0x40110000,
        // cs=0x10 and c0=c1=8.  A final hole that occupies only the even
        // 128-KiB half uses the same shared token with odd=0 and cs=0x8.
        // The bytes at the physical offset are a CblockInfo/deduplication token,
        // not a Kraken stream.  Requiring a logical extent larger than the token
        // keeps a legitimate eight- or sixteen-byte raw span from being treated
        // as a hole.
        bool completeUnit = span.Odd == 1
            && span.CompressedLength == 0x10
            && span.UncompressedLength > 0x10;
        bool evenHalfOnly = span.Odd == 0
            && span.CompressedLength == 0x8
            && span.UncompressedLength > 0x8
            && span.UncompressedLength <= 0x20000;
        return (completeUnit || evenHalfOnly)
            && span.FirstChunkCompressedLength == 8
            && span.Even == 1
            && span.KdePredictor == 0
            && span.ShuffleIndex == 0;
    }

    private static int ResolveCblockInfoIndex(NapsLayoutDocument layout, long uncompressedOffset)
    {
        if (uncompressedOffset < 0)
            throw new ArgumentOutOfRangeException(nameof(uncompressedOffset));
        int ublock = checked((int)(uncompressedOffset >> 18));
        uint start = ResolveU2c(layout, ublock);
        uint end = ublock + 1 < layout.Counts.UBlockCount
            ? ResolveU2c(layout, checked(ublock + 1))
            : checked((uint)layout.CblockInfos.Count);
        long blockBase = (long)ublock << 18;
        for (uint index = start; index < end; index++)
        {
            if (index >= layout.CblockInfos.Count)
                break;
            NapsCblockInfoEntry entry = layout.CblockInfos[(int)index];
            if (!entry.IsRunBase && !entry.IsTerminal
                && uncompressedOffset == blockBase + entry.UoffsetStart)
                return checked((int)index);
        }
        throw new InvalidDataException($"No NAPS CblockInfo starts at logical offset 0x{uncompressedOffset:x}.");
    }

    private static uint ResolveU2c(NapsLayoutDocument layout, int ublock)
    {
        if (ublock < 0 || ublock >= layout.Counts.UBlockCount)
            throw new InvalidDataException($"NAPS ublock {ublock} is outside the u2c table.");
        NapsU2cEntry group = layout.CblockInfoOffsetByUblock[ublock >> 3];
        return (ublock & 7) == 0
            ? group.InfoOffset9BBase
            : checked(group.InfoOffset9BBase + group.DeltaFromBase[(ublock & 7) - 1]);
    }

    private static long[] ValidateBoundaries(long logicalLength, IReadOnlyList<long>? requested)
    {
        if (requested is null)
            return [0, logicalLength];
        if (requested.Count < 2 || requested[0] != 0 || requested[^1] != logicalLength)
            throw new ArgumentException("NAPS boundaries must start at zero and end at the logical length.", nameof(requested));
        var result = new long[requested.Count];
        long previous = -1;
        for (int i = 0; i < requested.Count; i++)
        {
            long current = requested[i];
            if (current <= previous || current < 0 || current > logicalLength)
                throw new ArgumentException($"NAPS boundary {i} is not strictly increasing.", nameof(requested));
            result[i] = current;
            previous = current;
        }
        return result;
    }

    private sealed class NapsVerifyingWriteStream : Stream
    {
        private readonly Stream expected;
        private readonly long expectedLength;
        private byte[] scratch = new byte[UBlockSize];
        private long position;
        private long declaredLength;
        private long maxWritten;

        public NapsVerifyingWriteStream(Stream expected, long expectedLength)
        {
            this.expected = expected;
            this.expectedLength = expectedLength;
            declaredLength = expectedLength;
        }

        public override bool CanRead => false;
        public override bool CanSeek => true;
        public override bool CanWrite => true;
        public override long Length => declaredLength;
        public override long Position
        {
            get => position;
            set
            {
                if (value < 0 || value > expectedLength)
                    throw new ArgumentOutOfRangeException(nameof(value));
                position = value;
            }
        }

        public override void Write(byte[] buffer, int offset, int count) =>
            Write(buffer.AsSpan(offset, count));

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            if (position > expectedLength || buffer.Length > expectedLength - position)
                throw new InvalidDataException("NAPS round-trip produced more logical bytes than expected.");
            if (scratch.Length < buffer.Length)
                scratch = new byte[buffer.Length];
            expected.Position = position;
            expected.ReadExactly(scratch.AsSpan(0, buffer.Length));
            if (!scratch.AsSpan(0, buffer.Length).SequenceEqual(buffer))
                throw new InvalidDataException($"Generated NAPS image differs at logical offset 0x{position:X}.");
            position += buffer.Length;
            maxWritten = Math.Max(maxWritten, position);
        }

        public void EnsureComplete()
        {
            if (declaredLength != expectedLength || maxWritten != expectedLength)
                throw new InvalidDataException(
                    $"NAPS round-trip produced 0x{maxWritten:X} of 0x{expectedLength:X} logical bytes.");
        }

        public override void SetLength(long value)
        {
            if (value != expectedLength)
                throw new InvalidDataException(
                    $"NAPS round-trip declared length 0x{value:X}, expected 0x{expectedLength:X}.");
            declaredLength = value;
            if (position > value)
                position = value;
        }

        public override long Seek(long offset, SeekOrigin origin)
        {
            long target = origin switch
            {
                SeekOrigin.Begin => offset,
                SeekOrigin.Current => checked(position + offset),
                SeekOrigin.End => checked(expectedLength + offset),
                _ => throw new ArgumentOutOfRangeException(nameof(origin)),
            };
            Position = target;
            return position;
        }

        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) =>
            throw new NotSupportedException();
    }

    private static List<NapsU2cEntry> BuildU2c(
        IReadOnlyList<uint> indexes, int ublockCount, uint terminalIndex)
    {
        if (indexes.Count != ublockCount)
            throw new InvalidDataException("NAPS writer did not record one CblockInfo start per ublock.");
        int groupCount = (ublockCount + 7) / 8;
        var result = new List<NapsU2cEntry>(groupCount);
        for (int group = 0; group < groupCount; group++)
        {
            int startBlock = group * 8;
            uint baseIndex = indexes[startBlock];
            var deltas = new byte[7];
            for (int delta = 1; delta < 8; delta++)
            {
                int block = startBlock + delta;
                uint value = block < ublockCount ? indexes[block] : terminalIndex;
                uint difference = checked(value - baseIndex);
                if (difference > byte.MaxValue)
                    throw new InvalidDataException("NAPS u2c group delta exceeds eight bits.");
                deltas[delta - 1] = (byte)difference;
            }
            result.Add(new NapsU2cEntry(baseIndex, deltas));
        }
        return result;
    }

    private static byte[] AesCmac(ReadOnlySpan<byte> key, ReadOnlySpan<byte> message)
    {
        using Aes aes = Aes.Create();
        aes.Key = key.ToArray();
        Span<byte> zero = stackalloc byte[16];
        Span<byte> l = stackalloc byte[16];
        aes.EncryptEcb(zero, l, PaddingMode.None);
        Span<byte> k1 = stackalloc byte[16];
        Span<byte> k2 = stackalloc byte[16];
        DoubleCmacBlock(l, k1);
        DoubleCmacBlock(k1, k2);

        int blockCount = Math.Max(1, (message.Length + 15) / 16);
        bool complete = message.Length != 0 && (message.Length & 15) == 0;
        Span<byte> state = stackalloc byte[16];
        Span<byte> input = stackalloc byte[16];
        for (int block = 0; block < blockCount; block++)
        {
            input.Clear();
            int offset = block * 16;
            int count = Math.Min(16, message.Length - offset);
            if (count > 0)
                message.Slice(offset, count).CopyTo(input);
            if (block == blockCount - 1)
            {
                if (complete)
                    XorInPlace(input, k1);
                else
                {
                    input[count] = 0x80;
                    XorInPlace(input, k2);
                }
            }
            XorInPlace(input, state);
            aes.EncryptEcb(input, state, PaddingMode.None);
        }
        return state.ToArray();
    }

    private static void DoubleCmacBlock(ReadOnlySpan<byte> input, Span<byte> output)
    {
        int carry = 0;
        for (int i = 15; i >= 0; i--)
        {
            int value = input[i];
            output[i] = (byte)((value << 1) | carry);
            carry = value >> 7;
        }
        if (carry != 0)
            output[15] ^= 0x87;
    }

    private static void XorInPlace(Span<byte> target, ReadOnlySpan<byte> value)
    {
        for (int i = 0; i < target.Length; i++)
            target[i] ^= value[i];
    }

    private static int Delta18(uint next, uint previous)
    {
        int delta = checked((int)next - (int)previous);
        if (delta <= 0)
            delta += UBlockSize;
        return delta;
    }

    private static void DecodeKrakenSpan(
        byte[] payload, byte[] output, int firstChunk, ProsperoNapsSpan span)
    {
        // The three-bit NAPS half modes carry two independent Kraken choices:
        //   bit 2 = newLZ rather than the stored/bare-entropy path;
        //   bit 1 = sub/delta literals rather than raw literals.
        // They map to the decoder's per-half flags (0x02/0x01 for even and
        // 0x20/0x10 for odd). Publishing Tools emits both 5/4 (raw literals)
        // and 7/6 (sub literals) while KdePredictor remains zero, so the KDE
        // field must not be used as the Kraken literal-model selector.
        int flags = ((span.Even & 4) != 0 ? 0x02 : 0)
            | ((span.Even & 2) != 0 ? 0x01 : 0)
            | ((span.Odd & 4) != 0 ? 0x20 : 0)
            | ((span.Odd & 2) != 0 ? 0x10 : 0);
        KrakenDecodeStatus status = KrakenDecoder.DecodeBlock(payload, flags, firstChunk, output);
        if (status != KrakenDecodeStatus.Success)
            throw new InvalidDataException(
                $"NAPS span {span.Index} (CBI {span.CblockInfoIndex}, stored=0x{span.StoredOffset:x}, " +
                $"compressed=0x{span.CompressedLength:x}, first=0x{firstChunk:x}, " +
                $"uncompressed=0x{span.UncompressedLength:x}) Kraken decode failed " +
                $"({status}, modes {span.Even}/{span.Odd}, payload={Convert.ToHexString(payload.AsSpan(0, Math.Min(16, payload.Length)))}).");
    }
}
