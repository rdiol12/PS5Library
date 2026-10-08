// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// CNT container structures, entries and writer primitives.
#nullable disable
using LibProsperoPkg.Util;
using System;
using System.Collections.Generic;
using System.Linq;

namespace LibProsperoPkg.PKG;

public class Pkg
{
    // 0x0 - 0x5A0
    public Header Header;
    // 0xFE0 - 0xFFF
    public byte[] HeaderDigest;
    // Publisher profile: deterministic RSA-3072 public wrap at 0x1000 - 0x117F.
    // The historical member name is retained for API compatibility.
    public byte[] HeaderSignature;
    // Publisher profile: 0x2000 - 0x2B7F (0xB80 bytes).
    public KeysEntry EntryKeys;
    // Publisher profile commonly starts at 0x2B80 and is 0x800 bytes.
    public GenericEntry ImageKey;
    // Layout-dependent.
    public GeneralDigestsEntry GeneralDigests;
    // Layout-dependent.
    public MetasEntry Metas;
    // variable...
    public GenericEntry Digests;
    public NameTableEntry EntryNames;

    public List<Entry> Entries;

    // Constants
    const uint PKG_FLAG_FINALIZED = 1u << 31;
    const ulong PKG_PFS_FLAG_NESTED_IMAGE = 0x8000000000000000UL;
    public const int PKG_TABLE_ENTRY_SIZE = 0x20;
    public const int PKG_ENTRY_KEYSET_SIZE = 0x20;
    public const int HASH_SIZE = 0x20;
    public const string MAGIC = "\u007FCNT";

    const int PKG_MAX_ENTRY_KEYS = 7;
    const int PKG_CONTENT_ID_HASH_SIZE = HASH_SIZE;
    const int PKG_ENTRY_KEYS_XHASHES_SIZE = (PKG_MAX_ENTRY_KEYS * HASH_SIZE);
    const int PKG_PASSCODE_KEY_SIZE = 0x100;
    const int PKG_IMAGE_KEY_SIZE = 0x100;
    const int PKG_ENTRY_KEY_SIZE = 0x100;

    const int PKG_PLAYGO_CHUNK_HASH_TABLE_OFFSET = 0x40;
    const int PKG_PLAYGO_CHUNK_HASH_SIZE = 0x4;
    const int PKG_PLAYGO_PFS_CHUNK_SIZE = 0x10000;

    const int PKG_SHAREPARAM_FILE_VERSION_MAJOR = 1;
    const int PKG_SHAREPARAM_FILE_VERSION_MINOR = 10;

    public const int PKG_CONTENT_ID_SIZE = 0x30;
    public const int PKG_HEADER_SIZE = 0x5A0;
    public const int PKG_ENTRY_KEYSET_ENC_SIZE = 0x100;

    /// <summary>
    /// Decrypts the EKPFS for a package. Will not work on retail-only packages.
    /// </summary>
    /// <returns>The EKPFS if successful; null otherwise</returns>
    public byte[] GetEkpfs()
    {
        try
        {
            var dk3 = Crypto.RSA2048Decrypt(EntryKeys.Keys[3].key, RSAKeyset.PkgDerivedKey3Keyset);
            var iv_key = Crypto.Sha256(ImageKey.meta.GetBytes().Concat(dk3).ToArray());
            var imageKeyDecrypted = ImageKey.FileData.Clone() as byte[];
            Crypto.AesCbcCfb128Decrypt(
              imageKeyDecrypted,
              imageKeyDecrypted,
              imageKeyDecrypted.Length,
              iv_key.Skip(16).Take(16).ToArray(),
              iv_key.Take(16).ToArray());
            return Crypto.RSA2048Decrypt(imageKeyDecrypted, RSAKeyset.FakeKeyset);
        }
        catch
        {
            return null;
        }
    }

    /// <summary>
    /// Checks if the given passcode is valid for this pkg
    /// </summary>
    /// <param name="passcode"></param>
    /// <returns>True if the passcode is correct</returns>
    public bool CheckPasscode(string passcode)
    {
        if (passcode == null || passcode.Length != 32) return false;
        bool publisherProfile = EntryKeys.Keys.Length > 0 && EntryKeys.Keys[0].key.Length == 384;
        var dk0 = Crypto.ComputeKeys(Header.content_id, passcode, 0, useSha3: publisherProfile);
        var digest0 = (publisherProfile ? Crypto.Sha3_256(dk0) : Crypto.Sha256(dk0)).Xor(dk0);
        return digest0.SequenceEqual(EntryKeys.Keys[0].digest);
    }

    public bool CheckDerivedKey(byte[] dk, int index)
    {
        if (index < 0 || index > 6)
        {
            throw new ArgumentException("Invalid derived key index: " + index);
        }
        if (dk == null || dk.Length != 32)
            return false;
        bool publisherProfile = EntryKeys.Keys.Length > 0 && EntryKeys.Keys[0].key.Length == 384;
        var digest = (publisherProfile ? Crypto.Sha3_256(dk) : Crypto.Sha256(dk)).Xor(dk);
        return digest.SequenceEqual(EntryKeys.Keys[index].digest);

    }

    public bool CheckEkpfs(byte[] dk1) => CheckDerivedKey(dk1, 1);
}



public struct Header
{
    public string CNTMagic;
    public PKGFlags flags;
    /// <summary>PS5 CNT profile marker at +0x08 (0x80000000 in publisher packages).</summary>
    public uint ps5_profile_marker;
    /// <summary>CNT header profile code at +0x0C (0x0C in the PS5 publisher profile).</summary>
    public uint header_profile_code;
    public uint entry_count;
    public ushort sc_entry_count;
    public ushort entry_count_2; /* same as entry_count */
    public uint entry_table_offset;
    public uint main_ent_data_size;
    public ulong body_offset;
    public ulong body_size;
    public ulong mandatory_size;
    public string content_id; // Length = PKG_CONTENT_ID_SIZE
    public uint drm_type;
    public uint content_type;
    public ContentFlags content_flags;
    public uint promote_size;
    public uint version_date;
    public uint version_hash;
    /// <summary>Four profile-specific metadata words populated by delta-patch packages.</summary>
    public uint delta_patch_metadata_0;
    public uint delta_patch_metadata_1;
    public uint delta_patch_metadata_2;
    public uint delta_patch_metadata_3;
    public IROTag iro_tag;
    public uint ekc_version; /* drm type version */
    public byte[] sc_entries1_hash;
    public byte[] sc_entries2_hash;
    public byte[] digest_table_hash;
    public byte[] body_digest;

    /// <summary>Nonzero when the PFS image descriptor beginning at +0x404 is present.</summary>
    public uint pfs_descriptor_presence;
    public uint pfs_image_count;
    public ulong pfs_flags;
    public ulong pfs_image_offset;
    public ulong pfs_image_size;
    public ulong mount_image_offset;
    public ulong mount_image_size;
    public ulong package_size;
    public uint pfs_signed_size;
    public uint pfs_cache_size;
    public byte[] pfs_image_digest;
    public byte[] pfs_signed_digest;
    public ulong pfs_split_size_nth_0;
    public ulong pfs_split_size_nth_1;
    /// <summary>Outer-PFS AES-XTS seed, mirrored from superblock+0x370.</summary>
    public byte[] image_seed;
    /// <summary>FIH-relative offset and size of the embedded CNT region.</summary>
    public ulong cnt_region_offset;
    public ulong cnt_region_size;
    /// <summary>IMAGE_KEY and mandatory/imagedigs CNT region descriptors.</summary>
    public uint desc_image_key_offset;
    public uint desc_image_key_size;
    public uint desc_mandatory_offset;
    public uint desc_mandatory_size;
    /// <summary>SHA3-256 of each region described at CNT+0x510.</summary>
    public byte[] desc_digest;
}
