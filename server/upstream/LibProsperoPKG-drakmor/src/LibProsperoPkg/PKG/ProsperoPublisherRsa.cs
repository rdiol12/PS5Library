// LibProsperoPkg - public RSA operations used by the Prospero publishing profile.
#nullable enable
using LibProsperoPkg.Keys;
using LibProsperoPkg.Util;
using System;
using System.Security.Cryptography;

namespace LibProsperoPkg.PKG;

/// <summary>
/// Public RSA-3072 operations reproduced from the encrypted profile and call paths in
/// <c>sc2.exe</c>. No private key is involved in CNT, ENTRY_KEYS or IMAGE_KEY generation.
/// </summary>
public static class ProsperoPublisherRsa
{
    public const int ModulusSize = 384;
    public const int PasscodeBankCount = 7;
    public const int CntHeaderSize = 0x1000;
    public const int CntWrapPasscodeIndex = 3;

    /// <summary>
    /// Builds CNT+0x1000 exactly as <c>sc2!sub_423020</c>: SHA3-256 of the first
    /// 0x1000 CNT bytes, followed by deterministic RSAES-PKCS1-v1_5 public-key wrapping with
    /// <c>passcode[3]</c> and exponent 65537.
    /// </summary>
    public static byte[] BuildCntHeaderWrap(ReadOnlySpan<byte> cntHeader)
    {
        if (cntHeader.Length < CntHeaderSize)
            throw new ArgumentException(
                $"The CNT header wrap requires at least 0x{CntHeaderSize:X} bytes.",
                nameof(cntHeader));

        byte[] digest = ProsperoSha3.HashData(cntHeader[..CntHeaderSize]);
        return Crypto.RsaPkcs1EncryptKey(
            ProsperoKeys.GetPasscodeModulus(CntWrapPasscodeIndex).ToArray(),
            digest,
            deterministic: true);
    }

    /// <summary>Checks a stored CNT+0x1000 wrap by reproducing the deterministic public operation.</summary>
    public static bool VerifyCntHeaderWrap(
        ReadOnlySpan<byte> cntHeader,
        ReadOnlySpan<byte> storedWrap)
    {
        if (storedWrap.Length != ModulusSize)
            return false;
        return CryptographicOperations.FixedTimeEquals(
            BuildCntHeaderWrap(cntHeader),
            storedWrap);
    }

    /// <summary>
    /// Verifies an RS256 JWS/JWT signature using the publishing profile's <c>token</c> modulus.
    /// <paramref name="signedData"/> is the ASCII <c>base64url(header).base64url(payload)</c>
    /// byte sequence; <paramref name="signature"/> is its decoded 384-byte signature.
    /// </summary>
    public static bool VerifyTokenRs256(
        ReadOnlySpan<byte> signedData,
        ReadOnlySpan<byte> signature)
    {
        if (signature.Length != ModulusSize)
            return false;

        using RSA rsa = RSA.Create();
        rsa.ImportParameters(new RSAParameters
        {
            Modulus = ProsperoKeys.TokenKey.ToArray(),
            Exponent = [0x01, 0x00, 0x01],
        });
        return rsa.VerifyData(
            signedData,
            signature,
            HashAlgorithmName.SHA256,
            RSASignaturePadding.Pkcs1);
    }
}
