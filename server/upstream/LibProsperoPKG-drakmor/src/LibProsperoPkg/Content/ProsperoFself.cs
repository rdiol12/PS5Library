// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// SELF (signed ELF) container reader and fake-self producer. A PS5 package wraps executable modules as
// SELF images: an SCE header, a segment table, the original ELF header and program headers, extended
// info, and plaintext segment data. The debug path builds a fake-self whose per-segment digest and
// signature areas are zero-filled and whose authority id carries the fake-authority prefix, so a debug
// console accepts the module without a real signature. The extended-info digest is SHA-256 over the whole
// input ELF file.

#nullable enable
using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Security.Cryptography;

namespace LibProsperoPkg.Content;

/// <summary>A decoded entry from a <see cref="ProsperoFself"/> segment table.</summary>
/// <param name="Flags">Raw 64-bit flags word.</param>
/// <param name="FileOffset">Offset of the segment data within the SELF file.</param>
/// <param name="FileSize">Stored size of the segment.</param>
/// <param name="MemSize">In-memory size of the segment.</param>
public sealed record SelfSegment(ulong Flags, ulong FileOffset, ulong FileSize, ulong MemSize)
{
    /// <summary>Segment id (bits 20..35), a program-header index for data segments.</summary>
    public int Id => (int)((Flags >> 20) & 0xFFFF);

    /// <summary>Whether the segment is ordered.</summary>
    public bool Ordered => (Flags & 0x1) != 0;

    /// <summary>Whether the segment data is encrypted.</summary>
    public bool Encrypted => (Flags & 0x2) != 0;

    /// <summary>Whether the segment is covered by a signature/digest.</summary>
    public bool Signed => (Flags & 0x4) != 0;

    /// <summary>Whether the segment data is deflate-compressed.</summary>
    public bool Compressed => (Flags & 0x8) != 0;

    /// <summary>Whether the segment is stored in fixed-size blocks.</summary>
    public bool Blocked => (Flags & 0x800) != 0;
}

/// <summary>SELF extended information (0x40 bytes) that follows the ELF program headers.</summary>
/// <param name="AuthorityId">Program authority id (PAID). A fake-self uses the 0x31.. prefix.</param>
/// <param name="ProgramType">Program type (PTYPE).</param>
/// <param name="AppVersion">Application version.</param>
/// <param name="FirmwareVersion">Firmware version.</param>
/// <param name="Digest">SHA-256 of the original ELF file.</param>
public sealed record SelfExtInfo(ulong AuthorityId, ulong ProgramType, ulong AppVersion, ulong FirmwareVersion, byte[] Digest);

/// <summary>A parsed SELF image.</summary>
/// <param name="ProgramType">SCE header program/key type field.</param>
/// <param name="HeaderSize">Size of the header region.</param>
/// <param name="MetaSize">Size of the metadata footer.</param>
/// <param name="FileSize">Total file size recorded in the header.</param>
/// <param name="Segments">Decoded segment table.</param>
/// <param name="Elf">The embedded ELF header and program headers region.</param>
/// <param name="ExtInfo">Extended info, when present.</param>
public sealed record SelfImage(
    uint ProgramType,
    int HeaderSize,
    int MetaSize,
    ulong FileSize,
    IReadOnlyList<SelfSegment> Segments,
    byte[] Elf,
    SelfExtInfo? ExtInfo);

/// <summary>Options for <see cref="ProsperoFself.MakeFself"/>.</summary>
public sealed class FselfOptions
{
    /// <summary>Application version written to the extended info.</summary>
    public ulong AppVersion { get; init; }

    /// <summary>Firmware version written to the extended info.</summary>
    public ulong FirmwareVersion { get; init; }

    /// <summary>
    /// Overrides the authority id. When null, the id is derived from the ELF type and the ex-info byte.
    /// </summary>
    public ulong? AuthorityId { get; init; }

    /// <summary>
    /// Optional library name used to synthesize a single <c>.sceversion</c> record when the input
    /// ELF is stripped. The package builder supplies the PRX file name without its extension.
    /// </summary>
    public string? SceVersionName { get; init; }

    /// <summary>
    /// Eight-byte SDK record copied from the application's real <c>.sceversion</c> section. It is
    /// written twice in a synthesized publisher library record.
    /// </summary>
    public byte[]? SceVersionRecord { get; init; }
}

/// <summary>
/// Reader and producer for the SELF container used by PS5 executable modules.
/// </summary>
/// <remarks>
/// Layout (little-endian scalars):
/// <list type="bullet">
/// <item>SCE header, 0x20 bytes: magic <c>0x1D3D154F</c>, version/mode/endian/attr bytes, program type,
/// header size, metadata size, file size, segment count, flags.</item>
/// <item>Segment table at 0x20, one 0x20-byte entry per segment: flags, file offset, file size, memory
/// size. Content segments come in pairs (a zero-filled digest segment then the data segment).</item>
/// <item>ELF header and program headers, copied verbatim.</item>
/// <item>Extended info (0x40) after the program headers: authority id, program type, versions, and the
/// SHA-256 of the input ELF.</item>
/// <item>A zero-filled metadata footer, then the plaintext segment data.</item>
/// <item>The original non-allocated <c>.sceversion</c> section appended after the SELF size recorded
/// in the header. Publishing Tools use this trailer for SDK/library-version validation.</item>
/// </list>
/// </remarks>
public static class ProsperoFself
{
    /// <summary>Prospero SELF magic at file offset 0x00.</summary>
    public const uint Magic = 0xEEF51454;

    /// <summary>Legacy Orbis SELF magic accepted by the reader.</summary>
    public const uint OrbisMagic = 0x1D3D154F;

    private const int SceHeaderSize = 0x20;
    private const int SegEntrySize = 0x20;
    private const int ExtInfoSize = 0x40;
    private const int ControlRegionSize = 0x30;
    private const int MetaBlockSize = 0x50;
    private const int MetaFooterSize = 0x50;
    private const int SignatureSize = 0x220;
    private const int DigestSize = 0x20;
    private const int SignedBlockSize = 0x4000;
    private const int FooterMarkerOffset = 0x30;
    private const uint DefaultProgramType = 0x10000101;

    // Fake-authority ids selected by the ex-info byte at ELF offset 0x3f00, split by executable type.
    private const ulong PaidExec = 0x3100000000000001;
    private const ulong PaidDynamic = 0x3100000000000002;
    private const ulong PaidExecA = 0x3100000000001101;
    private const ulong PaidDynamicA = 0x3100000000001102;
    private const ulong PaidExecB = 0x3100000000001001;
    private const ulong PaidDynamicB = 0x3100000000001002;

    private const int ElfHeaderSize = 0x40;
    private const int ElfPhdrSize = 0x38;
    private const int ExInfoByteOffset = 0x3F00;

    /// <summary>Returns whether the buffer begins with an SCE/SELF header.</summary>
    public static bool IsSelf(ReadOnlySpan<byte> data)
    {
        if (data.Length < SceHeaderSize)
            return false;
        uint magic = BinaryPrimitives.ReadUInt32LittleEndian(data);
        return magic is Magic or OrbisMagic;
    }

    /// <summary>Returns whether the buffer begins with an ELF header.</summary>
    public static bool IsElf(ReadOnlySpan<byte> data) =>
        data.Length >= ElfHeaderSize && data[0] == 0x7F && data[1] == (byte)'E' && data[2] == (byte)'L' && data[3] == (byte)'F';

    /// <summary>
    /// Reads the SDK major/minor version from an ELF <c>.sceversion</c> section or from the same
    /// trailer appended to a publisher fake-SELF.
    /// </summary>
    public static bool TryGetSdkVersion(byte[] image, out ulong sdkVersion)
    {
        ArgumentNullException.ThrowIfNull(image);
        ReadOnlySpan<byte> records = GetSceVersionRecords(image);

        int bestMajor = -1;
        int bestMinor = -1;
        for (int offset = 0; offset + 4 <= records.Length;)
        {
            int payloadSize = BinaryPrimitives.ReadUInt16LittleEndian(
                records[(offset + 2)..]);
            int recordSize = payloadSize + 4;
            if (payloadSize < 17 || recordSize > records.Length - offset)
                break;
            int nameSize = payloadSize - 17;
            int versionOffset = offset + 5 + nameSize;
            int major = records[versionOffset];
            int minor = records[versionOffset + 1];
            if (major > bestMajor || major == bestMajor && minor > bestMinor)
            {
                bestMajor = major;
                bestMinor = minor;
            }
            offset += recordSize;
        }

        if (bestMajor < 0 || bestMajor > 99 || bestMinor is < 0 or > 99)
        {
            sdkVersion = 0;
            return false;
        }

        static byte PackedBcd(int value) =>
            checked((byte)(((value / 10) << 4) | value % 10));
        sdkVersion = (ulong)PackedBcd(bestMajor) << 56 |
                     (ulong)PackedBcd(bestMinor) << 48;
        return true;
    }

    /// <summary>
    /// Returns one raw eight-byte SDK/library version tuple from an ELF section or SELF trailer.
    /// </summary>
    public static bool TryGetSceVersionRecord(byte[] image, out byte[] record)
    {
        ArgumentNullException.ThrowIfNull(image);
        ReadOnlySpan<byte> records = GetSceVersionRecords(image);
        for (int offset = 0; offset + 4 <= records.Length;)
        {
            int payloadSize = BinaryPrimitives.ReadUInt16LittleEndian(
                records[(offset + 2)..]);
            int recordSize = payloadSize + 4;
            if (payloadSize < 17 || recordSize > records.Length - offset)
                break;
            int nameSize = payloadSize - 17;
            int versionOffset = offset + 5 + nameSize;
            record = records.Slice(versionOffset, 8).ToArray();
            return true;
        }
        record = Array.Empty<byte>();
        return false;
    }

    private static ReadOnlySpan<byte> GetSceVersionRecords(byte[] image)
    {
        if (IsElf(image))
            return FindElfSection(image, ".sceversion");
        if (IsSelf(image))
        {
            ulong selfSize = BinaryPrimitives.ReadUInt64LittleEndian(
                image.AsSpan(0x10));
            if (selfSize <= (ulong)image.LongLength)
                return image.AsSpan((int)selfSize);
        }
        return ReadOnlySpan<byte>.Empty;
    }

    /// <summary>Parses a SELF image.</summary>
    /// <exception cref="InvalidDataException">The buffer is not a structurally valid SELF.</exception>
    public static SelfImage Parse(ReadOnlySpan<byte> data)
    {
        if (!Validate(data, out var error))
            throw new InvalidDataException(error);

        uint programType = BinaryPrimitives.ReadUInt32LittleEndian(data[0x08..]);
        int headerSize = BinaryPrimitives.ReadUInt16LittleEndian(data[0x0C..]);
        int metaSize = BinaryPrimitives.ReadUInt16LittleEndian(data[0x0E..]);
        ulong fileSize = BinaryPrimitives.ReadUInt64LittleEndian(data[0x10..]);
        int segCount = BinaryPrimitives.ReadUInt16LittleEndian(data[0x18..]);

        var segments = new List<SelfSegment>(segCount);
        for (int i = 0; i < segCount; i++)
        {
            int e = SceHeaderSize + i * SegEntrySize;
            segments.Add(new SelfSegment(
                BinaryPrimitives.ReadUInt64LittleEndian(data[e..]),
                BinaryPrimitives.ReadUInt64LittleEndian(data[(e + 0x08)..]),
                BinaryPrimitives.ReadUInt64LittleEndian(data[(e + 0x10)..]),
                BinaryPrimitives.ReadUInt64LittleEndian(data[(e + 0x18)..])));
        }

        int elfStart = SceHeaderSize + segCount * SegEntrySize;
        SelfExtInfo? extInfo = null;
        byte[] elf = Array.Empty<byte>();
        if (IsElf(data[elfStart..]))
        {
            int phnum = BinaryPrimitives.ReadUInt16LittleEndian(data[(elfStart + 0x38)..]);
            int elfLen = ElfHeaderSize + phnum * ElfPhdrSize;
            if (elfStart + elfLen <= data.Length)
            {
                elf = data.Slice(elfStart, elfLen).ToArray();
                int extStart = AlignUp(elfStart + elfLen, 0x10);
                if (extStart + ExtInfoSize <= headerSize && extStart + ExtInfoSize <= data.Length)
                {
                    extInfo = new SelfExtInfo(
                        BinaryPrimitives.ReadUInt64LittleEndian(data[extStart..]),
                        BinaryPrimitives.ReadUInt64LittleEndian(data[(extStart + 0x08)..]),
                        BinaryPrimitives.ReadUInt64LittleEndian(data[(extStart + 0x10)..]),
                        BinaryPrimitives.ReadUInt64LittleEndian(data[(extStart + 0x18)..]),
                        data.Slice(extStart + 0x20, 0x20).ToArray());
                }
            }
        }

        return new SelfImage(programType, headerSize, metaSize, fileSize, segments, elf, extInfo);
    }

    /// <summary>Validates the SCE header and segment table of a SELF image.</summary>
    public static bool Validate(ReadOnlySpan<byte> data, out string? error)
    {
        if (data.Length < SceHeaderSize) { error = "Buffer is smaller than an SCE header."; return false; }
        uint magic = BinaryPrimitives.ReadUInt32LittleEndian(data);
        if (magic is not Magic and not OrbisMagic) { error = "Bad SCE magic."; return false; }

        int headerSize = BinaryPrimitives.ReadUInt16LittleEndian(data[0x0C..]);
        int segCount = BinaryPrimitives.ReadUInt16LittleEndian(data[0x18..]);
        long tableEnd = SceHeaderSize + (long)segCount * SegEntrySize;
        if (tableEnd > data.Length) { error = "Segment table overruns the buffer."; return false; }
        if (headerSize > data.Length) { error = "Header size exceeds the buffer."; return false; }
        error = null;
        return true;
    }

    /// <summary>Builds a debug fake-self from a plaintext ELF module.</summary>
    /// <param name="elf">The input ELF file bytes.</param>
    /// <param name="options">Version and authority overrides.</param>
    /// <exception cref="ArgumentException">The input is not a supported ELF.</exception>
    public static byte[] MakeFself(byte[] elf, FselfOptions? options = null)
    {
        ArgumentNullException.ThrowIfNull(elf);
        options ??= new FselfOptions();
        if (!IsElf(elf))
            throw new ArgumentException("Input is not an ELF file.", nameof(elf));
        if (elf[4] != 2)
            throw new ArgumentException("Only 64-bit ELF modules are supported.", nameof(elf));
        if (options.SceVersionRecord is { Length: not 8 })
            throw new ArgumentException(
                "The synthesized .sceversion tuple must contain exactly eight bytes.",
                nameof(options));

        ushort eType = BinaryPrimitives.ReadUInt16LittleEndian(elf.AsSpan(0x10));
        ulong phoffValue = BinaryPrimitives.ReadUInt64LittleEndian(elf.AsSpan(0x20));
        if (phoffValue != ElfHeaderSize)
            throw new ArgumentException(
                $"The ELF program-header table must follow the ELF header at 0x{ElfHeaderSize:X} " +
                $"(e_phoff is 0x{phoffValue:X}).",
                nameof(elf));
        int phoff = ElfHeaderSize;
        int phentSize = BinaryPrimitives.ReadUInt16LittleEndian(elf.AsSpan(0x36));
        int phnum = BinaryPrimitives.ReadUInt16LittleEndian(elf.AsSpan(0x38));
        if (phentSize != ElfPhdrSize)
            throw new ArgumentException($"Unexpected ELF program-header size {phentSize}.", nameof(elf));
        if ((long)phoff + (long)phnum * ElfPhdrSize > elf.Length)
            throw new ArgumentException("ELF program headers overrun the file.", nameof(elf));

        var selected = SelectSegments(elf, phoff, phnum);
        if (selected.Count == 0)
            throw new ArgumentException("The ELF has no loadable segment content.", nameof(elf));

        int segCount = selected.Count * 2;
        int afterSeg = SceHeaderSize + segCount * SegEntrySize;
        int elfHdrLen = ElfHeaderSize + phnum * ElfPhdrSize;
        int extInfoStart = AlignUp(afterSeg + elfHdrLen, 0x10);
        int headerSize = extInfoStart + ExtInfoSize + ControlRegionSize;
        int metaSize = checked(
            segCount * MetaBlockSize + MetaFooterSize + SignatureSize);
        int dataStart = headerSize + metaSize;

        // Both fields are serialized as u16 in the SCE header. Refuse an
        // unrepresentable module instead of silently truncating the layout.
        if (headerSize > ushort.MaxValue || metaSize > ushort.MaxValue)
            throw new ArgumentException(
                $"The ELF has too many segments to fake-sign (header 0x{headerSize:X}, " +
                $"meta 0x{metaSize:X} exceed the 16-bit SCE fields).",
                nameof(elf));

        // Assign segment file offsets: one SHA-256-sized digest slot per 0x4000-byte signed data
        // block, followed by the segment data. Every intermediate segment starts at 16-byte
        // alignment; the final file length is not rounded.
        var segOffsets = new int[segCount];
        var digestSizes = new int[selected.Count];
        int cursor = dataStart;
        for (int k = 0; k < selected.Count; k++)
        {
            digestSizes[k] = checked(
                (selected[k].FileSize + SignedBlockSize - 1) /
                SignedBlockSize * DigestSize);
            segOffsets[k * 2] = cursor;
            cursor += digestSizes[k];
            segOffsets[k * 2 + 1] = cursor;
            cursor += selected[k].FileSize;
            if (k + 1 < selected.Count)
                cursor = AlignUp(cursor, 0x10);
        }
        int fileSize = cursor;
        ReadOnlySpan<byte> sourceSceVersion =
            FindElfSection(elf, ".sceversion");
        byte[]? synthesizedSceVersion = null;
        if (sourceSceVersion.IsEmpty &&
            !string.IsNullOrWhiteSpace(options.SceVersionName) &&
            options.SceVersionRecord is { Length: 8 } versionRecord)
        {
            synthesizedSceVersion = BuildSceVersionRecord(
                options.SceVersionName, versionRecord);
        }
        ReadOnlySpan<byte> sceVersion =
            synthesizedSceVersion is null
                ? sourceSceVersion
                : synthesizedSceVersion;

        // The publisher appends .sceversion after the size recorded in the SELF header.  It is
        // deliberately outside every SELF content segment and outside Header.FileSize.
        var buffer = new byte[checked(fileSize + sceVersion.Length)];
        var span = buffer.AsSpan();

        BinaryPrimitives.WriteUInt32LittleEndian(span, Magic);
        span[0x04] = 0x10; // Prospero SELF version
        span[0x05] = 1;    // mode
        span[0x06] = 1;    // endian
        span[0x07] = 0x12; // attr
        BinaryPrimitives.WriteUInt32LittleEndian(span[0x08..], DefaultProgramType);
        BinaryPrimitives.WriteUInt16LittleEndian(span[0x0C..], (ushort)headerSize);
        BinaryPrimitives.WriteUInt16LittleEndian(span[0x0E..], (ushort)metaSize);
        BinaryPrimitives.WriteUInt64LittleEndian(span[0x10..], (ulong)fileSize);
        BinaryPrimitives.WriteUInt16LittleEndian(span[0x18..], (ushort)segCount);
        BinaryPrimitives.WriteUInt16LittleEndian(span[0x1A..], 0x0032); // three signed metadata groups

        for (int k = 0; k < selected.Count; k++)
        {
            int digestEntry = SceHeaderSize + (k * 2) * SegEntrySize;
            int dataEntry = SceHeaderSize + (k * 2 + 1) * SegEntrySize;
            int dataTableIndex = k * 2 + 1;

            ulong digestFlags = ((ulong)dataTableIndex << 20) | 0x10004;
            WriteSegment(span, digestEntry, digestFlags, (ulong)segOffsets[k * 2],
                (ulong)digestSizes[k], (ulong)digestSizes[k]);

            ulong dataFlags = ((ulong)selected[k].PhdrIndex << 20) | 0x2804;
            WriteSegment(span, dataEntry, dataFlags, (ulong)segOffsets[k * 2 + 1],
                (ulong)selected[k].FileSize, (ulong)selected[k].FileSize);
        }

        elf.AsSpan(0, elfHdrLen).CopyTo(span[afterSeg..]);

        ulong authorityId = options.AuthorityId ?? DeriveAuthorityId(elf, eType);
        BinaryPrimitives.WriteUInt64LittleEndian(span[extInfoStart..], authorityId);
        BinaryPrimitives.WriteUInt64LittleEndian(span[(extInfoStart + 0x08)..], 1); // program type
        BinaryPrimitives.WriteUInt64LittleEndian(span[(extInfoStart + 0x10)..], options.AppVersion);
        BinaryPrimitives.WriteUInt64LittleEndian(span[(extInfoStart + 0x18)..], options.FirmwareVersion);
        SHA256.HashData(elf).CopyTo(span[(extInfoStart + 0x20)..]);

        BinaryPrimitives.WriteUInt64LittleEndian(span[(extInfoStart + ExtInfoSize)..], 3); // control block type

        int footerStart = checked(headerSize + segCount * MetaBlockSize);
        BinaryPrimitives.WriteUInt32LittleEndian(
            span[(footerStart + FooterMarkerOffset)..], 0x00010000);

        for (int k = 0; k < selected.Count; k++)
            elf.AsSpan(selected[k].FileOffset, selected[k].FileSize).CopyTo(span[segOffsets[k * 2 + 1]..]);
        sceVersion.CopyTo(span[fileSize..]);

        return buffer;
    }

    private static byte[] BuildSceVersionRecord(
        string moduleName, ReadOnlySpan<byte> version)
    {
        string normalized = moduleName.EndsWith(':')
            ? moduleName
            : moduleName + ':';
        byte[] name = System.Text.Encoding.ASCII.GetBytes(normalized);
        int payloadSize = checked(1 + name.Length + 16);
        if (payloadSize > ushort.MaxValue)
            throw new ArgumentException(
                "The synthesized .sceversion module name is too long.",
                nameof(moduleName));
        byte[] result = new byte[checked(payloadSize + 4)];
        BinaryPrimitives.WriteUInt16LittleEndian(
            result.AsSpan(2), (ushort)payloadSize);
        result[4] = 8;
        name.CopyTo(result, 5);
        version.CopyTo(result.AsSpan(5 + name.Length, 8));
        version.CopyTo(result.AsSpan(13 + name.Length, 8));
        return result;
    }

    private readonly record struct SelectedSegment(int PhdrIndex, int FileOffset, int FileSize);

    // A program header becomes a SELF content segment when it has file content and its type is a loadable
    // segment or one of the module-data types the builder carries into the container.
    private const uint PtLoad = 0x00000001;
    private const uint PtModuleData = 0x61000000;
    private const uint PtRelro = 0x61000010;
    private const uint PtComment = 0x6FFFFF00;

    private static List<SelectedSegment> SelectSegments(byte[] elf, int phoff, int phnum)
    {
        var result = new List<SelectedSegment>();
        for (int i = 0; i < phnum; i++)
        {
            int p = phoff + i * ElfPhdrSize;
            uint pType = BinaryPrimitives.ReadUInt32LittleEndian(elf.AsSpan(p));
            long off = (long)BinaryPrimitives.ReadUInt64LittleEndian(elf.AsSpan(p + 0x08));
            long fsz = (long)BinaryPrimitives.ReadUInt64LittleEndian(elf.AsSpan(p + 0x20));
            if (fsz <= 0 || off + fsz > elf.Length)
                continue;
            if (pType == PtLoad || pType == PtModuleData || pType == PtRelro || pType == PtComment)
                result.Add(new SelectedSegment(i, (int)off, (int)fsz));
        }
        return result;
    }

    private static ReadOnlySpan<byte> FindElfSection(byte[] elf, string sectionName)
    {
        // ELF64 section-header fields. A stripped executable legitimately has no section table.
        ulong shoffValue = BinaryPrimitives.ReadUInt64LittleEndian(elf.AsSpan(0x28));
        int shentSize = BinaryPrimitives.ReadUInt16LittleEndian(elf.AsSpan(0x3A));
        int shnum = BinaryPrimitives.ReadUInt16LittleEndian(elf.AsSpan(0x3C));
        int shstrIndex = BinaryPrimitives.ReadUInt16LittleEndian(elf.AsSpan(0x3E));
        if (shoffValue == 0 || shnum == 0 || shentSize < 0x40 ||
            shstrIndex >= shnum || shoffValue > int.MaxValue)
            return ReadOnlySpan<byte>.Empty;

        int shoff = (int)shoffValue;
        if ((long)shoff + (long)shnum * shentSize > elf.Length)
            throw new ArgumentException("ELF section headers overrun the file.", nameof(elf));

        int stringHeader = checked(shoff + shstrIndex * shentSize);
        ReadOnlySpan<byte> stringTable = SectionPayload(elf, stringHeader);
        for (int i = 0; i < shnum; i++)
        {
            int header = checked(shoff + i * shentSize);
            uint nameOffset = BinaryPrimitives.ReadUInt32LittleEndian(
                elf.AsSpan(header));
            if (nameOffset >= stringTable.Length)
                continue;
            ReadOnlySpan<byte> candidate = stringTable[(int)nameOffset..];
            int terminator = candidate.IndexOf((byte)0);
            if (terminator < 0)
                continue;
            candidate = candidate[..terminator];
            if (candidate.SequenceEqual(System.Text.Encoding.ASCII.GetBytes(sectionName)))
                return SectionPayload(elf, header);
        }
        return ReadOnlySpan<byte>.Empty;

        static ReadOnlySpan<byte> SectionPayload(byte[] source, int header)
        {
            ulong offsetValue = BinaryPrimitives.ReadUInt64LittleEndian(
                source.AsSpan(header + 0x18));
            ulong sizeValue = BinaryPrimitives.ReadUInt64LittleEndian(
                source.AsSpan(header + 0x20));
            if (offsetValue > int.MaxValue || sizeValue > int.MaxValue ||
                offsetValue + sizeValue > (ulong)source.LongLength)
                throw new ArgumentException("ELF section payload overruns the file.", nameof(elf));
            return source.AsSpan((int)offsetValue, (int)sizeValue);
        }
    }

    private static ulong DeriveAuthorityId(byte[] elf, ushort eType)
    {
        bool exec = eType == 0x02 || eType == 0xFE00 || eType == 0xFE10;
        byte ex = ExInfoByteOffset < elf.Length ? elf[ExInfoByteOffset] : (byte)0;
        return ex switch
        {
            0x40 => exec ? PaidExecA : PaidDynamicA,
            0x80 => exec ? PaidExecB : PaidDynamicB,
            _ => exec ? PaidExec : PaidDynamic,
        };
    }

    private static void WriteSegment(Span<byte> span, int entry, ulong flags, ulong offset, ulong fileSize, ulong memSize)
    {
        BinaryPrimitives.WriteUInt64LittleEndian(span[entry..], flags);
        BinaryPrimitives.WriteUInt64LittleEndian(span[(entry + 0x08)..], offset);
        BinaryPrimitives.WriteUInt64LittleEndian(span[(entry + 0x10)..], fileSize);
        BinaryPrimitives.WriteUInt64LittleEndian(span[(entry + 0x18)..], memSize);
    }

    private static int AlignUp(int value, int alignment) => (value + alignment - 1) & ~(alignment - 1);
}
