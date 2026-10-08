// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// PFS image structures, builder and reader primitives.
#nullable disable

namespace LibProsperoPkg.PFS;

/// <summary>
/// A data structure representing everything configurable in a PFS image.
/// Gets fed to a PfsBuilder.
/// </summary>
public class PfsProperties
{
    public FSDir root;
    public long FileTime;
    public uint BlockSize;
    public uint MinBlocks = 0;
    public bool Encrypt;
    public bool Sign;
    /// <summary>
    /// Use the publisher PPR-PFS geometry: reserve block 1, place the inode table at block 2,
    /// and expose inode 0 as the user root without a super-root or flat-path-table wrapper.
    /// </summary>
    public bool DirectRootLayout;

    /// <summary>
    /// Remove files under sce_sys that are normally represented as outer package entries.
    /// Disable this for standalone publisher PPR-PFS images, which retain those files.
    /// </summary>
    public bool FilterOuterPackageEntries = true;

    /// <summary>Place lower-priority-number files first and keep each extent contiguous.</summary>
    public bool OptimizeFileLayoutForReadSpeed;
    public byte[] EKPFS;
    public byte[] Seed;

    /// <summary>
    /// PFS superblock version stamped into the image header
    /// (<see cref="PfsHeader.VersionPs5"/>, 2).
    /// </summary>
    public long Version = PfsHeader.VersionPs5;
}
