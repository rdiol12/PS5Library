// Copyright (c) 2026, SvenGDK
// Licensed under the BSD 2-Clause License. See LICENSE file for details.

using System.Text;

namespace UFS2Tool
{
    /// <summary>
    /// Represents a UFS2 directory entry (struct direct).
    /// </summary>
    public class Ufs2DirectoryEntry
    {
        public uint Inode { get; set; }            // d_ino - Inode number
        public ushort RecordLength { get; set; }   // d_reclen - Total entry length (padded)
        public byte FileType { get; set; }         // d_type - File type (DT_DIR, DT_REG, etc.)
        public byte NameLength { get; set; }       // d_namlen - Name length
        public string Name { get; set; } = "";     // d_name - File name

        /// <summary>
        /// Calculate the actual record length needed for this entry.
        /// Both UFS1 and UFS2 use 4-byte alignment per FreeBSD's DIRECTSIZ macro
        /// in sys/ufs/ufs/dir.h.
        /// </summary>
        /// <param name="nameLength">Length of the file name</param>
        /// <param name="isUfs2">Unused — both UFS1 and UFS2 use 4-byte alignment</param>
        public static ushort CalculateRecordLength(int nameLength, bool isUfs2)
        {
            // Header (8 bytes) + name + null terminator, rounded up to 4-byte boundary
            // Matches FreeBSD DIRECTSIZ(namlen):
            //   (offsetof(struct direct, d_name) + (namlen) + 1 + 3) & ~3
            int size = Ufs2Constants.DirectoryEntryHeaderSize + nameLength + 1;
            int mask = Ufs2Constants.DirectoryEntryAlignment - 1;
            return (ushort)((size + mask) & ~mask);
        }

        public void WriteTo(BinaryWriter writer)
        {
            writer.Write(Inode);
            writer.Write(RecordLength);
            writer.Write(FileType);
            writer.Write(NameLength);

            byte[] nameBytes = new byte[RecordLength - Ufs2Constants.DirectoryEntryHeaderSize];
            Encoding.ASCII.GetBytes(Name, 0, Math.Min(Name.Length, nameBytes.Length), nameBytes, 0);
            writer.Write(nameBytes);
        }

        public static Ufs2DirectoryEntry ReadFrom(BinaryReader reader)
        {
            var entry = new Ufs2DirectoryEntry
            {
                Inode = reader.ReadUInt32(),
                RecordLength = reader.ReadUInt16(),
                FileType = reader.ReadByte(),
                NameLength = reader.ReadByte()
            };

            int nameAreaSize = entry.RecordLength - Ufs2Constants.DirectoryEntryHeaderSize;
            if (nameAreaSize > 0)
            {
                byte[] nameBytes = reader.ReadBytes(nameAreaSize);
                int nameLen = Math.Min(entry.NameLength, nameBytes.Length);
                entry.Name = Encoding.ASCII.GetString(nameBytes, 0, nameLen);
            }

            return entry;
        }
    }
}