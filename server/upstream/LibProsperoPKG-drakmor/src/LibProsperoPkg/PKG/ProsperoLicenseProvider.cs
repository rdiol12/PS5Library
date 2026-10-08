// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// Provider boundary for publisher/backend-issued AC/AL license artifacts.
#nullable enable
using System;
using System.IO;

namespace LibProsperoPkg.PKG;

/// <summary>
/// Identifies the package for which an external publishing service, SDK tool or console bridge
/// should return already-issued license artifacts.
/// </summary>
public sealed class ProsperoLicenseRequest
{
    /// <summary>The package volume profile.</summary>
    public required ProsperoVolumeType VolumeType { get; init; }

    /// <summary>The exact 36-character package content id.</summary>
    public required string ContentId { get; init; }

    /// <summary>
    /// Optional 16-byte entitlement key from the GP5 package element. It is present for AC/AL
    /// profiles and is validated against <c>license.info+0x30</c>.
    /// </summary>
    public byte[]? EntitlementKey { get; init; }
}

/// <summary>Decrypted publisher RIF/license records ready for CNT entry encryption.</summary>
public sealed class ProsperoLicenseArtifacts
{
    /// <summary>Decrypted 0x400-byte <c>license.dat</c> record beginning with <c>RIF\0</c>.</summary>
    public required byte[] LicenseDat { get; init; }

    /// <summary>Decrypted 0x200-byte <c>license.info</c> record.</summary>
    public required byte[] LicenseInfo { get; init; }

    /// <summary>Loads the conventional two-file representation from a directory.</summary>
    public static ProsperoLicenseArtifacts Load(string directory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(directory);
        string fullDirectory = Path.GetFullPath(directory);
        return new ProsperoLicenseArtifacts
        {
            LicenseDat = File.ReadAllBytes(Path.Combine(fullDirectory, "license.dat")),
            LicenseInfo = File.ReadAllBytes(Path.Combine(fullDirectory, "license.info")),
        };
    }

    /// <summary>
    /// Validates sizes, RIF framing, content id and the optional entitlement key.
    /// Throws <see cref="InvalidDataException"/> with the first mismatch.
    /// </summary>
    public void Validate(ProsperoLicenseRequest request)
    {
        ArgumentNullException.ThrowIfNull(request);
        if (!ProsperoSystemFiles.ValidateLicenseDat(
                LicenseDat, request.ContentId, out string? datError))
            throw new InvalidDataException($"license.dat: {datError}");
        if (!ProsperoSystemFiles.ValidateLicenseInfo(
                LicenseInfo, request.ContentId,
                request.EntitlementKey ?? Array.Empty<byte>(), out string? infoError))
            throw new InvalidDataException($"license.info: {infoError}");
    }
}

/// <summary>
/// Supplies already-issued decrypted license records. Implementations may read a sidecar directory,
/// invoke an authorized publishing backend, or bridge a console/SDK service. The package writer
/// validates the returned records and performs the normal CNT entry encryption itself.
/// </summary>
public interface IProsperoLicenseProvider
{
    /// <summary>Returns license records for <paramref name="request"/>.</summary>
    ProsperoLicenseArtifacts GetLicense(ProsperoLicenseRequest request);
}

/// <summary>Simple provider that loads <c>license.dat</c>/<c>license.info</c> from one directory.</summary>
public sealed class ProsperoDirectoryLicenseProvider : IProsperoLicenseProvider
{
    private readonly string _directory;

    public ProsperoDirectoryLicenseProvider(string directory)
    {
        ArgumentException.ThrowIfNullOrWhiteSpace(directory);
        _directory = Path.GetFullPath(directory);
    }

    public ProsperoLicenseArtifacts GetLicense(ProsperoLicenseRequest request) =>
        ProsperoLicenseArtifacts.Load(_directory);
}
