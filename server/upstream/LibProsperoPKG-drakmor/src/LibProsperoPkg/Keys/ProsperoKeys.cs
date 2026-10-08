// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// Public RSA-3072 moduli recovered from the encrypted container-parameters profile embedded in
// sc2.exe. These are public wrapping/verification keys, not private publisher signing material.

using System;
using System.IO;
using System.Reflection;
using System.Security.Cryptography;

namespace LibProsperoPkg.Keys;

/// <summary>
/// Provides access to the embedded research/test key material used by the package pipeline.
/// <see cref="IsAvailable"/> reports whether every embedded resource could be loaded.
/// </summary>
public static class ProsperoKeys
{
    private const string RsaPemResource = "LibProsperoPkg.Keys.Data.pkg_meta_rsa_key.pem";
    private const string PasscodeResource = "LibProsperoPkg.Keys.Data.passcode.bin";
    private const string MountImageResource = "LibProsperoPkg.Keys.Data.mount_image.bin";
    private const string TokenResource = "LibProsperoPkg.Keys.Data.token.hex";

    private static readonly Lazy<RSAParameters?> _metadataRsa = new(LoadMetadataRsaParameters);
    private static readonly Lazy<byte[]?> _passcodeKey = new(() => TryLoadBytes(PasscodeResource));
    private static readonly Lazy<byte[]?> _mountImageKey = new(() => TryLoadBytes(MountImageResource));
    private static readonly Lazy<byte[]?> _tokenKey = new(() => TryLoadHex(TokenResource));

    /// <summary>True when every embedded research/test resource was loaded successfully.</summary>
    public static bool IsAvailable =>
        _metadataRsa.Value is not null
        && IsPublisherRsaProfileAvailable;

    /// <summary>
    /// True when all public RSA-3072 banks embedded in the matching <c>sc2.exe</c> profile are
    /// available: seven passcode moduli, the mount-image modulus and the token-verification modulus.
    /// </summary>
    public static bool IsPublisherRsaProfileAvailable =>
        _passcodeKey.Value is { Length: 7 * 384 }
        && _mountImageKey.Value is { Length: 384 }
        && _tokenKey.Value is { Length: 384 };

    /// <summary>
    /// The PKG-metadata RSA-3072 private key. Returns a fresh
    /// <see cref="RSA"/> instance the caller owns and must dispose.
    /// </summary>
    /// <exception cref="InvalidOperationException">The embedded key could not be loaded.</exception>
    public static RSA CreateMetadataRsa()
    {
        if (_metadataRsa.Value is not { } parameters)
            throw new InvalidOperationException("The PS5 PKG-metadata RSA-3072 key is unavailable.");

        var rsa = RSA.Create();
        rsa.ImportParameters(parameters);
        return rsa;
    }

    /// <summary>
    /// Seven concatenated RSA-3072 public moduli from the publishing profile's
    /// <c>&lt;passcode&gt;</c> bank.
    /// </summary>
    /// <exception cref="InvalidOperationException">The embedded key could not be loaded.</exception>
    public static ReadOnlySpan<byte> PasscodeKey =>
        _passcodeKey.Value ?? throw new InvalidOperationException("The PS5 passcode key is unavailable.");

    /// <summary>
    /// RSA-3072 public modulus from <c>&lt;mount-image&gt;</c>; used to wrap the 32-byte
    /// PFS image key placed at the beginning of IMAGE_KEY.
    /// </summary>
    /// <exception cref="InvalidOperationException">The embedded key could not be loaded.</exception>
    public static ReadOnlySpan<byte> MountImageKey =>
        _mountImageKey.Value ?? throw new InvalidOperationException("The PS5 mount-image key is unavailable.");

    /// <summary>
    /// RSA-3072 public modulus from <c>&lt;token&gt;</c>; used by <c>sc2.exe</c> to verify
    /// RS256 JWS/JWT authorization tokens. It is not used to build ordinary CNT/PPR-PFS images.
    /// </summary>
    public static ReadOnlySpan<byte> TokenKey =>
        _tokenKey.Value ?? throw new InvalidOperationException("The PS5 token key is unavailable.");

    /// <summary>Returns one RSA-3072 modulus from the seven-element passcode bank.</summary>
    public static ReadOnlySpan<byte> GetPasscodeModulus(int index)
    {
        if ((uint)index >= 7)
            throw new ArgumentOutOfRangeException(nameof(index));
        return PasscodeKey.Slice(index * 384, 384);
    }

    private static RSAParameters? LoadMetadataRsaParameters()
    {
        try
        {
            var pem = LoadText(RsaPemResource);
            if (pem is null) return null;

            using var rsa = RSA.Create();
            rsa.ImportFromPem(pem);
            // Export including private parameters so we can re-import on demand without
            // keeping a single shared (and disposable) instance alive.
            return rsa.ExportParameters(true);
        }
        catch
        {
            return null;
        }
    }

    private static string? LoadText(string resourceName)
    {
        using var stream = OpenResource(resourceName);
        if (stream is null) return null;
        using var reader = new StreamReader(stream);
        return reader.ReadToEnd();
    }

    private static byte[]? TryLoadBytes(string resourceName)
    {
        try
        {
            using var stream = OpenResource(resourceName);
            if (stream is null) return null;
            using var ms = new MemoryStream();
            stream.CopyTo(ms);
            return ms.ToArray();
        }
        catch
        {
            return null;
        }
    }

    private static byte[]? TryLoadHex(string resourceName)
    {
        try
        {
            string? value = LoadText(resourceName);
            return value is null ? null : Convert.FromHexString(value.Trim());
        }
        catch
        {
            return null;
        }
    }

    private static Stream? OpenResource(string resourceName) =>
        typeof(ProsperoKeys).GetTypeInfo().Assembly.GetManifestResourceStream(resourceName);
}
