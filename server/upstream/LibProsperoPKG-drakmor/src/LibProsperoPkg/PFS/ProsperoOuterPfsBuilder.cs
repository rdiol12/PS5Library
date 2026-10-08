// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// PS5 *finalized-image* outer-PFS STRUCTURE generator for the
// `nwonly` package. This assembles the plaintext outer-PFS
// filesystem image (the 11-block "data-first" layout) from the two outer
// files that an nwonly image always contains - `pfs_image.dat` (the nested inner PFS image) and
// `naps_pkg_layout.dat` - plus the fixed metadata inodes (super-root dir, inode_flat_path_table,
// uroot dir), then signs it (plain SHA3-256 per block + superblock ICV) and applies the
// AES-XTS block encryption.
//
// Every byte format here is modeled block-by-block:
//
// * Layout (data-first): blocks [0..D-1] = file data (file0 then file1 ...), block D = superblock
// (plaintext), D+1 = inode table, D+2 = super-root dirents, D+3 = inode_flat_path_table (FLT),
// followed by any signed indirect-map blocks and then uroot dirents. With no indirect maps and
// D = 6 (5 blocks pfs_image.dat + 1 block naps), uroot is D+4 and the image has 11 blocks.
// * Inodes (fixed template): 0 = super-root dir (mode 0x416d, flags 0x2000c), 1 =
// inode_flat_path_table file (mode 0x816d, flags 0x2000c), 2 = uroot dir (mode 0x416d, nlink 3,
// flags 0xc), 3.. = the outer files in order (mode 0x816d, flags 0xd).
// * Super-root dirents: { inode_flat_path_table -> inode 1 (File), uroot -> inode 2 (Dir) }.
// * uroot dirents: { ".", "..", <file0> -> inode 3, <file1> -> inode 4, ... } (names lowercase).
// * \x7fFLT (block D+3): header { ver=1, hdrSize=0x10, dataOff=0x40 }, magic "\x7fFLT" @0x20,
// count @0x2c, the two fixed FLT seeds @0x30, then one 16-byte entry per FILE:
// { u64 pathHash (custom reduced-Keccak over the UPPERCASED name), u64 inode | fileOrdinal<<40 }.
// * Signing: each dinode stores SHA3-256(plaintext block) + block index per owned block; the
// super-root inode in the superblock stores SHA3-256(inode table) @0xb8; the superblock ICV
// @0x380 = SHA3-256(superblock[0:0x5a0] with the ICV field zeroed). See ProsperoOuterPfsSignature.
// * Encryption: pfs_image.dat blocks = plain XTS sector (block index); every other block (the
// small files + all metadata) = signed XTS sector (bit 47 | block index); the superblock block
// is left plaintext. See ProsperoOuterPfsImage.
//
// The FLT path-hash is a custom 3-lane reduced-Keccak permutation (round constant 0x8000000080008081)
// with two fixed 64-bit seeds for the file names ("pfs_image.dat", "naps_pkg_layout.dat").
#nullable enable
using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;

namespace LibProsperoPkg.PFS;

/// <summary>
/// Describes one file that lives at the <em>outer</em> level of a PS5 nwonly finalized image.
/// An nwonly outer PFS always contains exactly two files - <c>pfs_image.dat</c> (the nested inner
/// image) and <c>naps_pkg_layout.dat</c> - but this type keeps the list general.
/// </summary>
public sealed class ProsperoOuterFile
{
    /// <summary>The outer file name (e.g. <c>pfs_image.dat</c>), stored lowercase in dirents.</summary>
    public required string Name { get; init; }

    /// <summary>The raw file bytes. Laid out block-by-block (zero-padded to the block size).</summary>
    public required byte[] Data { get; init; }

    /// <summary>
    /// The dinode <c>SizeCompressed</c> field (dinode+0x10). For <c>naps_pkg_layout.dat</c> this
    /// equals the file length; for <c>pfs_image.dat</c> it is the nested image's logical
    /// (uncompressed) size as recorded by the inner-image builder. Defaults to <see cref="Data"/>'s length.
    /// </summary>
    public long? SizeCompressed { get; init; }

    /// <summary>
    /// Whether this file's data blocks are AES-XTS encrypted as <em>signed</em> blocks (sector =
    /// bit 47 | block index). <c>pfs_image.dat</c> is plain data and
    /// <c>naps_pkg_layout.dat</c> is signed.
    /// </summary>
    public bool Signed { get; init; }
}

/// <summary>
/// Build parameters for the outer-PFS structure generator. The timestamp/seed defaults define the
/// default image parameters; a fresh build supplies the current time and a fresh seed.
/// </summary>
public sealed class ProsperoOuterPfsBuildParameters
{
    /// <summary>POSIX seconds stamped into every inode time field.</summary>
    public long TimestampSeconds { get; init; } = 0x6A31A5B9;

    /// <summary>Nanosecond fraction stamped into every inode time field.</summary>
    public uint TimestampNanoseconds { get; init; } = 0x14DC9380;

    /// <summary>The 16-byte crypt seed written at superblock+0x370 (and used for key derivation).</summary>
    public byte[]? Seed { get; init; }
}

/// <summary>
/// Result of building an outer-PFS image: the plaintext image, the per-block XTS classification,
/// and the metadata (superblock) block index.
/// </summary>
public sealed class ProsperoOuterPfsBuildResult
{
    /// <summary>The assembled plaintext outer-PFS image (a whole number of <see cref="ProsperoOuterPfsBuilder.BlockSize"/> blocks).</summary>
    public required byte[] Plaintext { get; init; }

    /// <summary>Per-block AES-XTS classification (Data / Signed / Plaintext), one entry per block.</summary>
    public required ProsperoOuterBlockKind[] BlockKinds { get; init; }

    /// <summary>Index of the plaintext metadata (superblock) block.</summary>
    public required int SuperblockIndex { get; init; }

    /// <summary>First image block of each outer file, parallel to the input file list.</summary>
    public int[] FileFirstBlock { get; init; } = [];

    /// <summary>Image block count of each outer file, parallel to the input file list.</summary>
    public int[] FileBlockCount { get; init; } = [];

    /// <summary>Block index of the inode (dinode) table.</summary>
    public int InodeTableIndex { get; init; }

    /// <summary>Block index of the super-root dirents.</summary>
    public int SuperRootDirentIndex { get; init; }

    /// <summary>Block index of the inode_flat_path_table.</summary>
    public int FltIndex { get; init; }

    /// <summary>Block index of the uroot dirents.</summary>
    public int UrootDirentIndex { get; init; }

    /// <summary>Total block count of the image.</summary>
    public int BlockCount => BlockKinds.Length;
}

/// <summary>
/// The finalized outer-PFS image for a package: the encrypted image plus the metadata the container
/// finalizer consumes (per-block digest table, superblock ICV, and image-tree snapshot).
/// </summary>
public sealed class ProsperoOuterPackageImage
{
    /// <summary>The encrypted outer-PFS image (the plaintext superblock block is left in the clear).</summary>
    public required byte[] Ciphertext { get; init; }

    /// <summary>Total image size in bytes.</summary>
    public required long PfsSize { get; init; }

    /// <summary>One 32-byte per-block digest for every image block (the imagedigs table).</summary>
    public required byte[] ImageDigests { get; init; }

    /// <summary>The 32-byte superblock integrity value.</summary>
    public required byte[] SuperblockIcv { get; init; }

    /// <summary>Index of the plaintext metadata (superblock) block.</summary>
    public required int SuperblockIndex { get; init; }

    /// <summary>Self-consistent image-tree snapshot for the pfsimage.xml introspection sections.</summary>
    public required ProsperoPfsImageTreeInfo Tree { get; init; }
}

/// <summary>
/// File-backed input for a large outer-PFS build. The source file is opened only while its blocks
/// are copied and hashed, so the complete payload never needs to be held in a managed array.
/// </summary>
public sealed class ProsperoOuterFileSource
{
    public required string Name { get; init; }
    public required string Path { get; init; }
    public long? SizeCompressed { get; init; }
    public bool Signed { get; init; }
}

/// <summary>Metadata returned by the file-backed outer-PFS package writer.</summary>
public sealed class ProsperoOuterPackageFileResult
{
    public required long PfsSize { get; init; }
    public required byte[] ImageDigests { get; init; }
    public byte[] BlockCrc32C { get; init; } = [];
    public required byte[] SuperblockIcv { get; init; }
    public required int SuperblockIndex { get; init; }
    public required int InodeTableIndex { get; init; }
    public required int SuperRootDirentIndex { get; init; }
    public required int FltIndex { get; init; }
    public required int UrootDirentIndex { get; init; }
    public required int[] FileFirstBlock { get; init; }
    public required int[] FileBlockCount { get; init; }
    public required ProsperoOuterBlockKind[] BlockKinds { get; init; }
    public required ProsperoPfsImageTreeInfo Tree { get; init; }
}

/// <summary>
/// Addressing geometry of one signed outer-PFS inode. Index 0 in both arrays describes
/// <c>ib[0]</c> (single indirect), index 1 describes <c>ib[1]</c> (double indirect), and so on.
/// This is useful for checking very large image layouts without materializing their payload.
/// </summary>
public sealed class ProsperoOuterAddressingGeometry
{
    public required long DataBlocks { get; init; }
    public required long DirectDataBlocks { get; init; }
    public required long[] DataBlocksByIndirectLevel { get; init; }
    public required long[] MetadataBlocksByIndirectLevel { get; init; }
    public required int HighestIndirectLevel { get; init; }
    public long TotalIndirectMetadataBlocks
    {
        get
        {
            long total = 0;
            foreach (long count in MetadataBlocksByIndirectLevel)
                total = checked(total + count);
            return total;
        }
    }
}

/// <summary>
/// Internal byte-level probe produced by the real indirect-map serializer. The companion
/// regression tool uses it to exercise a selected inode level without materializing file data.
/// </summary>
internal sealed class ProsperoOuterAddressingSerializationProbe
{
    public required int InodeLevel { get; init; }
    public required int RootBlockIndex { get; init; }
    public required int FirstDataOffset { get; init; }
    public required int DataBlockCount { get; init; }
    public required byte[] RootHash { get; init; }
    public required IReadOnlyDictionary<int, byte[]> MetadataBlocks { get; init; }
}

/// <summary>
/// Assembles, signs, and encrypts the plaintext outer-PFS image of a PS5 nwonly finalized package.
/// See the file header for the full byte layout.
/// </summary>
public static class ProsperoOuterPfsBuilder
{
    /// <summary>The outer finalized-image PFS block size (one block = one AES-XTS data unit).</summary>
    public const int BlockSize = ProsperoOuterPfsImage.DefaultBlockSize; // 0x10000

    // Fixed metadata inode/dirent names.
    private const string FlatPathTableName = "inode_flat_path_table";
    private const string UrootName = "uroot";

    // Number of fixed metadata inodes that precede the file inodes (super-root, FLT, uroot).
    private const int MetadataInodeCount = 3;

    // Inode mode / flag constants.
    private const ushort ModeDir = 0x416D;   // S_IFDIR | 0555
    private const ushort ModeFile = 0x816D;  // S_IFREG | 0555
    private const uint FlagsInternalMeta = 0x2000C; // @internal | unk2 | unk3 (super-root dir + FLT file)
    private const uint FlagsDir = 0x000C;           // unk2 | unk3 (uroot dir)
    private const uint FlagsFile = 0x000D;          // compressed | unk2 | unk3 (data files)

    // --- \x7fFLT custom reduced-Keccak path hash ---
    private const ulong FltRoundConstant = 0x8000000080008081UL;
    private const ulong FltSeed0 = 0x92CA8AAB26A24F51UL; // written at superblock-table+0x18 -> FLT @0x30
    private const ulong FltSeed1 = 0x09BBB761A41BC44DUL; // written at superblock-table+0x20 -> FLT @0x38

    // FLT block header constants.
    private const uint FltVersion = 1;
    private const uint FltHeaderSize = 0x10;
    private const uint FltDataOffset = 0x40;
    private static readonly byte[] FltMagic = { 0x7F, 0x46, 0x4C, 0x54 }; // "\x7fFLT"

    private const int DirectBlockSlots = 12;
    private const int SignedPointerSize = 36;
    private const int IndirectLevelCount = 5;
    private const int IndirectEntriesPerBlock = BlockSize / SignedPointerSize;

    private sealed class IndirectNodePlan
    {
        public required int BlockIndex { get; init; }
        public required int Depth { get; init; }
        public required int FirstDataOffset { get; init; }
        public required int DataBlockCount { get; init; }
        public List<IndirectNodePlan> Children { get; } = [];
    }

    private sealed class IndirectTreePlan
    {
        public required int InodeLevel { get; init; }
        public required IndirectNodePlan Root { get; init; }
    }

    private delegate void CopyDigest(int blockIndex, Span<byte> destination);

    /// <summary>
    /// Calculates which direct and indirect levels are needed for a file of
    /// <paramref name="dataBlockCount"/> blocks. No image or indirect-map buffers are allocated.
    /// </summary>
    public static ProsperoOuterAddressingGeometry GetAddressingGeometry(long dataBlockCount)
    {
        if (dataBlockCount < 0)
            throw new ArgumentOutOfRangeException(nameof(dataBlockCount));

        long direct = Math.Min(dataBlockCount, DirectBlockSlots);
        long remaining = dataBlockCount - direct;
        var dataByLevel = new long[IndirectLevelCount];
        var metadataByLevel = new long[IndirectLevelCount];
        int highest = -1;
        for (int level = 0; level < IndirectLevelCount && remaining > 0; level++)
        {
            int depth = level + 1;
            long capacity = SaturatingPow(IndirectEntriesPerBlock, depth);
            long take = Math.Min(remaining, capacity);
            dataByLevel[level] = take;
            metadataByLevel[level] = CountIndirectTreeBlocks(take, depth);
            remaining -= take;
            highest = level;
        }

        if (remaining > 0)
            throw new NotSupportedException(
                $"A signed outer-PFS inode cannot address {dataBlockCount} data blocks with " +
                $"{IndirectLevelCount} indirect levels.");

        // For every file size representable by the actual writer, derive the public geometry from
        // the same concrete node planner used during serialization. The arithmetic path above also
        // handles larger diagnostic values and provides the address-space check.
        if (dataBlockCount <= int.MaxValue)
        {
            IndirectTreePlan[][] plans = PlanIndirectTrees(
                [checked((int)dataBlockCount)], firstMetadataBlock: 0, out _);
            Array.Clear(dataByLevel);
            Array.Clear(metadataByLevel);
            highest = -1;
            foreach (IndirectTreePlan tree in plans[0])
            {
                dataByLevel[tree.InodeLevel] = tree.Root.DataBlockCount;
                metadataByLevel[tree.InodeLevel] = CountIndirectNodes(tree.Root);
                highest = tree.InodeLevel;
            }
        }

        return new ProsperoOuterAddressingGeometry
        {
            DataBlocks = dataBlockCount,
            DirectDataBlocks = direct,
            DataBlocksByIndirectLevel = dataByLevel,
            MetadataBlocksByIndirectLevel = metadataByLevel,
            HighestIndirectLevel = highest,
        };
    }

    /// <summary>
    /// Runs the production indirect-tree planner and serializer for one inode level using
    /// deterministic synthetic data digests. This is intentionally internal: it validates
    /// metadata bytes and pointer geometry but does not produce a usable filesystem image.
    /// </summary>
    internal static ProsperoOuterAddressingSerializationProbe
        BuildAddressingSerializationProbe(long dataBlockCount, int inodeLevel)
    {
        if (dataBlockCount < 0 || dataBlockCount > int.MaxValue)
            throw new ArgumentOutOfRangeException(nameof(dataBlockCount));
        if ((uint)inodeLevel >= IndirectLevelCount)
            throw new ArgumentOutOfRangeException(nameof(inodeLevel));

        int blockCount = checked((int)dataBlockCount);
        int firstMetadataBlock = checked(blockCount + 4);
        IndirectTreePlan[][] plans = PlanIndirectTrees(
            [blockCount], firstMetadataBlock, out _);
        IndirectTreePlan? selected = null;
        foreach (IndirectTreePlan tree in plans[0])
        {
            if (tree.InodeLevel == inodeLevel)
            {
                selected = tree;
                break;
            }
        }
        if (selected is null)
            throw new ArgumentException(
                $"A {dataBlockCount}-block inode does not use ib[{inodeLevel}].",
                nameof(inodeLevel));

        var serialized = new Dictionary<int, byte[]>();
        byte[] rootHash = WriteIndirectTree(
            selected.Root,
            fileFirstBlock: 0,
            copyDataDigest: static (dataBlock, destination) =>
            {
                destination.Clear();
                BinaryPrimitives.WriteInt32LittleEndian(destination, dataBlock);
                BinaryPrimitives.WriteInt32LittleEndian(
                    destination.Slice(28, 4), ~dataBlock);
            },
            writeBlock: (blockIndex, block) =>
                serialized.Add(blockIndex, (byte[])block.Clone()));
        return new ProsperoOuterAddressingSerializationProbe
        {
            InodeLevel = selected.InodeLevel,
            RootBlockIndex = selected.Root.BlockIndex,
            FirstDataOffset = selected.Root.FirstDataOffset,
            DataBlockCount = selected.Root.DataBlockCount,
            RootHash = rootHash,
            MetadataBlocks = serialized,
        };
    }

    private static long SaturatingPow(long value, int exponent)
    {
        long result = 1;
        for (int i = 0; i < exponent; i++)
        {
            if (result > long.MaxValue / value)
                return long.MaxValue;
            result *= value;
        }
        return result;
    }

    private static long CountIndirectTreeBlocks(long dataBlocks, int depth)
    {
        long total = 0;
        long divisor = 1;
        for (int level = 0; level < depth; level++)
        {
            if (divisor > long.MaxValue / IndirectEntriesPerBlock)
                divisor = long.MaxValue;
            else
                divisor *= IndirectEntriesPerBlock;
            long count = dataBlocks / divisor + (dataBlocks % divisor == 0 ? 0 : 1);
            total = checked(total + count);
        }
        return total;
    }

    private static IndirectTreePlan[][] PlanIndirectTrees(
        int[] fileBlockCounts, int firstMetadataBlock, out int nextMetadataBlock)
    {
        var result = new IndirectTreePlan[fileBlockCounts.Length][];
        int nextBlock = firstMetadataBlock;
        for (int fileIndex = 0; fileIndex < fileBlockCounts.Length; fileIndex++)
        {
            int remaining = Math.Max(0, fileBlockCounts[fileIndex] - DirectBlockSlots);
            int firstDataOffset = DirectBlockSlots;
            var trees = new List<IndirectTreePlan>(IndirectLevelCount);
            for (int level = 0; level < IndirectLevelCount && remaining > 0; level++)
            {
                int depth = level + 1;
                long capacity = SaturatingPow(IndirectEntriesPerBlock, depth);
                int take = checked((int)Math.Min(remaining, capacity));
                IndirectNodePlan root = AllocateIndirectNode(
                    depth, firstDataOffset, take, ref nextBlock);
                trees.Add(new IndirectTreePlan { InodeLevel = level, Root = root });
                firstDataOffset = checked(firstDataOffset + take);
                remaining -= take;
            }
            if (remaining > 0)
                throw new NotSupportedException(
                    $"Outer file {fileIndex} spans {fileBlockCounts[fileIndex]} blocks and exceeds " +
                    $"the five-level signed inode address space.");
            result[fileIndex] = trees.ToArray();
        }
        nextMetadataBlock = nextBlock;
        return result;
    }

    private static IndirectNodePlan AllocateIndirectNode(
        int depth, int firstDataOffset, int dataBlockCount, ref int nextBlock)
    {
        var node = new IndirectNodePlan
        {
            BlockIndex = nextBlock,
            Depth = depth,
            FirstDataOffset = firstDataOffset,
            DataBlockCount = dataBlockCount,
        };
        nextBlock = checked(nextBlock + 1);
        if (depth == 1)
            return node;

        long childCapacity = SaturatingPow(IndirectEntriesPerBlock, depth - 1);
        int remaining = dataBlockCount;
        int childDataOffset = firstDataOffset;
        while (remaining > 0)
        {
            int childCount = checked((int)Math.Min(remaining, childCapacity));
            node.Children.Add(AllocateIndirectNode(
                depth - 1, childDataOffset, childCount, ref nextBlock));
            childDataOffset = checked(childDataOffset + childCount);
            remaining -= childCount;
        }
        return node;
    }

    private static void MarkIndirectBlocksSigned(
        ProsperoOuterBlockKind[] kinds, IndirectTreePlan[][] plans)
    {
        foreach (IndirectTreePlan[] filePlans in plans)
            foreach (IndirectTreePlan tree in filePlans)
                MarkIndirectNodeSigned(kinds, tree.Root);
    }

    private static void MarkIndirectNodeSigned(
        ProsperoOuterBlockKind[] kinds, IndirectNodePlan node)
    {
        kinds[node.BlockIndex] = ProsperoOuterBlockKind.Signed;
        foreach (IndirectNodePlan child in node.Children)
            MarkIndirectNodeSigned(kinds, child);
    }

    private static long CountIndirectNodes(IndirectNodePlan node)
    {
        long count = 1;
        foreach (IndirectNodePlan child in node.Children)
            count = checked(count + CountIndirectNodes(child));
        return count;
    }

    private static byte[] WriteIndirectTree(
        IndirectNodePlan node, int fileFirstBlock, CopyDigest copyDataDigest,
        Action<int, byte[]> writeBlock)
    {
        var map = new byte[BlockSize];
        if (node.Depth == 1)
        {
            for (int entry = 0; entry < node.DataBlockCount; entry++)
            {
                int dataBlock = checked(fileFirstBlock + node.FirstDataOffset + entry);
                int entryOffset = entry * SignedPointerSize;
                copyDataDigest(dataBlock, map.AsSpan(entryOffset, 32));
                BinaryPrimitives.WriteInt32LittleEndian(
                    map.AsSpan(entryOffset + 32, 4), dataBlock);
            }
        }
        else
        {
            for (int entry = 0; entry < node.Children.Count; entry++)
            {
                IndirectNodePlan child = node.Children[entry];
                byte[] childHash = WriteIndirectTree(
                    child, fileFirstBlock, copyDataDigest, writeBlock);
                int entryOffset = entry * SignedPointerSize;
                childHash.CopyTo(map, entryOffset);
                BinaryPrimitives.WriteInt32LittleEndian(
                    map.AsSpan(entryOffset + 32, 4), child.BlockIndex);
            }
        }

        byte[] hash = ProsperoOuterPfsSignature.ComputeBlockHash(map);
        writeBlock(node.BlockIndex, map);
        return hash;
    }

    /// <summary>
    /// Builds the plaintext outer-PFS image (assembled + signed, not yet encrypted) for the given
    /// ordered outer <paramref name="files"/>. The metadata inodes/dirents/FLT and the superblock
    /// (including all SHA3-256 block hashes and the ICV) are produced here. Use
    /// <see cref="Encrypt"/> (or <see cref="ProsperoOuterPfsImage"/>'s block-kinds <c>Transform</c>
    /// overload with the returned <see cref="ProsperoOuterPfsBuildResult.BlockKinds"/>) to encrypt.
    /// </summary>
    public static ProsperoOuterPfsBuildResult BuildPlaintext(
        IReadOnlyList<ProsperoOuterFile> files, ProsperoOuterPfsBuildParameters parameters)
    {
        ArgumentNullException.ThrowIfNull(files);
        ArgumentNullException.ThrowIfNull(parameters);
        if (files.Count == 0)
            throw new ArgumentException("At least one outer file is required.", nameof(files));

        // ---- 1. Plan the block layout (data-first). ----
        int dataBlockTotal = 0;
        var fileFirstBlock = new int[files.Count];
        var fileBlockCount = new int[files.Count];
        for (int i = 0; i < files.Count; i++)
        {
            ProsperoOuterFile f = files[i];
            ArgumentNullException.ThrowIfNull(f);
            int blocks = Math.Max(1, (f.Data.Length + BlockSize - 1) / BlockSize);
            fileFirstBlock[i] = dataBlockTotal;
            fileBlockCount[i] = blocks;
            dataBlockTotal += blocks;
        }

        int superblockIndex = dataBlockTotal;       // block D
        int inodeTableIndex = dataBlockTotal + 1;    // block D+1
        int superRootDirentIndex = dataBlockTotal + 2; // block D+2
        int fltIndex = dataBlockTotal + 3;           // block D+3

        // Signed maps live after the FLT and before uroot. ib[n] is a tree of depth n+1,
        // so ib[2] removes the former ~202-GiB single+double-indirect file-size ceiling.
        int indirectRegionStart = fltIndex + 1;
        IndirectTreePlan[][] indirectPlans = PlanIndirectTrees(
            fileBlockCount, indirectRegionStart, out int afterIndirectRegion);
        int urootDirentIndex = afterIndirectRegion;
        int totalBlocks = urootDirentIndex + 1;

        var image = new byte[(long)totalBlocks * BlockSize];

        // ---- 2. Lay out file data blocks. ----
        for (int i = 0; i < files.Count; i++)
        {
            byte[] data = files[i].Data;
            Buffer.BlockCopy(data, 0, image, fileFirstBlock[i] * BlockSize, data.Length);
        }

        // ---- 3. Build the structural metadata blocks (super-root dirents, FLT, uroot dirents). ----
        BuildSuperRootDirents(image.AsSpan(superRootDirentIndex * BlockSize, BlockSize));
        BuildFlatPathTable(image.AsSpan(fltIndex * BlockSize, BlockSize), files);
        BuildUrootDirents(image.AsSpan(urootDirentIndex * BlockSize, BlockSize), files);

        // ---- 4. Build the inode table (block D+1) with per-block SHA3 hashes. ----
        BuildInodeTable(
            image, inodeTableIndex, parameters, files,
            fileFirstBlock, fileBlockCount,
            indirectPlans,
            superRootDirentIndex, fltIndex, urootDirentIndex);

        // ---- 5. Build the superblock (block D): super-root inode hash (of the inode table) + seed + ICV. ----
        byte[] inodeTableHash = ProsperoOuterPfsSignature.ComputeBlockHash(
            image.AsSpan(inodeTableIndex * BlockSize, BlockSize));
        BuildSuperblock(
            image.AsSpan(superblockIndex * BlockSize, BlockSize),
            parameters, files.Count, totalBlocks, inodeTableIndex, inodeTableHash);

        // ---- 6. Classify blocks for AES-XTS. ----
        var kinds = new ProsperoOuterBlockKind[totalBlocks];
        for (int i = 0; i < files.Count; i++)
        {
            ProsperoOuterBlockKind kind = files[i].Signed
                ? ProsperoOuterBlockKind.Signed : ProsperoOuterBlockKind.Data;
            for (int j = 0; j < fileBlockCount[i]; j++)
                kinds[fileFirstBlock[i] + j] = kind;
        }
        kinds[superblockIndex] = ProsperoOuterBlockKind.Plaintext;
        kinds[inodeTableIndex] = ProsperoOuterBlockKind.Signed;
        kinds[superRootDirentIndex] = ProsperoOuterBlockKind.Signed;
        kinds[fltIndex] = ProsperoOuterBlockKind.Signed;
        MarkIndirectBlocksSigned(kinds, indirectPlans);
        kinds[urootDirentIndex] = ProsperoOuterBlockKind.Signed;

        return new ProsperoOuterPfsBuildResult
        {
            Plaintext = image,
            BlockKinds = kinds,
            SuperblockIndex = superblockIndex,
            FileFirstBlock = fileFirstBlock,
            FileBlockCount = fileBlockCount,
            InodeTableIndex = inodeTableIndex,
            SuperRootDirentIndex = superRootDirentIndex,
            FltIndex = fltIndex,
            UrootDirentIndex = urootDirentIndex,
        };
    }

    /// <summary>
    /// Encrypts a plaintext outer-PFS image in place using the supplied AES-XTS key pair and the
    /// per-block classification from <see cref="BuildPlaintext"/>.
    /// </summary>
    public static void Encrypt(
        ProsperoOuterPfsBuildResult build, ReadOnlySpan<byte> tweakKey, ReadOnlySpan<byte> dataKey)
    {
        ArgumentNullException.ThrowIfNull(build);
        ProsperoOuterPfsImage.Transform(
            build.Plaintext, tweakKey, dataKey, BlockSize, build.BlockKinds, encrypt: true);
    }

    /// <summary>
    /// Convenience: builds the plaintext image and encrypts it with keys derived from the package
    /// <paramref name="contentId"/> + <paramref name="passcode"/> and the build seed, returning the
    /// final on-disk ciphertext image.
    /// </summary>
    public static byte[] BuildEncrypted(
        IReadOnlyList<ProsperoOuterFile> files, ProsperoOuterPfsBuildParameters parameters,
        string contentId, string passcode)
    {
        ArgumentNullException.ThrowIfNull(parameters);
        if (parameters.Seed is not { Length: 16 })
            throw new ArgumentException("A 16-byte build seed is required to encrypt the image.", nameof(parameters));

        ProsperoOuterPfsBuildResult build = BuildPlaintext(files, parameters);
        byte[] ekpfs = ProsperoPfsKeys.DeriveEkpfs(contentId, passcode);
        var (tweak, data) = ProsperoPfsKeys.DeriveImageEncryptionKeys(ekpfs, parameters.Seed);
        Encrypt(build, tweak, data);
        return build.Plaintext;
    }

    /// <summary>
    /// Builds the finalized outer-PFS image for a package: assembles the data-first plaintext image,
    /// captures the per-block digest table and superblock ICV from the plaintext, encrypts it with keys
    /// derived from <paramref name="ekpfs"/> and the build seed, and produces the image-tree snapshot.
    /// </summary>
    /// <param name="files">The ordered outer files (nested image first, then the layout descriptor).</param>
    /// <param name="parameters">Build parameters; the 16-byte seed drives key derivation.</param>
    /// <param name="ekpfs">The 32-byte package image key.</param>
    public static ProsperoOuterPackageImage BuildForPackage(
        IReadOnlyList<ProsperoOuterFile> files, ProsperoOuterPfsBuildParameters parameters, byte[] ekpfs)
    {
        ArgumentNullException.ThrowIfNull(parameters);
        ArgumentNullException.ThrowIfNull(ekpfs);
        byte[] seed = parameters.Seed ?? new byte[16];
        if (seed.Length != 16)
            throw new ArgumentException("A 16-byte build seed is required.", nameof(parameters));

        ProsperoOuterPfsBuildResult build = BuildPlaintext(files, parameters);
        int total = build.BlockCount;

        // Per-block digest table: one SHA3-256 over each plaintext block (including the superblock),
        // captured before encryption. Data blocks and metadata blocks alike are covered.
        var imageDigests = new byte[total * 32];
        for (int i = 0; i < total; i++)
        {
            byte[] h = ProsperoOuterPfsSignature.ComputeBlockHash(
                build.Plaintext.AsSpan(i * BlockSize, BlockSize));
            h.CopyTo(imageDigests, i * 32);
        }

        byte[] superblockIcv = ProsperoOuterPfsSignature.ComputeSuperblockIcv(
            build.Plaintext.AsSpan(build.SuperblockIndex * BlockSize, BlockSize));

        ProsperoPfsImageTreeInfo tree = BuildTreeInfo(build, files, seed, superblockIcv);

        var (tweak, data) = ProsperoPfsKeys.DeriveImageEncryptionKeys(ekpfs, seed);
        Encrypt(build, tweak, data);

        return new ProsperoOuterPackageImage
        {
            Ciphertext = build.Plaintext,
            PfsSize = build.Plaintext.LongLength,
            ImageDigests = imageDigests,
            SuperblockIcv = superblockIcv,
            SuperblockIndex = build.SuperblockIndex,
            Tree = tree,
        };
    }

    /// <summary>
    /// File-backed counterpart of <see cref="BuildForPackage"/>. Payloads and the finished image are
    /// processed one 64-KiB block at a time; memory use is proportional to the digest table rather
    /// than to the image size. Set <paramref name="encryptOutput"/> to <see langword="false"/> and
    /// pass a null <paramref name="ekpfs"/> to retain the assembled plaintext diagnostic image.
    /// </summary>
    public static ProsperoOuterPackageFileResult BuildForPackageToFile(
        IReadOnlyList<ProsperoOuterFileSource> files,
        ProsperoOuterPfsBuildParameters parameters,
        byte[]? ekpfs,
        string outputPath,
        bool encryptOutput = true)
        => BuildForPackageToFileCore(
            files, parameters, ekpfs, outputPath, encryptOutput, outputOffset: 0);

    internal static ProsperoOuterPackageFileResult BuildForPackageToFileAtOffset(
        IReadOnlyList<ProsperoOuterFileSource> files,
        ProsperoOuterPfsBuildParameters parameters,
        string outputPath,
        long outputOffset,
        long? reusedFirstFileLength = null)
        => BuildForPackageToFileCore(
            files, parameters, ekpfs: null, outputPath, encryptOutput: false,
            outputOffset, reusedFirstFileLength);

    private static ProsperoOuterPackageFileResult BuildForPackageToFileCore(
        IReadOnlyList<ProsperoOuterFileSource> files,
        ProsperoOuterPfsBuildParameters parameters,
        byte[]? ekpfs,
        string outputPath,
        bool encryptOutput,
        long outputOffset,
        long? reusedFirstFileLength = null)
    {
        ArgumentNullException.ThrowIfNull(files);
        ArgumentNullException.ThrowIfNull(parameters);
        if (encryptOutput)
            ArgumentNullException.ThrowIfNull(ekpfs);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);
        if (outputOffset < 0 || outputOffset % BlockSize != 0)
            throw new ArgumentOutOfRangeException(
                nameof(outputOffset), "The output offset must be a non-negative 64-KiB boundary.");
        if (encryptOutput && outputOffset != 0)
            throw new ArgumentException(
                "An offset output is supported only for a plaintext outer PFS.", nameof(outputOffset));
        if (reusedFirstFileLength is <= 0 ||
            (reusedFirstFileLength is not null && outputOffset == 0))
            throw new ArgumentOutOfRangeException(
                nameof(reusedFirstFileLength), "A reused first file requires a positive length and offset output.");
        if (files.Count == 0)
            throw new ArgumentException("At least one outer file is required.", nameof(files));
        byte[] seed = parameters.Seed ?? new byte[16];
        if (seed.Length != 16)
            throw new ArgumentException("A 16-byte build seed is required.", nameof(parameters));

        var lengths = new long[files.Count];
        var firstBlocks = new int[files.Count];
        var blockCounts = new int[files.Count];
        int dataBlockTotal = 0;
        for (int i = 0; i < files.Count; i++)
        {
            ProsperoOuterFileSource file = files[i]
                ?? throw new ArgumentException($"Outer file {i} is null.", nameof(files));
            ArgumentException.ThrowIfNullOrWhiteSpace(file.Name);
            ArgumentException.ThrowIfNullOrWhiteSpace(file.Path);
            lengths[i] = i == 0 && reusedFirstFileLength is long reusedLength
                ? reusedLength
                : new FileInfo(file.Path).Length;
            long blocks64 = Math.Max(1, checked((lengths[i] + BlockSize - 1) / BlockSize));
            blockCounts[i] = checked((int)blocks64);
            firstBlocks[i] = dataBlockTotal;
            dataBlockTotal = checked(dataBlockTotal + blockCounts[i]);
        }

        int superblockIndex = dataBlockTotal;
        int inodeTableIndex = checked(dataBlockTotal + 1);
        int superRootDirentIndex = checked(dataBlockTotal + 2);
        int fltIndex = checked(dataBlockTotal + 3);
        int indirectRegionStart = checked(fltIndex + 1);
        IndirectTreePlan[][] indirectPlans = PlanIndirectTrees(
            blockCounts, indirectRegionStart, out int afterIndirectRegion);
        int urootDirentIndex = afterIndirectRegion;
        int totalBlocks = checked(urootDirentIndex + 1);
        long totalLength = checked((long)totalBlocks * BlockSize);
        var kinds = new ProsperoOuterBlockKind[totalBlocks];
        for (int i = 0; i < files.Count; i++)
        {
            ProsperoOuterBlockKind kind = files[i].Signed
                ? ProsperoOuterBlockKind.Signed
                : ProsperoOuterBlockKind.Data;
            for (int block = 0; block < blockCounts[i]; block++)
                kinds[firstBlocks[i] + block] = kind;
        }
        MarkIndirectBlocksSigned(kinds, indirectPlans);
        kinds[superblockIndex] = ProsperoOuterBlockKind.Plaintext;
        kinds[inodeTableIndex] = ProsperoOuterBlockKind.Signed;
        kinds[superRootDirentIndex] = ProsperoOuterBlockKind.Signed;
        kinds[fltIndex] = ProsperoOuterBlockKind.Signed;
        kinds[urootDirentIndex] = ProsperoOuterBlockKind.Signed;

        string outputFullPath = Path.GetFullPath(outputPath);
        string outputDirectory = Path.GetDirectoryName(outputFullPath) ?? Directory.GetCurrentDirectory();
        Directory.CreateDirectory(outputDirectory);
        StringComparison pathComparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
        for (int i = 0; i < files.Count; i++)
            if (string.Equals(Path.GetFullPath(files[i].Path), outputFullPath, pathComparison) &&
                !(i == 0 && reusedFirstFileLength is not null))
                throw new ArgumentException("An outer-PFS source cannot also be the output file.", nameof(outputPath));
        if (reusedFirstFileLength is not null && !string.Equals(
                Path.GetFullPath(files[0].Path), outputFullPath, pathComparison))
            throw new ArgumentException("The reused first outer file must be the output file.", nameof(files));

        bool directOutput = outputOffset != 0;
        string token = Guid.NewGuid().ToString("N");
        string plaintextPath = directOutput
            ? outputFullPath
            : Path.Combine(outputDirectory, ".libprospero-outer-plain-" + token + ".tmp");
        string ciphertextPath = Path.Combine(outputDirectory, ".libprospero-outer-cipher-" + token + ".tmp");
        var imageDigests = new byte[checked(totalBlocks * 32)];
        var blockCrc32C = new byte[checked(totalBlocks * 4)];
        byte[] superblockIcv;
        bool completed = false;
        try
        {
            using (var image = new FileStream(
                plaintextPath,
                reusedFirstFileLength is not null ? FileMode.Open :
                    directOutput ? FileMode.Create : FileMode.CreateNew,
                FileAccess.ReadWrite, FileShare.None,
                bufferSize: 1 << 20, FileOptions.RandomAccess))
            {
                if (reusedFirstFileLength is long reusedLength &&
                    image.Length != checked(outputOffset + reusedLength))
                    throw new InvalidDataException("The reusable first outer file is incomplete.");
                image.SetLength(checked(outputOffset + totalLength));
                byte[] block = new byte[BlockSize];

                void StoreDigest(int blockIndex, ReadOnlySpan<byte> bytes)
                {
                    byte[] digest = ProsperoOuterPfsSignature.ComputeBlockHash(bytes);
                    digest.CopyTo(imageDigests, blockIndex * 32);
                    BinaryPrimitives.WriteUInt32LittleEndian(
                        blockCrc32C.AsSpan(blockIndex * 4),
                        Util.ProsperoCrc32C.Compute(bytes));
                }

                void WriteBlock(int blockIndex, ReadOnlySpan<byte> bytes)
                {
                    if (bytes.Length != BlockSize)
                        throw new ArgumentException("Structural outer-PFS blocks must be exactly 64 KiB.");
                    image.Position = checked(outputOffset + (long)blockIndex * BlockSize);
                    image.Write(bytes);
                    StoreDigest(blockIndex, bytes);
                }

                // Data region.
                for (int fileIndex = 0; fileIndex < files.Count; fileIndex++)
                {
                    if (fileIndex == 0 && reusedFirstFileLength is not null)
                    {
                        long reusedRemaining = lengths[fileIndex];
                        const int batchBlocks = 1024;
                        var batch = new byte[batchBlocks * BlockSize];
                        for (int localBlock = 0; localBlock < blockCounts[fileIndex];)
                        {
                            int count = Math.Min(batchBlocks, blockCounts[fileIndex] - localBlock);
                            int capacity = checked(count * BlockSize);
                            int bytes = checked((int)Math.Min(capacity, reusedRemaining));
                            batch.AsSpan(0, capacity).Clear();
                            image.Position = checked(
                                outputOffset + (long)(firstBlocks[fileIndex] + localBlock) * BlockSize);
                            image.ReadExactly(batch.AsSpan(0, bytes));
                            System.Threading.Tasks.Parallel.For(0, count, i =>
                            {
                                byte[] digest = ProsperoOuterPfsSignature.ComputeBlockHash(
                                    batch.AsSpan(i * BlockSize, BlockSize));
                                digest.CopyTo(
                                    imageDigests,
                                    checked((firstBlocks[fileIndex] + localBlock + i) * 32));
                                BinaryPrimitives.WriteUInt32LittleEndian(
                                    blockCrc32C.AsSpan(
                                        checked((firstBlocks[fileIndex] + localBlock + i) * 4)),
                                    Util.ProsperoCrc32C.Compute(
                                        batch.AsSpan(i * BlockSize, BlockSize)));
                            });
                            localBlock += count;
                            reusedRemaining -= bytes;
                        }
                        continue;
                    }
                    using var source = new FileStream(
                        files[fileIndex].Path, FileMode.Open, FileAccess.Read, FileShare.Read,
                        bufferSize: 1 << 20, FileOptions.SequentialScan);
                    long remaining = lengths[fileIndex];
                    for (int localBlock = 0; localBlock < blockCounts[fileIndex]; localBlock++)
                    {
                        Array.Clear(block);
                        int count = checked((int)Math.Min(BlockSize, remaining));
                        if (count != 0)
                            source.ReadExactly(block.AsSpan(0, count));
                        int blockIndex = firstBlocks[fileIndex] + localBlock;
                        WriteBlock(blockIndex, block);
                        remaining -= count;
                    }
                }

                // Fixed metadata blocks which are inputs to the inode table.
                Array.Clear(block);
                BuildSuperRootDirents(block);
                WriteBlock(superRootDirentIndex, block);
                Array.Clear(block);
                BuildFlatPathTable(block, files.Count, i => files[i].Name);
                WriteBlock(fltIndex, block);
                Array.Clear(block);
                BuildUrootDirents(block, files.Count, i => files[i].Name);
                WriteBlock(urootDirentIndex, block);

                var inodes = new List<DinodeS32>(MetadataInodeCount + files.Count);
                DinodeS32 MakeMeta(ushort mode, ushort nlink, uint flags, long size, int ownedBlock)
                {
                    var inode = new DinodeS32
                    {
                        Mode = (InodeMode)mode,
                        Nlink = nlink,
                        Flags = (InodeFlags)flags,
                        Size = size,
                        SizeCompressed = size,
                        Blocks = 1,
                    };
                    StampTime(inode, parameters);
                    inode.db[0].sig = imageDigests.AsSpan(ownedBlock * 32, 32).ToArray();
                    inode.db[0].block = ownedBlock;
                    return inode;
                }

                inodes.Add(MakeMeta(ModeDir, 1, FlagsInternalMeta, BlockSize, superRootDirentIndex));
                inodes.Add(MakeMeta(
                    ModeFile, 1, FlagsInternalMeta,
                    FltDataOffset + (long)files.Count * 16, fltIndex));
                inodes.Add(MakeMeta(ModeDir, 3, FlagsDir, BlockSize, urootDirentIndex));

                for (int fileIndex = 0; fileIndex < files.Count; fileIndex++)
                {
                    var inode = new DinodeS32
                    {
                        Mode = (InodeMode)ModeFile,
                        Nlink = 1,
                        Flags = (InodeFlags)FlagsFile,
                        Size = lengths[fileIndex],
                        SizeCompressed = files[fileIndex].SizeCompressed ?? lengths[fileIndex],
                        Blocks = checked((uint)blockCounts[fileIndex]),
                    };
                    StampTime(inode, parameters);
                    int directCount = Math.Min(blockCounts[fileIndex], DirectBlockSlots);
                    for (int entry = 0; entry < directCount; entry++)
                    {
                        int dataBlock = firstBlocks[fileIndex] + entry;
                        inode.db[entry].sig = imageDigests.AsSpan(dataBlock * 32, 32).ToArray();
                        inode.db[entry].block = dataBlock;
                    }

                    foreach (IndirectTreePlan treePlan in indirectPlans[fileIndex])
                    {
                        void CopyStoredDigest(int dataBlock, Span<byte> destination)
                        {
                            imageDigests.AsSpan(dataBlock * 32, 32).CopyTo(destination);
                        }
                        byte[] rootHash = WriteIndirectTree(
                            treePlan.Root, firstBlocks[fileIndex], CopyStoredDigest,
                            (mapBlock, bytes) => WriteBlock(mapBlock, bytes));
                        inode.ib[treePlan.InodeLevel].sig = rootHash;
                        inode.ib[treePlan.InodeLevel].block = treePlan.Root.BlockIndex;
                    }
                    inodes.Add(inode);
                }

                Array.Clear(block);
                using (var inodeBytes = new MemoryStream(block, writable: true))
                    foreach (DinodeS32 inode in inodes)
                        inode.WriteToStream(inodeBytes);
                WriteBlock(inodeTableIndex, block);

                Array.Clear(block);
                BuildSuperblock(
                    block, parameters, files.Count, totalBlocks, inodeTableIndex,
                    imageDigests.AsSpan(inodeTableIndex * 32, 32).ToArray());
                WriteBlock(superblockIndex, block);
                superblockIcv = block.AsSpan(
                    ProsperoOuterPfsSignature.SuperblockIcvOffset, 32).ToArray();
                image.Flush(flushToDisk: true);
            }

            if (encryptOutput)
            {
                var (tweak, data) = ProsperoPfsKeys.DeriveImageEncryptionKeys(ekpfs!, seed);
                using (var plaintext = new FileStream(
                           plaintextPath, FileMode.Open, FileAccess.Read, FileShare.Read,
                           bufferSize: 1 << 20, FileOptions.SequentialScan))
                using (var ciphertext = new FileStream(
                           ciphertextPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                           bufferSize: 1 << 20, FileOptions.SequentialScan))
                {
                    ProsperoOuterPfsImage.Transform(
                        plaintext, ciphertext, totalLength,
                        tweak, data, BlockSize, kinds, encrypt: true);
                    ciphertext.Flush(flushToDisk: true);
                }
                File.Move(ciphertextPath, outputFullPath, overwrite: true);
            }
            else if (!directOutput)
            {
                // Diagnostic/plaintext NAPS carrier. PFS hashes and ICV remain present;
                // only the final AES-XTS transform is omitted.
                File.Move(plaintextPath, outputFullPath, overwrite: true);
            }

            ProsperoPfsImageTreeInfo tree = BuildTreeInfo(
                totalBlocks, inodeTableIndex, superRootDirentIndex, fltIndex, urootDirentIndex,
                firstBlocks, blockCounts, files, lengths, seed, superblockIcv);
            completed = true;
            return new ProsperoOuterPackageFileResult
            {
                PfsSize = totalLength,
                ImageDigests = imageDigests,
                BlockCrc32C = blockCrc32C,
                SuperblockIcv = superblockIcv,
                SuperblockIndex = superblockIndex,
                InodeTableIndex = inodeTableIndex,
                SuperRootDirentIndex = superRootDirentIndex,
                FltIndex = fltIndex,
                UrootDirentIndex = urootDirentIndex,
                FileFirstBlock = firstBlocks,
                FileBlockCount = blockCounts,
                BlockKinds = kinds,
                Tree = tree,
            };
        }
        finally
        {
            if (!directOutput || !completed) TryDeleteFile(plaintextPath);
            TryDeleteFile(ciphertextPath);
        }
    }

    // Builds the self-consistent image-tree snapshot (super-root -> flat path table + uroot -> files)
    // from the fixed data-first inode template, mirroring the inode table this builder wrote.
    private static ProsperoPfsImageTreeInfo BuildTreeInfo(
        ProsperoOuterPfsBuildResult build, IReadOnlyList<ProsperoOuterFile> files,
        byte[] seed, byte[] superblockIcv)
    {
        long fltSize = FltDataOffset + (long)files.Count * 16;
        bool fileCompressed = (FlagsFile & 0x1u) != 0;

        var root = new ProsperoPfsImageNode
        {
            Name = "",
            IsDirectory = true,
            Internal = false,
            InodeNumber = 0,
            StartBlock = build.SuperRootDirentIndex,
            Blocks = 1,
            StoredSize = BlockSize,
            PlainSize = BlockSize,
            Flags = FlagsInternalMeta,
            Mode = ModeDir,
            Nlink = 1,
        };
        root.Children.Add(new ProsperoPfsImageNode
        {
            Name = FlatPathTableName,
            IsDirectory = false,
            Internal = true,
            InodeNumber = 1,
            StartBlock = build.FltIndex,
            Blocks = 1,
            StoredSize = fltSize,
            PlainSize = fltSize,
            Flags = FlagsInternalMeta,
            Mode = ModeFile,
            Nlink = 1,
        });

        var uroot = new ProsperoPfsImageNode
        {
            Name = UrootName,
            IsDirectory = true,
            InodeNumber = 2,
            StartBlock = build.UrootDirentIndex,
            Blocks = 1,
            StoredSize = BlockSize,
            PlainSize = BlockSize,
            Flags = FlagsDir,
            Mode = ModeDir,
            Nlink = 3,
        };
        for (int i = 0; i < files.Count; i++)
        {
            ProsperoOuterFile f = files[i];
            uroot.Children.Add(new ProsperoPfsImageNode
            {
                Name = f.Name,
                IsDirectory = false,
                InodeNumber = (uint)(MetadataInodeCount + i),
                StartBlock = build.FileFirstBlock[i],
                Blocks = (uint)build.FileBlockCount[i],
                StoredSize = f.Data.Length,
                PlainSize = f.SizeCompressed ?? f.Data.Length,
                Flags = FlagsFile,
                Mode = ModeFile,
                Nlink = 1,
                Compressed = fileCompressed,
            });
        }
        root.Children.Add(uroot);

        return new ProsperoPfsImageTreeInfo
        {
            BlockSize = BlockSize,
            ImageBlocks = build.BlockCount,
            InodeCount = MetadataInodeCount + files.Count,
            DinodeBlockCount = 1,
            RootInodeNumber = 0,
            DinodeBlock = build.InodeTableIndex,
            DinodeSize = BlockSize,
            DinodeFlags = 0,
            Seed = seed,
            SuperblockIcv = superblockIcv,
            Signed = true,
            Encrypted = true,
            Root = root,
        };
    }

    private static ProsperoPfsImageTreeInfo BuildTreeInfo(
        int imageBlocks, int inodeTableIndex, int superRootDirentIndex, int fltIndex,
        int urootDirentIndex, int[] firstBlocks, int[] blockCounts,
        IReadOnlyList<ProsperoOuterFileSource> files, long[] lengths,
        byte[] seed, byte[] superblockIcv)
    {
        long fltSize = FltDataOffset + (long)files.Count * 16;
        bool fileCompressed = (FlagsFile & 0x1u) != 0;
        var root = new ProsperoPfsImageNode
        {
            Name = "",
            IsDirectory = true,
            Internal = false,
            InodeNumber = 0,
            StartBlock = superRootDirentIndex,
            Blocks = 1,
            StoredSize = BlockSize,
            PlainSize = BlockSize,
            Flags = FlagsInternalMeta,
            Mode = ModeDir,
            Nlink = 1,
        };
        root.Children.Add(new ProsperoPfsImageNode
        {
            Name = FlatPathTableName,
            IsDirectory = false,
            Internal = true,
            InodeNumber = 1,
            StartBlock = fltIndex,
            Blocks = 1,
            StoredSize = fltSize,
            PlainSize = fltSize,
            Flags = FlagsInternalMeta,
            Mode = ModeFile,
            Nlink = 1,
        });
        var uroot = new ProsperoPfsImageNode
        {
            Name = UrootName,
            IsDirectory = true,
            InodeNumber = 2,
            StartBlock = urootDirentIndex,
            Blocks = 1,
            StoredSize = BlockSize,
            PlainSize = BlockSize,
            Flags = FlagsDir,
            Mode = ModeDir,
            Nlink = 3,
        };
        for (int i = 0; i < files.Count; i++)
        {
            uroot.Children.Add(new ProsperoPfsImageNode
            {
                Name = files[i].Name,
                IsDirectory = false,
                InodeNumber = (uint)(MetadataInodeCount + i),
                StartBlock = firstBlocks[i],
                Blocks = (uint)blockCounts[i],
                StoredSize = lengths[i],
                PlainSize = files[i].SizeCompressed ?? lengths[i],
                Flags = FlagsFile,
                Mode = ModeFile,
                Nlink = 1,
                Compressed = fileCompressed,
            });
        }
        root.Children.Add(uroot);
        return new ProsperoPfsImageTreeInfo
        {
            BlockSize = BlockSize,
            ImageBlocks = imageBlocks,
            InodeCount = MetadataInodeCount + files.Count,
            DinodeBlockCount = 1,
            RootInodeNumber = 0,
            DinodeBlock = inodeTableIndex,
            DinodeSize = BlockSize,
            DinodeFlags = 0,
            Seed = seed,
            SuperblockIcv = superblockIcv,
            Signed = true,
            Encrypted = true,
            Root = root,
        };
    }

    // ------------------------------------------------------------------ structural blocks

    private static void BuildSuperRootDirents(Span<byte> block)
    {
        using var ms = new MemoryStream(BlockSize);
        new PfsDirent { InodeNumber = 1, Type = DirentType.File, Name = FlatPathTableName }.WriteToStream(ms);
        new PfsDirent { InodeNumber = 2, Type = DirentType.Directory, Name = UrootName }.WriteToStream(ms);
        CopyStream(ms, block);
    }

    private static void BuildUrootDirents(Span<byte> block, IReadOnlyList<ProsperoOuterFile> files)
        => BuildUrootDirents(block, files.Count, i => files[i].Name);

    private static void BuildUrootDirents(
        Span<byte> block, int fileCount, Func<int, string> getName)
    {
        using var ms = new MemoryStream(BlockSize);
        // The uroot directory is inode 2 and references itself for "." and "..".
        new PfsDirent { InodeNumber = 2, Type = DirentType.Dot, Name = "." }.WriteToStream(ms);
        new PfsDirent { InodeNumber = 2, Type = DirentType.DotDot, Name = ".." }.WriteToStream(ms);
        for (int i = 0; i < fileCount; i++)
        {
            new PfsDirent
            {
                InodeNumber = (uint)(MetadataInodeCount + i),
                Type = DirentType.File,
                Name = getName(i),
            }.WriteToStream(ms);
        }
        CopyStream(ms, block);
    }

    private static void BuildFlatPathTable(Span<byte> block, IReadOnlyList<ProsperoOuterFile> files)
        => BuildFlatPathTable(block, files.Count, i => files[i].Name);

    private static void BuildFlatPathTable(
        Span<byte> block, int fileCount, Func<int, string> getName)
    {
        // Header (16 bytes): ver, hdrSize, dataOff, reserved.
        BinaryPrimitives.WriteUInt32LittleEndian(block[0x00..], FltVersion);
        BinaryPrimitives.WriteUInt32LittleEndian(block[0x04..], FltHeaderSize);
        BinaryPrimitives.WriteUInt32LittleEndian(block[0x08..], FltDataOffset);
        // Magic + reserved + entry count @0x20.
        FltMagic.CopyTo(block[0x20..]);
        BinaryPrimitives.WriteUInt32LittleEndian(block[0x2C..], (uint)fileCount);
        // Two fixed FLT seeds @0x30.
        BinaryPrimitives.WriteUInt64LittleEndian(block[0x30..], FltSeed0);
        BinaryPrimitives.WriteUInt64LittleEndian(block[0x38..], FltSeed1);
        // One 16-byte entry per file: { u64 pathHash, u64 inode | fileOrdinal<<40 }.
        int off = (int)FltDataOffset;
        for (int i = 0; i < fileCount; i++)
        {
            ulong inode = (ulong)(uint)(MetadataInodeCount + i);
            ulong packed = inode | ((ulong)(uint)i << 40);
            BinaryPrimitives.WriteUInt64LittleEndian(block[off..], FltPathHash(getName(i)));
            BinaryPrimitives.WriteUInt64LittleEndian(block[(off + 8)..], packed);
            off += 16;
        }
    }

    // ------------------------------------------------------------------ inode table + superblock

    private static void BuildInodeTable(
        byte[] image, int inodeTableIndex, ProsperoOuterPfsBuildParameters p,
        IReadOnlyList<ProsperoOuterFile> files,
        int[] fileFirstBlock, int[] fileBlockCount,
        IndirectTreePlan[][] indirectPlans,
        int superRootDirentIndex, int fltIndex, int urootDirentIndex)
    {
        var inodes = new List<DinodeS32>(MetadataInodeCount + files.Count);

        // inode 0: super-root directory (owns the super-root dirent block).
        inodes.Add(MakeMetaInode(ModeDir, nlink: 1, FlagsInternalMeta, size: BlockSize, p,
            image, new[] { superRootDirentIndex }));

        // inode 1: inode_flat_path_table file (owns the FLT block). Size = FLT content length.
        long fltSize = FltDataOffset + (long)files.Count * 16;
        inodes.Add(MakeMetaInode(ModeFile, nlink: 1, FlagsInternalMeta, size: fltSize, p,
            image, new[] { fltIndex }));

        // inode 2: uroot directory (owns the uroot dirent block). nlink = 2 + subdirectories (none here) + 1.
        inodes.Add(MakeMetaInode(ModeDir, nlink: 3, FlagsDir, size: BlockSize, p,
            image, new[] { urootDirentIndex }));

        // inode 3..: the outer files in order. Every file (signed metadata blob AND the plain-data
        // pfs_image.dat) stores a per-block SHA3 signature in its direct-block table; files whose block
        // count exceeds the 12 direct slots spill into ib[0]..ib[4]. ib[n] is a signed
        // {SHA3-256,block} tree of depth n+1.
        for (int i = 0; i < files.Count; i++)
        {
            ProsperoOuterFile f = files[i];
            int firstBlock = fileFirstBlock[i];
            int blockCount = fileBlockCount[i];

            var di = new DinodeS32
            {
                Mode = (InodeMode)ModeFile,
                Nlink = 1,
                Flags = (InodeFlags)FlagsFile,
                Size = f.Data.Length,
                SizeCompressed = f.SizeCompressed ?? f.Data.Length,
                Blocks = (uint)blockCount,
            };
            StampTime(di, p);

            int directCount = Math.Min(blockCount, di.db.Length);
            for (int j = 0; j < directCount; j++)
            {
                int blk = firstBlock + j;
                di.db[j].sig = ProsperoOuterPfsSignature.ComputeBlockHash(
                    image.AsSpan(blk * BlockSize, BlockSize));
                di.db[j].block = blk;
            }

            foreach (IndirectTreePlan treePlan in indirectPlans[i])
            {
                void CopyImageDigest(int dataBlock, Span<byte> destination)
                {
                    byte[] hash = ProsperoOuterPfsSignature.ComputeBlockHash(
                        image.AsSpan(dataBlock * BlockSize, BlockSize));
                    hash.CopyTo(destination);
                }
                void StoreMapBlock(int mapBlock, byte[] bytes)
                {
                    bytes.CopyTo(image, mapBlock * BlockSize);
                }
                byte[] rootHash = WriteIndirectTree(
                    treePlan.Root, firstBlock, CopyImageDigest, StoreMapBlock);
                di.ib[treePlan.InodeLevel].sig = rootHash;
                di.ib[treePlan.InodeLevel].block = treePlan.Root.BlockIndex;
            }
            inodes.Add(di);
        }

        // Serialize the inode table into block D+1.
        using var ms = new MemoryStream(BlockSize);
        foreach (DinodeS32 di in inodes) di.WriteToStream(ms);
        CopyStream(ms, image.AsSpan(inodeTableIndex * BlockSize, BlockSize));
    }

    private static DinodeS32 MakeMetaInode(
        ushort mode, ushort nlink, uint flags, long size,
        ProsperoOuterPfsBuildParameters p, byte[] image, int[] ownedBlocks)
    {
        var di = new DinodeS32
        {
            Mode = (InodeMode)mode,
            Nlink = nlink,
            Flags = (InodeFlags)flags,
            Size = size,
            SizeCompressed = size,
        };
        StampTime(di, p);
        FillSignedBlocks(di, image, ownedBlocks);
        return di;
    }

    private static void StampTime(DinodeS32 di, ProsperoOuterPfsBuildParameters p)
    {
        di.Time1_sec = di.Time2_sec = di.Time3_sec = di.Time4_sec = p.TimestampSeconds;
        di.Time1_nsec = di.Time2_nsec = di.Time3_nsec = di.Time4_nsec = p.TimestampNanoseconds;
    }

    // Fills a signed dinode's direct-block entries with { SHA3-256(plaintext block), block index }.
    private static void FillSignedBlocks(DinodeS32 di, byte[] image, int[] blocks)
    {
        di.Blocks = (uint)blocks.Length;
        for (int j = 0; j < blocks.Length; j++)
        {
            int blk = blocks[j];
            byte[] hash = ProsperoOuterPfsSignature.ComputeBlockHash(
                image.AsSpan(blk * BlockSize, BlockSize));
            di.db[j].sig = hash;
            di.db[j].block = blk;
        }
    }

    private static void BuildSuperblock(
        Span<byte> block, ProsperoOuterPfsBuildParameters p,
        int fileCount, int totalBlocks, int inodeTableIndex, byte[] inodeTableHash)
    {
        int ninodes = MetadataInodeCount + fileCount;

        // The super-root inode is embedded in the superblock as its InodeBlockSig (DinodeS64),
        // storing SHA3-256(inode table) at sb+0xb8 and the inode-table block index at sb+0xd8.
        var superRoot = new DinodeS64
        {
            Mode = 0,
            Nlink = 1,
            Flags = 0,
            Size = BlockSize,
            SizeCompressed = BlockSize,
            Blocks = 1,
        };
        superRoot.Time1_sec = superRoot.Time2_sec = superRoot.Time3_sec = superRoot.Time4_sec = p.TimestampSeconds;
        superRoot.Time1_nsec = superRoot.Time2_nsec = superRoot.Time3_nsec = superRoot.Time4_nsec = p.TimestampNanoseconds;
        superRoot.db[0].sig = inodeTableHash;
        superRoot.db[0].block = inodeTableIndex;

        var hdr = new PfsHeader
        {
            Version = PfsHeader.VersionPs5,
            ReadOnly = 1,
            Mode = (PfsMode)0x0D,
            BlockSize = BlockSize,
            NBlock = 1,
            DinodeCount = ninodes,
            Ndblock = totalBlocks,
            DinodeBlockCount = 1,
            UnknownIndex = 1,
            Seed = p.Seed ?? new byte[16],
            InodeBlockSig = superRoot,
        };

        using var ms = new MemoryStream(BlockSize);
        hdr.WriteToStream(ms);
        CopyStream(ms, block);

        // The ICV covers superblock[0:0x5a0] with its own field zeroed.
        ProsperoOuterPfsSignature.WriteSuperblockIcv(block);
    }

    // ------------------------------------------------------------------ FLT path hash

    private static ulong Rotl(ulong x, int n) => (x << n) | (x >> (64 - n));
    private static ulong Rotr(ulong x, int n) => (x >> n) | (x << (64 - n));

    /// <summary>
    /// The \x7fFLT path hash: a custom 3-lane reduced-Keccak permutation over the UPPERCASED ASCII
    /// file name, with two fixed 64-bit seeds and round constant 0x8000000080008081.
    /// </summary>
    internal static ulong FltPathHash(string name)
    {
        byte[] nm = new byte[name.Length];
        for (int i = 0; i < name.Length; i++)
        {
            char ch = name[i];
            if (ch is >= 'a' and <= 'z') ch = (char)(ch - 32);
            nm[i] = (byte)ch;
        }

        int n = nm.Length;
        ulong a = FltSeed0;
        ulong b = Rotl(FltSeed0, 11);
        ulong c = Rotl(FltSeed0, 23);
        ulong tail = 0;

        if (n != 0)
        {
            int nwords = (n - 1) >> 3;
            int pos = 0;
            for (int w = 0; w < nwords; w++)
            {
                ulong word = BinaryPrimitives.ReadUInt64LittleEndian(nm.AsSpan(pos, 8));
                a ^= word;
                ulong t18 = Rotr(Rotl(c ^ b, 5) ^ a, 11);
                ulong t12 = Rotl(Rotl(c ^ a, 17) ^ b, 11);
                ulong c2 = Rotr(Rotl(b ^ a, 1) ^ c, 5);
                a = (~t12 & c2) ^ t18 ^ FltRoundConstant;
                b = (~c2 & t18) ^ t12;
                c = (~t18 & t12) ^ c2;
                pos += 8;
            }
            int rem = ((n - 1) & 7) + 1;
            Span<byte> tb = stackalloc byte[8];
            tb.Clear();
            nm.AsSpan(pos, rem).CopyTo(tb);
            tail = BinaryPrimitives.ReadUInt64LittleEndian(tb);
        }

        ulong x16 = b, x11 = c, x6 = tail ^ a ^ FltSeed1;
        ulong u17 = Rotl(x11 ^ x16, 5) ^ x6;
        ulong u18 = Rotl(x11 ^ x6, 17) ^ x16;
        ulong x11b = Rotl(x16 ^ x6, 1) ^ x11;
        return (~Rotl(u18, 11) & Rotr(x11b, 5)) ^ Rotr(u17, 11) ^ FltRoundConstant;
    }

    // ------------------------------------------------------------------ helpers

    private static void CopyStream(MemoryStream ms, Span<byte> dest)
    {
        if (ms.Length > dest.Length)
            throw new InvalidOperationException(
                $"Serialized {ms.Length} bytes exceeds the {dest.Length}-byte block.");
        ms.GetBuffer().AsSpan(0, (int)ms.Length).CopyTo(dest);
    }

    private static void TryDeleteFile(string path)
    {
        try
        {
            if (File.Exists(path))
                File.Delete(path);
        }
        catch
        {
            // Best-effort cleanup of builder-owned temporary files.
        }
    }

}
