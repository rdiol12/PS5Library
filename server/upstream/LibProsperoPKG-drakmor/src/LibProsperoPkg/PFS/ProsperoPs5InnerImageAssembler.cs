// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// ---------------------------------------------------------------------------------------------------
// PS5 nwonly INNER pfs_image.dat assembler (generalised from a file tree). Computes the inode table,
// afid assignment, dirents, both flat-path tables, the afid_to_ino_table, per-file logical offsets and
// the data-first on-disk layout, then emits the metadata plaintext (via ProsperoPs5InnerMetadata) and
// the assembled inner image (via ProsperoPs5InnerImageBuilder).
//
// The file-tree model fixes inode order, afid order, dirent offsets, FLT entries, packed data offsets,
// store rules, data-first layout, and inner mount geometry (Ndblock / metadata-region base).
// ---------------------------------------------------------------------------------------------------
#nullable enable
using LibProsperoPkg.PFS.Compression;
using LibProsperoPkg.PFS.Compression.Oodle;
using LibProsperoPkg.PKG;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;

namespace LibProsperoPkg.PFS;

/// <summary>One regular file to place in the PS5 nwonly inner image.</summary>
public sealed class ProsperoPs5InnerFile
{
    /// <summary>Absolute path from the user root, e.g. <c>/sce_sys/keystone</c> or <c>/application.ps.bundle</c>.</summary>
    public required string Path { get; init; }

    /// <summary>The uncompressed file bytes.</summary>
    public required byte[] Data { get; init; }

    /// <summary>Optional source retained for the file-backed assembly path.</summary>
    internal Action<Stream>? WriteSource { get; init; }

    /// <summary>Original file path, when the source can be read directly without buffering.</summary>
    internal string? SourcePath { get; init; }

    /// <summary>Exact byte count produced by <see cref="WriteSource"/>.</summary>
    internal long SourceLength { get; init; }
}

/// <summary>
/// One explicit directory to preserve in the PS5 nwonly inner image.  This is primarily needed for
/// empty GP5 directories, which cannot be inferred from a flat file list.
/// </summary>
public sealed class ProsperoPs5InnerDirectory
{
    /// <summary>Absolute path from the user root, e.g. <c>/data/shaders</c>.</summary>
    public required string Path { get; init; }
}

/// <summary>The assembled inner image plus the intermediate model (for verification/diagnostics).</summary>
public sealed class ProsperoPs5InnerImageResult
{
    /// <summary>
    /// The on-disk inner <c>pfs_image.dat</c> bytes (data-first, per-file compressed).
    /// Empty for a result produced by a file-backed assembler overload.
    /// </summary>
    public required byte[] Image { get; init; }

    /// <summary>Physical image path for a file-backed result; otherwise <see langword="null"/>.</summary>
    public string? ImagePath { get; init; }

    /// <summary>Byte offset of the physical image within <see cref="ImagePath"/>.</summary>
    public long ImageOffset { get; init; }

    /// <summary>Exact block-aligned physical <c>pfs_image.dat</c> length.</summary>
    public required long ImageLength { get; init; }

    /// <summary>Opens the physical image without materializing it when this is a file-backed result.</summary>
    public Stream OpenImage()
    {
        if (ImagePath is not null)
        {
            var file = new FileStream(
                ImagePath, FileMode.Open, FileAccess.Read, FileShare.Read,
                bufferSize: 1 << 20, FileOptions.RandomAccess);
            return new Util.SubStream(file, ImageOffset, ImageLength, leaveOpen: false);
        }
        return new MemoryStream(Image, writable: false);
    }

    /// <summary>The uncompressed metadata-region plaintext (the block that is Kraken-compressed into the image tail).</summary>
    public required byte[] MetadataPlaintext { get; init; }

    /// <summary>The computed metadata nodes (inode order), for inspection.</summary>
    public required IReadOnlyList<ProsperoPs5MetaNode> Nodes { get; init; }

    /// <summary>The inner mount logical block count (superblock <c>Ndblock</c>).</summary>
    public required long Ndblock { get; init; }

    /// <summary>The per-file uncompressed logical start offsets, in afid order (the naps fidx values).</summary>
    public required IReadOnlyList<long> AfidLogicalOffsets { get; init; }

    /// <summary>
    /// Unreferenced FIDX boundaries emitted for zero-length files. Their inodes point at the common
    /// terminal FIDX entry, matching the publisher's empty-file representation.
    /// </summary>
    public IReadOnlyList<long> EmptyFileLogicalOffsets { get; init; } = Array.Empty<long>();

    /// <summary>Per-file on-disk/logical placement (afid order), for naps generation.</summary>
    public IReadOnlyList<ProsperoPs5InnerPlacement> Placements { get; init; } = Array.Empty<ProsperoPs5InnerPlacement>();

    /// <summary>
    /// Explicit empty AFID slots. Each slot covers one logical 256-KiB zero extent and is represented
    /// as <c>-1</c> in <c>afid_to_ino_table</c>.
    /// </summary>
    public IReadOnlyList<ProsperoPs5SparseAfidHole> SparseAfidHoles { get; init; } =
        Array.Empty<ProsperoPs5SparseAfidHole>();

    /// <summary>On-disk byte offset of the block-info table (block 75).</summary>
    public long BlockInfoOnDiskOffset { get; init; }

    /// <summary>On-disk byte offset of the Kraken-compressed metadata region.</summary>
    public long MetadataOnDiskOffset { get; init; }

    /// <summary>The Kraken-compressed metadata bytes (concatenated 256K blocks).</summary>
    public byte[] CompressedMetadata { get; init; } = Array.Empty<byte>();

    /// <summary>
    /// Per-256KiB-block chunk table of the compressed metadata region, captured once during assembly so
    /// the naps generator can read the chunk sizes WITHOUT Kraken-packing the metadata a second time.
    /// Empty when the metadata is stored raw (no compression).
    /// </summary>
    public IReadOnlyList<ProsperoInnerMetaBlockChunk> MetadataBlocks { get; init; } = Array.Empty<ProsperoInnerMetaBlockChunk>();

    /// <summary>Logical end of the packed data files (first fidx boundary after the last file).</summary>
    public long DataEndLogical { get; init; }

    /// <summary>Logical base of the metadata region in the mount (= Ndblock*64K - MetadataPlaintext.Length).</summary>
    public long MetaBaseLogical { get; init; }
}

/// <summary>One file's on-disk + logical placement in the assembled inner image (afid order).</summary>
public readonly struct ProsperoPs5InnerPlacement
{
    /// <summary>AFID slot used by the inode/FIDX tables.</summary>
    public uint Afid { get; init; }
    /// <summary>On-disk (compressed-image) byte offset.</summary>
    public long OnDiskOffset { get; init; }
    /// <summary>Uncompressed logical byte offset in the mount.</summary>
    public long LogicalOffset { get; init; }
    /// <summary>On-disk byte size (raw size when stored raw, else the Kraken payload size).</summary>
    public long OnDiskSize { get; init; }
    /// <summary>Uncompressed byte size.</summary>
    public long UncompressedSize { get; init; }
    /// <summary>
    /// Original uncompressed bytes. NAPS <c>ihsh</c> and <c>rhsh</c> are computed from this input,
    /// not from the Kraken stream stored in <c>pfs_image.dat</c>.
    /// </summary>
    public ReadOnlyMemory<byte> PlainData { get; init; }
    internal bool PlainDataStoredInImage { get; init; }
    internal string? PlainDataPath { get; init; }
    /// <summary>True when stored raw (block-split), false when Kraken-compressed.</summary>
    public bool StoreRaw { get; init; }

    /// <summary>Per-256 KiB Kraken/storage blocks when this file is stored compressed.</summary>
    public IReadOnlyList<ProsperoInnerDataBlockChunk>? CompressionBlocks { get; init; }
}

/// <summary>One intentionally empty AFID slot represented by a logical 256-KiB zero extent.</summary>
public readonly record struct ProsperoPs5SparseAfidHole(
    uint Afid, long LogicalOffset, long Size);

/// <summary>Compression geometry for one 256 KiB logical block of an inner payload file.</summary>
public readonly record struct ProsperoInnerDataBlockChunk(
    int CompressedSize, int UncompressedSize, bool IsStored,
    bool IsMultiChunk, int FirstChunkCompressedSize, int BoundaryFlags = 0);

/// <summary>One compressed-metadata 256KiB block's chunk sizes (for naps generation).</summary>
public readonly record struct ProsperoInnerMetaBlockChunk(
    int CompressedSize, int UncompressedSize, bool IsMultiChunk,
    int FirstChunkCompressedSize, int BoundaryFlags = 0);

/// <summary>
/// Builds a PS5 nwonly inner <c>pfs_image.dat</c> from a flat list of files. Handles the two flat-path
/// tables, the afid table, the data-first layout, and per-file Kraken compression.
/// </summary>
public sealed class ProsperoPs5InnerImageAssembler
{
    /// <summary>Inner-image block size (64 KiB).</summary>
    public const int BlockSize = 0x10000;

    // Keep the file-backed build's retained byte arrays and transient MemoryStream + ToArray peak
    // bounded. Files beyond this aggregate budget are copied straight into the physical image.
    private const long DefaultInMemoryBudget = 64L * 1024 * 1024;

    private const string SceSysDir = "sce_sys";

    private readonly long _timeSec;
    private readonly uint _timeNsec;
    private readonly IReadOnlyDictionary<string, uint>? _explicitAfids;
    private readonly Action<long,long>? _progress;

    /// <param name="buildTimeSec">Build timestamp seconds (package c_date/c_time — a deterministic build input).</param>
    /// <param name="buildTimeNsec">Build timestamp nanoseconds fraction.</param>
    /// <param name="explicitAfids">
    /// Optional exact path-to-AFID map. Unassigned slot numbers become sparse 256-KiB zero extents.
    /// </param>
    /// <param name="progress">Optional actual source-byte progress callback.</param>
    public ProsperoPs5InnerImageAssembler(
        long buildTimeSec,
        uint buildTimeNsec,
        IReadOnlyDictionary<string, uint>? explicitAfids = null,
        Action<long,long>? progress = null)
    {
        _timeSec = buildTimeSec;
        _timeNsec = buildTimeNsec;
        _explicitAfids = explicitAfids;
        _progress = progress;
    }

    // ---- Internal tree model -----------------------------------------------------------------------

    private sealed class Dir
    {
        public string Name = "";
        public string FullPath = "";      // "" for uroot
        public Dir? Parent;
        public readonly List<Dir> SubDirs = new();
        public readonly List<FileNode> Files = new();
        public uint Inode;
        public int DirentOffsetInParent = -1;
        public readonly List<PfsDirent> Dirents = new();
    }

    private sealed class FileNode
    {
        public string Name = "";
        public string FullPath = "";
        public byte[] Data = Array.Empty<byte>();
        public Action<Stream>? WriteSource;
        public string? SourcePath;
        public long Size;
        public Dir Parent = null!;
        public uint Inode;
        public uint Afid;
        public bool StoreRaw;
        public long LogicalOffset;
        public int DirentOffsetInParent = -1;

        /// <summary>The file's on-disk (data-region) byte offset in the built image (set during assembly).</summary>
        public long OnDiskOffset;
        public long OnDiskSize;

        /// <summary>The file's on-disk bytes (raw when StoreRaw, else the Kraken-compressed payload). Cached to
        /// avoid recompressing: it drives both the data-region geometry and the final image assembly.</summary>
        public byte[]? OnDiskData;

        /// <summary>Per-256 KiB compression geometry used directly by the NAPS CBI generator.</summary>
        public IReadOnlyList<ProsperoInnerDataBlockChunk> CompressionBlocks = Array.Empty<ProsperoInnerDataBlockChunk>();

        /// <summary>True for files in the sce_sys subtree. Drives the inode mode (base +0x20000) and the
        /// block-info Σ exclusion (sce_sys payload is not part of the uroot app-payload sum).</summary>
        public bool SceSys;

        /// <summary>True only for the DRM keystone, which is stored raw and occupies whole 64 KiB blocks
        /// (block-aligned start and end) so the packed data region begins on a fresh block after it. Other
        /// sce_sys payload files are Kraken-compressed and packed like app payload.</summary>
        public bool WholeBlockRaw;
    }

    /// <summary>
    /// Bridges the package builder's <see cref="FSDir"/> tree to the assembler: renders every file's
    /// bytes and its full path, then builds the data-first inner image. Convenience entry point for wiring the
    /// assembler into <c>ProsperoPkgBuilder</c> for the nwonly Kraken format.
    /// </summary>
    public ProsperoPs5InnerImageResult BuildFromFsTree(FSDir uroot)
    {
        RenderedFsTree tree = RenderFsTree(uroot, fileBacked: false, Array.MaxLength);
        return Build(tree.Files, tree.Directories);
    }

    /// <summary>
    /// File-backed counterpart of <see cref="BuildFromFsTree"/>. The final physical image is written
    /// directly to <paramref name="outputPath"/> and <see cref="ProsperoPs5InnerImageResult.Image"/>
    /// is empty; metadata and per-file integrity inputs remain available in the result.
    /// </summary>
    public ProsperoPs5InnerImageResult BuildFromFsTreeToFile(FSDir uroot, string outputPath)
        => BuildFromFsTreeToFile(uroot, outputPath, DefaultInMemoryBudget);

    internal ProsperoPs5InnerImageResult BuildFromFsTreeToFile(
        FSDir uroot, string outputPath, long inMemoryBudget)
        => BuildFromFsTreeToFileCore(uroot,outputPath,0,inMemoryBudget);

    internal ProsperoPs5InnerImageResult BuildFromFsTreeToFileAtOffset(
        FSDir uroot, string outputPath, long outputOffset)
        => BuildFromFsTreeToFileAtOffset(uroot, outputPath, outputOffset, DefaultInMemoryBudget);

    internal ProsperoPs5InnerImageResult BuildFromFsTreeToFileAtOffset(
        FSDir uroot, string outputPath, long outputOffset, long inMemoryBudget)
        => BuildFromFsTreeToFileCore(uroot,outputPath,outputOffset,inMemoryBudget);

    private ProsperoPs5InnerImageResult BuildFromFsTreeToFileCore(
        FSDir uroot,string outputPath,long outputOffset,long inMemoryBudget)
    {
        if (inMemoryBudget < 0)
            throw new ArgumentOutOfRangeException(nameof(inMemoryBudget));
        var total=uroot.GetAllChildrenFiles().Where(file=>!IsExcludedFromInner(file.FullPath())).Sum(file=>file.Size);long completed=0;
        void Advance(long count){completed=checked(completed+count);if(completed>total)throw new InvalidDataException("Inner sources exceeded their declared byte count.");_progress?.Invoke(completed,total);}
        _progress?.Invoke(0,total);
        RenderedFsTree tree = RenderFsTree(uroot, fileBacked: true, inMemoryBudget,Advance);
        string fullPath = Path.GetFullPath(outputPath);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath) ?? Directory.GetCurrentDirectory());
        var result=BuildCore(tree.Files, tree.Directories, fullPath, outputOffset,Advance);
        if(completed!=total)throw new InvalidDataException("Inner sources wrote a different byte count than declared.");
        return result;
    }

    private sealed record RenderedFsTree(
        IReadOnlyList<ProsperoPs5InnerFile> Files,
        IReadOnlyList<ProsperoPs5InnerDirectory> Directories);

    private static RenderedFsTree RenderFsTree(
        FSDir uroot, bool fileBacked, long inMemoryBudget,Action<long>? progress=null)
    {
        ArgumentNullException.ThrowIfNull(uroot);
        var files = new List<ProsperoPs5InnerFile>();
        long bufferedBytes = 0;
        foreach (var f in uroot.GetAllChildrenFiles())
        {
            if (IsExcludedFromInner(f.FullPath())) continue;
            if (fileBacked && (f.Size > inMemoryBudget - bufferedBytes))
            {
                files.Add(new ProsperoPs5InnerFile
                {
                    Path = f.FullPath(), Data = ReadPrefix(f),
                    WriteSource = f.Write, SourcePath = f.SourcePath, SourceLength = f.Size,
                });
                continue;
            }
            using var ms = new System.IO.MemoryStream();
            var destination=new BoundedWriteStream(ms,f.Size,progress);f.Write(destination);
            if(destination.Position!=f.Size||destination.Length!=f.Size)throw new InvalidDataException($"Inner source '{f.FullPath()}' wrote a different byte count than declared.");
            files.Add(new ProsperoPs5InnerFile
            {
                Path = f.FullPath(), Data = ms.ToArray(), SourceLength = f.Size,
            });
            bufferedBytes = checked(bufferedBytes + f.Size);
        }
        var directories = uroot.GetAllChildrenDirs()
            .Select(directory => new ProsperoPs5InnerDirectory { Path = directory.FullPath() })
            .ToList();
        return new RenderedFsTree(files, directories);
    }

    private sealed class PrefixCompleteException : Exception { }

    private sealed class PrefixStream(byte[] prefix) : Stream
    {
        private long _length;
        private long _position;

        public override bool CanRead => false;
        public override bool CanSeek => true;
        public override bool CanWrite => true;
        public override long Length => _length;
        public override long Position
        {
            get => _position;
            set => _position = value >= 0 ? value : throw new ArgumentOutOfRangeException(nameof(value));
        }

        public override void Flush() { }
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin)
        {
            long position = origin switch
            {
                SeekOrigin.Begin => offset,
                SeekOrigin.Current => checked(_position + offset),
                SeekOrigin.End => checked(_length + offset),
                _ => throw new ArgumentOutOfRangeException(nameof(origin)),
            };
            Position = position;
            return position;
        }
        public override void SetLength(long value)
        {
            if (value < 0) throw new ArgumentOutOfRangeException(nameof(value));
            _length = value;
        }
        public override void Write(byte[] buffer, int offset, int count) =>
            Write(buffer.AsSpan(offset, count));
        public override void Write(ReadOnlySpan<byte> buffer)
        {
            if (_position < prefix.Length)
            {
                int count = checked((int)Math.Min(buffer.Length, prefix.Length - _position));
                buffer[..count].CopyTo(prefix.AsSpan(checked((int)_position), count));
            }
            _position = checked(_position + buffer.Length);
            _length = Math.Max(_length, _position);
            if (_position >= prefix.Length)
                throw new PrefixCompleteException();
        }
    }

    private static byte[] ReadPrefix(FSFile file)
    {
        var prefix = new byte[checked((int)Math.Min(4, file.Size))];
        if (prefix.Length == 0) return prefix;
        if (file.SourcePath is not null)
        {
            using var input = new FileStream(
                file.SourcePath, FileMode.Open, FileAccess.Read, FileShare.Read,
                bufferSize: 4096, FileOptions.SequentialScan);
            input.ReadExactly(prefix);
            return prefix;
        }
        try
        {
            file.Write(new PrefixStream(prefix));
        }
        catch (PrefixCompleteException)
        {
            // Expected: stop a potentially multi-gigabyte writer as soon as its magic is known.
        }
        return prefix;
    }

    private static (long StoredSize, IReadOnlyList<ProsperoInnerDataBlockChunk> Blocks)
        WriteCompressedSource(
            string sourcePath, long sourceLength, Stream destination, long destinationOffset,
            Action<long>? progress)
    {
        const int blockSize = ProsperoPs5InnerImageBuilder.CompressBlockSize;
        int batchSize = Math.Max(1, Math.Min(Environment.ProcessorCount, 8));
        var inputBlocks = Enumerable.Range(0, batchSize)
            .Select(_ => new byte[blockSize])
            .ToArray();
        var inputLengths = new int[batchSize];
        var encodedBlocks = new EncodedBlock?[batchSize];
        var geometry = new List<ProsperoInnerDataBlockChunk>(
            checked((int)((sourceLength + blockSize - 1) / blockSize)));

        using var input = new FileStream(
            sourcePath, FileMode.Open, FileAccess.Read, FileShare.Read,
            bufferSize: 1 << 20, FileOptions.SequentialScan);
        if (input.Length != sourceLength)
            throw new InvalidDataException($"Inner source '{sourcePath}' changed size before compression.");

        destination.Position = destinationOffset;
        long consumed = 0;
        long stored = 0;
        while (consumed < sourceLength)
        {
            int count = 0;
            while (count < batchSize && consumed < sourceLength)
            {
                int length = checked((int)Math.Min(blockSize, sourceLength - consumed));
                input.ReadExactly(inputBlocks[count].AsSpan(0, length));
                inputLengths[count] = length;
                encodedBlocks[count] = null;
                consumed += length;
                progress?.Invoke(length);
                count++;
            }

            System.Threading.Tasks.Parallel.For(0, count, i =>
            {
                encodedBlocks[i] = OodleKrakenEncoder.EncodeBlock(
                    inputBlocks[i].AsSpan(0, inputLengths[i]),
                    useHuffmanArrays: true,
                    compressionLevel: 7);
            });

            for (int i = 0; i < count; i++)
            {
                int plainSize = inputLengths[i];
                if (encodedBlocks[i] is EncodedBlock encoded && encoded.Payload.Length < plainSize)
                {
                    destination.Write(encoded.Payload);
                    stored = checked(stored + encoded.Payload.LongLength);
                    geometry.Add(new ProsperoInnerDataBlockChunk(
                        encoded.Payload.Length, plainSize, false,
                        encoded.MultiChunk, encoded.FirstChunkCompSize, encoded.BoundaryFlags));
                }
                else
                {
                    destination.Write(inputBlocks[i].AsSpan(0, plainSize));
                    stored = checked(stored + plainSize);
                    geometry.Add(new ProsperoInnerDataBlockChunk(
                        plainSize, plainSize, true, false, 0));
                }
            }
        }

        if (stored <= ((sourceLength * 15) >> 4))
            return (stored, geometry);

        input.Position = 0;
        destination.Position = destinationOffset;
        var copyBuffer = new byte[1 << 20];
        long copied = 0;
        while (copied < sourceLength)
        {
            int count = input.Read(copyBuffer, 0, checked((int)Math.Min(copyBuffer.Length, sourceLength - copied)));
            if (count == 0)
                throw new EndOfStreamException($"Inner source '{sourcePath}' ended during raw fallback.");
            destination.Write(copyBuffer, 0, count);
            copied += count;
        }
        return (sourceLength, Array.Empty<ProsperoInnerDataBlockChunk>());
    }

    private sealed class BoundedWriteStream(Stream source, long maximumLength,Action<long>? progress=null) : Stream
    {
        public override bool CanRead => false;
        public override bool CanSeek => true;
        public override bool CanWrite => true;
        public override long Length => source.Length;
        public override long Position
        {
            get => source.Position;
            set
            {
                if (value < 0 || value > maximumLength)
                    throw new IOException("A file source attempted to seek outside its declared extent.");
                source.Position = value;
            }
        }

        public override void Flush() => source.Flush();
        public override int Read(byte[] buffer, int offset, int count) => throw new NotSupportedException();
        public override long Seek(long offset, SeekOrigin origin)
        {
            long position = origin switch
            {
                SeekOrigin.Begin => offset,
                SeekOrigin.Current => checked(Position + offset),
                SeekOrigin.End => checked(Length + offset),
                _ => throw new ArgumentOutOfRangeException(nameof(origin)),
            };
            Position = position;
            return position;
        }
        public override void SetLength(long value)
        {
            if (value < 0 || value > maximumLength)
                throw new IOException("A file source attempted to resize beyond its declared extent.");
            source.SetLength(value);
        }
        public override void Write(byte[] buffer, int offset, int count) =>
            Write(buffer.AsSpan(offset, count));
        public override void Write(ReadOnlySpan<byte> buffer)
        {
            if (Position > maximumLength - buffer.Length)
                throw new IOException("A file source wrote beyond its declared extent.");
            source.Write(buffer);
            progress?.Invoke(buffer.Length);
        }
    }

    // A sce_sys file whose sce_sys-relative name is a known outer-CNT entry is carried in the OUTER
    // container, not the inner image. The rule extends the standard inner-PFS builder
    // (ProsperoPfsBuilder) with param.json (CNT id 0x2000, emitted as its own outer entry and therefore
    // absent from NameToId). Files without CNT ids stay in the inner uroot alongside the app payload.
    private static bool IsExcludedFromInner(string fullPath)
    {
        const string prefix = "/sce_sys/";
        if (!fullPath.StartsWith(prefix, StringComparison.Ordinal)) return false;
        string rel = fullPath.Substring(prefix.Length);
        // pic2.png uses the late 0x2040 media id and is intentionally outside the older
        // EntryNames table, but it follows the same CNT-only policy as pic0/pic1.
        return rel is "param.json" or "pic2.png" ||
               PKG.EntryNames.NameToId.ContainsKey(rel);
    }

    /// <summary>Assembles the inner image from the supplied files.</summary>
    public ProsperoPs5InnerImageResult Build(IReadOnlyList<ProsperoPs5InnerFile> files)
        => BuildCore(files, directories: null, outputPath: null);

    /// <summary>
    /// Assembles the inner image from files and an explicit directory list.  Parent directories may
    /// be omitted because they are inferred; explicitly listed empty leaf directories are retained.
    /// </summary>
    public ProsperoPs5InnerImageResult Build(
        IReadOnlyList<ProsperoPs5InnerFile> files,
        IReadOnlyList<ProsperoPs5InnerDirectory> directories)
        => BuildCore(files, directories, outputPath: null);

    /// <summary>Assembles the inner image directly into a file without retaining its full bytes.</summary>
    public ProsperoPs5InnerImageResult BuildToFile(
        IReadOnlyList<ProsperoPs5InnerFile> files, string outputPath)
        => BuildToFile(files, directories: null, outputPath);

    /// <summary>
    /// File-backed counterpart accepting explicit directories, including empty GP5 directories.
    /// </summary>
    public ProsperoPs5InnerImageResult BuildToFile(
        IReadOnlyList<ProsperoPs5InnerFile> files,
        IReadOnlyList<ProsperoPs5InnerDirectory>? directories,
        string outputPath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);
        string fullPath = Path.GetFullPath(outputPath);
        Directory.CreateDirectory(Path.GetDirectoryName(fullPath) ?? Directory.GetCurrentDirectory());
        return BuildCore(files, directories, fullPath);
    }

    private ProsperoPs5InnerImageResult BuildCore(
        IReadOnlyList<ProsperoPs5InnerFile> files,
        IReadOnlyList<ProsperoPs5InnerDirectory>? directories,
        string? outputPath,
        long outputOffset = 0,
        Action<long>? progress = null)
    {
        ArgumentNullException.ThrowIfNull(files);
        if (files.Count == 0)
            throw new ArgumentException("At least one inner file is required.", nameof(files));
        if (outputPath is null && files.Any(file => file.WriteSource is not null))
            throw new ArgumentException(
                "File-backed inner sources require BuildToFile.", nameof(files));
        if (outputOffset < 0 || outputOffset % BlockSize != 0 ||
            (outputPath is null && outputOffset != 0))
            throw new ArgumentOutOfRangeException(
                nameof(outputOffset), "The output offset must be a non-negative 64-KiB boundary.");

        Dir uroot = BuildTree(files, directories);

        // ---- 1. Assign inodes. ---------------------------------------------------------------------
        // 0 = super-root, 1..3 = the three internal metadata files, 4 = uroot, then sub-directories in
        // pre-order DFS, then regular files grouped by directory in *reverse* directory-inode order
        // (deepest-assigned directory's files first), ordinal within a directory.
        var dirsPreOrder = new List<Dir>();
        CollectDirsPreOrder(uroot, dirsPreOrder); // uroot first, then descendants pre-order

        uint next = 0;
        var superRootInode = next++;      // 0
        var inodeFltInode = next++;       // 1
        var aprFltInode = next++;         // 2
        var afidTableInode = next++;      // 3
        foreach (var d in dirsPreOrder)   // uroot=4, subdirs...
            d.Inode = next++;

        // Files: directories in POST-ORDER DFS (deepest-first, siblings ordinal), files ordinal within each.
        // (For a linear chain — e.g. nwonly's uroot/sce_sys/about — post-order == reverse pre-order, but for a
        // branching tree they differ; post-order is the general rule.)
        var dirsPostOrder = new List<Dir>();
        CollectDirsPostOrder(uroot, dirsPostOrder);
        var fileNodes = new List<FileNode>();
        foreach (var d in dirsPostOrder)
            foreach (var f in d.Files.OrderBy(f => f.Name, StringComparer.Ordinal))
            {
                f.Inode = next++;
                fileNodes.Add(f);
            }

        // ---- 2. Assign afids. ----------------------------------------------------------------------
        // sce_sys subtree files first, then the remaining uroot files. Publisher GD/App gives its raw
        // bootstrap material a fixed leading order: keystone, executable modules (right.sprx, etc.),
        // other system payload, and finally pfs-version.dat. This keeps each raw module on its own
        // physical block and matches the observed FIDX/CBI order.
        var afidOrder = new List<FileNode>();
        Dir? sceSys = uroot.SubDirs.FirstOrDefault(d => d.Name == SceSysDir);
        if (sceSys != null)
        {
            var systemFiles = new List<FileNode>();
            CollectFilesPreOrder(sceSys, systemFiles);
            afidOrder.AddRange(systemFiles
                .OrderBy(SystemAfidRank)
                .ThenBy(f => f.FullPath, StringComparer.Ordinal));
        }
        // Outside sce_sys the publisher walks the merged directory-entry namespace in ordinal
        // order. A directory is recursed when its name is encountered among sibling files. Thus a
        // data/{aaa-dir,edge.bin,zzz-dir} tree places aaa-dir/*, edge.bin, zzz-dir/* in that order.
        // Inode numbering remains the independent post-order rule above.
        CollectFilesEntryOrder(uroot, sceSys, afidOrder);
        // Zero-length files retain inode/dirent metadata but do not consume a normal AFID/FIDX data
        // slot. Their inode points at the common terminal FIDX marker assigned below.
        List<FileNode> emptyFiles = afidOrder
            .Where(file => file.Size == 0)
            .ToList();
        afidOrder.RemoveAll(file => file.Size == 0);

        List<FileNode?> afidSlots;
        if (_explicitAfids is null)
        {
            // The publisher does not leave a very dense sequence of tiny AFID files packed into one
            // logical 256-KiB window. U2C stores seven CblockInfo deltas relative to one base as u8,
            // so at most 255 CBI records may begin across each group of eight logical windows.
            //
            // Real large APP corpora implement this by inserting empty AFID slots. Every slot advances
            // the logical stream by exactly 0x40000 and later becomes the shared 16-byte zero token.
            // Minecraft's native image starts with holes 28,59,90,121,152...: the first window admits
            // 28 AFID starts (two later non-AFID FIDX boundaries consume the reserve), following
            // windows admit 30. Large files naturally advance to a new window and reset the budget.
            // This keeps generated U2C deltas representable without requiring a captured AFID map.
            const int FirstWindowAfidStarts = 28;
            const int LaterWindowAfidStarts = 30;
            const long NapsWindow = 0x40000;
            afidSlots = [];
            long predictedLogicalOffset = 0;
            long currentWindow = -1;
            int startsInWindow = 0;
            foreach (FileNode file in afidOrder)
            {
                long window = predictedLogicalOffset / NapsWindow;
                if (window != currentWindow)
                {
                    currentWindow = window;
                    startsInWindow = 0;
                }
                int limit = currentWindow == 0
                    ? FirstWindowAfidStarts
                    : LaterWindowAfidStarts;
                if (startsInWindow >= limit)
                {
                    afidSlots.Add(null);
                    predictedLogicalOffset = checked(predictedLogicalOffset + NapsWindow);
                    currentWindow = predictedLogicalOffset / NapsWindow;
                    startsInWindow = 0;
                }

                file.Afid = checked((uint)afidSlots.Count);
                afidSlots.Add(file);
                predictedLogicalOffset = checked(
                    predictedLogicalOffset + file.Size);
                startsInWindow++;
            }
        }
        else
        {
            var normalized = new Dictionary<string, uint>(StringComparer.Ordinal);
            foreach ((string path, uint afid) in _explicitAfids)
            {
                string normalizedPath = NormalizeAfidPath(path);
                if (!normalized.TryAdd(normalizedPath, afid))
                    throw new InvalidDataException(
                        $"The explicit AFID map contains duplicate path '{normalizedPath}'.");
            }
            if (normalized.Count != afidOrder.Count)
                throw new InvalidDataException(
                    $"The explicit AFID map contains {normalized.Count} paths but the inner image " +
                    $"contains {afidOrder.Count} files.");

            uint maxAfid = 0;
            foreach (FileNode file in afidOrder)
            {
                if (!normalized.TryGetValue(file.FullPath, out uint afid))
                    throw new InvalidDataException(
                        $"The explicit AFID map has no assignment for '{file.FullPath}'.");
                file.Afid = afid;
                maxAfid = Math.Max(maxAfid, afid);
            }
            if (afidOrder.Count == 0)
            {
                afidSlots = [];
            }
            else
            {
                const uint MaxSupportedAfid = 10_000_000;
                if (maxAfid > MaxSupportedAfid)
                    throw new InvalidDataException(
                        $"The explicit AFID map requires slot {maxAfid}, exceeding the supported " +
                        $"{MaxSupportedAfid}-slot diagnostic limit.");
                afidSlots = Enumerable.Repeat<FileNode?>(
                    null, checked((int)maxAfid + 1)).ToList();
                foreach (FileNode file in afidOrder)
                {
                    if (afidSlots[(int)file.Afid] is not null)
                        throw new InvalidDataException(
                            $"The explicit AFID map assigns slot {file.Afid} more than once.");
                    afidSlots[(int)file.Afid] = file;
                }
            }
        }
        afidOrder = afidSlots
            .Where(file => file is not null)
            .Select(file => file!)
            .ToList();

        static string NormalizeAfidPath(string path)
        {
            ArgumentException.ThrowIfNullOrWhiteSpace(path);
            string normalized = path.Trim().Replace('\\', '/');
            return normalized.StartsWith('/') ? normalized : "/" + normalized;
        }

        static int SystemAfidRank(FileNode file)
        {
            if (IsKeystone(file.FullPath)) return 0;
            if (IsExecutableModule(file.Data)) return 1;
            if (file.FullPath.Equals("/sce_sys/pfs-version.dat", StringComparison.Ordinal)) return 3;
            return 2;
        }

        // ---- 3. Logical offsets (packed, in afid order) + store rule. -----------------------------
        long cursor = 0;
        long[] afidOffsets = [];
        var sparseAfidHoles = new List<ProsperoPs5SparseAfidHole>();
        void AssignLogicalLayout()
        {
            cursor = 0;
            afidOffsets = new long[afidSlots.Count];
            sparseAfidHoles.Clear();
            for (int afid = 0; afid < afidSlots.Count; afid++)
            {
                FileNode? file = afidSlots[afid];
                afidOffsets[afid] = cursor;
                if (file is null)
                {
                    sparseAfidHoles.Add(new ProsperoPs5SparseAfidHole(
                        checked((uint)afid), cursor, 0x40000));
                    cursor = checked(cursor + 0x40000);
                    continue;
                }
                file.Afid = checked((uint)afid);
                file.LogicalOffset = cursor;
                cursor = checked(cursor + file.Size);
            }
            uint terminalAfid = checked(
                (uint)afidSlots.Count + (uint)emptyFiles.Count + 1);
            foreach (FileNode emptyFile in emptyFiles)
            {
                emptyFile.Afid = terminalAfid;
                emptyFile.LogicalOffset = cursor;
            }
        }
        AssignLogicalLayout();

        long fileBackedDataEnd = 0;
        FileStream? fileBackedData = outputPath is null
            ? null
            : new FileStream(
                outputPath, FileMode.Create, FileAccess.ReadWrite, FileShare.None,
                bufferSize: 1 << 20, FileOptions.SequentialScan);
        try
        {
            foreach (FileNode f in afidOrder)
            {
                // Keystone and executable modules are stored raw; every other file is Kraken-compressed and
                // packed unless the compressed result does not save at least the store threshold. Compress once
                // and reuse it so the data-region geometry and the final image share a single compression pass.
                if (f.WriteSource is not null || IsKeystone(f.FullPath) || IsExecutableModule(f.Data))
                {
                    f.StoreRaw = true;
                    f.OnDiskData = f.WriteSource is null ? f.Data : null;
                }
                else
                {
                    byte[] comp = ProsperoPs5InnerImageBuilder.CompressPayload(
                        f.Data, storeRaw: false, out ProsperoCompressedPfsFile? compressedFile);
                    f.StoreRaw = comp.Length >= f.Data.Length; // CompressPayload returns raw when it does not help
                    f.OnDiskData = f.StoreRaw ? f.Data : comp;
                    if (compressedFile is not null)
                        f.CompressionBlocks = compressedFile.Blocks.Select(b => new ProsperoInnerDataBlockChunk(
                            b.CompressedSize, b.UncompressedSize, b.IsStored,
                            b.IsMultiChunk, b.FirstChunkCompressedSize, b.Flags)).ToList();
                }
                f.SceSys = f.FullPath.StartsWith("/sce_sys/", StringComparison.Ordinal);
                // Publisher places every forced-raw bootstrap payload in a complete physical extent.
                // The following file starts at the next 64-KiB boundary; opportunistically stored
                // (incompressible) ordinary files do not get this padding.
                f.WholeBlockRaw = IsKeystone(f.FullPath) || IsExecutableModule(f.Data);

                if (fileBackedData is not null)
                {
                    bool alignBefore = f.WholeBlockRaw;
                    if (alignBefore)
                        fileBackedDataEnd = RoundUp(fileBackedDataEnd, BlockSize);
                    f.OnDiskOffset = fileBackedDataEnd;
                    fileBackedData.Position = checked(outputOffset + fileBackedDataEnd);
                    if (f.SourcePath is not null && !f.WholeBlockRaw)
                    {
                        (f.OnDiskSize, f.CompressionBlocks) = WriteCompressedSource(
                            f.SourcePath, f.Size, fileBackedData,
                            checked(outputOffset + fileBackedDataEnd), progress);
                        f.StoreRaw = f.CompressionBlocks.Count == 0;
                    }
                    else if (f.WriteSource is not null)
                    {
                        var destination = new BoundedWriteStream(
                            new Util.OffsetStream(fileBackedData, checked(outputOffset + fileBackedDataEnd)), f.Size,progress);
                        destination.Position = 0;
                        f.WriteSource(destination);
                        if (destination.Position != f.Size || destination.Length != f.Size)
                            throw new InvalidDataException($"Inner source '{f.FullPath}' wrote a different byte count than declared.");
                        f.OnDiskSize = f.Size;
                    }
                    else
                    {
                        byte[] onDisk = f.OnDiskData!;
                        fileBackedData.Write(onDisk);
                        f.OnDiskSize = onDisk.LongLength;
                    }
                    fileBackedDataEnd = checked(fileBackedDataEnd + f.OnDiskSize);
                    if (f.WholeBlockRaw)
                        fileBackedDataEnd = RoundUp(fileBackedDataEnd, BlockSize);
                    f.OnDiskData = null;
                }
            }
        }
        finally
        {
            if (fileBackedData is not null)
            {
                fileBackedData.SetLength(checked(outputOffset + fileBackedDataEnd));
                fileBackedData.Flush(flushToDisk: true);
                fileBackedData.Dispose();
            }
        }

        // ---- 4-8. Build metadata/image, then prove the exact NAPS u2c layout is representable. ----
        const long NapsLogicalBlockSize = 0x40000;
        BuildDirents(uroot);
        int layoutRepairs = 0;
        while (true)
        {
            long logicalDataBlocks =
                RoundUp(Math.Max(cursor, 1), NapsLogicalBlockSize) / BlockSize;
            List<byte[]> metadataPayloads = BuildMetadataPayloads(
                dirsPreOrder, fileNodes, afidSlots,
                inodeFltInode, aprFltInode, afidTableInode, uroot);
            var nodes = BuildNodes(uroot, dirsPreOrder, fileNodes, logicalDataBlocks,
                superRootInode, inodeFltInode, aprFltInode, afidTableInode,
                metadataPayloads, out long ndblock, out int trailingMetadataBlocks);
            byte[] metaPlain = BuildMetadataPlaintext(
                nodes, metadataPayloads, ndblock, trailingMetadataBlocks);
            byte[] image = BuildImage(
                afidOrder, metaPlain, cursor, outputPath, outputOffset, fileBackedDataEnd,
                out long imageLength, out long blockInfoOnDisk, out long metadataOnDisk,
                out byte[] compressedMeta, out var metaBlocks);
            long metaBaseLogical =
                ndblock * ProsperoPs5InnerImageBuilder.BlockSize - metaPlain.Length;
            var placements = afidOrder.Select(f => new ProsperoPs5InnerPlacement
            {
                Afid = f.Afid,
                OnDiskOffset = f.OnDiskOffset,
                LogicalOffset = f.LogicalOffset,
                OnDiskSize = f.OnDiskSize,
                UncompressedSize = f.Size,
                PlainData = f.Data,
                PlainDataStoredInImage = f.WriteSource is not null && f.StoreRaw,
                PlainDataPath = f.StoreRaw ? null : f.SourcePath,
                StoreRaw = f.StoreRaw,
                CompressionBlocks = f.CompressionBlocks,
            }).ToList();
            var result = new ProsperoPs5InnerImageResult
            {
                Image = image,
                ImagePath = outputPath,
                ImageOffset = outputOffset,
                ImageLength = imageLength,
                MetadataPlaintext = metaPlain,
                Nodes = nodes,
                Ndblock = ndblock,
                AfidLogicalOffsets = afidOffsets,
                EmptyFileLogicalOffsets = emptyFiles
                    .Select(file => file.LogicalOffset)
                    .ToArray(),
                Placements = placements,
                SparseAfidHoles = sparseAfidHoles.ToArray(),
                BlockInfoOnDiskOffset = blockInfoOnDisk,
                MetadataOnDiskOffset = metadataOnDisk,
                CompressedMetadata = compressedMeta,
                MetadataBlocks = metaBlocks,
                DataEndLogical = cursor,
                MetaBaseLogical = metaBaseLogical,
            };

            try
            {
                _ = ProsperoNwonlyNapsGenerator.Generate(result);
                return result;
            }
            catch (NapsU2cOverflowException overflow) when (_explicitAfids is null)
            {
                long pivot = Math.Max(
                    overflow.GroupStartLogicalOffset,
                    overflow.TargetLogicalOffset - NapsLogicalBlockSize);
                int insertAt = afidSlots.FindIndex(slot =>
                    slot is FileNode file &&
                    file.LogicalOffset >= pivot &&
                    file.LogicalOffset < overflow.TargetLogicalOffset);
                if (insertAt < 0)
                    insertAt = afidSlots.FindIndex(slot =>
                        slot is FileNode file &&
                        file.LogicalOffset >= overflow.GroupStartLogicalOffset &&
                        file.LogicalOffset < overflow.TargetLogicalOffset);
                if (insertAt < 0 || ++layoutRepairs > afidOrder.Count + 64)
                    throw;
                afidSlots.Insert(insertAt, null);
                AssignLogicalLayout();
            }
            catch (NapsU2cOverflowException overflow)
            {
                throw new NotSupportedException(
                    "The explicit publisher AFID map produces an unrepresentable NAPS u2c layout.",
                    overflow);
            }
        }
    }

    // ---- Tree construction -------------------------------------------------------------------------

    private static Dir BuildTree(
        IReadOnlyList<ProsperoPs5InnerFile> files,
        IReadOnlyList<ProsperoPs5InnerDirectory>? directories)
    {
        var uroot = new Dir { Name = "uroot", FullPath = "" };
        var dirLookup = new Dictionary<string, Dir>(StringComparer.Ordinal) { [""] = uroot };

        Dir GetDir(string fullPath)
        {
            if (dirLookup.TryGetValue(fullPath, out var d)) return d;
            int slash = fullPath.LastIndexOf('/');
            string parentPath = slash <= 0 ? "" : fullPath[..slash];
            string name = fullPath[(slash + 1)..];
            Dir parent = GetDir(parentPath);
            var dir = new Dir { Name = name, FullPath = fullPath, Parent = parent };
            parent.SubDirs.Add(dir);
            dirLookup[fullPath] = dir;
            return dir;
        }

        // A metadata-only AC always contains /uroot/data.  APP images, however, omit the directory
        // when they have no data payload; a root eboot.bin distinguishes that profile.  A non-empty
        // APP data directory is created naturally by the file loop below.
        bool isApplication = files.Any(file =>
            file.Path.Replace('\\', '/').TrimStart('/')
                .Equals("eboot.bin", StringComparison.Ordinal));
        if (!isApplication)
            _ = GetDir("data");

        if (directories is not null)
        {
            foreach (ProsperoPs5InnerDirectory directory in directories
                         .OrderBy(directory => directory.Path, StringComparer.Ordinal))
            {
                ArgumentException.ThrowIfNullOrWhiteSpace(directory.Path);
                string path = directory.Path.Replace('\\', '/').Trim('/');
                if (path.Length != 0)
                    _ = GetDir(path);
            }
        }

        foreach (var f in files.OrderBy(f => f.Path, StringComparer.Ordinal))
        {
            string path = f.Path.StartsWith('/') ? f.Path[1..] : f.Path;
            int slash = path.LastIndexOf('/');
            string dirPath = slash < 0 ? "" : path[..slash];
            string name = slash < 0 ? path : path[(slash + 1)..];
            Dir parent = GetDir(dirPath);
            parent.Files.Add(new FileNode
            {
                Name = name,
                FullPath = "/" + path,
                Data = f.Data,
                WriteSource = f.WriteSource,
                SourcePath = f.SourcePath,
                Size = f.WriteSource is null ? f.Data.LongLength : f.SourceLength,
                Parent = parent,
            });
        }
        return uroot;
    }

    private static void CollectDirsPreOrder(Dir dir, List<Dir> outList)
    {
        outList.Add(dir);
        foreach (var d in dir.SubDirs.OrderBy(d => d.Name, StringComparer.Ordinal))
            CollectDirsPreOrder(d, outList);
    }

    private static void CollectDirsPostOrder(Dir dir, List<Dir> outList)
    {
        foreach (var d in dir.SubDirs.OrderBy(d => d.Name, StringComparer.Ordinal))
            CollectDirsPostOrder(d, outList);
        outList.Add(dir);
    }

    private static void CollectFilesPreOrder(Dir dir, List<FileNode> outList)
    {
        foreach (var f in dir.Files.OrderBy(f => f.Name, StringComparer.Ordinal))
            outList.Add(f);
        foreach (var d in dir.SubDirs.OrderBy(d => d.Name, StringComparer.Ordinal))
            CollectFilesPreOrder(d, outList);
    }

    private static void CollectFilesEntryOrder(
        Dir directory,
        Dir? excludedSubtree,
        List<FileNode> outList)
    {
        IEnumerable<(string Name, Dir? Directory, FileNode? File)> entries =
            directory.SubDirs
                .Where(child => child != excludedSubtree && !IsUnder(child, excludedSubtree))
                .Select(child => (child.Name, (Dir?)child, (FileNode?)null))
                .Concat(directory.Files.Select(file => (file.Name, (Dir?)null, (FileNode?)file)))
                .OrderBy(entry => entry.Name, StringComparer.Ordinal);
        foreach ((_, Dir? child, FileNode? file) in entries)
        {
            if (file is not null)
                outList.Add(file);
            else if (child is not null)
                CollectFilesEntryOrder(child, excludedSubtree, outList);
        }
    }

    private static bool IsUnder(Dir dir, Dir? ancestor)
    {
        if (ancestor == null) return false;
        for (Dir? d = dir; d != null; d = d.Parent)
            if (d == ancestor) return true;
        return false;
    }

    private static bool IsKeystone(string fullPath) =>
        string.Equals(fullPath, "/sce_sys/keystone", StringComparison.Ordinal);

    // Executable modules are stored raw (uncompressed) in the nwonly inner. The console memory-maps
    // modules directly, so compression is skipped. Detected by container magic: plaintext SELF
    // (0x1D3D154F), module container (0xEEF51454), or raw executable image (0x464C457F).
    private static bool IsExecutableModule(byte[] data)
    {
        if (data.Length < 4) return false;
        uint magic = (uint)(data[0] | (data[1] << 8) | (data[2] << 16) | (data[3] << 24));
        return magic is 0x1D3D154F or 0xEEF51454 or 0x464C457F;
    }

    // ---- Dirents -----------------------------------------------------------------------------------

    private static void BuildDirents(Dir uroot)
    {
        // super-root's children (the three tables + uroot) get no dirent-offset (ParentInode == -1).
        // Every ordinary directory's dirent block is: ".", "..", sub-directories (ordinal), files (ordinal).
        BuildDirentsRecursive(uroot, isUroot: true);
    }

    private static void BuildDirentsRecursive(Dir dir, bool isUroot)
    {
        dir.Dirents.Clear();
        // "." -> self, ".." -> parent (uroot's parent is itself).
        dir.Dirents.Add(new PfsDirent { Name = ".", InodeNumber = dir.Inode, Type = DirentType.Dot });
        uint parentIno = dir.Parent?.Inode ?? dir.Inode;
        dir.Dirents.Add(new PfsDirent { Name = "..", InodeNumber = parentIno, Type = DirentType.DotDot });

        foreach (var d in dir.SubDirs.OrderBy(d => d.Name, StringComparer.Ordinal))
            dir.Dirents.Add(new PfsDirent { Name = d.Name, InodeNumber = d.Inode, Type = DirentType.Directory });
        foreach (var f in dir.Files.OrderBy(f => f.Name, StringComparer.Ordinal))
            dir.Dirents.Add(new PfsDirent { Name = f.Name, InodeNumber = f.Inode, Type = DirentType.File });

        // A dirent may not straddle a 64-KiB directory block. Publisher consumes the unused tail
        // by enlarging the preceding record's EntSize, so the next record begins at the following
        // block. Without this rule a dense directory is readable until the first crossing and then
        // the reader interprets the second half of a name as a new header.
        int off = 0;
        var byName = new Dictionary<string, int>(StringComparer.Ordinal);
        for (int i = 0; i < dir.Dirents.Count; i++)
        {
            PfsDirent e = dir.Dirents[i];
            int inBlock = off % BlockSize;
            int remaining = BlockSize - inBlock;
            if (inBlock != 0 && e.EntSize > remaining)
            {
                if (i == 0)
                    throw new InvalidDataException("The first directory entry exceeds one block.");
                dir.Dirents[i - 1].EntSize = checked(
                    dir.Dirents[i - 1].EntSize + remaining);
                off = checked(off + remaining);
            }
            byName[e.Name] = off;
            off = checked(off + e.EntSize);
        }
        foreach (var d in dir.SubDirs)
            d.DirentOffsetInParent = byName[d.Name];
        foreach (var f in dir.Files)
            f.DirentOffsetInParent = byName[f.Name];

        foreach (var d in dir.SubDirs.OrderBy(d => d.Name, StringComparer.Ordinal))
            BuildDirentsRecursive(d, isUroot: false);
    }

    // ---- Node model + geometry ---------------------------------------------------------------------

    private List<ProsperoPs5MetaNode> BuildNodes(
        Dir uroot, List<Dir> dirsPreOrder, List<FileNode> fileNodes, long logicalDataBlocks,
        uint superRootInode, uint inodeFltInode, uint aprFltInode, uint afidTableInode,
        IReadOnlyList<byte[]> metadataPayloads, out long ndblock,
        out int trailingMetadataBlocks)
    {
        if (metadataPayloads.Count != 4 + dirsPreOrder.Count)
            throw new InvalidDataException("Inner metadata payload count does not match the filesystem tree.");

        static int PayloadBlocks(byte[] payload) =>
            Math.Max(1, checked((payload.Length + BlockSize - 1) / BlockSize));
        int metadataDataBlocks = metadataPayloads.Sum(PayloadBlocks);
        int inodeCount = checked(4 + dirsPreOrder.Count + fileNodes.Count);
        int inodeBlocks = checked(
            (inodeCount + ProsperoPs5InnerMetadata.InodesPerBlock - 1) /
            ProsperoPs5InnerMetadata.InodesPerBlock);
        // The reference data-first image keeps 60 logical blocks between the aligned end of the
        // AFID file extents and the superblock. Metadata consists of the superblock, the block-packed
        // inode table and the variable payload extents, padded to an even count of 64-KiB blocks.
        // Thus a minimal AC base of nine blocks gets one reserved block, while an APP with four
        // directories already occupies ten and gets none.
        const long MetadataReserveBlocks = 60;
        int metadataBaseBlocks = checked(
            1 /* superblock */ + inodeBlocks + metadataDataBlocks);
        int metadataTotalBlocks = checked((metadataBaseBlocks + 1) & ~1);
        trailingMetadataBlocks = metadataTotalBlocks - metadataBaseBlocks;
        long metadataStartBlock = logicalDataBlocks + MetadataReserveBlocks;
        long metadataPayloadStartBlock = metadataStartBlock + 1 + inodeBlocks;
        long metaBase = metadataPayloadStartBlock * BlockSize;
        ndblock = metadataStartBlock + metadataTotalBlocks;

        var payloadOffsets = new long[metadataPayloads.Count];
        long b = metaBase;
        for (int i = 0; i < metadataPayloads.Count; i++)
        {
            payloadOffsets[i] = b;
            b = checked(b + (long)PayloadBlocks(metadataPayloads[i]) * BlockSize);
        }
        var nodes = new List<ProsperoPs5MetaNode>();

        // inode 0: super-root directory.
        nodes.Add(new ProsperoPs5MetaNode
        {
            Name = "",
            Inode = superRootInode,
            IsDirectory = true,
            Mode = 0x416d,
            Nlink = 1,
            Flags = 0x00020010,
            Size = (long)PayloadBlocks(metadataPayloads[0]) * BlockSize,
            LogicalOffset = (ulong)payloadOffsets[0],
            ParentInode = -1,
            DirentOffset = -1,
        });
        // inodes 1..3: the internal metadata files (flat-path tables + afid table).
        nodes.Add(MetaFileNode(
            inodeFltInode, (ulong)payloadOffsets[1], metadataPayloads[1].LongLength,
            0x00020010, "inode_flat_path_table"));
        nodes.Add(MetaFileNode(
            aprFltInode, (ulong)payloadOffsets[2], metadataPayloads[2].LongLength,
            0x00020010, "apr_flat_path_table"));
        nodes.Add(MetaFileNode(
            afidTableInode, (ulong)payloadOffsets[3], metadataPayloads[3].LongLength,
            0x00020010, "afid_to_ino_table"));

        // inode 4: uroot; then sub-directories pre-order.
        for (int dirIndex = 0; dirIndex < dirsPreOrder.Count; dirIndex++)
        {
            Dir d = dirsPreOrder[dirIndex];
            bool isUroot = d == uroot;
            bool isSystemTree = d.FullPath.Equals("sce_sys", StringComparison.Ordinal)
                || d.FullPath.StartsWith("sce_sys/", StringComparison.Ordinal);
            nodes.Add(new ProsperoPs5MetaNode
            {
                Name = d.Name,
                FullPath = d.FullPath,
                Inode = d.Inode,
                IsDirectory = true,
                // Publisher nwonly gives APR/user directories the same 0555 mode as uroot.
                // Only the protected sce_sys subtree uses the narrower 0550/internal profile.
                Mode = (ushort)(isUroot || !isSystemTree ? 0x416d : 0x4168),
                Nlink = (ushort)(2 + d.SubDirs.Count + (isUroot ? 1 : 0)),
                Flags = (uint)(isUroot || !isSystemTree ? 0x00000010 : 0x00020010),
                Size = (long)PayloadBlocks(metadataPayloads[4 + dirIndex]) * BlockSize,
                LogicalOffset = (ulong)payloadOffsets[4 + dirIndex],
                ParentInode = isUroot ? -1 : (int)d.Parent!.Inode,
                DirentOffset = isUroot ? -1 : d.DirentOffsetInParent,
            });
        }

        // Regular files (inode order = fileNodes order).
        foreach (var f in fileNodes)
        {
            bool sceSys = f.FullPath.StartsWith("/sce_sys/", StringComparison.Ordinal);
            bool exec = IsExecutableModule(f.Data);
            nodes.Add(new ProsperoPs5MetaNode
            {
                Name = f.Name,
                FullPath = f.FullPath,
                Inode = f.Inode,
                IsDirectory = false,
                Mode = (ushort)(sceSys ? 0x8168 : 0x816d),
                Nlink = 1,
                // base 0x10, +0x40 for an executable module else +0x20
                // for a data blob (e.g. the DRM keystone), +0x20000 for the sce_sys subtree.
                Flags = 0x10u | (exec ? 0x40u : 0x20u) | (sceSys ? 0x20000u : 0u),
                Afid = f.Afid,
                Size = f.Size,
                LogicalOffset = (ulong)f.LogicalOffset,
                ParentInode = (int)f.Parent.Inode,
                DirentOffset = f.DirentOffsetInParent,
            });
        }

        return nodes.OrderBy(n => n.Inode).ToList();
    }

    private ProsperoPs5MetaNode MetaFileNode(
        uint inode, ulong logOff, long size, uint flags, string name = "") => new()
    {
        Name = name,
        Inode = inode,
        IsDirectory = false,
        Mode = 0x816d,
        Nlink = 1,
        Flags = flags,
        Size = size,
        LogicalOffset = logOff,
        ParentInode = -1,
        DirentOffset = -1,
    };

    /// <summary>Rounds <paramref name="value"/> up to a multiple of <paramref name="granularity"/>.</summary>
    private static long RoundUp(long value, long granularity) => (value + granularity - 1) / granularity * granularity;

    // ---- Metadata plaintext + FLT + afid table -----------------------------------------------------

    private List<byte[]> BuildMetadataPayloads(
        List<Dir> dirsPreOrder, List<FileNode> fileNodes, IReadOnlyList<FileNode?> afidSlots,
        uint inodeFltInode, uint aprFltInode, uint afidTableInode, Dir uroot)
    {
        // Flat-path tables. inode_flat_path_table = every path (files + dirs) -> {inode, dir flag, subtree
        // flag, afid}. apr_flat_path_table = only the non-sce_sys ("apr") files -> {uncompressed size, afid}.
        var inodeFlt = new List<ProsperoPs5FlatPathTable.Entry>();
        void FI(string path, uint inode, bool dir, bool subtreeApr, uint afid) =>
            inodeFlt.Add(new(ProsperoPs5FlatPathTable.HashPath(path),
                ProsperoPs5FlatPathTable.PackInodeEntry(inode, dir, !subtreeApr, afid)));

        var aprFlt = new List<ProsperoPs5FlatPathTable.Entry>();
        void FA(string path, long size, uint afid) =>
            aprFlt.Add(new(ProsperoPs5FlatPathTable.HashPath(path),
                ProsperoPs5FlatPathTable.PackAprEntry(size, afid)));

        foreach (var d in dirsPreOrder)
        {
            if (d == uroot)
                continue;
            bool apr = !d.FullPath.Equals("sce_sys", StringComparison.Ordinal)
                && !d.FullPath.StartsWith("sce_sys/", StringComparison.Ordinal);
            FI(d.FullPath, d.Inode, dir: true, subtreeApr: apr, afid: 0);
        }
        foreach (var f in fileNodes)
        {
            bool apr = !f.FullPath.StartsWith("/sce_sys/", StringComparison.Ordinal);
            FI(f.FullPath, f.Inode, dir: false, subtreeApr: apr, afid: f.Afid);
            if (apr) FA(f.FullPath, f.Size, f.Afid);
        }

        byte[] inodeFltBytes = ProsperoPs5FlatPathTable.ToBytes(inodeFlt);
        byte[] aprFltBytes = ProsperoPs5FlatPathTable.ToBytes(aprFlt);

        // afid_to_ino_table: [nonterminal NAPS FIDX count, inode per afid (afid 0..N), -1, -1].
        // The leading value is not an inode count.  Publisher images set it to NumFiles-1 in the
        // NAPS FIDX stream: one nonterminal record per AFID payload, plus the block-info/hole
        // boundary and the metadata boundary.  The final mount boundary is excluded.  The same
        // value is stored in the publisher FIH +0x94/+0x98 fields.
        int napsFileCount = checked(afidSlots.Count + 2);
        var afidTable = new List<int> { napsFileCount };
        foreach (FileNode? file in afidSlots)
            afidTable.Add(file is null ? -1 : checked((int)file.Inode));
        afidTable.Add(-1); afidTable.Add(-1);
        byte[] afidBytes = new byte[afidTable.Count * 4];
        for (int i = 0; i < afidTable.Count; i++)
            BitConverter.GetBytes(afidTable[i]).CopyTo(afidBytes, i * 4);

        // Ordered block-aligned metadata extents after the superblock and inode table:
        // [super-root dirents][inode_flt][apr_flt][afid][uroot dirents][sub-dir dirents...].
        var blocks = new List<byte[]>
        {
            DirentBytes(SuperRootDirents(inodeFltInode, aprFltInode, afidTableInode, uroot.Inode)),
            inodeFltBytes, aprFltBytes, afidBytes,
        };
        foreach (var d in dirsPreOrder)
            blocks.Add(DirentBytes(d.Dirents));
        return blocks;
    }

    private byte[] BuildMetadataPlaintext(
        List<ProsperoPs5MetaNode> nodes, List<byte[]> metadataPayloads, long ndblock,
        int trailingMetadataBlocks)
    {
        if (trailingMetadataBlocks is < 0 or > 1)
            throw new InvalidDataException("Publisher metadata padding must be zero or one block.");
        var extents = new List<byte[]>(metadataPayloads);
        if (trailingMetadataBlocks != 0)
            extents.Add(Array.Empty<byte>());
        var meta = new ProsperoPs5InnerMetadata(_timeSec, _timeNsec);
        return meta.Build(nodes, ndblock, extents);
    }

    private static IEnumerable<PfsDirent> SuperRootDirents(uint inodeFlt, uint aprFlt, uint afid, uint uroot) => new[]
    {
        new PfsDirent { InodeNumber = inodeFlt, Name = "inode_flat_path_table", Type = DirentType.File },
        new PfsDirent { InodeNumber = aprFlt, Name = "apr_flat_path_table", Type = DirentType.File },
        new PfsDirent { InodeNumber = afid, Name = "afid_to_ino_table", Type = DirentType.File },
        new PfsDirent { InodeNumber = uroot, Name = "uroot", Type = DirentType.Directory },
    };

    private static byte[] DirentBytes(IEnumerable<PfsDirent> dirents)
    {
        using var ms = new System.IO.MemoryStream();
        foreach (var d in dirents) d.WriteToStream(ms);
        return ms.ToArray();
    }

    // ---- Data-first image --------------------------------------------------------------------------

    private byte[] BuildImage(
        List<FileNode> afidOrder, byte[] metaPlain, long logicalDataEnd,
        string? outputPath, long outputOffset, long prewrittenDataEnd,
        out long imageLength, out long blockInfoOnDisk, out long metadataOnDisk, out byte[] compressedMeta,
        out IReadOnlyList<ProsperoInnerMetaBlockChunk> metaBlocks)
    {
        const int BLK = ProsperoPs5InnerImageBuilder.BlockSize; // 0x10000
        static long AlignUp(long v, long a) => (v + a - 1) & ~(a - 1);

        // Build payloads with the on-disk packing rule and compute each file's on-disk offset by
        // replaying the same layout the builder performs.
        //   - keystone (WholeBlockRaw): anchors its own whole block (block-aligned before + after).
        //   - every other raw or compressed data file packs contiguously. Crossing a 64-KiB physical
        //     boundary is allowed and does not open an artificial RUN.
        var payloads = new List<ProsperoPs5InnerPayload>();
        long pos = outputPath is null ? 0 : prewrittenDataEnd;
        if (outputPath is null)
        {
            foreach (var f in afidOrder)
            {
                bool alignAfter = f.WholeBlockRaw;
                bool alignBefore = f.WholeBlockRaw;

                var p = new ProsperoPs5InnerPayload
                {
                    // Pre-compressed: pass the cached on-disk bytes through as raw.
                    Data = f.OnDiskData!,
                    StoreRaw = true,
                    BlockAligned = alignBefore,
                    BlockAlignedAfter = alignAfter,
                };
                payloads.Add(p);

                if (alignBefore) pos = AlignUp(pos, BLK);
                f.OnDiskOffset = pos;
                f.OnDiskSize = p.Data.LongLength;
                pos += p.Data.Length;
                if (alignAfter) pos = AlignUp(pos, BLK);
            }
        }

        // The 256-byte block-info table sits between the data files and the metadata block,
        // block-aligned. Its final entry encodes the logical end of all afid payloads,
        // including sce_sys/pfs-version.dat.
        byte[] blockInfo = BuildBlockInfoTable(logicalDataEnd);
        pos = AlignUp(pos, BLK);
        blockInfoOnDisk = pos;
        pos += blockInfo.Length;
        if (outputPath is null)
            payloads.Add(new ProsperoPs5InnerPayload
            { Data = blockInfo, StoreRaw = true, BlockAligned = true });

        compressedMeta = ProsperoPs5InnerImageBuilder.CompressPayload(metaPlain, storeRaw: false, out var metaPf);
        // Capture the per-256KiB-block chunk table so the naps generator reuses it (no second Kraken pass).
        metaBlocks = metaPf is null
            ? Array.Empty<ProsperoInnerMetaBlockChunk>()
            : metaPf.Blocks.Select(b => new ProsperoInnerMetaBlockChunk(
                b.CompressedSize, b.UncompressedSize, b.IsMultiChunk,
                b.FirstChunkCompressedSize, b.Flags)).ToList();
        pos = AlignUp(pos, BLK);
        metadataOnDisk = pos;
        if (outputPath is null)
            payloads.Add(new ProsperoPs5InnerPayload
            {
                Data = compressedMeta,
                StoreRaw = true,
                BlockAligned = true,
            });
        var builder = new ProsperoPs5InnerImageBuilder();
        if (outputPath is null)
        {
            byte[] image = builder.Build(payloads);
            int alignedLength = checked((int)AlignUp(image.Length, BLK));
            if (image.Length != alignedLength)
                Array.Resize(ref image, alignedLength);
            imageLength = image.LongLength;
            return image;
        }

        using (var output = new FileStream(
                   outputPath, FileMode.Open, FileAccess.ReadWrite, FileShare.None,
                   bufferSize: 1 << 20, FileOptions.SequentialScan))
        {
            output.Position = checked(outputOffset + blockInfoOnDisk);
            output.Write(blockInfo);
            output.Position = checked(outputOffset + metadataOnDisk);
            output.Write(compressedMeta);
            long unpaddedLength = checked(metadataOnDisk + compressedMeta.LongLength);
            imageLength = AlignUp(unpaddedLength, BLK);
            output.SetLength(checked(outputOffset + imageLength));
            output.Flush(flushToDisk: true);
        }
        return [];
    }

    /// <summary>
    /// PFSv3 build/SDK version stamped into every block-75 entry (little-endian u32). The low nibble
    /// encodes system/firmware 4.03.
    /// </summary>
    private const uint BlockInfoVersion = 0x00400003;

    /// <summary>The constant value emitted for the first 31 slots of the block-75 table; independent
    /// of package content.</summary>
    private const uint BlockInfoTemplate = 0x00FCFF27;

    /// <summary>
    /// Global base constant (read big-endian) of the block-75 variable entry. See <see cref="BuildBlockInfoTable"/>.
    /// </summary>
    private const uint BlockInfoBase = 0x0027FFFC;

    /// <summary>
    /// Builds the 256-byte inner block-75 table that precedes the compressed metadata block.
    /// Each 8-byte entry is <c>{ u32 value, u32 version }</c> (little-endian): the first 31
    /// entries carry <see cref="BlockInfoTemplate"/>; the final entry is derived from the
    /// logical end of all afid files.
    /// <para>The final entry, read as the three displayed bytes, equals
    /// <c>0x27FFFC − 4·(afidDataEnd mod 0x10000)</c>. For the publisher baseline
    /// <c>afidDataEnd=0xA</c> this produces <c>27 FF D4</c>; for the compressed AC sample
    /// <c>afidDataEnd mod 0x10000=0x8C</c> it produces <c>27 FD CC</c>. A larger
    /// <c>0x2B482</c> tail uses <c>0xB482</c> and produces <c>25 2D F4</c>.</para>
    /// </summary>
    /// <param name="afidDataEnd">Logical end of all afid file data, including sce_sys files.</param>
    private static byte[] BuildBlockInfoTable(long afidDataEnd)
    {
        // Four times the sub-64-KiB logical tail; higher AFID offset bits do not participate.
        uint sub = checked((uint)((afidDataEnd & 0xFFFF) * 4));
        uint bigEndian = (BlockInfoBase - sub) & 0xFFFFFF;
        uint value = ((bigEndian & 0xFF) << 16) | (bigEndian & 0xFF00) | ((bigEndian >> 16) & 0xFF);

        var table = new byte[32 * 8];
        for (int i = 0; i < 31; i++)
            WriteBlockInfoEntry(table, i * 8, BlockInfoTemplate);
        WriteBlockInfoEntry(table, 31 * 8, value);
        return table;

        static void WriteBlockInfoEntry(byte[] buffer, int offset, uint entryValue)
        {
            System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(buffer.AsSpan(offset), entryValue);
            System.Buffers.Binary.BinaryPrimitives.WriteUInt32LittleEndian(buffer.AsSpan(offset + 4), BlockInfoVersion);
        }
    }
}
