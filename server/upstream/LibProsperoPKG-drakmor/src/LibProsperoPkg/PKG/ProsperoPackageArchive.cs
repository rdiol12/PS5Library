// LibProsperoPkg - complete structural access to finalized Prospero packages.
#nullable enable
using LibProsperoPkg.PFS;
using LibProsperoPkg.PFS.Compression;
using LibProsperoPkg.Util;
using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;

namespace LibProsperoPkg.PKG;

public readonly record struct ProsperoPackageMap(
    long FihOffset, long FihSize,
    long OuterPfsOffset, long OuterPfsSize,
    long CntOffset, long CntSize,
    long SupplementOffset, long SupplementSize,
    int OuterSuperblockIndex);

/// <summary>
/// Splits, decrypts and extracts finalized debug packages. Container parsing is independent of
/// protected transformations; outer-PFS decryption requires the package passcode.
/// </summary>
public static class ProsperoPackageArchive
{
    private static ReadOnlySpan<byte> PprPlaintextSeed => "PPRPLAIN-NOAUTH!"u8;
    public const int OuterBlockSize = 0x10000;

    /// <summary>
    /// Verifies the deterministic RSA-3072 public wrap stored at CNT+0x1000. The historical method
    /// name is retained for API compatibility; this field is not a private-key signature.
    /// </summary>
    public static bool VerifyCntMetadataSignature(string packagePath)
    {
        using var input = File.OpenRead(packagePath);
        ProsperoPkg package = ProsperoPkgReader.Read(input);
        long cntBase = package.Fih is null ? 0 : checked((long)package.Fih.EmbeddedCntOffset);
        const int signedHeaderSize = 0x1000;
        byte[] header = ReadRange(input, cntBase, signedHeaderSize);
        byte[] signature = ReadRange(
            input,
            checked(cntBase + signedHeaderSize),
            ProsperoPublisherRsa.ModulusSize);
        // A temporary combined CNT+PFS artifact still stores the physical image position at
        // +0x410, while sc2's metadata output and the final FIH-embedded CNT use 0x10000.
        // The builder intentionally wraps the final form, so normalize a non-zero temporary value
        // before reproducing the wrap.
        ulong pfsImageOffset = BinaryPrimitives.ReadUInt64BigEndian(
            header.AsSpan(ProsperoImageDigests.CntPfsImageOffsetField, 8));
        if (pfsImageOffset != 0 &&
            pfsImageOffset != ProsperoImageDigests.FihRelativeImageOffset)
        {
            BinaryPrimitives.WriteUInt64BigEndian(
                header.AsSpan(ProsperoImageDigests.CntPfsImageOffsetField, 8),
                ProsperoImageDigests.FihRelativeImageOffset);
        }
        return ProsperoPublisherRsa.VerifyCntHeaderWrap(header, signature);
    }

    public static ProsperoPackageMap Inspect(string path)
    {
        using var input = File.OpenRead(path);
        return Inspect(input);
    }

    public static ProsperoPackageMap Inspect(Stream input)
    {
        ArgumentNullException.ThrowIfNull(input);
        if (!input.CanRead || !input.CanSeek) throw new ArgumentException("Package stream must be readable and seekable.", nameof(input));
        ProsperoPkg package = ProsperoPkgReader.Read(input);
        ProsperoPkgHeader cnt = package.Header ?? throw new InvalidDataException("CNT header is unavailable.");

        long cntEnd = ProsperoPkgLayout.HeaderSize;
        cntEnd = Math.Max(cntEnd, checked((long)cnt.EntryTableOffset + package.Entries.Count * ProsperoPkgLayout.EntryMetaSize));
        if (cnt.BodyOffset > long.MaxValue || cnt.BodySize > long.MaxValue)
            throw new InvalidDataException("CNT body range exceeds Int64.");
        cntEnd = Math.Max(cntEnd, checked((long)cnt.BodyOffset + (long)cnt.BodySize));
        foreach (ProsperoPkgEntry entry in package.Entries)
            cntEnd = Math.Max(cntEnd, checked((long)entry.DataOffset + entry.DataSize));
        cntEnd = AlignUp(cntEnd, 16);

        // Entitlement-only PSAL packages are bare CNT containers followed directly by their SI ZIP:
        // [CNT/SC padded through BodyOffset+BodySize][SI]. They intentionally have no FIH or PFS.
        if (package.Fih is null)
        {
            RequireRange(input.Length, 0, cntEnd, "CNT");
            return new ProsperoPackageMap(
                0, 0,
                0, 0,
                0, cntEnd,
                cntEnd, input.Length - cntEnd,
                -1);
        }

        ProsperoFihHeader fih = package.Fih;
        if (fih.PfsImageOffset > long.MaxValue || fih.PfsImageSize > long.MaxValue || fih.EmbeddedCntOffset > long.MaxValue)
            throw new InvalidDataException("Package ranges exceed Int64.");
        long pfsOffset = (long)fih.PfsImageOffset;
        long pfsSize = (long)fih.PfsImageSize;
        long cntOffset = (long)fih.EmbeddedCntOffset;
        RequireRange(input.Length, pfsOffset, pfsSize, "outer PFS");
        if (cntOffset != checked(pfsOffset + pfsSize))
            throw new InvalidDataException("FIH CNT offset does not immediately follow the outer PFS image.");

        RequireRange(input.Length, cntOffset, cntEnd, "CNT");

        long supplement = checked(cntOffset + cntEnd);
        int superblock = ResolveSuperblockIndex(fih, checked((int)(pfsSize / OuterBlockSize)));
        return new ProsperoPackageMap(0, pfsOffset, pfsOffset, pfsSize, cntOffset, cntEnd,
            supplement, input.Length - supplement, superblock);
    }

    public static void Split(Stream input, Stream outerPfs, Stream cnt, Stream? supplement = null)
    {
        ProsperoPackageMap map = Inspect(input);
        CopyRange(input, outerPfs, map.OuterPfsOffset, map.OuterPfsSize);
        CopyRange(input, cnt, map.CntOffset, map.CntSize);
        if (supplement is not null) CopyRange(input, supplement, map.SupplementOffset, map.SupplementSize);
    }

    public static byte[] DecryptOuterPfs(string packagePath, string passcode)
    {
        using var input = File.OpenRead(packagePath);
        ProsperoPkg package = ProsperoPkgReader.Read(input);
        ProsperoPackageMap map = Inspect(input);
        if (map.OuterPfsSize > int.MaxValue) throw new InvalidDataException("Outer PFS is too large for the in-memory decryptor.");
        using var output = new MemoryStream(checked((int)map.OuterPfsSize));
        DecryptOuterPfs(input, output, package, map, passcode);
        return output.ToArray();
    }

    /// <summary>
    /// Decrypts the outer finalized-image PFS directly to a file. Unlike the byte-array overload,
    /// this path uses one 64-KiB buffer and supports multi-gigabyte images.
    /// </summary>
    public static void DecryptOuterPfs(string packagePath, string outputPath, string passcode)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packagePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);
        EnsureDistinctPaths(packagePath, outputPath);

        string outputFullPath = Path.GetFullPath(outputPath);
        string outputDirectory = Path.GetDirectoryName(outputFullPath) ?? Directory.GetCurrentDirectory();
        Directory.CreateDirectory(outputDirectory);
        string temporaryPath = Path.Combine(
            outputDirectory, "." + Path.GetFileName(outputFullPath) + "." + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            using var input = File.OpenRead(packagePath);
            ProsperoPkg package = ProsperoPkgReader.Read(input);
            ProsperoPackageMap map = Inspect(input);
            using (var output = new FileStream(
                temporaryPath, FileMode.CreateNew, FileAccess.Write, FileShare.None,
                bufferSize: 1024 * 1024, FileOptions.SequentialScan))
            {
                DecryptOuterPfs(input, output, package, map, passcode);
            }
            File.Move(temporaryPath, outputFullPath, overwrite: true);
        }
        finally
        {
            TryDelete(temporaryPath);
        }
    }

    public static IReadOnlyList<string> ExtractOuterFiles(string packagePath, string outputDirectory, string passcode, bool decompress = false)
    {
        Directory.CreateDirectory(outputDirectory);
        string decryptedPath = Path.Combine(
            Path.GetFullPath(outputDirectory), ".libprospero-outer-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            DecryptOuterPfs(packagePath, decryptedPath, passcode);
            ProsperoPackageMap map = Inspect(packagePath);
            using var decrypted = new FileStream(
                decryptedPath, FileMode.Open, FileAccess.Read, FileShare.Read,
                bufferSize: 1024 * 1024, FileOptions.RandomAccess);
            using var source = new LibProsperoPkg.Util.StreamReader(decrypted);
            var pfs = new PfsReader(
                source,
                superblockOffset: (long)map.OuterSuperblockIndex * OuterBlockSize,
                encryptedDataAlreadyDecrypted: true);
            var written = new List<string>();
            foreach (PfsReader.File file in pfs.GetAllFiles())
            {
                string relative = NormalizeRelativePath(file.FullName);
                string target = SafeTarget(outputDirectory, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                file.Save(target, decompress);
                written.Add(relative);
            }
            return written;
        }
        finally
        {
            TryDelete(decryptedPath);
        }
    }

    /// <summary>
    /// Decrypts the outer filesystem, resolves its NAPS sidecar and expands <c>pfs_image.dat</c> to
    /// the complete logical inner PPR-PFS image.
    /// </summary>
    public static byte[] DecodeInnerPfs(string packagePath, string passcode)
    {
        ProsperoPackageMap map = Inspect(packagePath);
        if (map.OuterSuperblockIndex == 0)
        {
            using var input = File.OpenRead(packagePath);
            ProsperoPkg legacyPackage = ProsperoPkgReader.Read(input);
            using var legacyLogical = new MemoryStream();
            DecodeLegacyInnerPfs(input, legacyPackage, map, legacyLogical, passcode);
            return legacyLogical.ToArray();
        }
        byte[] outerImage = DecryptOuterPfs(packagePath, passcode);
        ProsperoPkg package = ProsperoPkgReader.Read(packagePath);
        int outerSuperblock = ResolveSuperblockIndex(package.Fih!, outerImage.Length / OuterBlockSize);
        using var memory = new MemoryStream(outerImage, writable: false);
        using var logical = new MemoryStream();
        DecodeInnerPfs(memory, outerSuperblock, logical);
        return logical.ToArray();
    }

    /// <summary>
    /// Decrypts and NAPS-decodes a package to a logical inner PPR-PFS file without holding either
    /// complete image in managed memory.
    /// </summary>
    public static void DecodeInnerPfs(string packagePath, string outputPath, string passcode)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packagePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputPath);
        EnsureDistinctPaths(packagePath, outputPath);

        string outputFullPath = Path.GetFullPath(outputPath);
        string outputDirectory = Path.GetDirectoryName(outputFullPath) ?? Directory.GetCurrentDirectory();
        Directory.CreateDirectory(outputDirectory);
        string outerPath = Path.Combine(
            outputDirectory, ".libprospero-outer-" + Guid.NewGuid().ToString("N") + ".tmp");
        string logicalPath = Path.Combine(
            outputDirectory, "." + Path.GetFileName(outputFullPath) + "." + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            ProsperoPackageMap map = Inspect(packagePath);
            using (var logical = new FileStream(
                logicalPath, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None,
                bufferSize: 1024 * 1024, FileOptions.RandomAccess))
            {
                if (map.OuterSuperblockIndex == 0)
                {
                    using var input = File.OpenRead(packagePath);
                    ProsperoPkg package = ProsperoPkgReader.Read(input);
                    DecodeLegacyInnerPfs(input, package, map, logical, passcode);
                }
                else
                {
                    DecryptOuterPfs(packagePath, outerPath, passcode);
                    using var outer = new FileStream(
                        outerPath, FileMode.Open, FileAccess.Read, FileShare.Read,
                        bufferSize: 1024 * 1024, FileOptions.RandomAccess);
                    DecodeInnerPfs(outer, map.OuterSuperblockIndex, logical);
                }
            }
            File.Move(logicalPath, outputFullPath, overwrite: true);
        }
        finally
        {
            TryDelete(logicalPath);
            TryDelete(outerPath);
        }
    }

    /// <summary>Extracts every file from the NAPS-decoded inner PPR-PFS image.</summary>
    public static IReadOnlyList<string> ExtractInnerFiles(
        string packagePath, string outputDirectory, string passcode, bool decompressFiles = true)
    {
        Directory.CreateDirectory(outputDirectory);
        string innerPath = Path.Combine(
            Path.GetFullPath(outputDirectory), ".libprospero-inner-" + Guid.NewGuid().ToString("N") + ".tmp");
        try
        {
            DecodeInnerPfs(packagePath, innerPath, passcode);
            using var innerStream = new FileStream(
                innerPath, FileMode.Open, FileAccess.Read, FileShare.Read,
                bufferSize: 1024 * 1024, FileOptions.RandomAccess);
            long superblockOffset = LocateSuperblock(innerStream);
            if (superblockOffset < 0)
                throw new InvalidDataException("The NAPS logical stream does not contain an inner PPR-PFS superblock.");
            using var source = new LibProsperoPkg.Util.StreamReader(innerStream);
            var inner = new PfsReader(
                source, superblockOffset: superblockOffset, encryptedDataAlreadyDecrypted: true);
            var written = new List<string>();
            foreach (PfsReader.File file in inner.GetAllFiles())
            {
                string relative = NormalizeRelativePath(file.FullName);
                if (relative.StartsWith("uroot/", StringComparison.Ordinal))
                    relative = relative["uroot/".Length..];
                string target = SafeTarget(outputDirectory, relative);
                Directory.CreateDirectory(Path.GetDirectoryName(target)!);
                file.Save(target, decompressFiles);
                written.Add(relative);
            }
            return written;
        }
        finally
        {
            TryDelete(innerPath);
        }
    }

    public static IReadOnlyList<string> ExtractCntEntries(string packagePath, string outputDirectory, bool includeEncrypted = true)
        => ExtractCntEntriesCore(packagePath, outputDirectory, passcode: null, includeEncrypted);

    /// <summary>
    /// Extracts CNT entries and decrypts protected entries with the supplied package passcode.
    /// Publisher containers are detected from the 0xB80-byte RSA-3072 ENTRY_KEYS record.
    /// </summary>
    public static IReadOnlyList<string> ExtractCntEntries(
        string packagePath, string outputDirectory, string passcode, bool includeEncrypted = true)
    {
        if (passcode is not { Length: 32 })
            throw new ArgumentException("Passcode must be exactly 32 characters.", nameof(passcode));
        return ExtractCntEntriesCore(packagePath, outputDirectory, passcode, includeEncrypted);
    }

    private static IReadOnlyList<string> ExtractCntEntriesCore(
        string packagePath, string outputDirectory, string? passcode, bool includeEncrypted)
    {
        using var input = File.OpenRead(packagePath);
        ProsperoPkg package = ProsperoPkgReader.Read(input);
        ProsperoPkgHeader header = package.Header ?? throw new InvalidDataException("Package has no CNT header.");
        long cntBase = package.Fih is null ? 0 : checked((long)package.Fih.EmbeddedCntOffset);
        bool publisherProfile = package.Entries.Any(e =>
            e.RawId == (uint)EntryId.ENTRY_KEYS && e.DataSize >= 0xB80);
        Directory.CreateDirectory(outputDirectory);
        var written = new List<string>();
        foreach (ProsperoPkgEntry entry in package.Entries)
        {
            if (!includeEncrypted && entry.Encrypted) continue;
            string? knownName = null;
            EntryNames.IdToName.TryGetValue((EntryId)entry.RawId, out knownName);
            string name = !string.IsNullOrWhiteSpace(entry.Name)
                ? NormalizeRelativePath(entry.Name!)
                : !string.IsNullOrWhiteSpace(knownName)
                    ? NormalizeRelativePath(knownName!)
                    : $"entry-{entry.RawId:x8}.bin";
            string target = SafeTarget(outputDirectory, name);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            int storedSize = entry.Encrypted
                ? checked((int)((entry.DataSize + 15u) & ~15u))
                : checked((int)entry.DataSize);
            byte[] data = ReadRange(input, checked(cntBase + entry.DataOffset), storedSize);
            if (entry.Encrypted && passcode is not null)
            {
                var meta = new MetaEntry
                {
                    id = (EntryId)entry.RawId,
                    NameTableOffset = entry.NameTableOffset,
                    Flags1 = entry.Flags1,
                    Flags2 = entry.Flags2,
                    DataOffset = entry.DataOffset,
                    DataSize = entry.DataSize,
                };
                data = Entry.Decrypt(data, header.ContentId, passcode, meta, publisherProfile);
            }
            else if (data.Length != entry.DataSize)
            {
                Array.Resize(ref data, checked((int)entry.DataSize));
            }
            File.WriteAllBytes(target, data);
            written.Add(name);
        }
        return written;
    }

    /// <summary>Extracts the trailing debug SI ZIP while preserving its publisher member paths.</summary>
    public static IReadOnlyList<string> ExtractSiEntries(string packagePath, string outputDirectory)
    {
        using var input = File.OpenRead(packagePath);
        ProsperoPackageMap map = Inspect(input);
        if (map.SupplementSize <= 0)
            return Array.Empty<string>();
        if (map.SupplementSize > int.MaxValue)
            throw new InvalidDataException("SI segment is too large for the in-memory ZIP reader.");
        byte[] bytes = ReadRange(input, map.SupplementOffset, checked((int)map.SupplementSize));
        using var memory = new MemoryStream(bytes, writable: false);
        using var zip = new ZipArchive(memory, ZipArchiveMode.Read, leaveOpen: false);
        Directory.CreateDirectory(outputDirectory);
        var written = new List<string>();
        foreach (ZipArchiveEntry entry in zip.Entries)
        {
            if (string.IsNullOrEmpty(entry.Name)) continue;
            string relative = NormalizeRelativePath(entry.FullName);
            string target = SafeTarget(outputDirectory, relative);
            Directory.CreateDirectory(Path.GetDirectoryName(target)!);
            using Stream source = entry.Open();
            using var destination = new FileStream(target, FileMode.Create, FileAccess.Write, FileShare.None);
            source.CopyTo(destination);
            written.Add(relative);
        }
        return written;
    }

    private static void DecryptOuterPfs(
        Stream input, Stream output, ProsperoPkg package, ProsperoPackageMap map, string passcode)
    {
        if (!input.CanRead || !input.CanSeek)
            throw new ArgumentException("Package stream must be readable and seekable.", nameof(input));
        if (!output.CanWrite)
            throw new ArgumentException("Decrypted output stream must be writable.", nameof(output));
        ProsperoFihHeader fih =
            package.Fih ?? throw new InvalidDataException("A finalized FIH package is required.");
        ProsperoPkgHeader cnt =
            package.Header ?? throw new InvalidDataException("Embedded CNT header is unavailable.");
        if (map.OuterPfsSize <= 0 || (map.OuterPfsSize % OuterBlockSize) != 0)
            throw new InvalidDataException("Outer PFS is empty or not block aligned.");
        long blockCount64 = map.OuterPfsSize / OuterBlockSize;
        if (blockCount64 > int.MaxValue)
            throw new InvalidDataException("Outer PFS block count exceeds Int32.");
        int blocks = (int)blockCount64;
        int superblock = map.OuterSuperblockIndex;

        byte[] sb = ReadRange(
            input,
            checked(map.OuterPfsOffset + (long)superblock * OuterBlockSize),
            OuterBlockSize);
        ValidateSuperblockShape(sb, blocks);
        byte[] expectedIcv = sb.AsSpan(
            ProsperoOuterPfsSignature.SuperblockIcvOffset, 32).ToArray();
        byte[] actualIcv = ProsperoOuterPfsSignature.ComputeSuperblockIcv(sb);
        if (!expectedIcv.AsSpan().SequenceEqual(actualIcv))
            throw new InvalidDataException("Outer PFS superblock ICV mismatch.");

        byte[] seed = sb.AsSpan(0x370, 16).ToArray();
        if (seed.AsSpan().SequenceEqual(PprPlaintextSeed))
        {
            CopyRange(input, output, map.OuterPfsOffset, map.OuterPfsSize);
            output.Flush();
            return;
        }
        byte[] ekpfs = ProsperoPfsKeys.DeriveEkpfs(cnt.ContentId, passcode);
        var (tweak, data) = ProsperoPfsKeys.DeriveImageEncryptionKeys(ekpfs, seed);
        ProsperoOuterBlockKind[] kinds = InferBlockKinds(fih, blocks, superblock);
        input.Position = map.OuterPfsOffset;
        ProsperoOuterPfsImage.Transform(
            input, output, map.OuterPfsSize,
            tweak, data, OuterBlockSize, kinds, encrypt: false);
        output.Flush();
    }

    private static void DecodeInnerPfs(Stream outerImage, int outerSuperblockIndex, Stream destination)
    {
        if (!outerImage.CanRead || !outerImage.CanSeek)
            throw new ArgumentException("Decrypted outer-PFS stream must be readable and seekable.", nameof(outerImage));
        using var source = new LibProsperoPkg.Util.StreamReader(outerImage);
        var outer = new PfsReader(
            source,
            superblockOffset: (long)outerSuperblockIndex * OuterBlockSize,
            encryptedDataAlreadyDecrypted: true);
        PfsReader.File packedImage = FindFile(outer, "pfs_image.dat");
        PfsReader.File layoutFile = FindFile(outer, ProsperoNapsLayout.FileName);
        NapsLayoutDocument layout = ProsperoNapsLayout.Parse(layoutFile.ReadAllBytes());
        using IMemoryReader packedReader = packedImage.GetView();
        using var packedStream = new StreamWrapper(packedReader, packedImage.size);
        ProsperoNapsImage.Decompress(packedStream, layout, destination);
    }

    private static void DecodeLegacyInnerPfs(
        Stream packageStream, ProsperoPkg package, ProsperoPackageMap map,
        Stream destination, string passcode)
    {
        ProsperoPkgHeader cnt = package.Header ?? throw new InvalidDataException("Embedded CNT header is unavailable.");
        byte[] ekpfs = ProsperoPfsKeys.DeriveEkpfs(cnt.ContentId, passcode);
        using var source = new LibProsperoPkg.Util.StreamReader(packageStream, map.OuterPfsOffset);
        var outer = new PfsReader(source, ekpfs: ekpfs);
        FindFile(outer, "pfs_image.dat").CopyTo(destination, decompress: true);
    }

    private static long LocateSuperblock(Stream input, int blockSize = OuterBlockSize)
    {
        if (!input.CanRead || !input.CanSeek)
            throw new ArgumentException("PFS stream must be readable and seekable.", nameof(input));
        if (blockSize <= 16)
            throw new ArgumentOutOfRangeException(nameof(blockSize));
        long originalPosition = input.Position;
        try
        {
            Span<byte> identity = stackalloc byte[12];
            for (long offset = 0; offset <= input.Length - blockSize; offset += blockSize)
            {
                input.Position = offset;
                input.ReadExactly(identity);
                if (BinaryPrimitives.ReadUInt64LittleEndian(identity) == 2UL &&
                    identity[8] == 0x0B && identity[9] == 0x2A &&
                    identity[10] == 0x33 && identity[11] == 0x01)
                    return offset;
            }
            return -1;
        }
        finally
        {
            input.Position = originalPosition;
        }
    }

    private static ProsperoOuterBlockKind[] InferBlockKinds(ProsperoFihHeader fih, int blocks, int superblock)
    {
        var kinds = Enumerable.Repeat(ProsperoOuterBlockKind.Signed, blocks).ToArray();
        int plainDataBlocks = checked((int)fih.InnerImageBlockCount);
        if (plainDataBlocks > superblock) throw new InvalidDataException("FIH inner-image block count crosses the superblock.");
        for (int i = 0; i < plainDataBlocks; i++) kinds[i] = ProsperoOuterBlockKind.Data;
        kinds[superblock] = ProsperoOuterBlockKind.Plaintext;
        return kinds;
    }

    private static int ResolveSuperblockIndex(ProsperoFihHeader fih, int blocks)
    {
        long napsBlocks = checked(((long)fih.NapsLayoutSize + OuterBlockSize - 1) / OuterBlockSize);
        long index = checked((long)fih.InnerImageBlockCount + napsBlocks);
        if (index < 0 || index >= blocks) throw new InvalidDataException("FIH-derived outer superblock index is out of range.");
        return (int)index;
    }

    private static PfsReader.File FindFile(PfsReader pfs, string name)
    {
        PfsReader.File? result = pfs.GetAllFiles().FirstOrDefault(
            file => string.Equals(Path.GetFileName(file.FullName), name, StringComparison.Ordinal));
        return result ?? throw new InvalidDataException($"Outer PFS does not contain {name}.");
    }

    private static void ValidateSuperblockShape(ReadOnlySpan<byte> sb, int blocks)
    {
        ulong version = BinaryPrimitives.ReadUInt64LittleEndian(sb);
        ulong compatibility = BinaryPrimitives.ReadUInt64LittleEndian(sb[8..]);
        uint blockSize = BinaryPrimitives.ReadUInt32LittleEndian(sb[0x20..]);
        ulong blockCount = BinaryPrimitives.ReadUInt64LittleEndian(sb[0x38..]);
        if (version is not (1 or 2) || compatibility <= 0x01332A0A || blockSize != OuterBlockSize || blockCount != (ulong)blocks)
            throw new InvalidDataException("FIH-derived block is not a valid outer PPR-PFS superblock.");
    }

    private static string NormalizeRelativePath(string value)
    {
        string normalized = value.Replace('\\', '/').TrimStart('/');
        if (normalized.Length == 0 || normalized.Split('/').Any(p => p is "" or "." or ".."))
            throw new InvalidDataException($"Unsafe package path: {value}");
        return normalized;
    }

    private static string SafeTarget(string root, string relative)
    {
        string fullRoot = Path.GetFullPath(root) + Path.DirectorySeparatorChar;
        string target = Path.GetFullPath(Path.Combine(root, relative.Replace('/', Path.DirectorySeparatorChar)));
        if (!target.StartsWith(fullRoot, OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal))
            throw new InvalidDataException($"Package path escapes output directory: {relative}");
        return target;
    }

    private static byte[] ReadRange(Stream input, long offset, int size)
    {
        RequireRange(input.Length, offset, size, "stream range");
        byte[] result = new byte[size];
        input.Position = offset;
        input.ReadExactly(result);
        return result;
    }

    private static void CopyRange(Stream input, Stream output, long offset, long size)
    {
        RequireRange(input.Length, offset, size, "stream range");
        input.Position = offset;
        byte[] buffer = new byte[1024 * 1024];
        while (size != 0)
        {
            int requested = (int)Math.Min(buffer.Length, size);
            int read = input.Read(buffer, 0, requested);
            if (read == 0) throw new EndOfStreamException();
            output.Write(buffer, 0, read);
            size -= read;
        }
    }

    private static void RequireRange(long length, long offset, long size, string name)
    {
        if (offset < 0 || size < 0 || offset > length || size > length - offset)
            throw new InvalidDataException($"{name} lies outside the package.");
    }

    private static void EnsureDistinctPaths(string inputPath, string outputPath)
    {
        string inputFullPath = Path.GetFullPath(inputPath);
        string outputFullPath = Path.GetFullPath(outputPath);
        StringComparison comparison = OperatingSystem.IsWindows()
            ? StringComparison.OrdinalIgnoreCase
            : StringComparison.Ordinal;
        if (string.Equals(inputFullPath, outputFullPath, comparison))
            throw new ArgumentException("Input package and output image paths must be different.", nameof(outputPath));
    }

    private static void TryDelete(string path)
    {
        try
        {
            if (File.Exists(path))
                File.Delete(path);
        }
        catch
        {
            // Best-effort cleanup of library-owned temporary files.
        }
    }

    private static long AlignUp(long value, int alignment) => checked((value + alignment - 1) / alignment * alignment);
}
