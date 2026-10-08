// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// PFS image structures, builder and reader primitives.
#nullable disable
using LibProsperoPkg.Util;
using System;
using System.Collections.Generic;
using System.IO;
using System.IO.MemoryMappedFiles;
using System.Linq;

namespace LibProsperoPkg.PFS;

/// <summary>
/// Class allowing parallel readonly access to a PFS archive
/// </summary>
public class PfsReader
{
    /// <summary>
    /// Represents a file or directory in a PFS image.
    /// </summary>
    public abstract class Node
    {
        public Dir parent;
        public string name;
        public long offset;
        public long size;
        public long compressed_size;
        public uint ino;
        public string FullName => parent != null ? parent.FullName + "/" + name : name;
    }
    /// <summary>
    /// Represents a directory in a PFS image.
    /// </summary>
    public class Dir : Node
    {
        public List<Node> children = new List<Node>();
        public Node Get(string name)
          => children.Where(x => x.name == name).FirstOrDefault();
        public Node GetPath(string name)
        {
            var breadcrumbs = name.Split('/');
            Node n = this;
            var bc = 0;
            while (n != null && bc < breadcrumbs.Length)
            {
                n = (n as Dir)?.Get(breadcrumbs[bc]);
                bc++;
            }
            if (bc < breadcrumbs.Length)
            {
                return null;
            }
            return n;
        }
        public IEnumerable<File> GetAllFiles()
        {
            foreach (var n in children)
            {
                if (n is File f) yield return f;
                if (n is Dir d)
                    foreach (var x in d.GetAllFiles())
                        yield return x;
            }
        }
    }
    /// <summary>
    /// Represents a file in a PFS image.
    /// </summary>
    public class File : Node
    {
        public InodeFlags flags;
        public int blockSize;
        public int[] blocks;
        private IMemoryReader reader;
        public File(IMemoryReader r) { reader = r; }
        public IMemoryReader GetView()
        {
            if (blocks != null)
                return new ChunkedMemoryReader(reader, blockSize, blocks);
            return new MemoryAccessor(reader, offset);
        }
        public void Save(string path, bool decompress = false)
        {
            using (var file = new FileStream(path, FileMode.Create, FileAccess.Write, FileShare.None))
            {
                CopyTo(file, decompress);
            }
        }

        /// <summary>Copies this inode to an arbitrary writable stream.</summary>
        public void CopyTo(Stream destination, bool decompress = false)
        {
            if (destination == null) throw new ArgumentNullException(nameof(destination));
            if (!destination.CanWrite) throw new ArgumentException("Destination must be writable.", nameof(destination));
            var buf = new byte[blockSize];
            bool isCompressed = flags.HasFlag(InodeFlags.compressed);
            var sz = size;
            long pos = 0;
            var source = GetView();
            if (decompress && isCompressed)
            {
                sz = compressed_size;
                source = new PFSCReader(source);
            }
            if (destination.CanSeek) destination.SetLength(sz);
            while (sz > 0)
            {
                var toRead = (int)Math.Min(sz, buf.Length);
                source.Read(pos, buf, 0, toRead);
                destination.Write(buf, 0, toRead);
                pos += toRead;
                sz -= toRead;
            }
        }

        /// <summary>Reads the complete inode into memory.</summary>
        public byte[] ReadAllBytes(bool decompress = false)
        {
            using var memory = new MemoryStream();
            CopyTo(memory, decompress);
            return memory.ToArray();
        }
    }

    // Private state for the PfsReader class
    private IMemoryReader reader;
    private PfsHeader hdr;
    private Inode[] dinodes;
    private Dir root;
    private Dir uroot;
    private byte[] sectorBuf;
    private Stream sectorStream;

    public PfsReader(MemoryMappedViewAccessor r, ulong pfs_flags = 0, byte[] ekpfs = null, byte[] tweak = null, byte[] data = null)
    : this(new MemoryMappedViewAccessor_(r), pfs_flags, ekpfs, tweak, data, 0)
    { }
    public PfsReader(
        MemoryMappedViewAccessor r,
        long superblockOffset,
        bool encryptedDataAlreadyDecrypted = false,
        ulong pfs_flags = 0,
        byte[] ekpfs = null,
        byte[] tweak = null,
        byte[] data = null)
        : this(
            new MemoryMappedViewAccessor_(r), pfs_flags, ekpfs, tweak, data,
            superblockOffset, encryptedDataAlreadyDecrypted)
    { }
    public PfsReader(IMemoryReader r, ulong pfs_flags = 0, byte[] ekpfs = null, byte[] tweak = null, byte[] data = null, long superblockOffset = 0, bool encryptedDataAlreadyDecrypted = false)
    {
        if (superblockOffset < 0) throw new ArgumentOutOfRangeException(nameof(superblockOffset));
        reader = r;
        var buf = new byte[0x400];
        reader.Read(superblockOffset, buf, 0, 0x400);

        using (var ms = new MemoryStream(buf))
        {
            hdr = PfsHeader.ReadFromStream(ms);
        }
        int dinodeSize;
        Func<Stream, Inode> dinodeReader;
        bool is64 = hdr.Mode.HasFlag(PfsMode.Is64Bit);
        bool pprDirectOffsets = hdr.Mode.HasFlag(PfsMode.PprDirectOffsets);
        if (pprDirectOffsets)
        {
            dinodes = new DinodePpr[hdr.DinodeCount];
            dinodeReader = DinodePpr.ReadFromStream;
            dinodeSize = (int)DinodePpr.SizeOf;
        }
        else if (hdr.Mode.HasFlag(PfsMode.Signed))
        {
            // PS5 signed images use 64-bit block pointers in their inodes.
            if (is64)
            {
                dinodes = new DinodeS64[hdr.DinodeCount];
                dinodeReader = DinodeS64.ReadFromStream;
                dinodeSize = (int)DinodeS64.SizeOf; // 0x310
            }
            else
            {
                dinodes = new DinodeS32[hdr.DinodeCount];
                dinodeReader = DinodeS32.ReadFromStream;
                dinodeSize = (int)DinodeS32.SizeOf; // 0x2C8
            }
        }
        else
        {
            dinodes = new DinodeD32[hdr.DinodeCount];
            dinodeReader = DinodeD32.ReadFromStream;
            dinodeSize = (int)DinodeD32.SizeOf; // 0xA8
        }
        if (hdr.Mode.HasFlag(PfsMode.Encrypted) && !encryptedDataAlreadyDecrypted)
        {
            const int XtsSectorSize = 0x1000;
            uint XtsStartSector = hdr.BlockSize / XtsSectorSize;
            if (ekpfs == null && (tweak == null || data == null))
                throw new ArgumentException("PFS image is encrypted but no decryption key was provided");
            if (ekpfs != null)
            {
                var (tweakKey, dataKey) = Crypto.PfsGenEncKey(ekpfs, hdr.Seed, (pfs_flags & 0x2000000000000000UL) != 0);
                reader = new XtsDecryptReader(reader, dataKey, tweakKey, XtsStartSector, XtsSectorSize);
            }
            else
            {
                reader = new XtsDecryptReader(reader, data, tweak, XtsStartSector, XtsSectorSize);
            }
        }
        var total = 0;

        var maxPerSector = hdr.BlockSize / dinodeSize;
        sectorBuf = new byte[hdr.BlockSize];
        sectorStream = new MemoryStream(sectorBuf);
        // The inode table is described by the superblock's signed inode descriptor. Publisher PPR-PFS
        // images commonly place a signature/metadata block at block 1 and the inode table at block 2,
        // so deriving this as "one block after the superblock" reads the wrong bytes.
        var dinodeStartPos = (long)hdr.InodeBlockSig.StartBlock * hdr.BlockSize;
        for (var i = 0; i < hdr.DinodeBlockCount; i++)
        {
            var position = dinodeStartPos + (hdr.BlockSize * i);
            reader.Read(position, sectorBuf, 0, sectorBuf.Length);
            sectorStream.Position = 0;
            for (var j = 0; j < maxPerSector && total < hdr.DinodeCount; j++)
                dinodes[total++] = dinodeReader(sectorStream);
        }
        root = LoadDir(0, null, "");
        uroot = root.Get("uroot") as Dir;
        if (uroot == null)
        {
            // Publisher PPR-PFS images use inode 0 as the user root directly and omit the classic
            // super-root / flat_path_table wrapper.
            uroot = root;
        }
        else
        {
            uroot.name = "uroot";
        }
    }

    public PfsHeader Header => hdr;

    public File GetFile(string fullPath)
    {
        return uroot.GetPath(fullPath) as File;
    }

    public IEnumerable<File> GetAllFiles()
    {
        return uroot.GetAllFiles();
    }

    public Dir GetURoot()
    {
        return uroot;
    }

    public Dir GetSuperRoot()
    {
        return root;
    }

    private Dir LoadDir(uint dinode, Dir parent, string name)
    {
        // 100M blocks is enough for a 6TB file.
        const int MAX_BLOCKS = 100_000_000;
        var ret = new Dir() { name = name, parent = parent };
        var ino = dinodes[dinode];
        var postLoad = new List<Func<Dir>>();
        bool pprDirect = ino is DinodePpr;
        var blocks = pprDirect
            ? checked((int)Math.Max(1, (ino.Size + hdr.BlockSize - 1) / hdr.BlockSize))
            : (int)ino.Blocks;
        long firstOffset = pprDirect ? ((DinodePpr)ino).DataOffset : (long)ino.StartBlock * hdr.BlockSize;
        if (blocks < 1 || firstOffset < 0
            || firstOffset / hdr.BlockSize > MAX_BLOCKS || blocks > MAX_BLOCKS)
        {
            throw new Exception($"Inode {dinode} is corrupt. ");
        }
        for (int block = 0; block < blocks; block++)
        {
            long blockOffset = checked(firstOffset + (long)block * hdr.BlockSize);
            long position = blockOffset;
            reader.Read(blockOffset, sectorBuf, 0, sectorBuf.Length);
            sectorStream.Position = 0;
            while (position < blockOffset + hdr.BlockSize)
            {
                var dirent = PfsDirent.ReadFromStream(sectorStream);
                if (dirent.EntSize == 0) break;
                switch (dirent.Type)
                {
                    case DirentType.File:
                        ret.children.Add(LoadFile(dirent.InodeNumber, ret, dirent.Name));
                        break;
                    case DirentType.Directory:
                        postLoad.Add(() => LoadDir(dirent.InodeNumber, ret, dirent.Name));
                        break;
                    case DirentType.Dot:
                        break;
                    case DirentType.DotDot:
                        break;
                    default:
                        break;
                }
                position += dirent.EntSize;
            }
        }
        foreach (var p in postLoad)
        {
            ret.children.Add(p());
        }
        return ret;
    }

    private File LoadFile(uint dinode, Dir parent, string name)
    {
        int[] blocks = null;
        if (dinodes[dinode].Blocks > 1)
        {
            if (!hdr.Mode.HasFlag(PfsMode.Signed))
            {
                // Publisher unsigned PPR-PFS images fill more than one direct pointer even though the
                // file extent itself is contiguous. StartBlock + Blocks is sufficient in this profile.
                blocks = null;
            }
            else
            {
                int fileBlockCount = checked((int)dinodes[dinode].Blocks);
                blocks = new int[fileBlockCount];
                int outputIndex = 0;
                int remainingBlocks = fileBlockCount;
                int directCount = Math.Min(
                    remainingBlocks, dinodes[dinode].DirectBlocks.Count);
                for (int i = 0; i < directCount; i++)
                {
                    int block = dinodes[dinode].DirectBlocks[i];
                    if (block < 0)
                        throw new InvalidDataException(
                            $"Signed inode {dinode} has an invalid direct block {block} at db[{i}].");
                    blocks[outputIndex++] = block;
                }

                var bufferedReader = new BufferedMemoryReader(reader, 0x10000);
                remainingBlocks -= directCount;
                int entriesPerBlock = checked((int)(hdr.BlockSize / 36));

                void ReadIndirectNode(int mapBlock, int depth)
                {
                    if (mapBlock <= 0)
                        throw new InvalidDataException(
                            $"Signed inode {dinode} has a missing depth-{depth} indirect map.");
                    long mapOffset = checked((long)mapBlock * hdr.BlockSize);
                    for (int entry = 0; entry < entriesPerBlock && remainingBlocks > 0; entry++)
                    {
                        bufferedReader.Read(
                            checked(mapOffset + entry * 36L + 32), out int referencedBlock);
                        if (referencedBlock < 0)
                            throw new InvalidDataException(
                                $"Signed inode {dinode} has a negative indirect block pointer.");
                        if (depth == 1)
                        {
                            blocks[outputIndex++] = referencedBlock;
                            remainingBlocks--;
                        }
                        else
                        {
                            ReadIndirectNode(referencedBlock, depth - 1);
                        }
                    }
                }

                IList<int> indirectBlocks = dinodes[dinode].IndirectBlocks;
                for (int level = 0; level < indirectBlocks.Count && remainingBlocks > 0; level++)
                    ReadIndirectNode(indirectBlocks[level], level + 1);
                if (remainingBlocks != 0)
                    throw new InvalidDataException(
                        $"Signed inode {dinode} is missing mappings for {remainingBlocks} data blocks.");

                bool contiguous = true;
                for (int i = 1; i < blocks.Length; i++)
                {
                    if (blocks[i - 1] + 1 != blocks[i])
                    {
                        contiguous = false;
                        break;
                    }
                }
                if (contiguous)
                    blocks = null;
            }
        }
        return new File(reader)
        {
            name = name,
            parent = parent,
            offset = dinodes[dinode] is DinodePpr ppr
                ? ppr.DataOffset
                : (long)dinodes[dinode].StartBlock * hdr.BlockSize,
            size = dinodes[dinode].Size,
            compressed_size = dinodes[dinode].SizeCompressed,
            ino = dinode,
            blocks = blocks,
            flags = dinodes[dinode].Flags,
            blockSize = (int)hdr.BlockSize
        };
    }
}
