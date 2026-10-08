// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// UCP container codec. The trophy and user-data-system components of a PS5 package are shipped as
// UCP archives (sce_sys/trophy2/trophyNN.ucp and sce_sys/uds/udsNN.ucp): a flat set of named blobs
// (icons, PNG assets, JSON definition/metadata files) wrapped in a self-describing table plus a
// whole-file SHA-1 digest. The consumer reads entries through the table and re-validates the digest,
// so any self-consistent archive with a correct digest is accepted.

#nullable enable
using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;

namespace LibProsperoPkg.Content;

/// <summary>One named blob inside a <see cref="ProsperoUcp"/> archive.</summary>
/// <param name="Name">The entry name (no path separators; at most 32 bytes).</param>
/// <param name="Data">The raw entry bytes.</param>
public sealed record UcpEntry(string Name, byte[] Data);

/// <summary>
/// Reader and producer for the UCP archive format used by the trophy and user-data-system components
/// of a PS5 package.
/// </summary>
/// <remarks>
/// Layout (big-endian scalars):
/// <list type="bullet">
/// <item>Header, 0x60 bytes: 0x00 u32 magic <c>0xB228C60A</c>; 0x04 u32 version (1); 0x08 u64 total
/// file size; 0x10 u32 entry count; 0x14 u32 entry-record size (0x40); 0x18 u32 zero; 0x1C 20-byte
/// SHA-1 digest; 0x30..0x60 reserved zero.</item>
/// <item>Entry table at 0x60, one 0x40-byte record per entry: 32-byte name (NUL-padded), u64 offset,
/// u64 size, 16 reserved bytes.</item>
/// <item>Blob region: entries in ascending name order, each blob followed by padding to the next
/// 16-byte boundary (a full 16 bytes when the end is already aligned); the file size is padded the
/// same way. The digest covers the whole file with the digest field held zero.</item>
/// </list>
/// </remarks>
public static class ProsperoUcp
{
    /// <summary>Archive magic (big-endian) at file offset 0x00.</summary>
    public const uint Magic = 0xB228C60A;

    /// <summary>Format version at file offset 0x04.</summary>
    public const uint Version = 1;

    private const int HeaderSize = 0x60;
    private const int EntryRecordSize = 0x40;
    private const int NameFieldSize = 0x20;
    private const int CountOffset = 0x10;
    private const int RecordSizeOffset = 0x14;
    private const int DigestOffset = 0x1C;
    private const int DigestSize = 20;
    private const int BlobAlignment = 0x10;

    /// <summary>Returns whether the buffer begins with a UCP header.</summary>
    public static bool IsUcp(ReadOnlySpan<byte> data) =>
        data.Length >= HeaderSize && BinaryPrimitives.ReadUInt32BigEndian(data) == Magic;

    /// <summary>Reads the entry list from a UCP archive.</summary>
    /// <exception cref="InvalidDataException">The buffer is not a structurally valid archive.</exception>
    public static IReadOnlyList<UcpEntry> Read(ReadOnlySpan<byte> data)
    {
        if (!Validate(data, out var error))
            throw new InvalidDataException(error);

        int count = (int)BinaryPrimitives.ReadUInt32BigEndian(data[CountOffset..]);
        var entries = new List<UcpEntry>(count);
        for (int i = 0; i < count; i++)
        {
            int rec = HeaderSize + i * EntryRecordSize;
            var nameField = data.Slice(rec, NameFieldSize);
            int nul = nameField.IndexOf((byte)0);
            string name = Encoding.Latin1.GetString(nul < 0 ? nameField : nameField[..nul]);
            ulong off = BinaryPrimitives.ReadUInt64BigEndian(data[(rec + NameFieldSize)..]);
            ulong size = BinaryPrimitives.ReadUInt64BigEndian(data[(rec + NameFieldSize + 8)..]);
            entries.Add(new UcpEntry(name, data.Slice((int)off, (int)size).ToArray()));
        }
        return entries;
    }

    /// <summary>Builds a UCP archive from a set of named blobs.</summary>
    /// <exception cref="ArgumentException">A name is empty, duplicated, or longer than the name field.</exception>
    public static byte[] Build(IEnumerable<UcpEntry> entries)
    {
        ArgumentNullException.ThrowIfNull(entries);
        var ordered = entries.OrderBy(e => e.Name, StringComparer.Ordinal).ToArray();

        var names = new byte[ordered.Length][];
        var seen = new HashSet<string>(StringComparer.Ordinal);
        for (int i = 0; i < ordered.Length; i++)
        {
            string name = ordered[i].Name;
            if (string.IsNullOrEmpty(name))
                throw new ArgumentException("A UCP entry name must not be empty.", nameof(entries));
            byte[] nb = Encoding.Latin1.GetBytes(name);
            if (nb.Length > NameFieldSize)
                throw new ArgumentException($"UCP entry name '{name}' exceeds {NameFieldSize} bytes.", nameof(entries));
            if (!seen.Add(name))
                throw new ArgumentException($"Duplicate UCP entry name '{name}'.", nameof(entries));
            names[i] = nb;
        }

        // Lay out the blob region: the first blob starts right after the entry table (already
        // 16-aligned); each following blob starts at the next 16-byte boundary past the previous
        // blob's end. The total file size is padded the same way.
        var offsets = new long[ordered.Length];
        long cursor = HeaderSize + (long)ordered.Length * EntryRecordSize;
        for (int i = 0; i < ordered.Length; i++)
        {
            offsets[i] = cursor;
            cursor = AlignUpStrict(cursor + ordered[i].Data.Length);
        }
        long total = ordered.Length == 0 ? HeaderSize : cursor;

        var buffer = new byte[total];
        var span = buffer.AsSpan();
        BinaryPrimitives.WriteUInt32BigEndian(span, Magic);
        BinaryPrimitives.WriteUInt32BigEndian(span[4..], Version);
        BinaryPrimitives.WriteUInt64BigEndian(span[8..], (ulong)total);
        BinaryPrimitives.WriteUInt32BigEndian(span[CountOffset..], (uint)ordered.Length);
        BinaryPrimitives.WriteUInt32BigEndian(span[RecordSizeOffset..], EntryRecordSize);

        for (int i = 0; i < ordered.Length; i++)
        {
            int rec = HeaderSize + i * EntryRecordSize;
            names[i].CopyTo(span[rec..]);
            BinaryPrimitives.WriteUInt64BigEndian(span[(rec + NameFieldSize)..], (ulong)offsets[i]);
            BinaryPrimitives.WriteUInt64BigEndian(span[(rec + NameFieldSize + 8)..], (ulong)ordered[i].Data.Length);
            ordered[i].Data.CopyTo(span[(int)offsets[i]..]);
        }

        WriteDigest(buffer);
        return buffer;
    }

    /// <summary>
    /// Builds a UCP archive from the top-level files of a directory, using each file name as the entry
    /// name. Subdirectories are ignored.
    /// </summary>
    public static byte[] BuildFromDirectory(string directory)
    {
        ArgumentException.ThrowIfNullOrEmpty(directory);
        if (!Directory.Exists(directory))
            throw new DirectoryNotFoundException($"UCP source directory not found: {directory}");
        var entries = Directory.EnumerateFiles(directory)
            .Select(p => new UcpEntry(Path.GetFileName(p), File.ReadAllBytes(p)));
        return Build(entries);
    }

    /// <summary>
    /// Validates the header and entry table of a UCP archive. Does not verify the digest; use
    /// <see cref="VerifyDigest"/> for that.
    /// </summary>
    public static bool Validate(ReadOnlySpan<byte> data, out string? error)
    {
        if (data.Length < HeaderSize) { error = "Buffer is smaller than a UCP header."; return false; }
        if (BinaryPrimitives.ReadUInt32BigEndian(data) != Magic) { error = "Bad UCP magic."; return false; }
        if (BinaryPrimitives.ReadUInt32BigEndian(data[4..]) != Version) { error = "Unsupported UCP version."; return false; }

        ulong total = BinaryPrimitives.ReadUInt64BigEndian(data[8..]);
        if (total != (ulong)data.Length) { error = $"UCP size field ({total}) does not match buffer length ({data.Length})."; return false; }

        uint recSize = BinaryPrimitives.ReadUInt32BigEndian(data[RecordSizeOffset..]);
        if (recSize != EntryRecordSize) { error = $"Unexpected UCP entry-record size {recSize}."; return false; }

        long count = BinaryPrimitives.ReadUInt32BigEndian(data[CountOffset..]);
        long tableEnd = HeaderSize + count * EntryRecordSize;
        if (tableEnd > data.Length) { error = "UCP entry table overruns the buffer."; return false; }

        for (int i = 0; i < count; i++)
        {
            int rec = HeaderSize + i * EntryRecordSize;
            ulong off = BinaryPrimitives.ReadUInt64BigEndian(data[(rec + NameFieldSize)..]);
            ulong size = BinaryPrimitives.ReadUInt64BigEndian(data[(rec + NameFieldSize + 8)..]);
            if (off < (ulong)tableEnd || off + size > total)
            {
                error = $"UCP entry {i} range [{off},{off + size}) is outside the blob region.";
                return false;
            }
        }
        error = null;
        return true;
    }

    /// <summary>Recomputes the stored SHA-1 digest and reports whether it matches.</summary>
    public static bool VerifyDigest(ReadOnlySpan<byte> data)
    {
        if (data.Length < HeaderSize) return false;
        Span<byte> stored = stackalloc byte[DigestSize];
        data.Slice(DigestOffset, DigestSize).CopyTo(stored);
        byte[] copy = data.ToArray();
        Array.Clear(copy, DigestOffset, DigestSize);
        Span<byte> calc = stackalloc byte[DigestSize];
        SHA1.HashData(copy, calc);
        return calc.SequenceEqual(stored);
    }

    /// <summary>
    /// Returns a copy of the archive with its SHA-1 digest recomputed, correcting a stale or wrong
    /// digest without touching the entry data.
    /// </summary>
    public static byte[] WithRepairedDigest(ReadOnlySpan<byte> data)
    {
        if (!IsUcp(data))
            throw new InvalidDataException("Buffer is not a UCP archive.");
        byte[] copy = data.ToArray();
        WriteDigest(copy);
        return copy;
    }

    private static void WriteDigest(byte[] buffer)
    {
        Array.Clear(buffer, DigestOffset, DigestSize);
        Span<byte> digest = stackalloc byte[DigestSize];
        SHA1.HashData(buffer, digest);
        digest.CopyTo(buffer.AsSpan(DigestOffset));
    }

    // Next 16-byte boundary strictly greater than value (a full 16 bytes when already aligned).
    private static long AlignUpStrict(long value) => ((value / BlobAlignment) + 1) * BlobAlignment;
}
