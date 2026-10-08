// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// Central PS5 publisher CNT entry flags/key-index/name policy.
#nullable enable
using System;

namespace LibProsperoPkg.PKG;

/// <summary>Resolved table policy for one CNT entry.</summary>
public readonly record struct ProsperoCntEntryProfile(
    uint Flags1, uint Flags2, bool IncludeName);

/// <summary>
/// Resolves the publisher entry flags, encryption-key index and fixed-entry naming rule.
/// </summary>
public static class ProsperoCntEntryPolicy
{
    private const uint Encrypted = 0x80000000;
    private const uint Data = 0x08000000;

    /// <summary>Returns the profile for one entry and package volume type.</summary>
    public static ProsperoCntEntryProfile Resolve(
        uint id, ProsperoVolumeType volumeType, string? relativeName = null,
        string? applicationDrmType = null)
    {
        return id switch
        {
            (uint)EntryId.DIGESTS =>
                new ProsperoCntEntryProfile(0x40000000, 0, false),
            (uint)EntryId.ENTRY_KEYS or
            (uint)EntryId.IMAGE_KEY or
            (uint)EntryId.GENERAL_DIGESTS or
            (uint)EntryId.METAS =>
                new ProsperoCntEntryProfile(0x60000000, 0, false),
            (uint)EntryId.ENTRY_NAMES =>
                new ProsperoCntEntryProfile(0x40000000, 0, false),

            (uint)EntryId.LICENSE_DAT =>
                Protected(keyIndex: 3, includeName: false),
            (uint)EntryId.LICENSE_INFO =>
                Protected(
                    // A base GD/application license uses key 2. An upgradable APP is the
                    // patch/upgrade profile and uses the same key-4 license.info wrapping
                    // observed for AC/AL, despite retaining content_type 0x20.
                    keyIndex: volumeType == ProsperoVolumeType.Application &&
                              !IsUpgradableApplication(applicationDrmType)
                        ? 2
                        : 4,
                    includeName: false),
            (uint)EntryId.NPTITLE_DAT or
            (uint)EntryId.NPBIND_DAT or
            (uint)EntryId.SELFINFO_DAT or
            (uint)EntryId.IMAGEINFO_DAT or
            (uint)EntryId.TARGET_DELTAINFO_DAT or
            (uint)EntryId.ORIGIN_DELTAINFO_DAT or
            (uint)EntryId.PSRESERVED_DAT =>
                Protected(keyIndex: 3, includeName: false),

            0x2000 => new ProsperoCntEntryProfile(0, 0, true), // param.json
            _ when IsNestedNpbind(relativeName) =>
                Protected(keyIndex: 3, includeName: true),
            _ => new ProsperoCntEntryProfile(Data, 0, true),
        };
    }

    private static ProsperoCntEntryProfile Protected(int keyIndex, bool includeName) =>
        new(Encrypted, checked((uint)keyIndex << 12), includeName);

    private static bool IsNestedNpbind(string? relativeName) =>
        relativeName is not null &&
        (relativeName.Equals("npbind.dat", StringComparison.OrdinalIgnoreCase) ||
         relativeName.EndsWith("/npbind.dat", StringComparison.OrdinalIgnoreCase));

    private static bool IsUpgradableApplication(string? applicationDrmType) =>
        applicationDrmType?.Equals("upgradable", StringComparison.OrdinalIgnoreCase) == true;
}
