// Copyright (c) 2026, SvenGDK
// Licensed under the BSD 2-Clause License. See LICENSE file for details.

namespace UFS2Tool
{
    /// <summary>
    /// Represents a UFS1 on-disk inode (struct ufs1_dinode).
    /// Each inode is exactly 128 bytes. UFS1 uses 32-bit block pointers
    /// and 32-bit timestamps (unlike UFS2's 64-bit variants).
    /// </summary>
    public class Ufs1Inode
    {
        public ushort Mode { get; set; }           // di_mode - File type and permissions
        public short NLink { get; set; }           // di_nlink - Number of hard links
        public uint DirDepth { get; set; }         // di_freelink/di_dirdepth (union at offset 4)
        public long Size { get; set; }             // di_size - File size in bytes (64-bit)
        public int AccessTime { get; set; }        // di_atime - 32-bit timestamp
        public int ATimeNsec { get; set; }         // di_atimensec
        public int ModTime { get; set; }           // di_mtime - 32-bit timestamp
        public int MTimeNsec { get; set; }         // di_mtimensec
        public int ChangeTime { get; set; }        // di_ctime - 32-bit timestamp
        public int CTimeNsec { get; set; }         // di_ctimensec
        public int[] DirectBlocks { get; set; } = new int[Ufs2Constants.NDirect];   // di_db[12] - 32-bit
        public int[] IndirectBlocks { get; set; } = new int[Ufs2Constants.NIndirect]; // di_ib[3] - 32-bit
        public uint Flags { get; set; }            // di_flags
        public int Blocks { get; set; }            // di_blocks - 512-byte blocks
        public int Generation { get; set; }        // di_gen
        public uint Uid { get; set; }              // di_uid (at offset 112)
        public uint Gid { get; set; }              // di_gid (at offset 116)

        public bool IsDirectory => (Mode & 0xF000) == Ufs2Constants.IfDir;
        public bool IsRegularFile => (Mode & 0xF000) == Ufs2Constants.IfReg;
        public bool IsSymlink => (Mode & 0xF000) == Ufs2Constants.IfLnk;

        /// <summary>
        /// Write this inode as exactly 128 bytes to the given writer.
        /// Layout matches FreeBSD struct ufs1_dinode.
        /// </summary>
        public void WriteTo(BinaryWriter writer)
        {
            long startPos = writer.BaseStream.Position;

            writer.Write(Mode);              // 0x00 (2 bytes)
            writer.Write(NLink);             // 0x02 (2 bytes)
            writer.Write(DirDepth);          // 0x04 di_freelink/di_dirdepth (4 bytes)
            writer.Write(Size);              // 0x08 (8 bytes)
            writer.Write(AccessTime);        // 0x10 (4 bytes)
            writer.Write(ATimeNsec);         // 0x14 (4 bytes)
            writer.Write(ModTime);           // 0x18 (4 bytes)
            writer.Write(MTimeNsec);         // 0x1C (4 bytes)
            writer.Write(ChangeTime);        // 0x20 (4 bytes)
            writer.Write(CTimeNsec);         // 0x24 (4 bytes)

            // Direct block pointers: 12 × int32 = 48 bytes
            for (int i = 0; i < Ufs2Constants.NDirect; i++)
                writer.Write(DirectBlocks[i]);

            // Indirect block pointers: 3 × int32 = 12 bytes
            for (int i = 0; i < Ufs2Constants.NIndirect; i++)
                writer.Write(IndirectBlocks[i]);

            writer.Write(Flags);             // di_flags (4 bytes)
            writer.Write(Blocks);            // di_blocks (4 bytes)
            writer.Write(Generation);        // di_gen (4 bytes)
            writer.Write(Uid);               // di_uid (4 bytes)
            writer.Write(Gid);               // di_gid (4 bytes)

            // Pad to exactly 128 bytes
            long written = writer.BaseStream.Position - startPos;
            if (written < Ufs2Constants.Ufs1InodeSize)
            {
                writer.Write(new byte[Ufs2Constants.Ufs1InodeSize - written]);
            }
        }

        /// <summary>
        /// Read a 128-byte UFS1 inode from the given reader.
        /// </summary>
        public static Ufs1Inode ReadFrom(BinaryReader reader)
        {
            long startPos = reader.BaseStream.Position;
            var inode = new Ufs1Inode
            {
                Mode = reader.ReadUInt16(),
                NLink = reader.ReadInt16(),
                DirDepth = reader.ReadUInt32(), // di_freelink/di_dirdepth
                Size = reader.ReadInt64(),
                AccessTime = reader.ReadInt32(),
                ATimeNsec = reader.ReadInt32(),
                ModTime = reader.ReadInt32(),
                MTimeNsec = reader.ReadInt32(),
                ChangeTime = reader.ReadInt32(),
                CTimeNsec = reader.ReadInt32(),

                DirectBlocks = new int[Ufs2Constants.NDirect]
            };
            for (int i = 0; i < Ufs2Constants.NDirect; i++)
                inode.DirectBlocks[i] = reader.ReadInt32();

            inode.IndirectBlocks = new int[Ufs2Constants.NIndirect];
            for (int i = 0; i < Ufs2Constants.NIndirect; i++)
                inode.IndirectBlocks[i] = reader.ReadInt32();

            inode.Flags = reader.ReadUInt32();
            inode.Blocks = reader.ReadInt32();
            inode.Generation = reader.ReadInt32();
            inode.Uid = reader.ReadUInt32();
            inode.Gid = reader.ReadUInt32();

            // Skip remaining padding
            long read = reader.BaseStream.Position - startPos;
            int remaining = Ufs2Constants.Ufs1InodeSize - (int)read;
            if (remaining > 0)
                reader.ReadBytes(remaining);

            return inode;
        }
    }
}
