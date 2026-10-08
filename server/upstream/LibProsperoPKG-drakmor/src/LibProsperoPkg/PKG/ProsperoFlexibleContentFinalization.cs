// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// Dependency-free port of fa.exe's Flexible Content (FGC) finalization path.

#nullable enable
using LibProsperoPkg.Util;
using System;
using System.Buffers.Binary;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace LibProsperoPkg.PKG;

/// <summary>Files and credentials consumed by local FGC finalization.</summary>
public sealed class ProsperoFlexibleContentFinalizationOptions
{
    public required string FixedInfoHeaderPath { get; init; }
    public required string PfsMetadataPath { get; init; }
    public required string SubcontainerPath { get; init; }
    public required string ManifestPath { get; init; }
    public required string TokenPath { get; init; }
    public required string PartnerPrivateKeyPath { get; init; }
    public required string Passcode { get; init; }
}

/// <summary>Digests produced while finalizing an FGC artifact set.</summary>
public sealed class ProsperoFlexibleContentFinalizationResult
{
    public required byte[] SuperblockDigest { get; init; }
    public required byte[] FixedInfoDigest { get; init; }
    public long SuperblockOffsetInPfsMetadata { get; init; }
    public int TokenFormatVersion { get; init; }
}

/// <summary>
/// Finalizes FGC PFS metadata, FIH and CNT files without invoking <c>fa.exe</c> or <c>sc2.exe</c>.
/// The caller still supplies the issued FGC token and matching partner RSA-3072 private key.
/// </summary>
public static class ProsperoFlexibleContentFinalizer
{
    private const int BlockSize = 0x10000;
    private const int CertificateSize = 0x380;
    private const int RsaSize = 0x180;
    private const int AuthenticationSize = 0xA00;
    private const int PfsSignOffset = 0xC000;
    private const int FihSignOffset = 0xF000;
    private const int CntSignOffset = 0x1000;
    private const int SuperblockSystemVersionOffset = 0x360;
    private const int SuperblockIcvOffset = 0x380;
    private const int SuperblockIcvPreimageSize = 0x5A0;
    private const int FihStateOffset = 0x04;
    private const int FihSuperblockDigestOffset = 0x30;
    private const int FihSuperblockOffsetField = 0x20;
    private const uint ImageDigestsEntryId = 0x040A;

    /// <summary>Finalizes all three FGC authentication targets in publisher order.</summary>
    public static ProsperoFlexibleContentFinalizationResult Finalize(
        ProsperoFlexibleContentFinalizationOptions options)
    {
        ArgumentNullException.ThrowIfNull(options);
        ValidateInputFiles(options);

        string contentId;
        using (var cnt = OpenReadWrite(options.SubcontainerPath))
        {
            contentId = ReadCntContentId(cnt);
        }

        Manifest manifest = ReadManifest(options.ManifestPath);
        if (!string.Equals(contentId, manifest.ContentId, StringComparison.Ordinal))
        {
            throw new InvalidDataException(
                $"Manifest contentId '{manifest.ContentId}' does not match CNT content id '{contentId}'.");
        }

        FlexibleContentToken token = FlexibleContentToken.Load(
            options.TokenPath, contentId, options.Passcode);
        using RSA rsa = LoadPartnerPrivateKey(options.PartnerPrivateKeyPath);
        token.ValidatePartnerModulus(rsa);

        long absoluteSuperblockOffset;
        using (var fih = OpenReadWrite(options.FixedInfoHeaderPath))
        {
            byte[] header = ReadRange(fih, 0, BlockSize);
            EnsureMagic(header, ProsperoPkgLayout.FihMagic, "FIH");
            absoluteSuperblockOffset = checked((long)BinaryPrimitives.ReadUInt64LittleEndian(
                header.AsSpan(FihSuperblockOffsetField, sizeof(ulong))));
        }

        long superblockOffsetInMetadata =
            checked(absoluteSuperblockOffset - manifest.PfsMetadataOffset);
        if (superblockOffsetInMetadata < 0 ||
            superblockOffsetInMetadata > new FileInfo(options.PfsMetadataPath).Length - BlockSize)
        {
            throw new InvalidDataException(
                "The FIH superblock offset is outside the pfsmeta extent from manifest.json.");
        }

        byte[] superblockDigest = FinalizeSuperblock(
            options.PfsMetadataPath, superblockOffsetInMetadata, token, rsa);
        byte[] fixedInfoDigest = FinalizeFih(
            options.FixedInfoHeaderPath, superblockDigest, token, rsa);

        FinalizeCnt(
            options.SubcontainerPath,
            absoluteSuperblockOffset,
            superblockDigest,
            fixedInfoDigest,
            token,
            options.Passcode,
            rsa);

        return new ProsperoFlexibleContentFinalizationResult
        {
            SuperblockDigest = superblockDigest,
            FixedInfoDigest = fixedInfoDigest,
            SuperblockOffsetInPfsMetadata = superblockOffsetInMetadata,
            TokenFormatVersion = token.FormatVersion,
        };
    }

    private static byte[] FinalizeSuperblock(
        string path, long offset, FlexibleContentToken token, RSA rsa)
    {
        using FileStream stream = OpenReadWrite(path);
        byte[] block = ReadRange(stream, offset, BlockSize);

        BinaryPrimitives.WriteUInt64LittleEndian(
            block.AsSpan(SuperblockSystemVersionOffset, sizeof(ulong)),
            token.RequiredSystemSoftwareVersion);
        block.AsSpan(SuperblockIcvOffset, ProsperoImageDigests.DigestSize).Clear();
        ProsperoSha3.HashData(block.AsSpan(0, SuperblockIcvPreimageSize))
            .CopyTo(block, SuperblockIcvOffset);

        WriteAuthentication(
            block, PfsSignOffset, token.PfsCertificates, rsa,
            ProsperoSha3.HashData(block.AsSpan(0, PfsSignOffset)));
        WriteRange(stream, offset, block);
        return ProsperoSha3.HashData(block);
    }

    private static byte[] FinalizeFih(
        string path, byte[] superblockDigest, FlexibleContentToken token, RSA rsa)
    {
        using FileStream stream = OpenReadWrite(path);
        byte[] block = ReadRange(stream, 0, BlockSize);
        EnsureMagic(block, ProsperoPkgLayout.FihMagic, "FIH");

        uint stateAndVersion =
            BinaryPrimitives.ReadUInt32LittleEndian(block.AsSpan(FihStateOffset, sizeof(uint)));
        BinaryPrimitives.WriteUInt32LittleEndian(
            block.AsSpan(FihStateOffset, sizeof(uint)), stateAndVersion | 0x00008010u);
        superblockDigest.CopyTo(block, FihSuperblockDigestOffset);

        WriteAuthentication(
            block, FihSignOffset, token.FihCertificates, rsa,
            ProsperoSha3.HashData(block.AsSpan(0, FihSignOffset)));
        WriteRange(stream, 0, block);
        return ProsperoSha3.HashData(block);
    }

    private static void FinalizeCnt(
        string cntPath,
        long absoluteSuperblockOffset,
        byte[] superblockDigest,
        byte[] fixedInfoDigest,
        FlexibleContentToken token,
        string passcode,
        RSA rsa)
    {
        using FileStream stream = OpenReadWrite(cntPath);
        ProsperoPkg package = ProsperoPkgReader.Read(stream);
        ProsperoPkgHeader header = package.Header ??
            throw new InvalidDataException("FGC subcontainer has no CNT header.");
        if (package.Type != ProsperoPkgType.Meta)
            throw new InvalidDataException("FGC subcontainer must be a standalone CNT file.");

        byte[] cntHeader = ReadRange(stream, 0, BlockSize);
        EnsureMagic(cntHeader, ProsperoPkgLayout.CntMagic, "CNT");
        BinaryPrimitives.WriteUInt32BigEndian(
            cntHeader.AsSpan(0x04, sizeof(uint)),
            BinaryPrimitives.ReadUInt32BigEndian(cntHeader.AsSpan(0x04, sizeof(uint))) |
            (uint)PKGFlags.FINALIZED);
        superblockDigest.CopyTo(cntHeader, 0x440);
        fixedInfoDigest.CopyTo(cntHeader, 0x460);
        WriteRange(stream, 0, cntHeader);

        ReplaceAccessToken(stream, package.Entries, token.AccessToken);
        UpdateImageDigests(
            stream, package.Entries, header.ContentId, passcode,
            absoluteSuperblockOffset, superblockDigest);
        ResealCnt(stream, package.Entries, header);

        cntHeader = ReadRange(stream, 0, BlockSize);
        WriteAuthentication(
            cntHeader, CntSignOffset, token.CntCertificates, rsa,
            ProsperoSha3.HashData(cntHeader.AsSpan(0, CntSignOffset)));
        WriteRange(stream, 0, cntHeader);
    }

    private static void ReplaceAccessToken(
        Stream stream, IReadOnlyList<ProsperoPkgEntry> entries, byte[] accessToken)
    {
        ProsperoPkgEntry imageKey = FindEntry(entries, (uint)EntryId.IMAGE_KEY);
        if (accessToken.Length != imageKey.DataSize)
        {
            throw new InvalidDataException(
                $"FGC access token is 0x{accessToken.Length:X} bytes, but CNT IMAGE_KEY reserves " +
                $"0x{imageKey.DataSize:X} bytes.");
        }
        WriteRange(stream, imageKey.DataOffset, accessToken);
    }

    private static void UpdateImageDigests(
        Stream stream,
        IReadOnlyList<ProsperoPkgEntry> entries,
        string contentId,
        string passcode,
        long absoluteSuperblockOffset,
        byte[] superblockDigest)
    {
        ProsperoPkgEntry entry = FindEntry(entries, ImageDigestsEntryId);
        byte[] stored = ReadRange(stream, entry.DataOffset, checked((int)entry.DataSize));
        byte[] plain = entry.Encrypted
            ? Entry.Decrypt(stored, contentId, passcode, ToMeta(entry), publisherProfile: true)
            : stored;

        if (absoluteSuperblockOffset % BlockSize != 0)
            throw new InvalidDataException("FIH superblock offset is not 64-KiB aligned.");
        long digestOffset = checked((absoluteSuperblockOffset / BlockSize - 1) *
            ProsperoImageDigests.DigestSize);
        if (digestOffset < 0 || digestOffset > plain.Length - ProsperoImageDigests.DigestSize)
            throw new InvalidDataException("Superblock imagedigs slot is outside imagedigs.dat.");

        byte[] reversed = superblockDigest.ToArray();
        Array.Reverse(reversed);
        reversed.CopyTo(plain, checked((int)digestOffset));

        if (!entry.Encrypted)
        {
            WriteRange(stream, entry.DataOffset, plain);
            return;
        }

        var replacement = new GenericEntry((EntryId)entry.RawId)
        {
            FileData = plain,
            meta = ToMeta(entry),
        };
        stream.Position = entry.DataOffset;
        replacement.WriteEncrypted(stream, contentId, passcode, publisherProfile: true);
    }

    private static void ResealCnt(
        FileStream stream,
        IReadOnlyList<ProsperoPkgEntry> entries,
        ProsperoPkgHeader header)
    {
        ProsperoPkgEntry digestTable = FindEntry(entries, (uint)EntryId.DIGESTS);
        byte[] table = ReadRange(stream, digestTable.DataOffset, checked((int)digestTable.DataSize));
        if (table.Length < checked(entries.Count * ProsperoImageDigests.DigestSize))
            throw new InvalidDataException("CNT digest table is shorter than the entry table.");

        for (int i = 1; i < entries.Count; i++)
        {
            ProsperoPkgEntry entry = entries[i];
            Crypto.Sha3_256(stream, entry.DataOffset, entry.DataSize)
                .CopyTo(table, i * ProsperoImageDigests.DigestSize);
        }
        WriteRange(stream, digestTable.DataOffset, table);

        byte[] sc1 = HashConcatenatedEntries(
            stream, entries.Take(Math.Max(0, header.ScEntryCount - 1)),
            useMetaPrefix: false, header.ScEntryCount);
        byte[] sc2 = HashConcatenatedEntries(
            stream, entries.Take(Math.Max(0, header.ScEntryCount - 2)),
            useMetaPrefix: true, header.ScEntryCount);
        byte[] tableDigest = ProsperoSha3.HashData(table);
        byte[] bodyDigest = Crypto.Sha3_256(
            stream, checked((long)header.BodyOffset), checked((long)header.BodySize));

        WriteRange(stream, 0x100, sc1);
        WriteRange(stream, 0x120, sc2);
        WriteRange(stream, 0x140, tableDigest);
        WriteRange(stream, 0x160, bodyDigest);

        byte[] descriptors = ReadRange(stream, 0x510, 0x10);
        uint imageKeyOffset = BinaryPrimitives.ReadUInt32BigEndian(descriptors.AsSpan(0x00, 4));
        uint imageKeySize = BinaryPrimitives.ReadUInt32BigEndian(descriptors.AsSpan(0x04, 4));
        uint mandatoryOffset = BinaryPrimitives.ReadUInt32BigEndian(descriptors.AsSpan(0x08, 4));
        uint mandatorySize = BinaryPrimitives.ReadUInt32BigEndian(descriptors.AsSpan(0x0C, 4));
        if (imageKeySize != 0 && mandatorySize != 0)
        {
            byte[] descriptorDigest = new byte[64];
            Crypto.Sha3_256(stream, imageKeyOffset, imageKeySize).CopyTo(descriptorDigest, 0);
            Crypto.Sha3_256(stream, mandatoryOffset, mandatorySize).CopyTo(descriptorDigest, 32);
            WriteRange(stream, 0x520, descriptorDigest);
        }

        byte[] rollupFields = ReadRange(stream, 0, 0x30);
        ulong rollupOffset = BinaryPrimitives.ReadUInt64BigEndian(
            rollupFields.AsSpan(0x20, 8));
        uint rollupSize = BinaryPrimitives.ReadUInt32BigEndian(
            rollupFields.AsSpan(0x1C, 4));
        if (rollupOffset > (ulong)stream.Length ||
            rollupSize > (ulong)stream.Length - rollupOffset)
            throw new InvalidDataException("CNT header rollup range is outside the subcontainer.");
        byte[] rollup = Crypto.Sha3_256(stream, checked((long)rollupOffset), rollupSize);
        WriteRange(stream, ProsperoImageDigests.CntHeaderRollupStoredOffset, rollup);
        byte[] packageDigest = ProsperoImageDigests.ComputePackageDigest(
            ReadRange(stream, 0, ProsperoImageDigests.PackageDigestRegionSize));
        WriteRange(stream, ProsperoImageDigests.PackageDigestStoredOffset, packageDigest);
    }

    private static byte[] HashConcatenatedEntries(
        Stream stream,
        IEnumerable<ProsperoPkgEntry> entries,
        bool useMetaPrefix,
        ushort scEntryCount)
    {
        using var data = new MemoryStream();
        foreach (ProsperoPkgEntry entry in entries)
        {
            long size = useMetaPrefix && entry.RawId == (uint)EntryId.METAS
                ? checked(scEntryCount * ProsperoPkgLayout.EntryMetaSize)
                : entry.DataSize;
            CopyRange(stream, entry.DataOffset, size, data);
        }
        return ProsperoSha3.HashData(data.ToArray());
    }

    private static void WriteAuthentication(
        byte[] target,
        int offset,
        (byte[] First, byte[] Second) certificates,
        RSA rsa,
        byte[] digest)
    {
        if (certificates.First.Length != CertificateSize ||
            certificates.Second.Length != CertificateSize)
            throw new InvalidDataException("Every FGC presigned certificate must be exactly 0x380 bytes.");
        if (target.Length < offset + AuthenticationSize)
            throw new InvalidDataException("FGC authentication area is outside its 64-KiB target.");

        byte[] signature = rsa.SignHash(
            digest, HashAlgorithmName.SHA256, RSASignaturePadding.Pkcs1);
        if (signature.Length != RsaSize)
            throw new CryptographicException("FGC partner key did not produce an RSA-3072 signature.");

        int cursor = offset;
        certificates.First.CopyTo(target, cursor);
        cursor += CertificateSize;
        signature.CopyTo(target, cursor);
        cursor += RsaSize;
        certificates.Second.CopyTo(target, cursor);
        cursor += CertificateSize;
        signature.CopyTo(target, cursor);
    }

    private static void ValidateInputFiles(ProsperoFlexibleContentFinalizationOptions options)
    {
        foreach (string path in new[]
        {
            options.FixedInfoHeaderPath,
            options.PfsMetadataPath,
            options.SubcontainerPath,
            options.ManifestPath,
            options.TokenPath,
            options.PartnerPrivateKeyPath,
        })
        {
            if (string.IsNullOrWhiteSpace(path) || !File.Exists(path))
                throw new FileNotFoundException("Required FGC input file was not found.", path);
        }
        if (options.Passcode.Length != 32 ||
            options.Passcode.Any(c => !(char.IsAsciiLetterOrDigit(c) || c is '-' or '_')))
            throw new ArgumentException(
                "FGC passcode must contain exactly 32 ASCII letters, digits, '-' or '_'.",
                nameof(options));
    }

    private static RSA LoadPartnerPrivateKey(string path)
    {
        RSA rsa = RSA.Create();
        try
        {
            rsa.ImportFromPem(File.ReadAllText(path));
            RSAParameters parameters = rsa.ExportParameters(true);
            if (rsa.KeySize != 3072 || parameters.Exponent is not [0x01, 0x00, 0x01] ||
                parameters.D is null)
                throw new InvalidDataException(
                    "FGC partner key must be a private RSA-3072 key with exponent 0x10001.");
            return rsa;
        }
        catch
        {
            rsa.Dispose();
            throw;
        }
    }

    private static Manifest ReadManifest(string path)
    {
        using JsonDocument document = JsonDocument.Parse(File.ReadAllBytes(path));
        JsonElement root = document.RootElement;
        string contentId = root.GetProperty("contentId").GetString() ??
            throw new InvalidDataException("manifest.json has no contentId.");
        foreach (JsonElement extent in root.GetProperty("pkgExtents").EnumerateArray())
        {
            if (extent.GetProperty("type").GetString() == "pfsmeta")
            {
                return new Manifest(contentId, ReadJsonInteger(extent.GetProperty("offsetInPkg")));
            }
        }
        throw new InvalidDataException("manifest.json has no pfsmeta extent.");
    }

    private static long ReadJsonInteger(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.Number && value.TryGetInt64(out long number))
            return number;
        if (value.ValueKind == JsonValueKind.String)
        {
            string text = value.GetString()!;
            return text.StartsWith("0x", StringComparison.OrdinalIgnoreCase)
                ? Convert.ToInt64(text[2..], 16)
                : long.Parse(text, System.Globalization.CultureInfo.InvariantCulture);
        }
        throw new InvalidDataException("Expected a numeric manifest offset.");
    }

    private static string ReadCntContentId(Stream stream)
    {
        byte[] header = ReadRange(stream, 0, 0x70);
        EnsureMagic(header, ProsperoPkgLayout.CntMagic, "CNT");
        ReadOnlySpan<byte> field = header.AsSpan(0x40, ProsperoPkgLayout.ContentIdSize);
        int end = field.IndexOf((byte)0);
        return Encoding.ASCII.GetString(end < 0 ? field : field[..end]);
    }

    private static ProsperoPkgEntry FindEntry(
        IReadOnlyList<ProsperoPkgEntry> entries, uint rawId) =>
        entries.FirstOrDefault(entry => entry.RawId == rawId) ??
        throw new InvalidDataException($"CNT entry 0x{rawId:X8} is missing.");

    private static MetaEntry ToMeta(ProsperoPkgEntry entry) => new()
    {
        id = (EntryId)entry.RawId,
        NameTableOffset = entry.NameTableOffset,
        Flags1 = entry.Flags1,
        Flags2 = entry.Flags2,
        DataOffset = entry.DataOffset,
        DataSize = entry.DataSize,
    };

    private static FileStream OpenReadWrite(string path) =>
        new(path, FileMode.Open, FileAccess.ReadWrite, FileShare.None);

    private static byte[] ReadRange(Stream stream, long offset, int size)
    {
        byte[] result = new byte[size];
        stream.Position = offset;
        stream.ReadExactly(result);
        return result;
    }

    private static void WriteRange(Stream stream, long offset, ReadOnlySpan<byte> data)
    {
        stream.Position = offset;
        stream.Write(data);
    }

    private static void CopyRange(Stream source, long offset, long size, Stream destination)
    {
        byte[] buffer = new byte[1024 * 1024];
        source.Position = offset;
        while (size > 0)
        {
            int read = source.Read(buffer, 0, (int)Math.Min(buffer.Length, size));
            if (read == 0)
                throw new EndOfStreamException("CNT entry ends before its declared size.");
            destination.Write(buffer, 0, read);
            size -= read;
        }
    }

    private static void EnsureMagic(byte[] data, ReadOnlySpan<byte> magic, string name)
    {
        if (!data.AsSpan(0, magic.Length).SequenceEqual(magic))
            throw new InvalidDataException($"{name} magic is invalid.");
    }

    private readonly record struct Manifest(string ContentId, long PfsMetadataOffset);

    private sealed class FlexibleContentToken
    {
        public required int FormatVersion { get; init; }
        public required (byte[] First, byte[] Second) PfsCertificates { get; init; }
        public required (byte[] First, byte[] Second) FihCertificates { get; init; }
        public required (byte[] First, byte[] Second) CntCertificates { get; init; }
        public required byte[] AccessToken { get; init; }
        public required ulong RequiredSystemSoftwareVersion { get; init; }

        public static FlexibleContentToken Load(string path, string contentId, string passcode)
        {
            using JsonDocument document = JsonDocument.Parse(File.ReadAllBytes(path));
            JsonElement root = document.RootElement;
            int version = root.GetProperty("tokenFormatVersion").GetInt32();

            JsonElement certificates;
            JsonElement accessTokenElement;
            JsonElement config;
            byte[] accessToken;
            if (version == 0)
            {
                JsonElement flexible = root.GetProperty("binary").GetProperty("flexibleContent");
                certificates = flexible.GetProperty("certificates");
                accessTokenElement = flexible.GetProperty("accessTokens").GetProperty(contentId);
                accessToken = Base64UrlDecode(accessTokenElement.GetString()!);
                config = root.GetProperty("config").GetProperty("flexibleContent");
            }
            else if (version == 1)
            {
                JsonElement flexible = root.GetProperty("binary").GetProperty("flexibleContents");
                certificates = flexible.GetProperty("certificates").GetProperty(contentId);
                accessTokenElement = flexible.GetProperty("accessTokens").GetProperty(contentId);
                Span<byte> tokenKey = stackalloc byte[16];
                ProsperoSha3.Shake128Data(
                    Encoding.ASCII.GetBytes($"encryptby{passcode}4token"), tokenKey);
                accessToken = DecryptCompactJwe(accessTokenElement.GetString()!, tokenKey);

                string expected = TrimHexPrefix(
                    root.GetProperty("digest").GetProperty("flexibleContents")
                        .GetProperty("accessTokens").GetProperty(contentId).GetString()!);
                if (!CryptographicOperations.FixedTimeEquals(
                        Convert.FromHexString(expected), ProsperoSha3.HashData(accessToken)))
                    throw new InvalidDataException("FGC access-token digest does not match token JSON.");
                config = root.GetProperty("config").GetProperty("flexibleContents")
                    .GetProperty(contentId);
            }
            else
            {
                throw new InvalidDataException(
                    $"FGC tokenFormatVersion {version} is not supported.");
            }

            Span<byte> expectedPasscode = stackalloc byte[32];
            ProsperoSha3.Shake128Data(
                Encoding.ASCII.GetBytes($"passcode{passcode}"), expectedPasscode);
            byte[] storedPasscode = Convert.FromHexString(
                TrimHexPrefix(config.GetProperty("passcodeDigest").GetString()!));
            if (!CryptographicOperations.FixedTimeEquals(storedPasscode, expectedPasscode))
                throw new InvalidDataException("FGC passcodeDigest does not match the supplied passcode.");

            return new FlexibleContentToken
            {
                FormatVersion = version,
                PfsCertificates = ReadCertificates(certificates, "PFS0", "PFS1"),
                FihCertificates = ReadCertificates(certificates, "FIH0", "FIH1"),
                CntCertificates = ReadCertificates(certificates, "CNT0", "CNT1"),
                AccessToken = accessToken,
                RequiredSystemSoftwareVersion = Convert.ToUInt64(
                    TrimHexPrefix(
                        config.GetProperty("requiredSystemSoftwareVersion").GetString()!), 16),
            };
        }

        public void ValidatePartnerModulus(RSA rsa)
        {
            byte[] modulus = rsa.ExportParameters(false).Modulus ??
                throw new CryptographicException("FGC private key exposes no modulus.");
            foreach (byte[] certificate in new[]
            {
                PfsCertificates.First, PfsCertificates.Second,
                FihCertificates.First, FihCertificates.Second,
                CntCertificates.First, CntCertificates.Second,
            })
            {
                if (certificate.Length != CertificateSize ||
                    !CryptographicOperations.FixedTimeEquals(
                        certificate.AsSpan(0x80, RsaSize), modulus))
                    throw new InvalidDataException(
                        "FGC token certificate modulus does not match the partner private key.");
            }
        }

        private static (byte[] First, byte[] Second) ReadCertificates(
            JsonElement element, string first, string second) =>
            (Base64UrlDecode(element.GetProperty(first).GetString()!),
             Base64UrlDecode(element.GetProperty(second).GetString()!));
    }

    private static byte[] DecryptCompactJwe(string compact, ReadOnlySpan<byte> key)
    {
        string[] parts = compact.Split('.');
        if (parts.Length != 5)
            throw new InvalidDataException("FGC access token is not a five-part compact JWE.");

        byte[] headerBytes = Base64UrlDecode(parts[0]);
        using JsonDocument header = JsonDocument.Parse(headerBytes);
        if (header.RootElement.GetProperty("alg").GetString() != "dir")
            throw new InvalidDataException("FGC token JWE must use direct key management.");

        string encryption = header.RootElement.GetProperty("enc").GetString()!;
        byte[] encryptedKey = Base64UrlDecode(parts[1]);
        if (encryptedKey.Length != 0)
            throw new InvalidDataException("Direct-key FGC JWE must have an empty encrypted-key part.");
        byte[] nonce = Base64UrlDecode(parts[2]);
        byte[] ciphertext = Base64UrlDecode(parts[3]);
        byte[] tag = Base64UrlDecode(parts[4]);
        byte[] aad = Encoding.ASCII.GetBytes(parts[0]);

        if (encryption == "A128GCM")
        {
            if (key.Length != 16 || tag.Length != 16)
                throw new InvalidDataException("A128GCM FGC token has invalid key/tag length.");
            byte[] plaintext = new byte[ciphertext.Length];
            using var aes = new AesGcm(key, tag.Length);
            aes.Decrypt(nonce, ciphertext, tag, plaintext, aad);
            return plaintext;
        }

        if (encryption == "A128CBC-HS256")
        {
            if (key.Length != 32 || tag.Length != 16)
                throw new InvalidDataException("A128CBC-HS256 FGC token has invalid key/tag length.");
            byte[] authInput = new byte[
                aad.Length + nonce.Length + ciphertext.Length + sizeof(ulong)];
            int cursor = 0;
            aad.CopyTo(authInput, cursor);
            cursor += aad.Length;
            nonce.CopyTo(authInput, cursor);
            cursor += nonce.Length;
            ciphertext.CopyTo(authInput, cursor);
            BinaryPrimitives.WriteUInt64BigEndian(
                authInput.AsSpan(authInput.Length - sizeof(ulong)), checked((ulong)aad.Length * 8));
            byte[] expected = HMACSHA256.HashData(key[..16], authInput);
            if (!CryptographicOperations.FixedTimeEquals(expected.AsSpan(0, 16), tag))
                throw new CryptographicException("FGC JWE authentication tag is invalid.");

            using Aes aes = Aes.Create();
            aes.Key = key[16..].ToArray();
            aes.IV = nonce;
            aes.Mode = CipherMode.CBC;
            aes.Padding = PaddingMode.PKCS7;
            using ICryptoTransform decryptor = aes.CreateDecryptor();
            return decryptor.TransformFinalBlock(ciphertext, 0, ciphertext.Length);
        }

        throw new InvalidDataException($"Unsupported FGC JWE encryption '{encryption}'.");
    }

    private static byte[] Base64UrlDecode(string value)
    {
        string padded = value.Replace('-', '+').Replace('_', '/');
        padded += new string('=', (4 - padded.Length % 4) % 4);
        return Convert.FromBase64String(padded);
    }

    private static string TrimHexPrefix(string value) =>
        value.StartsWith("0x", StringComparison.OrdinalIgnoreCase) ? value[2..] : value;
}
