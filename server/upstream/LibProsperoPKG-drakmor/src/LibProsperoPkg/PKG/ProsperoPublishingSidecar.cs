// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK

using System;
using System.Collections.Generic;
using System.IO;
using System.IO.Compression;
using System.Linq;

namespace LibProsperoPkg.PKG;

/// <summary>
/// Conventional external test-key files used by the publisher-compatible build path.
/// Explicit providers/keys always take precedence; sidecars are loaded from the application
/// directory only when the corresponding build option is omitted.
/// </summary>
public static class ProsperoPublishingSidecar
{
    /// <summary>Default RSA-3072 PKCS#1/PKCS#8 private-key sidecar.</summary>
    public const string MetadataPrivateKeyFileName = "pkg_meta_rsa_key.pem";

    /// <summary>Default raw 16-byte AES-CMAC key sidecar.</summary>
    public const string NapsCmacKeyFileName = "naps_cmac_key.bin";

    /// <summary>Default raw 32-byte publisher PFS image key sidecar.</summary>
    public const string NapsPfsImageKeyFileName = "pfs_image_key.bin";

    /// <summary>Default raw 16-byte publisher PFS image seed sidecar.</summary>
    public const string NapsPfsImageSeedFileName = "pfs_image_seed.bin";

    /// <summary>Default raw 0x800-byte publisher CNT IMAGE_KEY sidecar.</summary>
    public const string PublisherImageKeyFileName = "pkg_image_key.bin";

    /// <summary>Default raw 0xB80-byte publisher CNT ENTRY_KEYS sidecar.</summary>
    public const string PublisherEntryKeysFileName = "pkg_entry_keys.bin";

    /// <summary>Default publisher-authored encrypted NAPS metadata sidecar.</summary>
    public const string NapsMeta18FileName = "naps_meta_18.dat";

    /// <summary>Returns the absolute sidecar directory used by default.</summary>
    public static string DefaultDirectory => Path.GetFullPath(AppContext.BaseDirectory);

    /// <summary>Returns an absolute path for a conventional sidecar name.</summary>
    public static string GetPath(string fileName, string? directory = null)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(fileName);
        return Path.Combine(Path.GetFullPath(directory ?? DefaultDirectory), fileName);
    }

    /// <summary>
    /// Loads <c>pkg_meta_rsa_key.pem</c> when it exists next to the host executable.
    /// A present but malformed key is rejected instead of silently falling back.
    /// </summary>
    public static ProsperoRsaMetadataSigner? TryLoadMetadataSigner(string? directory = null)
    {
        string path = GetPath(MetadataPrivateKeyFileName, directory);
        return File.Exists(path)
            ? ProsperoRsaMetadataSigner.LoadPem(path, $"sidecar:{MetadataPrivateKeyFileName}")
            : null;
    }

    /// <summary>
    /// Loads the raw 16-byte <c>naps_cmac_key.bin</c> sidecar when present.
    /// A present file with another size is rejected.
    /// </summary>
    public static byte[]? TryLoadNapsCmacKey(string? directory = null)
    {
        string path = GetPath(NapsCmacKeyFileName, directory);
        if (!File.Exists(path))
            return null;

        byte[] key = File.ReadAllBytes(path);
        if (key.Length != 16)
            throw new InvalidDataException(
                $"{NapsCmacKeyFileName} must contain exactly 16 raw bytes, not {key.Length}.");
        return key;
    }

    /// <summary>Loads the raw 32-byte <c>pfs_image_key.bin</c> sidecar when present.</summary>
    public static byte[]? TryLoadNapsPfsImageKey(string? directory = null) =>
        TryLoadRawSidecar(NapsPfsImageKeyFileName, 32, directory);

    /// <summary>Loads the raw 16-byte <c>pfs_image_seed.bin</c> sidecar when present.</summary>
    public static byte[]? TryLoadNapsPfsImageSeed(string? directory = null) =>
        TryLoadRawSidecar(NapsPfsImageSeedFileName, 16, directory);

    /// <summary>Loads the raw 0x800-byte <c>pkg_image_key.bin</c> sidecar when present.</summary>
    public static byte[]? TryLoadPublisherImageKey(string? directory = null) =>
        TryLoadRawSidecar(PublisherImageKeyFileName, 0x800, directory);

    /// <summary>Loads the raw 0xB80-byte <c>pkg_entry_keys.bin</c> sidecar when present.</summary>
    public static byte[]? TryLoadPublisherEntryKeys(string? directory = null) =>
        TryLoadRawSidecar(PublisherEntryKeysFileName, 0xB80, directory);

    /// <summary>
    /// Loads a publisher-authored <c>naps_meta_18.dat</c> sidecar when present.
    /// The payload is intentionally kept encrypted and is validated by the SI/NAPS parser later.
    /// </summary>
    public static byte[]? TryLoadNapsMeta18(string? directory = null)
    {
        string path = GetPath(NapsMeta18FileName, directory);
        return File.Exists(path) ? File.ReadAllBytes(path) : null;
    }

    /// <summary>
    /// Reads the protected raw 0x800-byte CNT <c>IMAGE_KEY</c> entry from an existing publisher
    /// package. The bytes are not decrypted or rewrapped and can therefore be preserved exactly
    /// when rebuilding the same publisher context.
    /// </summary>
    public static byte[] ReadPublisherImageKey(string packagePath)
        => ReadRawCntEntry(packagePath, EntryId.IMAGE_KEY, 0x800, "IMAGE_KEY");

    /// <summary>
    /// Reads the complete raw 0xB80-byte publisher CNT <c>ENTRY_KEYS</c> entry.
    /// The RSA ciphertexts are preserved verbatim.
    /// </summary>
    public static byte[] ReadPublisherEntryKeys(string packagePath)
        => ReadRawCntEntry(packagePath, EntryId.ENTRY_KEYS, 0xB80, "ENTRY_KEYS");

    private static byte[] ReadRawCntEntry(
        string packagePath,
        EntryId entryId,
        int expectedLength,
        string displayName)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packagePath);
        using var input = File.OpenRead(packagePath);
        ProsperoPkg package = ProsperoPkgReader.Read(input);
        ProsperoPkgEntry entry = package.Entries.SingleOrDefault(
            candidate => candidate.RawId == (uint)entryId)
            ?? throw new InvalidDataException($"The package does not contain a CNT {displayName} entry.");
        if (entry.DataSize != expectedLength)
            throw new InvalidDataException(
                $"Publisher CNT {displayName} must contain exactly 0x{expectedLength:X} bytes, " +
                $"not 0x{entry.DataSize:X}.");

        long cntBase = package.Fih is null ? 0 : checked((long)package.Fih.EmbeddedCntOffset);
        long offset = checked(cntBase + entry.DataOffset);
        if (offset < 0 || offset > input.Length - entry.DataSize)
            throw new InvalidDataException($"The CNT {displayName} range is outside the package.");

        byte[] value = new byte[entry.DataSize];
        input.Position = offset;
        input.ReadExactly(value);
        return value;
    }

    /// <summary>
    /// Reads <c>common/etc/naps_meta_18.dat</c> from the trailing publisher SI ZIP.
    /// Returns <see langword="null"/> when the package has no SI segment or that member is absent.
    /// </summary>
    public static byte[]? TryReadNapsMeta18(string packagePath)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packagePath);
        using var input = File.OpenRead(packagePath);
        ProsperoPackageMap map = ProsperoPackageArchive.Inspect(input);
        if (map.SupplementSize == 0)
            return null;
        if (map.SupplementSize > int.MaxValue)
            throw new InvalidDataException("The package SI segment is too large to inspect in memory.");

        byte[] supplement = new byte[checked((int)map.SupplementSize)];
        input.Position = map.SupplementOffset;
        input.ReadExactly(supplement);
        using var memory = new MemoryStream(supplement, writable: false);
        using var zip = new ZipArchive(memory, ZipArchiveMode.Read, leaveOpen: false);
        ZipArchiveEntry? member = zip.Entries.SingleOrDefault(entry =>
            string.Equals(
                entry.FullName.Replace('\\', '/'),
                "common/etc/naps_meta_18.dat",
                StringComparison.OrdinalIgnoreCase));
        if (member is null)
            return null;
        if (member.Length > int.MaxValue)
            throw new InvalidDataException("The SI naps_meta_18.dat member is too large.");

        using Stream source = member.Open();
        using var result = new MemoryStream(checked((int)member.Length));
        source.CopyTo(result);
        return result.ToArray();
    }

    /// <summary>
    /// Exports reusable protected publisher inputs from an existing package under their conventional
    /// sidecar names. Existing files are rejected unless <paramref name="overwrite"/> is true.
    /// This does not recover the separate <c>sc2 estimate</c> PFS-image key from the
    /// package alone; the builder derives it when primary id, passcode, and seed are known.
    /// </summary>
    public static IReadOnlyList<string> ExportReusableInputs(
        string packagePath,
        string outputDirectory,
        bool overwrite = false)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(outputDirectory);
        byte[] imageKey = ReadPublisherImageKey(packagePath);
        byte[] entryKeys = ReadPublisherEntryKeys(packagePath);
        byte[]? napsMeta18 = TryReadNapsMeta18(packagePath);
        string directory = Path.GetFullPath(outputDirectory);
        bool exportRetail;
        using (var input = File.OpenRead(packagePath))
            exportRetail = ProsperoPkgReader.Read(input).Fih?.IsOfficial == true;
        var outputs = new List<(string Path, byte[] Data)>
        {
            (Path.Combine(directory, PublisherEntryKeysFileName), entryKeys),
            (Path.Combine(directory, PublisherImageKeyFileName), imageKey),
        };
        if (napsMeta18 is not null)
            outputs.Add((Path.Combine(directory, NapsMeta18FileName), napsMeta18));

        if (!overwrite)
        {
            IEnumerable<string> candidatePaths = outputs.Select(output => output.Path);
            if (exportRetail)
            {
                candidatePaths = candidatePaths.Concat(
                [
                    Path.Combine(directory,
                        ProsperoDirectoryRetailFinalizationProvider.FihRequestDigestFileName),
                    Path.Combine(directory,
                        ProsperoDirectoryRetailFinalizationProvider.FihFinalizationFileName),
                    Path.Combine(directory,
                        ProsperoDirectoryRetailFinalizationProvider.CntRequestDigestFileName),
                    Path.Combine(directory,
                        ProsperoDirectoryRetailFinalizationProvider.CntAuthenticationFileName),
                ]);
            }
            string? existing = candidatePaths.FirstOrDefault(File.Exists);
            if (existing is not null)
                throw new IOException($"Refusing to overwrite existing publisher sidecar: {existing}");
        }

        Directory.CreateDirectory(directory);
        foreach ((string path, byte[] data) in outputs)
            File.WriteAllBytes(path, data);

        var paths = outputs.Select(output => output.Path).ToList();
        if (exportRetail)
        {
            // Standard-Retail FIH/CNT material is reusable only for the exact
            // same deterministic request. Preserve it with SHA3 request bindings.
            paths.AddRange(
                ProsperoDirectoryRetailFinalizationProvider.ExportFromPackage(
                    packagePath, directory, overwrite));
        }
        return paths;
    }

    private static byte[]? TryLoadRawSidecar(string fileName, int expectedLength, string? directory)
    {
        string path = GetPath(fileName, directory);
        if (!File.Exists(path))
            return null;

        byte[] value = File.ReadAllBytes(path);
        if (value.Length != expectedLength)
            throw new InvalidDataException(
                $"{fileName} must contain exactly {expectedLength} raw bytes, not {value.Length}.");
        return value;
    }
}
