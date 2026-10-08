// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK

using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using LibProsperoPkg.Util;

namespace LibProsperoPkg.PKG;

/// <summary>
/// Replays trusted standard-Retail finalization artifacts from a directory, but only when their
/// SHA3-256 request bindings match the exact FIH and CNT produced by the current build.
/// </summary>
/// <remarks>
/// This provider does not create publisher signatures. It makes an authorized/captured result a
/// first-class, fail-closed build input and prevents material from one package revision being
/// silently attached to another. Use <see cref="ExportFromPackage"/> to preserve the four files
/// from an existing standard-Retail package.
/// </remarks>
public sealed class ProsperoDirectoryRetailFinalizationProvider :
    IProsperoRetailFinalizationProvider
{
    public const string FihRequestDigestFileName = "retail_fih_request.sha3";
    public const string FihFinalizationFileName = "retail_fih_finalization.bin";
    public const string CntRequestDigestFileName = "retail_cnt_request.sha3";
    public const string CntAuthenticationFileName = "retail_cnt_authentication.bin";

    private readonly string directory;

    public ProsperoDirectoryRetailFinalizationProvider(string directory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(directory);
        this.directory = Path.GetFullPath(directory);
    }

    public ProsperoRetailFinalizationResult FinalizeFih(
        ProsperoRetailFinalizationRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        ValidateFihRequest(request.FihHeader.Span);
        ValidateBinding(
            request.FihHeader.Span,
            FihRequestDigestFileName,
            "FIH");
        return new ProsperoRetailFinalizationResult
        {
            FihFinalizationMaterial = ReadExact(
                FihFinalizationFileName,
                ProsperoPkgLayout.FihRetailFinalizationSize),
        };
    }

    public byte[] FinalizeCntHeader(
        ProsperoRetailCntFinalizationRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (request.CntHeader.Length != 0x1000)
            throw new InvalidDataException(
                $"The standard-Retail CNT request must contain exactly 0x1000 bytes, " +
                $"not 0x{request.CntHeader.Length:X}.");
        ValidateBinding(
            request.CntHeader.Span,
            CntRequestDigestFileName,
            "CNT");
        return ReadExact(
            CntAuthenticationFileName,
            ProsperoPublisherRsa.ModulusSize);
    }

    /// <summary>
    /// Exports request-bound FIH/CNT artifacts from a completed standard-Retail package.
    /// The result can finalize only a byte-identical deterministic rebuild.
    /// </summary>
    public static IReadOnlyList<string> ExportFromPackage(
        string packagePath,
        string outputDirectory,
        bool overwrite = false)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(packagePath);
        ArgumentException.ThrowIfNullOrWhiteSpace(outputDirectory);
        string package = Path.GetFullPath(packagePath);
        string output = Path.GetFullPath(outputDirectory);

        using var input = File.OpenRead(package);
        ProsperoPkg parsed = ProsperoPkgReader.Read(input);
        ProsperoFihHeader fih = parsed.Fih
            ?? throw new InvalidDataException(
                "A finalized FIH package is required to export Retail artifacts.");
        if (!fih.IsOfficial)
            return Array.Empty<string>();
        if (fih.EmbeddedCntOffset > long.MaxValue)
            throw new InvalidDataException("The embedded CNT offset exceeds the supported range.");

        byte[] fihRequest = ReadRange(
            input, 0, ProsperoPkgLayout.FihHeaderRegionSize);
        byte[] fihMaterial = fihRequest.AsSpan(
            ProsperoPkgLayout.FihRetailFinalizationOffset,
            ProsperoPkgLayout.FihRetailFinalizationSize).ToArray();
        if (IsAllZero(fihMaterial))
            throw new InvalidDataException(
                "The official FIH has no standard-Retail finalization material.");
        fihRequest.AsSpan(
            ProsperoPkgLayout.FihRetailFinalizationOffset,
            ProsperoPkgLayout.FihRetailFinalizationSize).Clear();
        ValidateFihRequest(fihRequest);

        long cntOffset = checked((long)fih.EmbeddedCntOffset);
        byte[] cntRequest = ReadRange(input, cntOffset, 0x1000);
        byte[] cntAuthentication = ReadRange(
            input,
            checked(cntOffset + 0x1000),
            ProsperoPublisherRsa.ModulusSize);
        if (IsAllZero(cntAuthentication))
            throw new InvalidDataException(
                "The official CNT has no standard-Retail authentication material.");

        var files = new List<(string Name, byte[] Data)>
        {
            (FihRequestDigestFileName, ProsperoSha3.HashData(fihRequest)),
            (FihFinalizationFileName, fihMaterial),
            (CntRequestDigestFileName, ProsperoSha3.HashData(cntRequest)),
            (CntAuthenticationFileName, cntAuthentication),
        };
        string[] paths = files
            .Select(file => Path.Combine(output, file.Name))
            .ToArray();
        if (!overwrite)
        {
            string? existing = paths.FirstOrDefault(File.Exists);
            if (existing is not null)
                throw new IOException(
                    $"Refusing to overwrite an existing Retail artifact: {existing}");
        }

        Directory.CreateDirectory(output);
        for (int i = 0; i < files.Count; i++)
            File.WriteAllBytes(paths[i], files[i].Data);
        return paths;
    }

    private void ValidateBinding(
        ReadOnlySpan<byte> request,
        string digestFileName,
        string displayName)
    {
        byte[] expected = ReadExact(
            digestFileName,
            ProsperoImageDigests.DigestSize);
        byte[] actual = ProsperoSha3.HashData(request);
        if (!CryptographicOperations.FixedTimeEquals(expected, actual))
        {
            throw new InvalidDataException(
                $"The {displayName} Retail artifact is bound to another request " +
                $"(expected SHA3-256 {Convert.ToHexString(expected)}, " +
                $"actual {Convert.ToHexString(actual)}).");
        }
    }

    private byte[] ReadExact(string fileName, int expectedLength)
    {
        string path = Path.Combine(directory, fileName);
        if (!File.Exists(path))
            throw new FileNotFoundException(
                $"Required standard-Retail artifact '{fileName}' was not found.",
                path);
        byte[] value = File.ReadAllBytes(path);
        if (value.Length != expectedLength)
            throw new InvalidDataException(
                $"{fileName} must contain exactly 0x{expectedLength:X} bytes, " +
                $"not 0x{value.Length:X}.");
        if (IsAllZero(value))
            throw new InvalidDataException($"{fileName} is all zero.");
        return value;
    }

    private static void ValidateFihRequest(ReadOnlySpan<byte> fih)
    {
        if (fih.Length != ProsperoPkgLayout.FihHeaderRegionSize)
            throw new InvalidDataException(
                $"The standard-Retail FIH request must contain exactly " +
                $"0x{ProsperoPkgLayout.FihHeaderRegionSize:X} bytes.");
        if (!fih[..ProsperoPkgLayout.FihMagic.Length]
                .SequenceEqual(ProsperoPkgLayout.FihMagic) ||
            fih[ProsperoPkgLayout.FihSignedByteOffset] != 0x80)
        {
            throw new InvalidDataException(
                "The Retail finalization request is not an official FIH header.");
        }
        if (!IsAllZero(fih.Slice(
                ProsperoPkgLayout.FihRetailFinalizationOffset,
                ProsperoPkgLayout.FihRetailFinalizationSize)))
        {
            throw new InvalidDataException(
                "The FIH Retail finalization area must be zero in the signed request.");
        }
    }

    private static byte[] ReadRange(Stream input, long offset, int length)
    {
        if (offset < 0 || offset > input.Length - length)
            throw new InvalidDataException(
                $"Retail artifact range 0x{offset:X}+0x{length:X} is outside the package.");
        byte[] result = new byte[length];
        input.Position = offset;
        input.ReadExactly(result);
        return result;
    }

    private static bool IsAllZero(ReadOnlySpan<byte> value)
    {
        byte aggregate = 0;
        foreach (byte item in value)
            aggregate |= item;
        return aggregate == 0;
    }
}
