#nullable enable
using System;
using System.Buffers.Binary;
using System.IO;
using System.Numerics;
using System.Security.Cryptography;

namespace LibProsperoPkg.Util;

/// <summary>Portable SHA3-256 with platform acceleration when available.</summary>
public static class ProsperoSha3
{
    public const int DigestSize = 32;
    public static bool IsSupported => true;

    public static byte[] HashData(ReadOnlySpan<byte> data)
    {
        if (SHA3_256.IsSupported) return SHA3_256.HashData(data);
        var hash = new ManagedSha3();
        hash.AppendData(data);
        return hash.GetHashAndReset();
    }

    public static int HashData(ReadOnlySpan<byte> data, Span<byte> destination)
    {
        if (destination.Length < DigestSize) throw new ArgumentException("Destination needs 32 bytes.", nameof(destination));
        byte[] digest = HashData(data);
        digest.CopyTo(destination);
        return DigestSize;
    }

    /// <summary>
    /// Portable SHAKE128 extendable-output function. This is kept managed because the platform
    /// <see cref="Shake128"/> API may be present at compile time while remaining unsupported by
    /// the active Windows cryptographic provider.
    /// </summary>
    public static void Shake128Data(ReadOnlySpan<byte> data, Span<byte> destination)
    {
        const int rate = 168;
        var lanes = new ulong[25];

        while (data.Length >= rate)
        {
            for (int i = 0; i < rate / sizeof(ulong); i++)
                lanes[i] ^= BinaryPrimitives.ReadUInt64LittleEndian(data[(i * 8)..]);
            ManagedSha3.Permute(lanes);
            data = data[rate..];
        }

        Span<byte> finalBlock = stackalloc byte[rate];
        finalBlock.Clear();
        data.CopyTo(finalBlock);
        finalBlock[data.Length] ^= 0x1F;
        finalBlock[rate - 1] ^= 0x80;
        for (int i = 0; i < rate / sizeof(ulong); i++)
            lanes[i] ^= BinaryPrimitives.ReadUInt64LittleEndian(finalBlock[(i * 8)..]);
        ManagedSha3.Permute(lanes);

        Span<byte> partialWord = stackalloc byte[sizeof(ulong)];
        while (!destination.IsEmpty)
        {
            int take = Math.Min(rate, destination.Length);
            int fullWords = take / sizeof(ulong);
            for (int i = 0; i < fullWords; i++)
                BinaryPrimitives.WriteUInt64LittleEndian(
                    destination[(i * 8)..], lanes[i]);
            int remainder = take - fullWords * sizeof(ulong);
            if (remainder != 0)
            {
                BinaryPrimitives.WriteUInt64LittleEndian(
                    partialWord, lanes[fullWords]);
                partialWord[..remainder].CopyTo(destination[(fullWords * 8)..]);
            }
            destination = destination[take..];
            if (!destination.IsEmpty)
                ManagedSha3.Permute(lanes);
        }
    }

    public static byte[] HashData(Stream stream)
    {
        ArgumentNullException.ThrowIfNull(stream);
        var hash = new ManagedSha3();
        byte[] buffer = new byte[1024 * 1024];
        int read;
        while ((read = stream.Read(buffer, 0, buffer.Length)) != 0) hash.AppendData(buffer.AsSpan(0, read));
        return hash.GetHashAndReset();
    }

    public sealed class Incremental
    {
        private ManagedSha3 state = new();
        public void AppendData(ReadOnlySpan<byte> data) => state.AppendData(data);
        public byte[] GetHashAndReset()
        {
            byte[] result = state.GetHashAndReset();
            state = new ManagedSha3();
            return result;
        }
    }

    private sealed class ManagedSha3
    {
        private const int Rate = 136;
        private static readonly ulong[] RoundConstants =
        [
            0x0000000000000001, 0x0000000000008082, 0x800000000000808A, 0x8000000080008000,
            0x000000000000808B, 0x0000000080000001, 0x8000000080008081, 0x8000000000008009,
            0x000000000000008A, 0x0000000000000088, 0x0000000080008009, 0x000000008000000A,
            0x000000008000808B, 0x800000000000008B, 0x8000000000008089, 0x8000000000008003,
            0x8000000000008002, 0x8000000000000080, 0x000000000000800A, 0x800000008000000A,
            0x8000000080008081, 0x8000000000008080, 0x0000000080000001, 0x8000000080008008,
        ];
        private static readonly int[] Rotation =
        [
            0, 1, 62, 28, 27,
            36, 44, 6, 55, 20,
            3, 10, 43, 25, 39,
            41, 45, 15, 21, 8,
            18, 2, 61, 56, 14,
        ];

        private readonly ulong[] lanes = new ulong[25];
        private readonly byte[] pending = new byte[Rate];
        private int pendingLength;
        private bool finalized;

        public void AppendData(ReadOnlySpan<byte> data)
        {
            if (finalized) throw new InvalidOperationException("SHA3 state is finalized.");
            if (pendingLength != 0)
            {
                int take = Math.Min(Rate - pendingLength, data.Length);
                data[..take].CopyTo(pending.AsSpan(pendingLength));
                pendingLength += take;
                data = data[take..];
                if (pendingLength == Rate) { Absorb(pending); pendingLength = 0; }
            }
            while (data.Length >= Rate)
            {
                Absorb(data[..Rate]);
                data = data[Rate..];
            }
            data.CopyTo(pending);
            pendingLength = data.Length;
        }

        public byte[] GetHashAndReset()
        {
            if (finalized) throw new InvalidOperationException("SHA3 state is finalized.");
            finalized = true;
            pending.AsSpan(pendingLength).Clear();
            pending[pendingLength] ^= 0x06;
            pending[Rate - 1] ^= 0x80;
            Absorb(pending);
            byte[] result = new byte[DigestSize];
            for (int i = 0; i < result.Length / 8; i++)
                BinaryPrimitives.WriteUInt64LittleEndian(result.AsSpan(i * 8), lanes[i]);
            return result;
        }

        private void Absorb(ReadOnlySpan<byte> block)
        {
            for (int i = 0; i < Rate / 8; i++) lanes[i] ^= BinaryPrimitives.ReadUInt64LittleEndian(block[(i * 8)..]);
            Permute(lanes);
        }

        public static void Permute(ulong[] a)
        {
            Span<ulong> c = stackalloc ulong[5];
            Span<ulong> d = stackalloc ulong[5];
            Span<ulong> b = stackalloc ulong[25];
            foreach (ulong rc in RoundConstants)
            {
                for (int x = 0; x < 5; x++) c[x] = a[x] ^ a[x + 5] ^ a[x + 10] ^ a[x + 15] ^ a[x + 20];
                for (int x = 0; x < 5; x++) d[x] = c[(x + 4) % 5] ^ BitOperations.RotateLeft(c[(x + 1) % 5], 1);
                for (int y = 0; y < 5; y++) for (int x = 0; x < 5; x++) a[x + 5 * y] ^= d[x];
                for (int y = 0; y < 5; y++) for (int x = 0; x < 5; x++)
                    b[y + 5 * ((2 * x + 3 * y) % 5)] = BitOperations.RotateLeft(a[x + 5 * y], Rotation[x + 5 * y]);
                for (int y = 0; y < 5; y++) for (int x = 0; x < 5; x++)
                    a[x + 5 * y] = b[x + 5 * y] ^ (~b[(x + 1) % 5 + 5 * y] & b[(x + 2) % 5 + 5 * y]);
                a[0] ^= rc;
            }
        }
    }
}
