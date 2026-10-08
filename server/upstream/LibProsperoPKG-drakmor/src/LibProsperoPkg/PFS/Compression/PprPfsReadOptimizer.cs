// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// Runtime-read layout planning for a PFS image wrapped in PFSC v2/Kraken.
#nullable enable
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Linq;
using System.Text.RegularExpressions;

namespace LibProsperoPkg.PFS.Compression;

/// <summary>Controls which regions of an inner PFS image remain raw inside PFSC v2.</summary>
public sealed class PprPfsReadOptimizationOptions
{
    /// <summary>Keep the superblock, inode table, directory data, and other pre-file metadata raw.</summary>
    public bool KeepMetadataRaw { get; set; } = true;

    /// <summary>Keep files no larger than this many bytes raw. Zero disables the size rule.</summary>
    public long SmallFileRawThreshold { get; set; } = 0x100000;

    /// <summary>Case-insensitive inner paths that should remain raw.</summary>
    public IReadOnlyCollection<string> RawFilePatterns { get; set; } = DefaultLatencySensitivePatterns;

    /// <summary>Force the entire logical image to raw PFSC entries.</summary>
    public bool ForceAllRaw { get; set; }

    /// <summary>Default startup-sensitive paths for a game image.</summary>
    public static IReadOnlyCollection<string> DefaultLatencySensitivePatterns { get; } =
        new[] { "eboot.bin", "sce_module/**", "sce_sys/**" };
}

/// <summary>Raw ranges and diagnostics produced from an inner PFS layout.</summary>
public sealed class PprPfsReadOptimizationPlan
{
    public required IReadOnlyList<PprPfsRawRange> RawRanges { get; init; }
    public required long RawLogicalBytes { get; init; }
    public required int RawGroupCount { get; init; }
    public required int RawFileCount { get; init; }
    public required long MetadataPrefixBytes { get; init; }
}

/// <summary>Builds a group-aligned fast-read plan from an existing plaintext PFS image.</summary>
public static class PprPfsReadOptimizer
{
    /// <summary>Inspect file extents and return 256 KiB groups that should bypass Kraken.</summary>
    public static PprPfsReadOptimizationPlan AnalyzePfsImage(
        string imagePath,
        PprPfsReadOptimizationOptions? options = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(imagePath);
        options ??= new PprPfsReadOptimizationOptions();
        if (options.SmallFileRawThreshold < 0)
            throw new ArgumentOutOfRangeException(nameof(options.SmallFileRawThreshold));

        var info = new FileInfo(imagePath);
        if (!info.Exists)
            throw new FileNotFoundException("Inner PFS image was not found.", imagePath);
        if (info.Length == 0)
            throw new InvalidDataException("Inner PFS image is empty.");

        if (options.ForceAllRaw)
            return CreatePlan(new[] { new PprPfsRawRange(0, info.Length) }, info.Length, 0, info.Length);

        Regex[] rawPathMatchers = CompilePathGlobs(options.RawFilePatterns);
        if (!options.KeepMetadataRaw
            && options.SmallFileRawThreshold == 0
            && rawPathMatchers.Length == 0)
        {
            return CreatePlan(Array.Empty<PprPfsRawRange>(), info.Length, 0, 0);
        }

        using var mapped = MemoryMappedFile.CreateFromFile(
            imagePath, FileMode.Open, mapName: null, capacity: 0, MemoryMappedFileAccess.Read);
        using var view = mapped.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read);
        var reader = new PfsReader(view);
        PfsReader.File[] files = reader.GetAllFiles().ToArray();
        foreach (PfsReader.File file in files)
        {
            if (file.offset < 0 || file.offset > info.Length || file.size < 0
                || (file.offset == info.Length && file.size != 0))
                throw new InvalidDataException($"Inner PFS file '{file.FullName}' has an invalid extent.");
        }
        var ranges = new List<PprPfsRawRange>();

        long metadataPrefix = 0;
        if (options.KeepMetadataRaw)
        {
            metadataPrefix = files.Length == 0
                ? info.Length
                : Math.Clamp(files.Min(static file => file.offset), 0, info.Length);
            if (metadataPrefix > 0)
                ranges.Add(new PprPfsRawRange(0, metadataPrefix));
        }

        int rawFiles = 0;
        foreach (PfsReader.File file in files)
        {
            string relativePath = ImageRelativePath(file.FullName);
            bool keepRaw = options.SmallFileRawThreshold > 0
                    && file.size <= options.SmallFileRawThreshold
                || MatchesAnyPattern(relativePath, rawPathMatchers);
            if (!keepRaw)
                continue;

            rawFiles++;
            AddFileRanges(ranges, file, reader.Header.BlockSize, info.Length);
        }

        return CreatePlan(ranges, info.Length, rawFiles, metadataPrefix);
    }

    private static void AddFileRanges(
        List<PprPfsRawRange> ranges,
        PfsReader.File file,
        uint blockSize,
        long imageLength)
    {
        if (blockSize == 0)
            throw new InvalidDataException("Inner PFS has a zero filesystem block size.");
        long allocatedLength = Math.Min(
            imageLength,
            Align(Math.Max(file.size, 1), checked((int)blockSize)));
        if (file.blocks is { Length: > 0 })
        {
            long remaining = allocatedLength;
            foreach (int block in file.blocks)
            {
                if (remaining <= 0)
                    break;
                if (block < 0 || checked((long)block * blockSize) >= imageLength)
                    throw new InvalidDataException($"Inner PFS file '{file.FullName}' has an invalid block map.");
                long length = Math.Min(blockSize, remaining);
                ranges.Add(new PprPfsRawRange(checked((long)block * blockSize), length));
                remaining -= length;
            }
            return;
        }

        long lengthAtOffset = Math.Min(allocatedLength, imageLength - file.offset);
        if (lengthAtOffset > 0)
            ranges.Add(new PprPfsRawRange(file.offset, lengthAtOffset));
    }

    private static PprPfsReadOptimizationPlan CreatePlan(
        IEnumerable<PprPfsRawRange> ranges,
        long imageLength,
        int rawFiles,
        long metadataPrefix)
    {
        PprPfsRawRange[] merged = MergeGroupAlignedRanges(ranges, imageLength);
        long bytes = merged.Sum(static range => range.Length);
        int groups = checked((int)merged.Sum(static range =>
            (range.Length + PprPfsKraken.CompressionGroupSize - 1)
            / PprPfsKraken.CompressionGroupSize));
        return new PprPfsReadOptimizationPlan
        {
            RawRanges = merged,
            RawLogicalBytes = bytes,
            RawGroupCount = groups,
            RawFileCount = rawFiles,
            MetadataPrefixBytes = metadataPrefix,
        };
    }

    private static PprPfsRawRange[] MergeGroupAlignedRanges(
        IEnumerable<PprPfsRawRange> ranges,
        long imageLength)
    {
        var aligned = new List<PprPfsRawRange>();
        foreach (PprPfsRawRange range in ranges)
        {
            if (range.Offset < 0 || range.Length < 0)
                throw new InvalidDataException("Read-optimization ranges cannot be negative.");
            if (range.Length == 0 || range.Offset >= imageLength)
                continue;
            long start = range.Offset / PprPfsKraken.CompressionGroupSize
                * PprPfsKraken.CompressionGroupSize;
            long end = Math.Min(
                imageLength,
                Align(checked(range.Offset + range.Length), PprPfsKraken.CompressionGroupSize));
            aligned.Add(new PprPfsRawRange(start, end - start));
        }

        aligned.Sort(static (left, right) => left.Offset.CompareTo(right.Offset));
        var merged = new List<PprPfsRawRange>(aligned.Count);
        foreach (PprPfsRawRange range in aligned)
        {
            if (merged.Count == 0)
            {
                merged.Add(range);
                continue;
            }
            PprPfsRawRange previous = merged[^1];
            long previousEnd = checked(previous.Offset + previous.Length);
            long currentEnd = checked(range.Offset + range.Length);
            if (range.Offset <= previousEnd)
                merged[^1] = new PprPfsRawRange(previous.Offset, Math.Max(previousEnd, currentEnd) - previous.Offset);
            else
                merged.Add(range);
        }
        return merged.ToArray();
    }

    private static Regex[] CompilePathGlobs(IReadOnlyCollection<string>? patterns)
    {
        if (patterns is null)
            return Array.Empty<Regex>();
        return patterns.Select(patternValue =>
        {
            string pattern = patternValue.Replace('\\', '/').TrimStart('/');
            string expression = "^" + Regex.Escape(pattern)
                .Replace("\\*\\*", ".*")
                .Replace("\\*", "[^/]*")
                .Replace("\\?", "[^/]") + "$";
            return new Regex(expression,
                RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
                | RegexOptions.Compiled | RegexOptions.NonBacktracking);
        }).ToArray();
    }

    private static bool MatchesAnyPattern(string relativePath, IReadOnlyList<Regex> patterns) =>
        patterns.Any(pattern => pattern.IsMatch(relativePath));

    private static string ImageRelativePath(string fullName)
    {
        string normalized = fullName.TrimStart('/');
        return normalized.StartsWith("uroot/", StringComparison.OrdinalIgnoreCase)
            ? normalized[6..]
            : normalized;
    }

    private static long Align(long value, int alignment) =>
        checked((value + alignment - 1) / alignment * alignment);
}
