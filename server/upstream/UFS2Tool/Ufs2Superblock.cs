// Copyright (c) 2026, SvenGDK
// Licensed under the BSD 2-Clause License. See LICENSE file for details.

using System.Text;

namespace UFS2Tool
{
    /// <summary>
    /// Represents the UFS superblock structure (both UFS1 and UFS2).
    /// Based on FreeBSD sys/ufs/ffs/fs.h 'struct fs'.
    /// Field offsets verified against FreeBSD amd64 struct fs (sizeof == 1376).
    /// </summary>
    public class Ufs2Superblock
    {
        // Offsets and sizes match FreeBSD's struct fs for UFS1/UFS2
        public int FirstDataBlock { get; set; }          // fs_firstfield / fs_unused_1
        public int SuperblockLocation { get; set; }      // fs_sblkno - Offset of superblock in CG
        public int CblkNo { get; set; }                  // fs_cblkno - Offset of cyl-block in CG
        public int IblkNo { get; set; }                  // fs_iblkno - Offset of inode-blocks in CG
        public int DblkNo { get; set; }                  // fs_dblkno - Offset of first data after CG

        public int CgOffset { get; set; }                // fs_old_cgoffset
        public int CgMask { get; set; }                  // fs_old_cgmask

        public int FSize { get; set; }                   // fs_fsize - Fragment size in bytes
        public int BSize { get; set; }                   // fs_bsize - Block size in bytes
        public int FragsPerBlock { get; set; }           // fs_frag - Number of frags in a block

        // Cylinder group information
        public int CylGroupSize { get; set; }            // fs_fpg - Fragments per cylinder group
        public int InodesPerGroup { get; set; }          // fs_ipg - Inodes per cylinder group
        public int NumCylGroups { get; set; }            // fs_ncg - Number of cylinder groups

        // Total counts
        public long TotalBlocks { get; set; }            // fs_size - Total fragments in filesystem
        public long TotalDataBlocks { get; set; }        // fs_dsize - Total data fragments
        public int TotalInodes { get; set; }             // calculated

        // Free resource summaries (fs_cstotal)
        public long FreeBlocks { get; set; }             // cs_nbfree
        public long FreeFragments { get; set; }          // cs_nffree
        public long FreeInodes { get; set; }             // cs_nifree
        public long Directories { get; set; }            // cs_ndir
        public long NumClusters { get; set; }            // cs_numclusters

        // Identification
        public int Magic { get; set; }                   // fs_magic
        public int FsId0 { get; set; }                   // fs_id[0]
        public int FsId1 { get; set; }                   // fs_id[1]

        public int SectorSize { get; set; }              // sector size
        public long Time { get; set; }                   // fs_time

        public string VolumeName { get; set; } = "";     // fs_volname
        public string MountPoint { get; set; } = "";     // fs_fsmnt

        public int Flags { get; set; }                   // fs_flags
        public int InodeSize { get; set; }               // inode size (128 for UFS1, 256 for UFS2)

        // Block shift and mask for fast calculation
        public int BShift { get; set; }                  // fs_bshift
        public int FShift { get; set; }                  // fs_fshift
        public int BMask { get; set; }                   // fs_bmask
        public int FMask { get; set; }                   // fs_fmask
        public int FragShift { get; set; }               // fs_fragshift

        // newfs parameters stored in superblock
        public int MinFreePercent { get; set; } = 8;     // fs_minfree
        public int Optimization { get; set; }            // fs_optim (0=time, 1=space)
        public int MaxContig { get; set; }               // fs_maxcontig
        public int MaxBpg { get; set; }                  // fs_maxbpg
        public int AvgFileSize { get; set; }             // fs_avgfilesize
        public int AvgFilesPerDir { get; set; }          // fs_avgfpdir

        // Fields required by FreeBSD's superblock validation
        public int MaxSymlinkLen { get; set; }           // fs_maxsymlinklen
        public long QBMask { get; set; }                 // fs_qbmask - ~fs_bmask as int64
        public long QFMask { get; set; }                 // fs_qfmask - ~fs_fmask as int64
        public int OldInodeFmt { get; set; }             // fs_old_inodefmt
        public long MaxFileSize { get; set; }            // fs_maxfilesize
        public long SbBlockLoc { get; set; }              // fs_sblockloc
        public int MaxBSize { get; set; }                // fs_maxbsize
        public int ContigSumSize { get; set; }           // fs_contigsumsize
        public int CgSize { get; set; }                  // fs_cgsize
        public int CsSize { get; set; }                  // fs_cssize
        public long CsAddr { get; set; }                 // fs_csaddr (UFS2 64-bit)
        public long ProviderSize { get; set; }           // fs_providersize
        public long MetaSpace { get; set; }              // fs_metaspace

        /// <summary>
        /// Write this superblock to a binary stream at the current position.
        /// Produces the exact byte layout of FreeBSD's struct fs (amd64, sizeof=1376).
        /// All offsets verified against FreeBSD sys/ufs/ffs/fs.h using offsetof().
        /// </summary>
        public void WriteTo(BinaryWriter writer)
        {
            byte[] block = new byte[Ufs2Constants.SuperblockSize];
            using var ms = new MemoryStream(block);
            using var bw = new BinaryWriter(ms, Encoding.ASCII);

            // fs_firstfield (0x000)
            bw.Write(FirstDataBlock);
            // fs_unused_1 (0x004)
            bw.Write(0);
            // fs_sblkno (0x008)
            bw.Write(SuperblockLocation);
            // fs_cblkno (0x00C)
            bw.Write(CblkNo);
            // fs_iblkno (0x010)
            bw.Write(IblkNo);
            // fs_dblkno (0x014)
            bw.Write(DblkNo);

            // fs_old_cgoffset (0x018)
            bw.Write(CgOffset);
            // fs_old_cgmask (0x01C)
            bw.Write(CgMask);

            // fs_old_time (0x020) - 32-bit time for UFS1 compat
            bw.Write((int)(Time & 0xFFFFFFFF));
            // fs_old_size (0x024)
            bw.Write((int)(TotalBlocks & 0xFFFFFFFF));

            // fs_old_dsize (0x028)
            bw.Write((int)(TotalDataBlocks & 0xFFFFFFFF));
            // fs_ncg (0x02C)
            bw.Write(NumCylGroups);
            // fs_bsize (0x030)
            bw.Write(BSize);
            // fs_fsize (0x034)
            bw.Write(FSize);
            // fs_frag (0x038)
            bw.Write(FragsPerBlock);

            // fs_minfree (0x03C)
            bw.Write(MinFreePercent);
            // fs_old_rotdelay (0x040)
            bw.Write(0);
            // fs_old_rps (0x044)
            bw.Write(0);

            // fs_bmask (0x048)
            bw.Write(BMask);
            // fs_fmask (0x04C)
            bw.Write(FMask);
            // fs_bshift (0x050)
            bw.Write(BShift);
            // fs_fshift (0x054)
            bw.Write(FShift);

            // fs_maxcontig (0x058)
            bw.Write(MaxContig > 0 ? MaxContig : FragsPerBlock);
            // fs_maxbpg (0x05C)
            bw.Write(MaxBpg > 0 ? MaxBpg : InodesPerGroup);

            // fs_fragshift (0x060)
            bw.Write(FragShift);
            // fs_fsbtodb (0x064)
            int sectorSize = SectorSize > 0 ? SectorSize : Ufs2Constants.DefaultSectorSize;
            bw.Write(Log2(FSize / sectorSize));

            // fs_sbsize (0x068)
            bw.Write(Ufs2Constants.SuperblockSize);
            // fs_spare1[0] (0x06C)
            bw.Write(0);
            // fs_spare1[1] (0x070)
            bw.Write(0);

            // fs_nindir (0x074) — number of indirect pointers per block
            int ptrSize = (Magic == Ufs2Constants.Ufs1Magic) ? 4 : 8;
            bw.Write(BSize / ptrSize);

            // fs_inopb (0x078) — inodes per block
            int inodeSize = (Magic == Ufs2Constants.Ufs1Magic)
                ? Ufs2Constants.Ufs1InodeSize : Ufs2Constants.Ufs2InodeSize;
            bw.Write(BSize / inodeSize);
            // fs_old_nspf (0x07C)
            bw.Write(FSize / sectorSize);

            // fs_optim (0x080)
            bw.Write(Optimization);
            // fs_old_npsect (0x084)
            bw.Write(0);
            // fs_old_interleave (0x088)
            bw.Write(0);
            // fs_old_trackskew (0x08C)
            bw.Write(0);

            // fs_id[0] (0x090), fs_id[1] (0x094)
            bw.Write(FsId0);
            bw.Write(FsId1);

            // fs_old_csaddr (0x098)
            bw.Write((int)(CsAddr & 0xFFFFFFFF));
            // fs_cssize (0x09C)
            bw.Write(CsSize);
            // fs_cgsize (0x0A0)
            bw.Write(CgSize);

            // fs_spare2 (0x0A4)
            bw.Write(0);
            // fs_old_nsect (0x0A8)
            bw.Write(0);
            // fs_old_spc (0x0AC)
            bw.Write(0);

            // fs_old_ncyl (0x0B0)
            bw.Write(NumCylGroups);
            // fs_old_cpg (0x0B4)
            bw.Write(1);

            // fs_ipg (0x0B8) - inodes per group
            bw.Write(InodesPerGroup);
            // fs_fpg (0x0BC) - fragments per group
            bw.Write(CylGroupSize);

            // fs_old_cstotal (0x0C0) - struct csum, 4 x int32 = 16 bytes
            bw.Write((int)(Directories & 0xFFFFFFFF));   // cs_ndir
            bw.Write((int)(FreeBlocks & 0xFFFFFFFF));    // cs_nbfree
            bw.Write((int)(FreeInodes & 0xFFFFFFFF));    // cs_nifree
            bw.Write((int)(FreeFragments & 0xFFFFFFFF)); // cs_nffree

            // fs_fmod (0x0D0), fs_clean (0x0D1), fs_ronly (0x0D2), fs_old_flags (0x0D3)
            bw.Write((byte)0); // fs_fmod
            bw.Write((byte)1); // fs_clean = 1 (clean)
            bw.Write((byte)0); // fs_ronly
            bw.Write((byte)Ufs2Constants.FsFlagsUpdated); // fs_old_flags = FS_FLAGS_UPDATED

            // fs_fsmnt (0x0D4) - mount point, MAXMNTLEN=468 bytes
            byte[] mntBytes = new byte[Ufs2Constants.MaxMntLen];
            Encoding.ASCII.GetBytes(MountPoint, 0,
                Math.Min(MountPoint.Length, Ufs2Constants.MaxMntLen - 1), mntBytes, 0);
            bw.Write(mntBytes);

            // fs_volname (0x2A8) - MAXVOLLEN=32 bytes
            byte[] volBytes = new byte[Ufs2Constants.MaxVolLen];
            Encoding.ASCII.GetBytes(VolumeName, 0,
                Math.Min(VolumeName.Length, Ufs2Constants.MaxVolLen - 1), volBytes, 0);
            bw.Write(volBytes);

            // fs_swuid (0x2C8) - 8 bytes
            bw.Write(0L);

            // fs_pad (0x2D0) - 4 bytes
            bw.Write(0);

            // fs_cgrotor (0x2D4) - 4 bytes
            bw.Write(0);

            // fs_ocsp[NOCSPTRS] (0x2D8) + fs_si (0x350) = 128 bytes of in-core pointers (zero on disk)
            ms.Position = 0x2D8;
            for (int i = 0; i < 128 / 4; i++) bw.Write(0);

            // fs_old_cpc (0x358)
            ms.Position = 0x358;
            bw.Write(0);
            // fs_maxbsize (0x35C)
            bw.Write(MaxBSize > 0 ? MaxBSize : BSize);

            // fs_unrefs (0x360) - int64
            bw.Write(0L);
            // fs_providersize (0x368) - int64
            bw.Write(ProviderSize);
            // fs_metaspace (0x370) - int64
            bw.Write(MetaSpace);
            // fs_save_maxfilesize (0x378) - uint64
            bw.Write(0L);

            // fs_sparecon64[12] (0x380) - 96 bytes
            ms.Position = 0x380;
            for (int i = 0; i < 12; i++) bw.Write(0L);

            // fs_sblockactualloc (0x3E0) - int64
            bw.Write(SbBlockLoc);
            // fs_sblockloc (0x3E8) - int64
            bw.Write(SbBlockLoc);

            // fs_cstotal (0x3F0) - struct csum_total, 8 x int64 = 64 bytes
            bw.Write(Directories);    // cs_ndir
            bw.Write(FreeBlocks);     // cs_nbfree
            bw.Write(FreeInodes);     // cs_nifree
            bw.Write(FreeFragments);  // cs_nffree
            bw.Write(NumClusters);    // cs_numclusters
            bw.Write(0L);             // cs_spare[0]
            bw.Write(0L);             // cs_spare[1]
            bw.Write(0L);             // cs_spare[2]

            // fs_time (0x430) - UFS2 64-bit time
            bw.Write(Time);

            // fs_size (0x438) - total fragments
            bw.Write(TotalBlocks);
            // fs_dsize (0x440) - total data fragments
            bw.Write(TotalDataBlocks);

            // fs_csaddr (0x448) - UFS2 64-bit
            bw.Write(CsAddr);

            // fs_pendingblocks (0x450) - int64
            bw.Write(0L);
            // fs_pendinginodes (0x458) - uint32
            bw.Write(0);

            // fs_snapinum (0x45C) - 20 x uint32 = 80 bytes
            for (int i = 0; i < 20; i++) bw.Write(0);

            // fs_avgfilesize (0x4AC) - uint32
            bw.Write(AvgFileSize);
            // fs_avgfpdir (0x4B0) - uint32
            bw.Write(AvgFilesPerDir);

            // fs_available_spare (0x4B4) - uint32
            bw.Write(0);
            // fs_mtime (0x4B8) - int64
            bw.Write(Time);
            // fs_sujfree (0x4C0) - int32
            bw.Write(0);

            // fs_sparecon32[21] (0x4C4) - 84 bytes
            for (int i = 0; i < 21; i++) bw.Write(0);

            // fs_ckhash (0x518) - uint32
            bw.Write(0);
            // fs_metackhash (0x51C) - uint32
            bw.Write(0);

            // fs_flags (0x520)
            bw.Write(Flags);
            // fs_contigsumsize (0x524)
            bw.Write(ContigSumSize);
            // fs_maxsymlinklen (0x528)
            bw.Write(MaxSymlinkLen);
            // fs_old_inodefmt (0x52C)
            bw.Write(OldInodeFmt);

            // fs_maxfilesize (0x530) - uint64
            bw.Write(MaxFileSize);

            // fs_qbmask (0x538) - int64
            bw.Write(QBMask);
            // fs_qfmask (0x540) - int64
            bw.Write(QFMask);

            // fs_state (0x548)
            bw.Write(0);
            // fs_old_postblformat (0x54C)
            bw.Write(Ufs2Constants.FsDynamicPostblFmt);
            // fs_old_nrpos (0x550)
            bw.Write(1);
            // fs_spare5[0] (0x554)
            bw.Write(0);
            // fs_spare5[1] (0x558)
            bw.Write(0);

            // fs_magic (0x55C)
            bw.Write(Magic);

            writer.Write(block);
        }

        /// <summary>
        /// Read a superblock from the given binary reader at the current position.
        /// All offsets verified against FreeBSD sys/ufs/ffs/fs.h using offsetof().
        /// </summary>
        public static Ufs2Superblock ReadFrom(BinaryReader reader)
        {
            byte[] block = reader.ReadBytes(Ufs2Constants.SuperblockSize);
            using var ms = new MemoryStream(block);
            using var br = new BinaryReader(ms, Encoding.ASCII);

            var sb = new Ufs2Superblock
            {
                // 0x000 - 0x014
                FirstDataBlock = br.ReadInt32()
            };
            br.ReadInt32(); // unused_1
            sb.SuperblockLocation = br.ReadInt32();
            sb.CblkNo = br.ReadInt32();
            sb.IblkNo = br.ReadInt32();
            sb.DblkNo = br.ReadInt32();
            // 0x018 - 0x01C
            sb.CgOffset = br.ReadInt32();
            sb.CgMask = br.ReadInt32();

            // 0x020 - 0x024
            int oldTime = br.ReadInt32(); // old_time
            br.ReadInt32(); // old_size

            // 0x028 - 0x038
            br.ReadInt32(); // old_dsize
            sb.NumCylGroups = br.ReadInt32();
            sb.BSize = br.ReadInt32();
            sb.FSize = br.ReadInt32();
            sb.FragsPerBlock = br.ReadInt32();

            // 0x03C - 0x044
            sb.MinFreePercent = br.ReadInt32();
            br.ReadInt32(); // old_rotdelay
            br.ReadInt32(); // old_rps

            // 0x048 - 0x054
            sb.BMask = br.ReadInt32();
            sb.FMask = br.ReadInt32();
            sb.BShift = br.ReadInt32();
            sb.FShift = br.ReadInt32();

            // 0x058 - 0x05C
            sb.MaxContig = br.ReadInt32();
            sb.MaxBpg = br.ReadInt32();

            // 0x060
            sb.FragShift = br.ReadInt32();

            // 0x064 - fs_fsbtodb
            int fsbtodb = br.ReadInt32();
            // Recover sector size from fs_fsbtodb = log2(fsize / sectorsize)
            // => sectorsize = fsize / (1 << fsbtodb)
            // Guard: fsbtodb < 30 prevents (1 << fsbtodb) overflow;
            // computed >= MinSectorSize (512) ensures a valid sector size.
            if (fsbtodb >= 0 && fsbtodb < 30 && sb.FSize > 0)
            {
                int computed = sb.FSize / (1 << fsbtodb);
                if (computed >= Ufs2Constants.DefaultSectorSize)
                    sb.SectorSize = computed;
            }

            // 0x080
            ms.Position = 0x80;
            sb.Optimization = br.ReadInt32();

            // 0x090 - 0x094
            ms.Position = 0x90;
            sb.FsId0 = br.ReadInt32();
            sb.FsId1 = br.ReadInt32();

            // 0x09C - 0x0A0
            ms.Position = 0x9C;
            sb.CsSize = br.ReadInt32();
            sb.CgSize = br.ReadInt32();

            // fs_ipg (0x0B8), fs_fpg (0x0BC)
            ms.Position = 0xB8;
            sb.InodesPerGroup = br.ReadInt32();
            sb.CylGroupSize = br.ReadInt32();

            // fs_fsmnt (0x0D4)
            ms.Position = 0xD4;
            byte[] mntBytes = br.ReadBytes(Ufs2Constants.MaxMntLen);
            sb.MountPoint = Encoding.ASCII.GetString(mntBytes).TrimEnd('\0');

            // fs_volname (0x2A8)
            ms.Position = 0x2A8;
            byte[] volBytes = br.ReadBytes(Ufs2Constants.MaxVolLen);
            sb.VolumeName = Encoding.ASCII.GetString(volBytes).TrimEnd('\0');

            // fs_maxbsize (0x35C)
            ms.Position = 0x35C;
            sb.MaxBSize = br.ReadInt32();

            // fs_providersize (0x368)
            ms.Position = 0x368;
            sb.ProviderSize = br.ReadInt64();

            // fs_metaspace (0x370)
            sb.MetaSpace = br.ReadInt64();

            // fs_sblockloc (0x3E8)
            ms.Position = 0x3E8;
            sb.SbBlockLoc = br.ReadInt64();

            // fs_cstotal (0x3F0) - 64-bit summary
            ms.Position = 0x3F0;
            sb.Directories = br.ReadInt64();
            sb.FreeBlocks = br.ReadInt64();
            sb.FreeInodes = br.ReadInt64();
            sb.FreeFragments = br.ReadInt64();
            sb.NumClusters = br.ReadInt64();

            // fs_time (0x430)
            ms.Position = 0x430;
            sb.Time = br.ReadInt64();
            sb.TotalBlocks = br.ReadInt64();
            sb.TotalDataBlocks = br.ReadInt64();

            // fs_csaddr (0x448)
            sb.CsAddr = br.ReadInt64();

            // fs_avgfilesize (0x4AC), fs_avgfpdir (0x4B0)
            ms.Position = 0x4AC;
            sb.AvgFileSize = br.ReadInt32();
            sb.AvgFilesPerDir = br.ReadInt32();

            // fs_flags (0x520)
            ms.Position = 0x520;
            sb.Flags = br.ReadInt32();

            // fs_contigsumsize (0x524)
            sb.ContigSumSize = br.ReadInt32();

            // fs_maxsymlinklen (0x528)
            sb.MaxSymlinkLen = br.ReadInt32();

            // fs_old_inodefmt (0x52C)
            sb.OldInodeFmt = br.ReadInt32();

            // fs_maxfilesize (0x530)
            sb.MaxFileSize = br.ReadInt64();

            // fs_qbmask (0x538), fs_qfmask (0x540)
            sb.QBMask = br.ReadInt64();
            sb.QFMask = br.ReadInt64();

            // fs_magic (0x55C)
            ms.Position = 0x55C;
            sb.Magic = br.ReadInt32();

            // If UFS1 and 64-bit time is zero, use old 32-bit time
            if (sb.Magic == Ufs2Constants.Ufs1Magic && sb.Time == 0)
                sb.Time = oldTime;

            return sb;
        }

        public bool IsValid => Magic == Ufs2Constants.Ufs2Magic || Magic == Ufs2Constants.Ufs1Magic;
        public bool IsUfs1 => Magic == Ufs2Constants.Ufs1Magic;
        public bool IsUfs2 => Magic == Ufs2Constants.Ufs2Magic;

        private static int Log2(int value)
        {
            int result = 0;
            while (value > 1) { value >>= 1; result++; }
            return result;
        }
    }
}
