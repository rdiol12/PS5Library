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
using System.Security.Cryptography;
using System.Threading.Tasks;

namespace LibProsperoPkg.PFS;

/// <summary>
/// Contains the functionality to construct a PFS disk image.
/// </summary>
public class PfsBuilder
{
    static int CeilDiv(int a, int b) => a / b + (a % b == 0 ? 0 : 1);
    static long CeilDiv(long a, long b) => a / b + (a % b == 0 ? 0 : 1);

    private PfsHeader hdr;
    private List<Inode> inodes;
    private List<PfsDirent> super_root_dirents;

    private Inode super_root_ino, fpt_ino, cr_ino;

    private List<FSDir> allDirs;
    private List<FSFile> allFiles;
    private List<FSNode> allNodes;

    private FlatPathTable fpt;
    private CollisionResolver colResolver;

    private PfsProperties properties;

    private int emptyBlock = 0x4;
    const int xtsSectorSize = 0x1000;

    private struct BlockSigInfo
    {
        public long Block;
        public long SigOffset;
        public int Size;
        public BlockSigInfo(long block, long offset, int size = 0x10000)
        {
            Block = block;
            SigOffset = offset;
            Size = size;
        }
    }
    private Stack<BlockSigInfo> final_sigs = new Stack<BlockSigInfo>();
    private Stack<BlockSigInfo> data_sigs = new Stack<BlockSigInfo>();

    /// <summary>
    /// When set before <see cref="WriteImage(Stream)"/>, captures the <c>sce_sys/imagedigs.dat</c>
    /// preimage into <see cref="ImageDigests"/>: one per-block descriptor digest for every
    /// block of the plaintext signed image, stored from last byte to first. The PS5 image builder
    /// gathers the signer's per-block HMAC-SHA256 descriptor digests and writes each digest from
    /// byte 31 down to byte 0; reproduced here from this image's own signing key. Populated only for a signed image.
    /// </summary>
    public bool CaptureImageDigests;

    /// <summary>
    /// The captured <c>imagedigs.dat</c> body (N * 32 bytes for N image blocks), or <c>null</c> until
    /// a signed image is written with <see cref="CaptureImageDigests"/> set. See that property.
    /// </summary>
    public byte[] ImageDigests;

    /// <summary>
    /// When set before <see cref="WriteImage(Stream)"/>, captures this image's superblock integrity
    /// value into <see cref="SuperblockIcv"/>: the 32-byte HMAC-SHA256 self-signature of the
    /// superblock (final signature block 0 @ offset 0x380), computed from this image's own signing
    /// key during signing (before XTS encryption). Used for the supplemental <c>pfsimage.xml</c>
    /// <c>&lt;icv&gt;</c> element. Populated only for a signed image.
    /// </summary>
    public bool CaptureSuperblockIcv;

    /// <summary>
    /// The captured 32-byte superblock ICV (see <see cref="CaptureSuperblockIcv"/>), or <c>null</c>
    /// until a signed image is written with that flag set.
    /// </summary>
    public byte[] SuperblockIcv;

    Action<string> logger;
    private void Log(string s) => logger?.Invoke(s);

    /// <summary>
    /// Constructs a PfsBuilder with the given properties and logger.
    /// </summary>
    /// <param name="p">Properties for the image to be built</param>
    /// <param name="logger">Function that is called to report realtime PFS build status.</param>
    public PfsBuilder(PfsProperties p, Action<string> logger = null)
    {
        this.logger = logger;
        properties = p;
        Setup();
    }

    /// <summary>
    /// Computes the final size of this image as it will be written to disk.
    /// </summary>
    /// <returns>PFS Image size</returns>
    public long CalculatePfsSize()
    {
        return checked(hdr.Ndblock * hdr.BlockSize);
    }

    /// <summary>
    /// Captures a self-consistent snapshot of this image's inode tree and geometry AFTER
    /// <see cref="WriteImage(Stream)"/> has assigned every inode's block layout (and, for a signed
    /// image with <see cref="CaptureSuperblockIcv"/> set, computed the superblock ICV). The snapshot
    /// drives the supplemental <c>pfsimage.xml</c> sections (<c>&lt;pfs-image&gt;</c> /
    /// <c>&lt;nested-image&gt;</c>), which describe the exact bytes this builder produced.
    /// </summary>
    /// <returns>A snapshot of the built image's super-root tree and superblock geometry.</returns>
    public ProsperoPfsImageTreeInfo CaptureImageTree()
    {
        if (properties.DirectRootLayout)
        {
            var directRoot = ImageNodeFromDir(properties.root);
            return new ProsperoPfsImageTreeInfo
            {
                BlockSize = (int)hdr.BlockSize,
                ImageBlocks = hdr.Ndblock,
                InodeCount = inodes.Count,
                DinodeBlockCount = (int)hdr.DinodeBlockCount,
                RootInodeNumber = properties.root.ino.Number,
                DinodeBlock = hdr.InodeBlockSig.StartBlock,
                DinodeSize = hdr.InodeBlockSig.Size,
                DinodeFlags = (uint)hdr.InodeBlockSig.Flags,
                Seed = hdr.Seed,
                SuperblockIcv = SuperblockIcv,
                Signed = false,
                Encrypted = false,
                Root = directRoot,
            };
        }

        var root = ImageNodeFromInode(super_root_ino, name: "", isDir: true, isInternal: false);

        // The PFS super-root holds the flat path table (+ optional collision resolver) and the user
        // root ("uroot"). These internal pseudo files are not part of the user tree, so synthesize
        // them from their dedicated inodes to mirror the reference super-root layout.
        root.Children.Add(ImageNodeFromInode(fpt_ino, "inode_flat_path_table", isDir: false, isInternal: true));
        if (cr_ino != null)
            root.Children.Add(ImageNodeFromInode(cr_ino, "collision_resolver", isDir: false, isInternal: true));
        root.Children.Add(ImageNodeFromDir(properties.root));

        return new ProsperoPfsImageTreeInfo
        {
            BlockSize = (int)hdr.BlockSize,
            ImageBlocks = hdr.Ndblock,
            InodeCount = inodes.Count,
            DinodeBlockCount = (int)hdr.DinodeBlockCount,
            RootInodeNumber = super_root_ino.Number,
            DinodeBlock = hdr.InodeBlockSig.StartBlock,
            DinodeSize = hdr.InodeBlockSig.Size,
            DinodeFlags = (uint)hdr.InodeBlockSig.Flags,
            Seed = hdr.Seed,
            SuperblockIcv = SuperblockIcv,
            Signed = hdr.Mode.HasFlag(PfsMode.Signed),
            Encrypted = hdr.Mode.HasFlag(PfsMode.Encrypted),
            Root = root,
        };
    }

    static ProsperoPfsImageNode ImageNodeFromInode(Inode ino, string name, bool isDir, bool isInternal) => new()
    {
        Name = name,
        IsDirectory = isDir,
        Internal = isInternal,
        InodeNumber = ino.Number,
        StoredSize = ino.Size,
        PlainSize = ino.SizeCompressed == 0 ? ino.Size : ino.SizeCompressed,
        Flags = (uint)ino.Flags,
        Mode = (ushort)ino.Mode,
        Nlink = ino.Nlink,
        StartBlock = ino.StartBlock,
        Blocks = ino.Blocks,
        Compressed = (ino.Flags & InodeFlags.compressed) != 0,
    };

    static ProsperoPfsImageNode ImageNodeFromDir(FSDir dir)
    {
        var node = ImageNodeFromFsNode(dir, isDir: true);
        foreach (var d in dir.Dirs.OrderBy(d => d.name, StringComparer.Ordinal))
            node.Children.Add(ImageNodeFromDir(d));
        // Files whose sce_sys path is a known outer-CNT entry are filtered out of the inner image in
        // Setup() (they receive no inode and no dirent), yet they linger in the in-memory FSDir.Files
        // list. Skip any file that never got an inode so the snapshot mirrors the materialized image
        // rather than the pre-filter tree (otherwise such a node would collide on inode 0).
        foreach (var f in dir.Files.Where(f => f.ino != null).OrderBy(f => f.name, StringComparer.Ordinal))
            node.Children.Add(ImageNodeFromFsNode(f, isDir: false));
        return node;
    }

    static ProsperoPfsImageNode ImageNodeFromFsNode(FSNode n, bool isDir)
    {
        var ino = n.ino;
        return new ProsperoPfsImageNode
        {
            Name = n.name ?? "",
            IsDirectory = isDir,
            InodeNumber = ino?.Number ?? 0,
            StoredSize = ino?.Size ?? n.Size,
            PlainSize = ino != null ? (ino.SizeCompressed == 0 ? ino.Size : ino.SizeCompressed) : n.CompressedSize,
            Flags = (uint)(ino?.Flags ?? 0),
            Mode = (ushort)(ino?.Mode ?? 0),
            Nlink = ino?.Nlink ?? 0,
            StartBlock = ino?.StartBlock ?? 0,
            Blocks = ino?.Blocks ?? 0,
            Compressed = ino != null && (ino.Flags & InodeFlags.compressed) != 0,
        };
    }

    /// <summary>
    /// This gets called by the constructor.
    /// </summary>
    void Setup()
    {
        // TODO: Combine the superroot-specific stuff with the rest of the data block writing.
        // I think this is as simple as adding superroot and flat_path_table to allNodes

        // Insert header digest to be calculated with the rest of the digests
        final_sigs.Push(new BlockSigInfo(0, 0x380, 0x5A0));
        hdr = new PfsHeader
        {
            Version = properties.Version,
            BlockSize = properties.BlockSize,
            ReadOnly = 1,
            Mode = (properties.Sign ? PfsMode.Signed : 0)
               | (properties.Encrypt ? PfsMode.Encrypted : 0)
               | PfsMode.UnknownFlagAlwaysSet,
            UnknownIndex = 1,
            Seed = properties.Encrypt || properties.Sign ? properties.Seed : null
        };
        inodes = new List<Inode>();

        Log("Setting up filesystem structure...");
        allDirs = properties.root.GetAllChildrenDirs();
        allFiles = properties.root.GetAllChildrenFiles().Where((f) =>
        {
            if (!properties.FilterOuterPackageEntries)
                return true;
            bool is_sce_sys = false;
            var name = f.name;
            var parent = f.Parent;
            while (parent != null && parent != properties.root)
            {
                if (parent.Parent == properties.root && parent.name == "sce_sys")
                {
                    is_sce_sys = true;
                    break;
                }
                name = parent.name + "/" + name;
                parent = parent.Parent;
            }
            // param.json is the named CNT entry 0x2000 but is intentionally not part of
            // EntryNames (the enum table contains the legacy param.sfo mapping instead).
            // Treat it like the other outer sce_sys records so a high-level package build
            // cannot leave a duplicate copy in the nested PPR-PFS image.
            bool isOuterEntry = name.Equals("param.json", StringComparison.Ordinal) ||
                PKG.EntryNames.NameToId.ContainsKey(name);
            return !is_sce_sys || !isOuterEntry;
        }).ToList();
        if (properties.OptimizeFileLayoutForReadSpeed)
        {
            // Put startup-sensitive and small random-access files into adjacent early extents.
            // Besides reducing seeks, this lets the outer PFSC planner cover them with fewer raw
            // 256 KiB groups while leaving large sequential assets available for Kraken.
            allFiles = allFiles
                .OrderBy(static file => file.LayoutPriority)
                .ThenBy(static file => file.FullPath(), StringComparer.Ordinal)
                .ToList();
        }
        allNodes = new List<FSNode>(allDirs.OrderBy(d => d.FullPath()).ToList());
        allNodes.AddRange(allFiles);

        if (properties.DirectRootLayout)
            SetupDirectRootStructure();
        else
            SetupRootStructure(FlatPathTable.HasCollision(allNodes));

        Log($"Creating inodes ({allDirs.Count} dirs and {allFiles.Count} files)...");
        addDirInodes();
        addFileInodes();

        if (!properties.DirectRootLayout)
            (fpt, colResolver) = FlatPathTable.Create(allNodes);

        Log("Calculating data block layout...");
        allNodes.Insert(0, properties.root);
        CalculateDataBlockLayout();
    }

    private void WriteData(Stream stream)
    {
        Log("Writing data...");
        hdr.WriteToStream(stream);
        if (properties.DirectRootLayout)
            WriteDirectRootInodeBitmap(stream);
        WriteInodes(stream);
        if (!properties.DirectRootLayout)
        {
            WriteSuperrootDirents(stream);
            stream.Position = checked((long)fpt_ino.StartBlock * hdr.BlockSize);
            fpt.WriteToStream(stream);
            if (colResolver != null)
            {
                stream.Position = checked((long)cr_ino.StartBlock * hdr.BlockSize);
                colResolver.WriteToStream(stream);
            }
        }

        for (var x = 0; x < allNodes.Count; x++)
        {
            var f = allNodes[x];
            stream.Position = f.ino.StartBlock * hdr.BlockSize;
            WriteFSNode(stream, f);
        }
        if (properties.DirectRootLayout)
            WriteDirectRootIndirectBlocks(stream);
    }

    /// <summary>
    /// Enumerates the sectors that should be encrypted with AES-XTS
    /// </summary>
    /// <returns>Sector indices</returns>
    private IEnumerable<long> XtsSectorGen()
    {
        long totalSectors = (CalculatePfsSize() + 0xFFF) / xtsSectorSize;
        long xtsSector = 16;
        while (xtsSector < totalSectors)
        {
            if (xtsSector / 0x10 == emptyBlock)
            {
                xtsSector += 16;
            }
            yield return xtsSector;
            xtsSector += 1;
        }
    }

    /// <summary>
    /// Writes the PFS image using a memory mapped file. This allows for parallelization of signing and encrypting.
    /// </summary>
    /// <param name="file">The memory mapped file</param>
    /// <param name="offset">Start offset of the PFS image in the file</param>
    public void WriteImage(MemoryMappedFile file, long offset)
    {
        using (var viewStream = file.CreateViewStream(offset, CalculatePfsSize(), MemoryMappedFileAccess.ReadWrite))
        {
            WriteData(viewStream);
        }
        using (var view = file.CreateViewAccessor(offset, CalculatePfsSize(), MemoryMappedFileAccess.ReadWrite))
        {
            if (hdr.Mode.HasFlag(PfsMode.Signed))
            {
                Log("Signing in parallel...");
                var signKey = Crypto.PfsGenSignKey(properties.EKPFS, hdr.Seed);
                // We can do the actual data blocks in parallel
                Parallel.ForEach(
                  data_sigs,
                  () => Tuple.Create(new byte[properties.BlockSize], new HMACSHA256(signKey)),
                  (sig, status, local) =>
                  {
                      var (sig_buffer, hmac) = local;
                      var position = sig.Block * sig_buffer.Length;
                      view.ReadArray(position, sig_buffer, 0, sig_buffer.Length);
                      position = sig.SigOffset;
                      byte[] digest = hmac.ComputeHash(sig_buffer);
                      view.WriteArray(position, digest, 0, digest.Length);
                      view.Write(position + 32, (int)sig.Block);
                      return local;
                  },
                  local => local.Item2.Dispose());
                // The indirect blocks must be done after, since they rely on data block signatures
                using var finalHmac = new HMACSHA256(signKey);
                foreach (var sig in final_sigs)
                {
                    var sig_buffer = new byte[sig.Size];
                    var position = sig.Block * properties.BlockSize;
                    view.ReadArray(position, sig_buffer, 0, sig_buffer.Length);
                    position = sig.SigOffset;
                    byte[] digest = finalHmac.ComputeHash(sig_buffer);
                    view.WriteArray(position, digest, 0, digest.Length);
                    view.Write(position + 32, (int)sig.Block);
                }
            }

            if (hdr.Mode.HasFlag(PfsMode.Encrypted))
            {
                Log("Encrypting in parallel...");
                var (tweakKey, dataKey) = Crypto.PfsGenEncKey(properties.EKPFS, hdr.Seed);
                Parallel.ForEach(
                  // generates sector indices for each sector to be encrypted
                  XtsSectorGen(),
                  // generates thread-local data
                  () => Tuple.Create(new XtsBlockTransform(dataKey, tweakKey), new byte[xtsSectorSize]),
                  // Loop body
                  (xtsSector, loopState, localData) =>
                  {
                      var (transformer, sectorBuffer) = localData;
                      var sectorOffset = xtsSector * xtsSectorSize;
                      view.ReadArray(sectorOffset, sectorBuffer, 0, xtsSectorSize);
                      transformer.EncryptSector(sectorBuffer, (ulong)xtsSector);
                      view.WriteArray(sectorOffset, sectorBuffer, 0, xtsSectorSize);
                      return localData;
                  },
                  // Finalizer
                  local => local.Item1.Dispose());
            }
        }
    }

    /// <summary>
    /// Writes the PFS image to the given stream
    /// </summary>
    public void WriteImage(Stream stream)
    {
        WriteData(stream);

        if (hdr.Mode.HasFlag(PfsMode.Signed))
        {
            Log("Signing...");
            var signKey = Crypto.PfsGenSignKey(properties.EKPFS, hdr.Seed);
            using var hmac = new HMACSHA256(signKey);
            foreach (var sig in data_sigs.Concat(final_sigs))
            {
                var sig_buffer = new byte[sig.Size];
                stream.Position = sig.Block * properties.BlockSize;
                stream.ReadExactly(sig_buffer, 0, sig.Size);
                stream.Position = sig.SigOffset;
                byte[] mac = hmac.ComputeHash(sig_buffer);
                stream.Write(mac, 0, 32);
                stream.WriteLE((int)sig.Block);
                // The superblock self-signature (block 0 @ 0x380) is this image's integrity value,
                // surfaced for the supplemental pfsimage.xml <icv> element.
                if (CaptureSuperblockIcv && sig.Block == 0 && sig.SigOffset == 0x380)
                    SuperblockIcv = mac;
            }
        }

        if (CaptureImageDigests && hdr.Mode.HasFlag(PfsMode.Signed))
        {
            // sce_sys/imagedigs.dat preimage: one per-block descriptor digest for every block
            // of the plaintext signed image (captured here, before XTS encryption), stored from last
            // byte to first. The PS5 image builder gathers the signer's per-block HMAC-SHA256
            // descriptor digests and writes each digest from byte 31 down to byte 0; reproduced from
            // this image's own signing key.
            var idKey = Crypto.PfsGenSignKey(properties.EKPFS, hdr.Seed);
            int bs = (int)properties.BlockSize;
            int idCount = (int)(CalculatePfsSize() / bs);
            var digs = new byte[idCount * 32];
            var blockBuf = new byte[bs];
            for (int i = 0; i < idCount; i++)
            {
                stream.Position = (long)i * bs;
                stream.ReadExactly(blockBuf);
                byte[] h = Crypto.HmacSha256(idKey, blockBuf);
                Array.Reverse(h);
                h.CopyTo(digs, i * 32);
            }
            ImageDigests = digs;
        }

        if (hdr.Mode.HasFlag(PfsMode.Encrypted))
        {
            Log("Encrypting...");
            var (tweakKey, dataKey) = Crypto.PfsGenEncKey(properties.EKPFS, hdr.Seed);
            using var transformer = new XtsBlockTransform(dataKey, tweakKey);
            byte[] sectorBuffer = new byte[xtsSectorSize];
            foreach (var xtsSector in XtsSectorGen())
            {
                stream.Position = xtsSector * xtsSectorSize;
                stream.ReadExactly(sectorBuffer, 0, xtsSectorSize);
                transformer.EncryptSector(sectorBuffer, (ulong)xtsSector);
                stream.Position = xtsSector * xtsSectorSize;
                stream.Write(sectorBuffer, 0, xtsSectorSize);
            }
        }
        stream.Position = CalculatePfsSize();
    }

    /// <summary>
    /// Adds inodes for each dir.
    /// </summary>
    void addDirInodes()
    {
        inodes.Add(properties.root.ino);
        foreach (var dir in allDirs.OrderBy(x => x.FullPath()))
        {
            var ino = MakeInode(
              Mode: InodeMode.dir | (properties.DirectRootLayout ? (InodeMode)0x1ED : Inode.RXOnly),
              Number: (uint)inodes.Count,
              Blocks: 1,
              Size: 65536,
              Flags: properties.DirectRootLayout ? 0 : InodeFlags.@readonly,
              Nlink: 2 // 1 link each for its own dirent and its . dirent
            );
            dir.ino = ino;
            dir.Dirents.Add(new PfsDirent { Name = ".", InodeNumber = ino.Number, Type = DirentType.Dot });
            dir.Dirents.Add(new PfsDirent { Name = "..", InodeNumber = dir.Parent.ino.Number, Type = DirentType.DotDot });

            var dirent = new PfsDirent { Name = dir.name, InodeNumber = (uint)inodes.Count, Type = DirentType.Directory };
            dir.Parent.Dirents.Add(dirent);
            dir.Parent.ino.Nlink++;
            inodes.Add(ino);
        }
    }

    /// <summary>
    /// Adds inodes for each file.
    /// </summary>
    void addFileInodes()
    {
        foreach (var file in allFiles.OrderBy(x => x.FullPath()))
        {
            var ino = MakeInode(
              Mode: InodeMode.file | (properties.DirectRootLayout ? (InodeMode)0x1A4 : Inode.RXOnly),
              Size: file.PprKrakenCompression ? file.CompressedSize : file.Size,
              SizeCompressed: file.CompressedSize,
              Number: (uint)inodes.Count,
              Blocks: checked((uint)CeilDiv(file.Size, hdr.BlockSize)),
              Flags: (properties.DirectRootLayout ? 0 : InodeFlags.@readonly)
                  | (file.Compress ? InodeFlags.compressed : 0)
            );
            if (properties.Sign) // HACK: Outer PFS images don't use readonly?
            {
                ino.Flags &= ~InodeFlags.@readonly;
            }
            file.ino = ino;
            var dirent = new PfsDirent { Name = file.name, Type = DirentType.File, InodeNumber = (uint)inodes.Count };
            file.Parent.Dirents.Add(dirent);
            inodes.Add(ino);
        }
    }

    long roundUpSizeToBlock(long size) => CeilDiv(size, hdr.BlockSize) * hdr.BlockSize;
    long calculateIndirectBlocks(long size)
    {
        var sigs_per_block = hdr.BlockSize / 36;
        var blocks = CeilDiv(size, hdr.BlockSize);
        var ib = 0L;
        if (blocks > 12)
        {
            blocks -= 12;
            ib++;
        }
        if (blocks > sigs_per_block)
        {
            blocks -= sigs_per_block;
            ib += 1 + CeilDiv(blocks, sigs_per_block);
        }
        return ib;
    }

    ///<summary>
    ///Given an inode number and an index into the db[] array, returns the absolute offset of that array value.
    ///The inode table has tail padding in every filesystem block, so the inode's block boundary
    ///must be applied rather than treating all inode records as one contiguous run.
    ///</summary>
    long inoNumberToOffset(uint number, int db = 0)
    {
        long inodesPerBlock = hdr.BlockSize / DinodeS32.SizeOf;
        long block = 1 + number / inodesPerBlock;
        long withinBlock = (number % inodesPerBlock) * DinodeS32.SizeOf;
        return block * hdr.BlockSize + withinBlock + 0x64 + 36L * db;
    }

    /// <summary>
    /// Sets the data blocks. Also updates header for total number of data blocks.
    /// </summary>
    void CalculateDataBlockLayout()
    {
        if (properties.DirectRootLayout)
        {
            if (properties.Sign || properties.Encrypt)
                throw new NotSupportedException("The publisher direct-root layout currently supports plaintext unsigned images only.");

            var inodesPerBlock = hdr.BlockSize / DinodeD32.SizeOf;
            hdr.DinodeCount = inodes.Count;
            hdr.DinodeBlockCount = CeilDiv(inodes.Count, inodesPerBlock);
            hdr.InodeBlockSig.Blocks = checked((uint)hdr.DinodeBlockCount);
            hdr.InodeBlockSig.Size = hdr.DinodeBlockCount * hdr.BlockSize;
            hdr.InodeBlockSig.SizeCompressed = hdr.InodeBlockSig.Size;
            hdr.InodeBlockSig.SetTime(properties.FileTime);

            // Publisher PPR-PFS reserves block 1 for metadata and starts its inode table at block 2.
            hdr.InodeBlockSig.SetDirectBlock(0, 2);
            for (int i = 1; i < hdr.DinodeBlockCount && i < 12; i++)
                hdr.InodeBlockSig.SetDirectBlock(i, 2 + i);
            hdr.Ndblock = 2 + hdr.DinodeBlockCount;

            foreach (var node in allNodes)
            {
                long blocks = CeilDiv(node.Size, hdr.BlockSize);
                node.ino.SetDirectBlock(0, (int)hdr.Ndblock);
                for (int i = 1; i < blocks && i < 12; i++)
                    node.ino.SetDirectBlock(i, checked((int)hdr.Ndblock + i));
                node.ino.Blocks = checked((uint)blocks);
                node.ino.Size = node is FSDir
                    ? node.Size
                    : node is FSFile { PprKrakenCompression: true } pprFile ? pprFile.CompressedSize : node.Size;
                if (node is FSDir)
                    node.ino.SizeCompressed = node.Size;
                else if (node.ino.SizeCompressed == 0)
                    node.ino.SizeCompressed = node.ino.Size;
                hdr.Ndblock += blocks;

                // Publisher unsigned PPR-PFS uses ordinary 32-bit PFS block maps. Data is
                // contiguous, but the kernel still expects ib[0]/ib[1] and their pointer blocks
                // once the extent no longer fits in the twelve direct inode entries.
                long pointersPerBlock = hdr.BlockSize / sizeof(int);
                if (blocks > 12)
                {
                    node.ino.IndirectBlocks[0] = checked((int)hdr.Ndblock++);
                    long doublyIndirectBlocks = blocks - 12 - pointersPerBlock;
                    if (doublyIndirectBlocks > 0)
                    {
                        node.ino.IndirectBlocks[1] = checked((int)hdr.Ndblock++);
                        hdr.Ndblock += CeilDiv(doublyIndirectBlocks, pointersPerBlock);
                    }
                }
            }

            hdr.Ndblock = Math.Max(hdr.Ndblock, properties.MinBlocks);
            return;
        }

        // TODO: Consolidate of all this duplicate code
        if (properties.Sign)
        {
            // Include the header block in the total count
            hdr.Ndblock = 1;
            var inodesPerBlock = hdr.BlockSize / DinodeS32.SizeOf;
            hdr.DinodeCount = inodes.Count;
            hdr.DinodeBlockCount = CeilDiv(inodes.Count, inodesPerBlock);
            hdr.InodeBlockSig.Blocks = checked((uint)hdr.DinodeBlockCount);
            hdr.InodeBlockSig.Size = hdr.DinodeBlockCount * hdr.BlockSize;
            hdr.InodeBlockSig.SizeCompressed = hdr.DinodeBlockCount * hdr.BlockSize;
            hdr.InodeBlockSig.SetTime(properties.FileTime);
            hdr.InodeBlockSig.Flags = 0;
            for (var i = 0; i < hdr.DinodeBlockCount; i++)
            {
                hdr.InodeBlockSig.SetDirectBlock(i, 1 + i);
                final_sigs.Push(new BlockSigInfo(1 + i, 0xB8 + (36 * i)));
            }
            hdr.Ndblock += hdr.DinodeBlockCount;
            super_root_ino.SetDirectBlock(0, (int)(hdr.DinodeBlockCount + 1));
            final_sigs.Push(new BlockSigInfo(super_root_ino.StartBlock, inoNumberToOffset(super_root_ino.Number)));
            hdr.Ndblock += super_root_ino.Blocks;

            // flat path table
            fpt_ino.SetDirectBlock(0, super_root_ino.StartBlock + 1);
            fpt_ino.Size = fpt.Size;
            fpt_ino.SizeCompressed = fpt.Size;
            fpt_ino.Blocks = checked((uint)CeilDiv(fpt.Size, hdr.BlockSize));
            final_sigs.Push(new BlockSigInfo(fpt_ino.StartBlock, inoNumberToOffset(fpt_ino.Number)));

            for (int i = 1; i < fpt_ino.Blocks && i < 12; i++)
            {
                fpt_ino.SetDirectBlock(i, (int)hdr.Ndblock++);
                final_sigs.Push(new BlockSigInfo(fpt_ino.StartBlock, inoNumberToOffset(fpt_ino.Number, i)));
            }

            // DATs I've found include an empty block after the FPT
            hdr.Ndblock++;
            // HACK: outer PFS has a block of zeroes that is not encrypted???
            emptyBlock = (int)hdr.Ndblock;
            hdr.Ndblock++;

            var ibStartBlock = hdr.Ndblock;
            hdr.Ndblock += allNodes.Select(s => calculateIndirectBlocks(s.Size)).Sum();

            var sigs_per_block = hdr.BlockSize / 36;
            // Fill in DB/IB pointers
            foreach (var n in allNodes)
            {
                var blocks = CeilDiv(n.Size, hdr.BlockSize);
                n.ino.SetDirectBlock(0, (int)hdr.Ndblock);
                n.ino.Blocks = checked((uint)blocks);
                n.ino.Size = n is FSDir
                    ? roundUpSizeToBlock(n.Size)
                    : n is FSFile { PprKrakenCompression: true } pprFile ? pprFile.CompressedSize : n.Size;
                if (n.ino.SizeCompressed == 0)
                    n.ino.SizeCompressed = n.ino.Size;

                for (var i = 0; (blocks - i) > 0 && i < 12; i++)
                {
                    data_sigs.Push(new BlockSigInfo((int)hdr.Ndblock++, inoNumberToOffset(n.ino.Number, i)));
                }
                if (blocks > 12)
                {
                    // More than 12 blocks -> use 1 indirect block
                    // ib[0]
                    final_sigs.Push(new BlockSigInfo(ibStartBlock, inoNumberToOffset(n.ino.Number, 12)));
                    for (int i = 12, pointerOffset = 0; (blocks - i) > 0 && i < (12 + sigs_per_block); i++, pointerOffset += 36)
                    {
                        // ib[0][i]
                        data_sigs.Push(new BlockSigInfo((int)hdr.Ndblock++, ibStartBlock * hdr.BlockSize + pointerOffset));
                    }
                    ibStartBlock++;
                }
                if (blocks > 12 + sigs_per_block)
                {
                    uint blockSigsDone = 12 + sigs_per_block;
                    // More than 12 + one block of pointers -> use 1 doubly-indirect block + any number of indirect blocks
                    // ib[1] = signature for block of signatures for block of signatures for data blocks
                    final_sigs.Push(new BlockSigInfo(ibStartBlock, inoNumberToOffset(n.ino.Number, 13)));
                    var ib_1_block = ibStartBlock;
                    for (var i = 0; i < sigs_per_block && blockSigsDone < blocks; i++)
                    {
                        // ib[1][i] = signature for block of signatures for data blocks
                        final_sigs.Push(new BlockSigInfo((int)++ibStartBlock, ib_1_block * hdr.BlockSize + i * 36));
                        for (int j = 0; j < sigs_per_block && blockSigsDone < blocks; j++, blockSigsDone++)
                        {
                            // ib[1][i][j] = signature for data block
                            data_sigs.Push(new BlockSigInfo((int)hdr.Ndblock++, ibStartBlock * hdr.BlockSize + (j * 36)));
                        }
                    }
                }
            }
        }
        else
        {
            // Include the header block in the total count
            hdr.Ndblock = 1;
            var inodesPerBlock = hdr.BlockSize / DinodeD32.SizeOf;
            hdr.DinodeCount = inodes.Count;
            hdr.DinodeBlockCount = CeilDiv(inodes.Count, inodesPerBlock);
            hdr.InodeBlockSig.Blocks = checked((uint)hdr.DinodeBlockCount);
            hdr.InodeBlockSig.Size = hdr.DinodeBlockCount * hdr.BlockSize;
            hdr.InodeBlockSig.SizeCompressed = hdr.DinodeBlockCount * hdr.BlockSize;
            hdr.InodeBlockSig.SetDirectBlock(0, (int)hdr.Ndblock++);
            hdr.InodeBlockSig.SetTime(properties.FileTime);
            for (var i = 1; i < hdr.DinodeBlockCount; i++)
            {
                if (i < 12)
                    hdr.InodeBlockSig.SetDirectBlock(i, -1);
                hdr.Ndblock++;
            }
            super_root_ino.SetDirectBlock(0, (int)hdr.Ndblock);
            hdr.Ndblock += super_root_ino.Blocks;

            // flat path table
            fpt_ino.SetDirectBlock(0, (int)hdr.Ndblock++);
            fpt_ino.Size = fpt.Size;
            fpt_ino.SizeCompressed = fpt.Size;
            fpt_ino.Blocks = checked((uint)CeilDiv(fpt.Size, hdr.BlockSize));

            for (int i = 1; i < fpt_ino.Blocks && i < 12; i++)
                fpt_ino.SetDirectBlock(i, (int)hdr.Ndblock++);

            // DATs I've found include an empty block after the FPT if there's no collision resolver
            if (cr_ino == null)
            {
                hdr.Ndblock++;
            }
            else
            {
                // collision resolver
                cr_ino.SetDirectBlock(0, (int)hdr.Ndblock++);
                cr_ino.Size = colResolver.Size;
                cr_ino.SizeCompressed = colResolver.Size;
                cr_ino.Blocks = checked((uint)CeilDiv(colResolver.Size, hdr.BlockSize));

                for (int i = 1; i < cr_ino.Blocks && i < 12; i++)
                    cr_ino.SetDirectBlock(i, (int)hdr.Ndblock++);
            }

            // Calculate length of all dirent blocks
            foreach (var n in allNodes)
            {
                var blocks = CeilDiv(n.Size, hdr.BlockSize);
                n.ino.SetDirectBlock(0, (int)hdr.Ndblock);
                n.ino.Blocks = checked((uint)blocks);
                n.ino.Size = n is FSDir
                    ? roundUpSizeToBlock(n.Size)
                    : n is FSFile { PprKrakenCompression: true } pprFile ? pprFile.CompressedSize : n.Size;
                if (n.ino.SizeCompressed == 0)
                    n.ino.SizeCompressed = n.ino.Size;
                for (int i = 1; i < blocks && i < 12; i++)
                {
                    n.ino.SetDirectBlock(i, -1);
                }
                hdr.Ndblock += blocks;
            }
        }
        // Hack: set a minimum size for the PFS image.
        hdr.Ndblock = Math.Max(hdr.Ndblock, properties.MinBlocks);
    }

    Inode MakeInode(InodeMode Mode, uint Blocks, long Size = 0, long SizeCompressed = 0, ushort Nlink = 1, uint Number = 0, InodeFlags Flags = 0)
    {
        Inode ret;
        if (properties.Sign)
        {
            ret = new DinodeS32()
            {
                Mode = Mode,
                Blocks = Blocks,
                Size = Size,
                SizeCompressed = SizeCompressed,
                Nlink = Nlink,
                Number = Number,
                Flags = Flags | InodeFlags.unk2 | InodeFlags.unk3,
            };
        }
        else
        {
            ret = new DinodeD32()
            {
                Mode = Mode,
                Blocks = Blocks,
                Size = Size,
                SizeCompressed = SizeCompressed,
                Nlink = Nlink,
                Number = Number,
                Flags = Flags
            };
        }
        ret.SetTime(properties.FileTime);
        return ret;
    }

    /// <summary>
    /// Creates inodes and dirents for superroot, flat_path_table, and uroot.
    /// Also, creates the root node for the FS tree.
    /// </summary>
    void SetupRootStructure(bool hasCollision)
    {
        var inodeNum = 0u;
        inodes.Add(super_root_ino = MakeInode(
          Mode: InodeMode.dir | Inode.RXOnly,
          Blocks: 1,
          Size: 65536,
          SizeCompressed: 65536,
          Nlink: 1,
          Number: inodeNum++,
          Flags: InodeFlags.@internal | InodeFlags.@readonly
        ));
        inodes.Add(fpt_ino = MakeInode(
          Mode: InodeMode.file | Inode.RXOnly,
          Blocks: 1,
          Number: inodeNum++,
          Flags: InodeFlags.@internal | InodeFlags.@readonly
        ));
        if (hasCollision)
        {
            inodes.Add(cr_ino = MakeInode(
              Mode: InodeMode.file | Inode.RXOnly,
              Blocks: 1,
              Number: inodeNum++,
              Flags: InodeFlags.@internal | InodeFlags.@readonly
            ));
        }
        var uroot_ino = MakeInode(
          Mode: InodeMode.dir | Inode.RXOnly,
          Number: inodeNum++,
          Size: 65536,
          SizeCompressed: 65536,
          Blocks: 1,
          Flags: InodeFlags.@readonly,
          Nlink: 3
        );

        super_root_dirents = new List<PfsDirent>
  {
    new PfsDirent { InodeNumber = fpt_ino.Number, Name = "flat_path_table", Type = DirentType.File },
  };
        if (hasCollision)
        {
            super_root_dirents.Add(
              new PfsDirent { InodeNumber = cr_ino.Number, Name = "collision_resolver", Type = DirentType.File });
        }
        super_root_dirents.Add(
          new PfsDirent { InodeNumber = uroot_ino.Number, Name = "uroot", Type = DirentType.Directory });

        properties.root.name = "uroot";
        properties.root.ino = uroot_ino;
        properties.root.Dirents = new List<PfsDirent>
  {
    new PfsDirent { Name = ".", Type = DirentType.Dot, InodeNumber = uroot_ino.Number },
    new PfsDirent { Name = "..", Type = DirentType.DotDot, InodeNumber = uroot_ino.Number }
  };
        if (properties.Sign) // HACK: Outer PFS lacks readonly flags
        {
            super_root_ino.Flags &= ~InodeFlags.@readonly;
            fpt_ino.Flags &= ~InodeFlags.@readonly;
            uroot_ino.Flags &= ~InodeFlags.@readonly;
        }
    }

    /// <summary>
    /// Creates the publisher PPR-PFS root, where inode 0 is the user root directly.
    /// </summary>
    void SetupDirectRootStructure()
    {
        var rootInode = MakeInode(
          Mode: InodeMode.dir | (InodeMode)0x1ED,
          Number: 0,
          Size: 65536,
          SizeCompressed: 65536,
          Blocks: 1,
          Flags: 0,
          Nlink: 2
        );
        properties.root.name = "";
        properties.root.ino = rootInode;
        properties.root.Dirents = new List<PfsDirent>
        {
            new PfsDirent { Name = ".", Type = DirentType.Dot, InodeNumber = 0 },
            new PfsDirent { Name = "..", Type = DirentType.DotDot, InodeNumber = 0 },
        };
    }

    /// <summary>
    /// Writes all the inodes to the image file.
    /// </summary>
    /// <param name="s"></param>
    void WriteInodes(Stream s)
    {
        s.Position = (long)hdr.InodeBlockSig.StartBlock * hdr.BlockSize;
        foreach (var di in inodes)
        {
            di.WriteToStream(s);
            if (s.Position % hdr.BlockSize > hdr.BlockSize - (properties.Sign ? DinodeS32.SizeOf : DinodeD32.SizeOf))
            {
                s.Position += hdr.BlockSize - (s.Position % hdr.BlockSize);
            }
        }
    }

    /// <summary>
    /// Writes the inode allocation bitmap used by publisher PPR-PFS images in block 1.
    /// One low-to-high bit is set for every materialized inode.
    /// </summary>
    void WriteDirectRootInodeBitmap(Stream stream)
    {
        stream.Position = hdr.BlockSize;
        int fullBytes = inodes.Count / 8;
        for (int i = 0; i < fullBytes; i++)
            stream.WriteByte(0xFF);
        int remainingBits = inodes.Count % 8;
        if (remainingBits != 0)
            stream.WriteByte((byte)((1 << remainingBits) - 1));
    }

    /// <summary>
    /// Writes the unsigned 32-bit single- and double-indirect block maps used by the publisher
    /// direct-root profile. The reference layout places these maps immediately after each file's
    /// contiguous data extent: ib[0], ib[1], then the ib[1] leaf blocks.
    /// </summary>
    void WriteDirectRootIndirectBlocks(Stream stream)
    {
        long pointersPerBlock = hdr.BlockSize / sizeof(int);
        foreach (FSNode node in allNodes)
        {
            long blocks = node.ino.Blocks;
            if (blocks <= 12)
                continue;

            int dataStart = node.ino.StartBlock;
            int singleIndirect = node.ino.IndirectBlocks[0];
            stream.Position = checked((long)singleIndirect * hdr.BlockSize);
            long singleCount = Math.Min(blocks - 12, pointersPerBlock);
            for (long index = 0; index < singleCount; index++)
                stream.WriteLE(checked(dataStart + 12 + (int)index));

            long remaining = blocks - 12 - pointersPerBlock;
            if (remaining <= 0)
                continue;

            int doubleIndirect = node.ino.IndirectBlocks[1];
            int firstLeaf = checked(doubleIndirect + 1);
            long leafCount = CeilDiv(remaining, pointersPerBlock);
            stream.Position = checked((long)doubleIndirect * hdr.BlockSize);
            for (int leaf = 0; leaf < leafCount; leaf++)
                stream.WriteLE(checked(firstLeaf + leaf));

            long dataIndex = 12 + pointersPerBlock;
            for (int leaf = 0; leaf < leafCount; leaf++)
            {
                stream.Position = checked((long)(firstLeaf + leaf) * hdr.BlockSize);
                long leafEntries = Math.Min(remaining, pointersPerBlock);
                for (long entry = 0; entry < leafEntries; entry++)
                    stream.WriteLE(checked(dataStart + (int)dataIndex++));
                remaining -= leafEntries;
            }
        }
    }

    /// <summary>
    /// Writes the dirents for the superroot, which precede the flat_path_table.
    /// </summary>
    /// <param name="stream"></param>
    void WriteSuperrootDirents(Stream stream)
    {
        stream.Position = hdr.BlockSize * (hdr.DinodeBlockCount + 1);
        foreach (var d in super_root_dirents)
        {
            d.WriteToStream(stream);
        }
    }

    /// <summary>
    /// Writes all the data blocks.
    /// </summary>
    /// <param name="s"></param>
    /// <param name="f"></param>
    void WriteFSNode(Stream s, FSNode f)
    {
        if (f is FSDir)
        {
            var dir = (FSDir)f;
            var startBlock = f.ino.StartBlock;
            foreach (var d in dir.Dirents)
            {
                d.WriteToStream(s);
                if (s.Position % hdr.BlockSize > hdr.BlockSize - PfsDirent.MaxSize)
                {
                    s.Position = (++startBlock * hdr.BlockSize);
                }
            }
        }
        else if (f is FSFile)
        {
            var file = (FSFile)f;
            long start = s.Position;
            file.Write(s);
            long expectedEnd = checked(start + file.Size);
            if (s.Position != expectedEnd)
            {
                throw new InvalidDataException(
                    $"File writer for '{file.FullPath()}' produced {s.Position - start:N0} bytes; "
                    + $"the planned extent is {file.Size:N0} bytes.");
            }
        }
    }
}
