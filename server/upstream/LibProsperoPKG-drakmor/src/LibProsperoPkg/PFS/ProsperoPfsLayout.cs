// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// PS5 inner-PFS layout generation: a prepared folder is turned
// into a plaintext inner-PFS image with the superblock, inode table, super-root,
// flat-path-table, dirents and file data laid out exactly as the kernel expects.
//
// The layout is produced by LibProsperoPkg.PFS.PfsBuilder with the superblock version stamped to 2,
// so this stays a single, round-trip-validated code path — the same way
// ProsperoPfsImage reuses XtsBlockTransform for image encryption and ProsperoPfsc reuses
// PfscEncoder for compression. The produced plaintext image is what the ProsperoPfsc
// (compression) and ProsperoPfsImage (AES-XTS encryption) primitives then consume, giving a
// folder-to-compressed/encrypted inner-PFS pipeline.
#nullable enable
using LibProsperoPkg.PFS.Compression;
using LibProsperoPkg.Util;
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Linq;
using System.Text.RegularExpressions;

namespace LibProsperoPkg.PFS;

/// <summary>Per-file compression used while laying out a PFS image.</summary>
public enum PfsFileCompressionMethod
{
    /// <summary>Store every file verbatim.</summary>
    None,

    /// <summary>Classic PFSC/zlib blocks, readable by the classic pfs driver.</summary>
    Zlib,

    /// <summary>PFSC v2/Kraken blocks, readable by ppr_pfs.</summary>
    Kraken,
}

/// <summary>Options controlling an inner-PFS layout build.</summary>
public sealed class ProsperoPfsLayoutOptions
{
    /// <summary>Filesystem block size in bytes. Default 64 KiB (the PS5 inner-PFS block size).</summary>
    public uint BlockSize { get; set; } = 0x10000;

    /// <summary>
    /// Compress regular files as ppr_pfs-compatible PFSC v2 Kraken containers.
    /// Files are wrapped even when metadata overhead makes the stored container larger, matching
    /// publisher output. Set <see cref="KrakenOnlyWhenSmaller"/> for size-driven fallback.
    /// </summary>
    public bool CompressFilesWithKraken { get; set; }

    /// <summary>
    /// Selects per-file compression. <see cref="PfsFileCompressionMethod.None"/> stores files raw;
    /// the legacy <see cref="CompressFilesWithKraken"/> flag still selects Kraken when this remains None.
    /// </summary>
    public PfsFileCompressionMethod FileCompression { get; set; }

    /// <summary>
    /// Codec level. Kraken accepts -4..9 (publisher default 8); zlib accepts 0..9.
    /// </summary>
    public int CompressionLevel { get; set; } = PprPfsKraken.DefaultLevel;

    /// <summary>Kraken level recorded in PFSC v2 headers. Publisher-produced images use level 8.</summary>
    public int KrakenLevel
    {
        get => CompressionLevel;
        set => CompressionLevel = value;
    }

    /// <summary>Smallest source file considered for Kraken compression.</summary>
    public long MinimumKrakenFileSize { get; set; }

    /// <summary>Keep a PFSC v2 file only when its complete stored size is smaller than the source.</summary>
    public bool KrakenOnlyWhenSmaller { get; set; }

    /// <summary>
    /// Minimum percentage a Kraken group must save. Lower-gain groups remain raw to reduce
    /// runtime decompression latency.
    /// </summary>
    public int KrakenMinimumSavingsPercent { get; set; }

    /// <summary>
    /// Optional logical raw-range provider for each file being wrapped in PFSC v2/Kraken.
    /// The callback receives a forward-slash relative path.
    /// </summary>
    public Func<string, IReadOnlyCollection<PprPfsRawRange>?>? KrakenRawRangeProvider { get; set; }

    /// <summary>Physically place latency-sensitive files before large sequential files.</summary>
    public bool OptimizeFileLayoutForReadSpeed { get; set; }

    /// <summary>Files at or below this size receive the early-layout priority.</summary>
    public long ReadPrioritySmallFileSize { get; set; } = 0x100000;

    /// <summary>Case-insensitive path globs receiving the highest early-layout priority.</summary>
    public IReadOnlyCollection<string> ReadPriorityPatterns { get; set; } =
        PprPfsReadOptimizationOptions.DefaultLatencySensitivePatterns;

    /// <summary>
    /// Use the publisher PPR-PFS outer layout: inode 0 is the user root and the inode table starts
    /// at block 2. This omits the classic super-root and flat-path-table wrapper.
    /// </summary>
    public bool UsePublisherPprLayout { get; set; }

    /// <summary>
    /// Remove sce_sys files that a full PKG build normally moves to outer container entries.
    /// Disable this when reproducing a standalone publisher PPR-PFS tree.
    /// </summary>
    public bool FilterOuterPackageEntries { get; set; } = true;

    /// <summary>
    /// Case-insensitive path globs excluded from Kraken compression. Paths use forward slashes;
    /// <c>*</c> matches within one component and <c>**</c> crosses directory separators.
    /// The default mirrors the reference image, where every file below <c>sce_sys</c> is raw.
    /// </summary>
    public IReadOnlyCollection<string> KrakenExcludePatterns { get; set; } = DefaultKrakenExcludePatterns;

    /// <summary>
    /// Alias for <see cref="KrakenExcludePatterns"/> used by all selected compression methods.
    /// </summary>
    public IReadOnlyCollection<string> CompressionExcludePatterns
    {
        get => KrakenExcludePatterns;
        set => KrakenExcludePatterns = value;
    }

    /// <summary>Default publisher-style Kraken exclusions.</summary>
    public static IReadOnlyCollection<string> DefaultKrakenExcludePatterns { get; } =
        new[] { "sce_sys/**" };

    /// <summary>
    /// Timestamp written into the inode table. Defaults to the Unix epoch for reproducible output.
    /// </summary>
    public DateTime TimeStamp { get; set; } = DateTime.UnixEpoch;

    /// <summary>
    /// Case-insensitive file names that are skipped (project scaffolding that must never end up
    /// inside the image). Matches the default exclude masks the publishing tools use.
    /// </summary>
    public IReadOnlyCollection<string> ExcludeFileNames { get; set; } = DefaultExcludeFileNames;

    /// <summary>The default file-name exclude set (project files, intermediate caches, …).</summary>
    public static IReadOnlyCollection<string> DefaultExcludeFileNames { get; } =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            "keystone", "disc_info.dat", "pfs-version.dat", "ext_info.dat",
        };

    /// <summary>File-name suffixes that are skipped (e.g. the project file itself).</summary>
    public IReadOnlyCollection<string> ExcludeFileSuffixes { get; set; } = DefaultExcludeFileSuffixes;

    /// <summary>The default file-suffix exclude set.</summary>
    public static IReadOnlyCollection<string> DefaultExcludeFileSuffixes { get; } =
        new HashSet<string>(StringComparer.OrdinalIgnoreCase) { ".gp4", ".gp5", ".esbak", ".dds" };
}

/// <summary>The outcome of an inner-PFS layout build.</summary>
public sealed class ProsperoPfsLayoutResult
{
    /// <summary>The path the plaintext inner-PFS image was written to.</summary>
    public required string OutputPath { get; init; }

    /// <summary>Total image size in bytes.</summary>
    public required long ImageSize { get; init; }

    /// <summary>Filesystem block size used (bytes).</summary>
    public required uint BlockSize { get; init; }

    /// <summary>The PFS superblock version stamped (2 = PS5).</summary>
    public required long Version { get; init; }

    /// <summary>Number of files placed into the image.</summary>
    public required int FileCount { get; init; }

    /// <summary>Number of directories placed into the image.</summary>
    public required int DirectoryCount { get; init; }
}

/// <summary>
/// Inner-PFS layout generator for PS5. See the file header for the scheme.
/// </summary>
public static class ProsperoPfsLayout
{
    /// <summary>
    /// Builds a plaintext inner-PFS image from <paramref name="sourceFolder"/> and writes it to
    /// <paramref name="outputPath"/>. The result is unsigned and unencrypted; apply
    /// <see cref="ProsperoPfsImage"/> (AES-XTS) and/or <see cref="ProsperoPfsc"/> (compression)
    /// afterwards for the encrypted/compressed forms.
    /// </summary>
    /// <param name="sourceFolder">A prepared application folder (its tree becomes the image's uroot).</param>
    /// <param name="outputPath">Destination plaintext PFS image path.</param>
    /// <param name="options">Layout options. <c>null</c> uses the PS5 defaults.</param>
    /// <param name="logger">Optional progress sink.</param>
    public static ProsperoPfsLayoutResult BuildFromFolder(
        string sourceFolder, string outputPath, ProsperoPfsLayoutOptions? options = null, Action<string>? logger = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sourceFolder);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);
        if (!Directory.Exists(sourceFolder))
            throw new DirectoryNotFoundException($"Source folder does not exist: {sourceFolder}");

        options ??= new ProsperoPfsLayoutOptions();
        PfsFileCompressionMethod compression = ResolveCompression(options);
        ValidateOptions(options, compression);
        var log = logger ?? (_ => { });

        string sourceFullPath = Path.GetFullPath(sourceFolder);
        string outputFullPath = Path.GetFullPath(outputPath);
        string outputDirectory = Path.GetDirectoryName(outputFullPath) ?? Directory.GetCurrentDirectory();
        Directory.CreateDirectory(outputDirectory);
        string buildWorkspace = Path.Combine(
            outputDirectory, ".libprospero-build-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(buildWorkspace);
        using var workspaceCleanup = new TemporaryDirectory(buildWorkspace);
        string stagedOutput = Path.Combine(buildWorkspace, "image.pfs.tmp");

        long version = PfsHeader.VersionPs5;
        string layoutName = options.UsePublisherPprLayout ? "ppr" : "classic";
        log($"Laying out the {layoutName} PFS image (superblock version {version}, block size 0x{options.BlockSize:X}, compression {compression.ToString().ToLowerInvariant()}, level {options.CompressionLevel})...");

        using var temporaryFiles = new TemporaryFileSet();
        var root = BuildTree(
            sourceFullPath, options, temporaryFiles, log, buildWorkspace, outputFullPath,
            out int fileCount, out int dirCount, out int compressedFileCount);
        log($"Filesystem tree: {dirCount} directories, {fileCount} files, "
            + $"{compressedFileCount} {compression.ToString().ToLowerInvariant()}-compressed files.");

        var props = new PfsProperties
        {
            root = root,
            BlockSize = options.BlockSize,
            Version = version,
            Encrypt = false,
            Sign = false,
            FileTime = ToUnixSeconds(options.TimeStamp),
            DirectRootLayout = options.UsePublisherPprLayout,
            FilterOuterPackageEntries = options.FilterOuterPackageEntries,
            OptimizeFileLayoutForReadSpeed = options.OptimizeFileLayoutForReadSpeed,
        };

        var builder = new PfsBuilder(props, s => log(s));
        long canonicalSize = builder.CalculatePfsSize();
        using (var output = new FileStream(
            stagedOutput, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None,
            bufferSize: 1 << 20, FileOptions.SequentialScan))
        {
            builder.WriteImage(output);
            // The stream writer fills blocks lazily, so the tail of the final block can be left
            // unwritten. The canonical image size is the data-block count (Ndblock) * BlockSize —
            // a whole number of 0x10000 blocks; pad to it so the image is block-aligned, which the
            // AES-XTS image crypto (operating on 0x1000-byte sectors) requires.
            if (output.Length < canonicalSize)
                output.SetLength(canonicalSize);
            else if (output.Length != canonicalSize)
                throw new InvalidDataException(
                    $"PFS writer exceeded its calculated image size ({output.Length:N0} > {canonicalSize:N0}).");
        }

        File.Move(stagedOutput, outputFullPath, overwrite: true);
        long size = new FileInfo(outputFullPath).Length;
        log($"Done: {Path.GetFileName(outputFullPath)} ({size:N0} bytes).");

        return new ProsperoPfsLayoutResult
        {
            OutputPath = outputFullPath,
            ImageSize = size,
            BlockSize = options.BlockSize,
            Version = version,
            FileCount = fileCount,
            DirectoryCount = dirCount,
        };
    }

    /// <summary>
    /// Proves a freshly built plaintext layout is self-consistent: builds the image from
    /// <paramref name="sourceFolder"/>, reads it back with <see cref="PfsReader"/> and verifies
    /// every source file is present with byte-identical content (and the superblock version
    /// matches the requested profile). This is the self-check that replaces on-hardware
    /// testing for the layout step.
    /// </summary>
    public static bool VerifyRoundTrip(string sourceFolder, ProsperoPfsLayoutOptions? options = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(sourceFolder);
        options ??= new ProsperoPfsLayoutOptions();
        string image = Path.GetTempFileName();
        try
        {
            var result = BuildFromFolder(sourceFolder, image, options);

            using var mmf = MemoryMappedFile.CreateFromFile(image, FileMode.Open, mapName: null, capacity: 0, MemoryMappedFileAccess.Read);
            using var view = mmf.CreateViewAccessor(0, 0, MemoryMappedFileAccess.Read);
            var reader = new PfsReader(view);
            if (reader.Header.Version != result.Version)
                return false;

            // Every non-excluded source file must round-trip byte-for-byte.
            var expected = EnumerateSourceFiles(Path.GetFullPath(sourceFolder), options);
            foreach (var (relativePath, fullPath) in expected)
            {
                var node = reader.GetFile(relativePath);
                if (node is null)
                    return false;
                if (!FileMatchesNode(fullPath, node))
                    return false;
            }
            return true;
        }
        catch
        {
            return false;
        }
        finally
        {
            TryDelete(image);
        }
    }

    // Recursively builds an FSDir tree from a reference folder, applying the exclude masks. Names are
    // sorted for deterministic, reproducible output.
    private static FSDir BuildTree(
        string sourceFolder,
        ProsperoPfsLayoutOptions options,
        TemporaryFileSet temporaryFiles,
        Action<string> log,
        string buildWorkspace,
        string outputFullPath,
        out int fileCount,
        out int dirCount,
        out int compressedFileCount)
    {
        int files = 0, dirs = 0, compressed = 0;
        Regex[] readPriorityMatchers = CompilePathGlobs(options.ReadPriorityPatterns);
        Regex[] compressionExcludeMatchers = CompilePathGlobs(options.KrakenExcludePatterns);
        var root = new FSDir();
        Populate(root, sourceFolder);
        fileCount = files;
        dirCount = dirs;
        compressedFileCount = compressed;
        return root;

        void Populate(FSDir node, string path)
        {
            foreach (var sub in Directory.EnumerateDirectories(path).OrderBy(Path.GetFileName, StringComparer.Ordinal))
            {
                if (PathsEqual(sub, buildWorkspace))
                    continue;
                var child = new FSDir { name = Path.GetFileName(sub), Parent = node };
                node.Dirs.Add(child);
                dirs++;
                Populate(child, sub);
            }
            foreach (var file in Directory.EnumerateFiles(path).OrderBy(Path.GetFileName, StringComparer.Ordinal))
            {
                if (PathsEqual(file, outputFullPath))
                    continue;
                var name = Path.GetFileName(file);
                if (IsExcluded(name, options))
                    continue;
                node.Files.Add(BuildFile(file, name, node));
                files++;
            }
        }

        FSFile BuildFile(string path, string name, FSDir parent)
        {
            var sourceInfo = new FileInfo(path);
            string relativePath = Path.GetRelativePath(sourceFolder, path).Replace('\\', '/');
            int layoutPriority = !options.OptimizeFileLayoutForReadSpeed
                ? 0
                : MatchesPathGlob(relativePath, readPriorityMatchers)
                    ? 0
                    : options.ReadPrioritySmallFileSize > 0
                        && sourceInfo.Length <= options.ReadPrioritySmallFileSize
                        ? 1
                        : 2;
            PfsFileCompressionMethod compression = ResolveCompression(options);
            if (compression == PfsFileCompressionMethod.None
                || sourceInfo.Length < options.MinimumKrakenFileSize
                || MatchesPathGlob(relativePath, compressionExcludeMatchers))
                return new FSFile(path) { name = name, Parent = parent, LayoutPriority = layoutPriority };

            string temporary = Path.Combine(
                buildWorkspace, "pfsc2_" + Guid.NewGuid().ToString("N") + ".tmp");
            long storedSize;
            int compressedBlocks;
            int forcedRawBlocks = 0;
            int lowGainRawBlocks = 0;
            long blockCount;
            bool pprCompression;
            if (compression == PfsFileCompressionMethod.Kraken)
            {
                PprPfsKrakenWriteResult result = PprPfsKraken.PackFile(
                    path, temporary, new PprPfsKrakenWriteOptions
                    {
                        Level = options.CompressionLevel,
                        MinimumSavingsPercent = options.KrakenMinimumSavingsPercent,
                        RawRanges = options.KrakenRawRangeProvider?.Invoke(relativePath)
                            ?? Array.Empty<PprPfsRawRange>(),
                    });
                if (result.UncompressedSize != sourceInfo.Length)
                    throw new IOException($"Source file changed size while being compressed: {path}");
                storedSize = result.StoredSize;
                compressedBlocks = result.CompressedBlockCount;
                forcedRawBlocks = result.ForcedRawBlockCount;
                lowGainRawBlocks = result.LowGainRawBlockCount;
                blockCount = result.BlockCount;
                pprCompression = true;
            }
            else
            {
                PfscEncodeStats result;
                using (var source = new FileStream(
                    path, FileMode.Open, FileAccess.Read, FileShare.Read,
                    bufferSize: 1 << 20, FileOptions.SequentialScan))
                using (var destination = new FileStream(
                    temporary, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None,
                    bufferSize: 1 << 20, FileOptions.SequentialScan))
                {
                    if (source.Length != sourceInfo.Length)
                        throw new IOException($"Source file changed size while being compressed: {path}");
                    result = PfscEncoder.Encode(
                        source,
                        sourceInfo.Length,
                        destination,
                        new PfscEncoderOptions
                        {
                            BlockSize = checked((int)options.BlockSize),
                            ZlibLevel = options.CompressionLevel,
                        });
                }
                if (result.StoredRaw)
                {
                    TryDelete(temporary);
                    return new FSFile(path) { name = name, Parent = parent, LayoutPriority = layoutPriority };
                }
                storedSize = result.EncodedSize;
                compressedBlocks = checked((int)result.CompressedBlocks);
                blockCount = result.BlockCount;
                pprCompression = false;
            }

            if (options.KrakenOnlyWhenSmaller && storedSize >= sourceInfo.Length)
            {
                TryDelete(temporary);
                return new FSFile(path) { name = name, Parent = parent, LayoutPriority = layoutPriority };
            }

            temporaryFiles.Add(temporary);
            compressed++;
            log($"{compression}: {Path.GetRelativePath(sourceFolder, path)} "
                + $"{sourceInfo.Length:N0} -> {storedSize:N0} bytes "
                + $"({compressedBlocks}/{blockCount} blocks"
                + (forcedRawBlocks > 0 ? $", forced-raw {forcedRawBlocks}" : string.Empty)
                + (lowGainRawBlocks > 0 ? $", low-gain-raw {lowGainRawBlocks}" : string.Empty)
                + ").");
            string storedPath = temporary;
            return new FSFile(
                destination =>
                {
                    using var stored = new FileStream(
                        storedPath, FileMode.Open, FileAccess.Read, FileShare.Read,
                        bufferSize: 1 << 20, FileOptions.SequentialScan);
                    stored.CopyTo(destination, 1 << 20);
                },
                name,
                size: storedSize,
                compressedSize: sourceInfo.Length,
                compress: true)
            {
                Parent = parent,
                PprKrakenCompression = pprCompression,
                LayoutPriority = layoutPriority,
            };
        }
    }

    private static PfsFileCompressionMethod ResolveCompression(ProsperoPfsLayoutOptions options) =>
        options.FileCompression != PfsFileCompressionMethod.None
            ? options.FileCompression
            : options.CompressFilesWithKraken
                ? PfsFileCompressionMethod.Kraken
                : PfsFileCompressionMethod.None;

    private static void ValidateOptions(ProsperoPfsLayoutOptions options, PfsFileCompressionMethod compression)
    {
        ArgumentNullException.ThrowIfNull(options.KrakenExcludePatterns);
        ArgumentNullException.ThrowIfNull(options.ReadPriorityPatterns);
        ArgumentNullException.ThrowIfNull(options.ExcludeFileNames);
        ArgumentNullException.ThrowIfNull(options.ExcludeFileSuffixes);
        if (options.BlockSize is < 0x1000 or > 0x200000 || (options.BlockSize & (options.BlockSize - 1)) != 0)
            throw new ArgumentOutOfRangeException(nameof(options.BlockSize), "PFS block size must be a power of two from 0x1000 through 0x200000.");
        if (options.MinimumKrakenFileSize < 0)
            throw new ArgumentOutOfRangeException(nameof(options.MinimumKrakenFileSize));
        if (options.KrakenMinimumSavingsPercent is < 0 or > 100)
            throw new ArgumentOutOfRangeException(nameof(options.KrakenMinimumSavingsPercent));
        if (options.ReadPrioritySmallFileSize < 0)
            throw new ArgumentOutOfRangeException(nameof(options.ReadPrioritySmallFileSize));
        if (compression == PfsFileCompressionMethod.Kraken && options.CompressionLevel is < -4 or > 9)
            throw new ArgumentOutOfRangeException(nameof(options.CompressionLevel), "Kraken level must be in the range -4..9.");
        if (compression == PfsFileCompressionMethod.Zlib && options.CompressionLevel is < 0 or > 9)
            throw new ArgumentOutOfRangeException(nameof(options.CompressionLevel), "Zlib level must be in the range 0..9.");
        if (options.UsePublisherPprLayout && compression == PfsFileCompressionMethod.Zlib)
            throw new NotSupportedException(
                "The publisher direct-root runtime format uses PFSv2/v3 Kraken, not the distinct " +
                "classic PFSC/zlib container. Use --layout classic with zlib, or select kraken/none.");
    }

    private static Regex[] CompilePathGlobs(IReadOnlyCollection<string> patterns)
    {
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

    private static bool MatchesPathGlob(string relativePath, IReadOnlyList<Regex> matchers) =>
        matchers.Any(matcher => matcher.IsMatch(relativePath));

    private sealed class TemporaryFileSet : IDisposable
    {
        private readonly List<string> _paths = new();

        public void Add(string path) => _paths.Add(path);

        public void Dispose()
        {
            foreach (string path in _paths)
                TryDelete(path);
        }
    }

    private sealed class TemporaryDirectory(string path) : IDisposable
    {
        public void Dispose() => TryDeleteDirectory(path);
    }

    // Enumerates (image-relative path, full path) for every source file that ends up in the image.
    private static IEnumerable<(string Relative, string Full)> EnumerateSourceFiles(string sourceFolder, ProsperoPfsLayoutOptions options)
    {
        foreach (var file in Directory.EnumerateFiles(sourceFolder, "*", SearchOption.AllDirectories))
        {
            var name = Path.GetFileName(file);
            if (IsExcluded(name, options))
                continue;
            var rel = Path.GetRelativePath(sourceFolder, file)
                .Replace(Path.DirectorySeparatorChar, '/')
                .Replace(Path.AltDirectorySeparatorChar, '/');
            yield return (rel, file);
        }
    }

    private static bool IsExcluded(string name, ProsperoPfsLayoutOptions options)
    {
        if (options.ExcludeFileNames.Any(excluded =>
            string.Equals(excluded, name, StringComparison.OrdinalIgnoreCase)))
            return true;
        foreach (var suffix in options.ExcludeFileSuffixes)
            if (name.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
                return true;
        return false;
    }

    private static bool FileMatchesNode(string fullPath, PfsReader.File node)
    {
        var info = new FileInfo(fullPath);
        long logicalSize = node.flags.HasFlag(InodeFlags.compressed) ? node.compressed_size : node.size;
        if (info.Length != logicalSize)
            return false;

        var actual = node.GetView();
        using var expected = File.OpenRead(fullPath);
        if (node.flags.HasFlag(InodeFlags.compressed))
        {
            var header = new byte[0x28];
            actual.Read(0, header, 0, header.Length);
            if (BitConverter.ToUInt32(header, 0) != PprPfsKraken.Magic)
                return false;

            uint version = BitConverter.ToUInt32(header, 4);
            if (version == PprPfsKraken.Version)
            {
                long storedSize = checked((long)BitConverter.ToUInt64(header, 0x20));
                using var source = new StreamWrapper(actual, storedSize);
                using var comparison = new ComparisonWriteStream(expected, info.Length);
                PprPfsKraken.Unpack(source, 0, comparison);
                return comparison.IsComplete;
            }

            using var classic = new PFSCReader(actual);
            var decodedBlock = new byte[1 << 16];
            var expectedBlock = new byte[decodedBlock.Length];
            long decodedOffset = 0;
            while (decodedOffset < info.Length)
            {
                int count = (int)Math.Min(decodedBlock.Length, info.Length - decodedOffset);
                classic.Read(decodedOffset, decodedBlock, 0, count);
                ReadExact(expected, expectedBlock, count);
                if (!decodedBlock.AsSpan(0, count).SequenceEqual(expectedBlock.AsSpan(0, count)))
                    return false;
                decodedOffset += count;
            }
            return true;
        }

        using var actualStream = new StreamWrapper(actual, node.size);
        return StreamsMatch(expected, actualStream, info.Length);
    }

    private static bool StreamsMatch(Stream expected, Stream actual, long length)
    {
        var ba = new byte[1 << 16];
        var bb = new byte[1 << 16];
        long remaining = length;
        while (remaining > 0)
        {
            int toRead = (int)Math.Min(ba.Length, remaining);
            ReadExact(expected, ba, toRead);
            ReadExact(actual, bb, toRead);
            if (!ba.AsSpan(0, toRead).SequenceEqual(bb.AsSpan(0, toRead)))
                return false;
            remaining -= toRead;
        }
        return true;
    }

    private sealed class ComparisonWriteStream(Stream expected, long expectedLength) : Stream
    {
        private readonly byte[] _buffer = new byte[1 << 20];
        private long _written;
        private bool _matches = true;

        public bool IsComplete => _matches && _written == expectedLength;
        public override bool CanRead => false;
        public override bool CanSeek => false;
        public override bool CanWrite => true;
        public override long Length => _written;
        public override long Position
        {
            get => _written;
            set => throw new NotSupportedException();
        }

        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
        public override void SetLength(long value) => throw new NotSupportedException();

        public override void Write(byte[] buffer, int offset, int count) =>
            Write(buffer.AsSpan(offset, count));

        public override void Write(ReadOnlySpan<byte> buffer)
        {
            if (_written > expectedLength - buffer.Length)
            {
                _matches = false;
                _written += buffer.Length;
                return;
            }

            int consumed = 0;
            while (consumed < buffer.Length)
            {
                int count = Math.Min(_buffer.Length, buffer.Length - consumed);
                ReadExact(expected, _buffer, count);
                if (!buffer.Slice(consumed, count).SequenceEqual(_buffer.AsSpan(0, count)))
                    _matches = false;
                consumed += count;
            }
            _written += buffer.Length;
        }
    }

    private static void ReadExact(Stream s, byte[] buffer, int count)
    {
        int read = 0;
        while (read < count)
        {
            int n = s.Read(buffer, read, count - read);
            if (n == 0) throw new EndOfStreamException("Unexpected end of stream while comparing PFS file data.");
            read += n;
        }
    }

    private static long ToUnixSeconds(DateTime time) =>
        (long)time.ToUniversalTime().Subtract(DateTime.UnixEpoch).TotalSeconds;

    private static void TryDelete(string path)
    {
        try { if (File.Exists(path)) File.Delete(path); }
        catch { /* best-effort cleanup */ }
    }

    private static bool PathsEqual(string left, string right) =>
        string.Equals(
            Path.GetFullPath(left),
            Path.GetFullPath(right),
            OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal);

    private static void TryDeleteDirectory(string path)
    {
        try
        {
            if (Directory.Exists(path))
                Directory.Delete(path, recursive: true);
        }
        catch
        {
            // Best-effort cleanup. A failed build still preserves the previous destination image.
        }
    }
}
