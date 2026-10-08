// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
#nullable enable
using LibProsperoPkg.Util;
using System;
using System.IO;

namespace LibProsperoPkg.PFS;

/// <summary>
/// Random-access plaintext view of an encrypted outer PFS. Reads are decrypted one outer block at
/// a time and the most recently used block is cached, allowing <see cref="PfsReader"/> to traverse
/// very large signed indirect maps without creating a second plaintext image.
/// </summary>
public sealed class ProsperoOuterPfsDecryptReader : IMemoryReader
{
    private readonly Stream input;
    private readonly bool ownsInput;
    private readonly long startOffset;
    private readonly long length;
    private readonly int blockSize;
    private readonly ProsperoOuterBlockKind[] blockKinds;
    private readonly XtsBlockTransform xts;
    private readonly byte[] cachedBlock;
    private readonly object sync = new();
    private int cachedBlockIndex = -1;
    private int cachedBlockLength;
    private bool disposed;

    public ProsperoOuterPfsDecryptReader(
        Stream input,
        long length,
        ReadOnlySpan<byte> tweakKey,
        ReadOnlySpan<byte> dataKey,
        ReadOnlySpan<ProsperoOuterBlockKind> blockKinds,
        int blockSize = ProsperoOuterPfsImage.DefaultBlockSize,
        long startOffset = 0,
        bool takeOwnership = false)
    {
        ArgumentNullException.ThrowIfNull(input);
        if (!input.CanRead || !input.CanSeek)
            throw new ArgumentException("Input must be a readable, seekable stream.", nameof(input));
        if (length < 0)
            throw new ArgumentOutOfRangeException(nameof(length));
        if (startOffset < 0)
            throw new ArgumentOutOfRangeException(nameof(startOffset));
        if (blockSize <= 0 || (blockSize & 15) != 0)
            throw new ArgumentOutOfRangeException(
                nameof(blockSize), "Block size must be a positive multiple of 16.");
        if (tweakKey.Length != 16)
            throw new ArgumentException("Tweak key must be 16 bytes.", nameof(tweakKey));
        if (dataKey.Length != 16)
            throw new ArgumentException("Data key must be 16 bytes.", nameof(dataKey));
        long blockCount64 = checked((length + blockSize - 1) / blockSize);
        if (blockCount64 > int.MaxValue)
            throw new ArgumentOutOfRangeException(
                nameof(length), "Outer-PFS block count exceeds Int32.");
        if (blockKinds.Length != (int)blockCount64)
            throw new ArgumentException(
                $"blockKinds length ({blockKinds.Length}) must equal the block count " +
                $"({blockCount64}).",
                nameof(blockKinds));
        if (checked(startOffset + length) > input.Length)
            throw new ArgumentException(
                "The requested outer-PFS range exceeds the input stream.", nameof(length));

        this.input = input;
        this.length = length;
        this.startOffset = startOffset;
        this.blockSize = blockSize;
        this.blockKinds = blockKinds.ToArray();
        ownsInput = takeOwnership;
        cachedBlock = new byte[blockSize];
        xts = new XtsBlockTransform(dataKey.ToArray(), tweakKey.ToArray());
    }

    public void Read(long pos, byte[] buf, int offset, int count)
    {
        ArgumentNullException.ThrowIfNull(buf);
        if (pos < 0 || pos > length)
            throw new ArgumentOutOfRangeException(nameof(pos));
        if (offset < 0 || count < 0 || offset > buf.Length - count)
            throw new ArgumentOutOfRangeException(nameof(offset));
        if (count > length - pos)
            throw new EndOfStreamException("Read exceeds the outer-PFS range.");

        lock (sync)
        {
            ObjectDisposedException.ThrowIf(disposed, this);
            while (count != 0)
            {
                int blockIndex = checked((int)(pos / blockSize));
                int blockOffset = checked((int)(pos % blockSize));
                LoadBlock(blockIndex);
                int copy = Math.Min(count, cachedBlockLength - blockOffset);
                if (copy <= 0)
                    throw new EndOfStreamException("Read reached a truncated outer-PFS block.");
                Buffer.BlockCopy(cachedBlock, blockOffset, buf, offset, copy);
                pos += copy;
                offset += copy;
                count -= copy;
            }
        }
    }

    private void LoadBlock(int blockIndex)
    {
        if (blockIndex == cachedBlockIndex)
            return;

        long relativeOffset = checked((long)blockIndex * blockSize);
        int count = checked((int)Math.Min(blockSize, length - relativeOffset));
        Array.Clear(cachedBlock);
        input.Position = checked(startOffset + relativeOffset);
        input.ReadExactly(cachedBlock, 0, count);

        ProsperoOuterBlockKind kind = blockKinds[blockIndex];
        if (kind != ProsperoOuterBlockKind.Plaintext)
        {
            ulong sector = ProsperoOuterPfsSignature.BlockSector(
                blockIndex, kind == ProsperoOuterBlockKind.Signed);
            if (count == blockSize)
            {
                xts.CryptSector(cachedBlock, sector, encrypt: false);
            }
            else
            {
                byte[] tail = cachedBlock.AsSpan(0, count).ToArray();
                xts.CryptSector(tail, sector, encrypt: false);
                tail.CopyTo(cachedBlock, 0);
            }
        }

        cachedBlockLength = count;
        cachedBlockIndex = blockIndex;
    }

    public void Dispose()
    {
        lock (sync)
        {
            if (disposed)
                return;
            disposed = true;
            xts.Dispose();
            if (ownsInput)
                input.Dispose();
        }
    }
}
