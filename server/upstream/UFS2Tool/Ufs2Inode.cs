// Copyright (c) 2026, SvenGDK
// Licensed under the BSD 2-Clause License. See LICENSE file for details.

namespace UFS2Tool
{
    /// <summary>
    /// Represents a UFS2 on-disk inode (struct ufs2_dinode).
    /// Each inode is exactly 256 bytes.
    /// </summary>
    public class Ufs2Inode
    {
        public ushort Mode { get; set; }           // di_mode - File type and permissions
        public short NLink { get; set; }           // di_nlink - Number of hard links
        public uint Uid { get; set; }              // di_uid - Owner user ID
        public uint Gid { get; set; }              // di_gid - Owner group ID
        public uint BlkSize { get; set; }          // di_blksize - Inode blocksize
        public long Size { get; set; }             // di_size - File size in bytes
        public long Blocks { get; set; }           // di_blocks - 512-byte blocks held
        public long AccessTime { get; set; }       // di_atime - Last access time
        public long ModTime { get; set; }          // di_mtime - Last modification time
        public long ChangeTime { get; set; }       // di_ctime - Last inode change time
        public long CreateTime { get; set; }       // di_birthtime - Creation time
        public int ATimeNsec { get; set; }         // di_atimensec
        public int MTimeNsec { get; set; }         // di_mtimensec
        public int CTimeNsec { get; set; }         // di_ctimensec
        public int CreateTimeNsec { get; set; }    // di_birthnsec
        public int Generation { get; set; }        // di_gen - Generation number
        public uint KernFlags { get; set; }        // di_kernflags
        public uint Flags { get; set; }            // di_flags
        public int ExtSize { get; set; }           // di_extsize
        public uint DirDepth { get; set; }         // di_dirdepth - IFDIR only: depth from root dir

        // UFS2 uses 64-bit block pointers
        public long[] DirectBlocks { get; set; } = new long[Ufs2Constants.NDirect];   // di_db[12]
        public long[] IndirectBlocks { get; set; } = new long[Ufs2Constants.NIndirect]; // di_ib[3]

        public bool IsDirectory => (Mode & 0xF000) == Ufs2Constants.IfDir;
        public bool IsRegularFile => (Mode & 0xF000) == Ufs2Constants.IfReg;
        public bool IsSymlink => (Mode & 0xF000) == Ufs2Constants.IfLnk;

        /// <summary>
        /// Write this inode as exactly 256 bytes to the given writer.
        /// </summary>
        public void WriteTo(BinaryWriter writer)
        {
            long startPos = writer.BaseStream.Position;

            writer.Write(Mode);              // 0x00 (2 bytes)
            writer.Write(NLink);             // 0x02 (2 bytes)
            writer.Write(Uid);               // 0x04 (4 bytes)
            writer.Write(Gid);               // 0x08 (4 bytes)
            writer.Write(BlkSize);           // 0x0C (4 bytes)
            writer.Write(Size);              // 0x10 (8 bytes)
            writer.Write(Blocks);            // 0x18 (8 bytes)
            writer.Write(AccessTime);        // 0x20 (8 bytes)
            writer.Write(ModTime);           // 0x28 (8 bytes)
            writer.Write(ChangeTime);        // 0x30 (8 bytes)
            writer.Write(CreateTime);        // 0x38 (8 bytes)
            writer.Write(MTimeNsec);         // 0x40 (4 bytes) - di_mtimensec
            writer.Write(ATimeNsec);         // 0x44 (4 bytes) - di_atimensec
            writer.Write(CTimeNsec);         // 0x48 (4 bytes)
            writer.Write(CreateTimeNsec);    // 0x4C (4 bytes)
            writer.Write(Generation);        // 0x50 (4 bytes)
            writer.Write(KernFlags);         // 0x54 (4 bytes)
            writer.Write(Flags);             // 0x58 (4 bytes)
            writer.Write(ExtSize);           // 0x5C (4 bytes)

            // Extended attribute blocks (2 × int64) — reserved
            writer.Write(0L);                // 0x60
            writer.Write(0L);                // 0x68

            // Direct block pointers: 12 × int64 = 96 bytes
            for (int i = 0; i < Ufs2Constants.NDirect; i++)
                writer.Write(DirectBlocks[i]);

            // Indirect block pointers: 3 × int64 = 24 bytes
            for (int i = 0; i < Ufs2Constants.NIndirect; i++)
                writer.Write(IndirectBlocks[i]);

            // di_modrev (0xE8) - 8 bytes
            writer.Write(0L);
            // di_freelink/di_dirdepth (0xF0) - 4 bytes (union: freelink for
            // unlinked inodes, dirdepth for IFDIR; see FreeBSD dinode.h)
            writer.Write(DirDepth);
            // di_ckhash (0xF4) - 4 bytes
            writer.Write(0);

            // Pad to exactly 256 bytes
            long written = writer.BaseStream.Position - startPos;
            if (written < Ufs2Constants.Ufs2InodeSize)
            {
                writer.Write(new byte[Ufs2Constants.Ufs2InodeSize - written]);
            }
        }

        /// <summary>
        /// Read a 256-byte inode from the given reader.
        /// </summary>
        public static Ufs2Inode ReadFrom(BinaryReader reader)
        {
            var inode = new Ufs2Inode
            {
                Mode = reader.ReadUInt16(),
                NLink = reader.ReadInt16(),
                Uid = reader.ReadUInt32(),
                Gid = reader.ReadUInt32(),
                BlkSize = reader.ReadUInt32(),
                Size = reader.ReadInt64(),
                Blocks = reader.ReadInt64(),
                AccessTime = reader.ReadInt64(),
                ModTime = reader.ReadInt64(),
                ChangeTime = reader.ReadInt64(),
                CreateTime = reader.ReadInt64(),
                MTimeNsec = reader.ReadInt32(),
                ATimeNsec = reader.ReadInt32(),
                CTimeNsec = reader.ReadInt32(),
                CreateTimeNsec = reader.ReadInt32(),
                Generation = reader.ReadInt32(),
                KernFlags = reader.ReadUInt32(),
                Flags = reader.ReadUInt32(),
                ExtSize = reader.ReadInt32()
            };

            // Extended attribute blocks
            reader.ReadInt64();
            reader.ReadInt64();

            inode.DirectBlocks = new long[Ufs2Constants.NDirect];
            for (int i = 0; i < Ufs2Constants.NDirect; i++)
                inode.DirectBlocks[i] = reader.ReadInt64();

            inode.IndirectBlocks = new long[Ufs2Constants.NIndirect];
            for (int i = 0; i < Ufs2Constants.NIndirect; i++)
                inode.IndirectBlocks[i] = reader.ReadInt64();

            // di_modrev (8 bytes)
            reader.ReadInt64();
            // di_freelink/di_dirdepth (4 bytes) - union
            inode.DirDepth = reader.ReadUInt32();
            // di_ckhash (4 bytes)
            reader.ReadInt32();

            // Read remaining padding
            long totalRead = 2 + 2 + 4 + 4 + 4 + 8 + 8 + 8 + 8 + 8 + 8 +
                             4 + 4 + 4 + 4 + 4 + 4 + 4 + 4 + 8 + 8 +
                             (12 * 8) + (3 * 8) + 8 + 4 + 4; // = 248
            int remaining = Ufs2Constants.Ufs2InodeSize - (int)totalRead;
            if (remaining > 0)
                reader.ReadBytes(remaining);

            return inode;
        }
    }
}