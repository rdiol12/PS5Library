// LibProsperoPkg - A library for building and inspecting PS5 packages.
// Copyright (C) 2026 SvenGDK
//
// ---------------------------------------------------------------------------------------------------
// Kraken (newLZ) encoder — a from-scratch managed encoder producing standard, decoder-valid
// newLZ chunks accepted by the PS5 Kraken decompressor (the compressor
// -decompress is the acceptance check). No bytes are copied from any third-party encoder source — only
// the published format is generated and validated byte-exact against the output. GPLv3.
//
// A PFS block (up to blockSize, default 256 KiB) is encoded as ONE or TWO headerless newLZ chunks,
// because a single newLZ chunk decodes at most 128 KiB (0x20000). blockSize 0x40000 is therefore
// exactly two chunks. The block-boundary byte describes each half independently: bits 0x02/0x20
// select newLZ and 0x01/0x10 select sub/delta literals for the first/second half. A half for which
// compression is not beneficial is stored directly while the other half may remain newLZ. The size
// hint stores the first half's physical size, exactly as the frame rebuilder expects when it splits
// the block back into per-chunk OodleLZ frames.
//
// CHUNK FORMAT ("excess mode", post-seed control byte high bit set):
//
// first chunk:[8-byte raw seed][ctrl][lit raw][cmd raw][offs raw][litlen raw][dual bitstream][excess]
// second chunk:[ctrl][lit raw][cmd raw][offs raw][litlen raw][dual bitstream][excess]
//
// * seed = the first 8 bytes of the first chunk (COPY_64); decoding starts at dst+8. The second
// chunk has NO seed — it is decoded at a non-zero output offset and its matches may
// reference back into the first chunk's already-decoded output.
// * ctrl byte = 0x80 | (excessByteCount & 0x3F), with a continuation byte when the low six bits would
// * exceed 0x1F. excessByteCount is the length of the trailing excess sub-stream that carries
// * the literal-length escape values (0 when no literal run exceeds 257).
// * 4 raw arrays, each a DecodeBytes chunk-type-0 raw block: a 3-byte big-endian length header (high
// bit clear, len <= 0x3FFFF) followed by that many raw bytes. Order: lit, cmd, packed_offs,
// packed_litlen.
// * dual bitstream = forward bytes ++ reverse(backward bytes); carries ONLY the offset extra (E) bits,
// alternating new-offset #0 -> forward, #1 -> backward, #2 -> forward,...
// * excess sub-stream (only when excessByteCount > 0) = the chunk's trailing excessByteCount bytes:
// a forward writer (even-index literal-length escapes) ++ reverse(backward writer, odd-index escapes),
// each value written with WriteLength; the decoder's ea/eb readers consume them in the same order.
//
// Command byte f: litfield = f & 3 (== 3 -> packed_litlen carries litlen-3); matchfield = (f >> 2) & 0xF
// (<= 14 -> inline matchlen = matchfield + 2; == 15 -> packed_litlen carries matchlen-17);
// offs_index = f >> 6 (== 3 -> new offset taken from packed_offs + E bits).
//
// CONSTRAINTS THAT MAKE A CHUNK DECODER-VALID (validated byte-exact through the actual decoder):
// 1. Every chunk MUST end with a literal tail; a match may never cover the final 8 bytes of a chunk.
// 2. Minimum new-offset distance is 8 (recent offsets initialise to -8; 1..7 are not encodable).
// 3. matchlen is capped at 271 (split into consecutive same-distance pieces) so packed_litlen never
// needs a match-length escape. A literal run longer than 257 is encoded as follows: packed_litlen stores a
// 255 marker and the (litlen-258) value is emitted into the trailing excess sub-stream. At most 512
// escapes per chunk (the decoder's u32 length-stream cap), else the block is stored raw.
// ---------------------------------------------------------------------------------------------------
#nullable enable
using System;
using System.Collections.Generic;
using System.Text;

namespace LibProsperoPkg.PFS.Compression.Oodle;

/// <summary>
/// The result of compressing one PFS block: the section-7 payload plus the metadata the boundary
/// table needs (whether the block was split into two chunks, and the first chunk's compressed size).
/// </summary>
internal readonly struct EncodedBlock
{
    /// <summary>The bytes that land in section 7 for this block (one or two concatenated chunks).</summary>
    public readonly byte[] Payload;

    /// <summary>True when the block has two independently encoded 128-KiB halves.</summary>
    public readonly bool MultiChunk;

    /// <summary>The compressed size of the first chunk (the value stored, minus one, in the size hint).</summary>
    public readonly int FirstChunkCompSize;

    /// <summary>The authoritative PFSC boundary flag byte for both halves.</summary>
    public readonly int BoundaryFlags;

    /// <summary>The corresponding NAPS mode for the even half.</summary>
    public byte NapsEvenMode =>
        (byte)(1
            | ((BoundaryFlags & 0x02) != 0 ? 4 : 0)
            | ((BoundaryFlags & 0x01) != 0 ? 2 : 0));

    /// <summary>The corresponding NAPS mode for the odd half, or zero when absent.</summary>
    public byte NapsOddMode => !MultiChunk
        ? (byte)0
        : (byte)(((BoundaryFlags & 0x20) != 0 ? 4 : 1)
            | ((BoundaryFlags & 0x10) != 0 ? 2 : 0));

    public EncodedBlock(
        byte[] payload,
        bool multiChunk,
        int firstChunkCompSize,
        int boundaryFlags)
    {
        Payload = payload;
        MultiChunk = multiChunk;
        FirstChunkCompSize = firstChunkCompSize;
        BoundaryFlags = boundaryFlags;
    }
}

/// <summary>
/// Managed Kraken (newLZ) encoder. Compresses a PFS block into one or two headerless newLZ "excess
/// mode" chunks that round-trip through the PS5 block decompressor.
/// <para>
/// <b>Length escapes.</b> A literal run longer than 257 bytes (packed value <c>litLen-3 &gt;= 255</c>) and
/// a match longer than <see cref="MaxMatch"/> (packed value <c>matchLen-17 &gt;= 255</c>) are carried by a
/// 0xFF packed_litlen marker plus a u32 escape value. Every escape in a chunk is collected in packed_litlen
/// order and written into a trailing excess sub-stream, split even index -&gt; forward writer / odd index
/// -&gt; backward writer and laid out <c>forward ++ reverse(backward)</c>, mirroring the paired readers the
/// decoder uses. The post-seed control byte is <c>0x80 | low6(excessByteCount)</c> with a continuation byte
/// when the count exceeds 0x1F. Over-long matches are split into &lt;= <see cref="MaxMatch"/> pieces so in
/// practice only literal runs escape; a chunk needing more than <see cref="MaxEscapes"/> escapes falls back
/// to the stored path.
/// </para>
/// <para>
/// <b>No match may start in the last <see cref="NoMatchZone"/> (16) bytes of a chunk.</b> The newLZ release
/// parse loop enforces <c>match_zone_end - to_ptr &gt;= lrl</c> where <c>match_zone_end = chunk_end - 16</c>:
/// the literal-run end (= match start) must be &lt;= chunk_end - 16. A match that starts later drifts the
/// decode pointer and the block is rejected with error -1007. The parser therefore stops emitting matches
/// past <c>chunkEnd - NoMatchZone</c> and flushes the remainder as the trailing literal run; a store-raw
/// safety net rejects any chunk that would still violate it.
/// </para>
/// Returns null when compression is not worthwhile (caller stores the block).
/// </summary>
internal static class OodleKrakenEncoder
{
    private const int ChunkMax = 0x20000;       // a single newLZ chunk decodes at most 128 KiB
    private const int MinChunk = 64;            // below this, storing raw is never worse
    private const int MinMatch = 4;
    private const int MinRepMatch = 2;          // a repeat-offset match costs no offset, so length 2 can pay
    private const int MinDistance = 8;          // recent-offset init is -8; shorter distances are illegal
    private const int LiteralTail = 8;          // a match may extend to chunkEnd-8, so >=8 trailing literals remain
    private const int NoMatchZone = 16;         // the reference newLZ:a match may not START in the last 16 bytes of a chunk (match_zone_end = chunkEnd-16)
    private const int MaxMatch = 271;           // split path caps matchlen-17 <= 254 (packed_litlen < 255); a lone over-long match instead uses the single match-length escape
    private const int MaxArrayLength = 0x3FFFF; // DecodeBytes raw 3-byte size limit
    private const int MaxFirstChunkComp = 0x1FFFF; // size hint is 17-bit; first chunk must fit
    private const int MaxChainWalk = 128;
    [ThreadStatic] private static int ActiveCompressionLevel;
    [ThreadStatic] private static bool HasActiveCompressionLevel;

    // Fast negative levels deliberately inspect fewer hash-chain candidates. Levels 4..9 use
    // the full managed matcher. This makes the public level an actual speed/ratio control rather
    // than merely a byte copied into the PFSC header.
    private static int ChainWalkLimit => !HasActiveCompressionLevel ? MaxChainWalk : ActiveCompressionLevel switch
    {
        <= -4 => 4,
        -3 => 8,
        -2 => 16,
        -1 => 32,
        0 => 48,
        1 => 64,
        2 => 80,
        3 => 96,
        _ => MaxChainWalk,
    };
    private const int HashBits = 17;
    private const int HashSize = 1 << HashBits;
    private const byte CtrlExcessMode = 0x80;   // post-seed control byte:0x80 | low6(excessCount), plus a continuation byte when excessCount > 0x1F
    private const int MaxEscapes = 512;         // the decoder caps u32_len_stream_size (the count of length escapes) at 512

    private readonly struct Command
    {
        public readonly int LitStart;
        public readonly int LitLen;
        public readonly int Distance;
        public readonly int MatchLen;
        public readonly int OffsIndex; // 0/1/2 = reuse a recent offset (no offset emitted); 3 = new offset

        public Command(int litStart, int litLen, int distance, int matchLen, int offsIndex)
        {
            LitStart = litStart;
            LitLen = litLen;
            Distance = distance;
            MatchLen = matchLen;
            OffsIndex = offsIndex;
        }
    }

    /// <summary>
    /// Compresses <paramref name="data"/> (one PFS block) into a section-7 payload of one or two
    /// newLZ chunks, or returns null if the data is too small or does not compress below its original
    /// size.
    /// </summary>
    public static EncodedBlock? EncodeBlock(ReadOnlySpan<byte> data) => EncodeBlock(data, useHuffmanArrays: false);

    /// <summary>
    /// Compresses a block using a Kraken level in the supported -4..9 range. Negative fast
    /// levels reduce match-search effort and skip Huffman arrays; non-negative levels retain
    /// entropy coding when requested.
    /// </summary>
    public static EncodedBlock? EncodeBlock(
        ReadOnlySpan<byte> data,
        bool useHuffmanArrays,
        int compressionLevel)
        => EncodeBlock(
            data,
            useHuffmanArrays,
            compressionLevel,
            allowSubLiterals: true,
            allowStoredHalves: true);

    /// <summary>
    /// Compresses a block with explicit control over publisher half-block modes.
    /// </summary>
    public static EncodedBlock? EncodeBlock(
        ReadOnlySpan<byte> data,
        bool useHuffmanArrays,
        int compressionLevel,
        bool allowSubLiterals,
        bool allowStoredHalves)
    {
        if (compressionLevel is < -4 or > 9)
            throw new ArgumentOutOfRangeException(nameof(compressionLevel));
        int savedLevel = ActiveCompressionLevel;
        bool savedHasLevel = HasActiveCompressionLevel;
        ActiveCompressionLevel = compressionLevel;
        HasActiveCompressionLevel = true;
        try
        {
            return EncodeBlockCore(
                data,
                useHuffmanArrays && compressionLevel >= 0,
                allowSubLiterals,
                allowStoredHalves);
        }
        finally
        {
            ActiveCompressionLevel = savedLevel;
            HasActiveCompressionLevel = savedHasLevel;
        }
    }

    private readonly record struct EncodedChunk(byte[] Payload, int LiteralMode);

    /// <summary>
    /// Compresses <paramref name="data"/> (one PFS block) into a section-7 payload of one or two
    /// newLZ chunks, or returns null if the data is too small or does not compress below its original
    /// size. When <paramref name="useHuffmanArrays"/> is true
    /// the literal/command/length arrays are Huffman-coded (entropy chunk type 2) via
    /// <see cref="KrakenHuffmanArrayEncoder"/> when that is smaller than the raw form, shrinking actual
    /// blocks toward the sizes. The packed-offset array is always left raw because the offset
    /// reader inspects its first byte (the 0x80 bit selects two-table mode), which an entropy header
    /// would corrupt.
    /// </summary>
    public static EncodedBlock? EncodeBlock(
        ReadOnlySpan<byte> data,
        bool useHuffmanArrays)
        => EncodeBlockCore(
            data,
            useHuffmanArrays,
            allowSubLiterals: true,
            allowStoredHalves: true);

    private static EncodedBlock? EncodeBlockCore(
        ReadOnlySpan<byte> data,
        bool useHuffmanArrays,
        bool allowSubLiterals,
        bool allowStoredHalves)
    {
        int n = data.Length;
        if (n < MinChunk)
            return null; // not worth it; caller stores raw

        var head = new int[HashSize];
        var prev = new int[n];
        head.AsSpan().Fill(-1);

        if (n <= ChunkMax)
        {
            EncodedChunk? single = EncodeChunk(
                data, head, prev, 0, n, withSeed: true, useHuffmanArrays,
                allowSubLiterals, allowOptimal: true);
            if (single is not EncodedChunk encoded || encoded.Payload.Length >= n)
                return null;
            int flags = 0x04 | 0x02 | (encoded.LiteralMode == 0 ? 0x01 : 0);
            return new EncodedBlock(
                encoded.Payload,
                multiChunk: false,
                encoded.Payload.Length,
                flags);
        }

        // blockSize is at most 0x40000 (two chunks). A larger block cannot be described by the single
        // first-chunk size hint, so leave it to the stored path.
        if (n > 2 * ChunkMax)
            return null;

        EncodedChunk? chunk0 = EncodeChunk(
            data, head, prev, 0, ChunkMax, withSeed: true, useHuffmanArrays,
            allowSubLiterals);
        int chunk1PlainSize = n - ChunkMax;
        EncodedChunk? chunk1 = EncodeChunk(
            data, head, prev, ChunkMax, n, withSeed: false, useHuffmanArrays,
            allowSubLiterals);
        bool compressed0 = chunk0 is EncodedChunk c0
            && c0.Payload.Length <= MaxFirstChunkComp
            && c0.Payload.Length < ChunkMax;
        bool compressed1 = chunk1 is EncodedChunk c1
            && c1.Payload.Length < chunk1PlainSize;
        if (!allowStoredHalves && (!compressed0 || !compressed1))
            return null;

        if (!compressed0 && !compressed1)
            return null;

        byte[] first = compressed0
            ? chunk0!.Value.Payload
            : data[..ChunkMax].ToArray();
        byte[] second = compressed1
            ? chunk1!.Value.Payload
            : data[ChunkMax..].ToArray();
        var payload = new byte[first.Length + second.Length];
        Buffer.BlockCopy(first, 0, payload, 0, first.Length);
        Buffer.BlockCopy(second, 0, payload, first.Length, second.Length);
        if (payload.Length >= n)
            return null;

        int boundaryFlags = 0x04;
        if (compressed0)
        {
            boundaryFlags |= 0x02;
            if (chunk0!.Value.LiteralMode == 0)
                boundaryFlags |= 0x01;
        }
        if (compressed1)
        {
            boundaryFlags |= 0x20;
            if (chunk1!.Value.LiteralMode == 0)
                boundaryFlags |= 0x10;
        }
        return new EncodedBlock(
            payload,
            multiChunk: true,
            first.Length,
            boundaryFlags);
    }

    /// <summary>
    /// Encodes the output range [<paramref name="chunkStart"/>, <paramref name="chunkEnd"/>) of
    /// <paramref name="data"/> as one newLZ chunk. The shared <paramref name="head"/>/<paramref name="prev"/>
    /// hash chain lets a later chunk reference matches in an earlier one. When
    /// <paramref name="withSeed"/> is false the chunk omits the 8-byte COPY_64 seed (used for any
    /// chunk decoded at a non-zero output offset).
    /// </summary>
    private static EncodedChunk? EncodeChunk(
        ReadOnlySpan<byte> data,
        int[] head,
        int[] prev,
        int chunkStart,
        int chunkEnd,
        bool withSeed,
        bool useHuffmanArrays,
        bool allowSubLiterals,
        bool allowOptimal = false)
    {
        int matchLimit = chunkEnd - LiteralTail; // a match may EXTEND up to here, so >= LiteralTail trailing literals remain
        // The newLZ decoder forbids a match from STARTING in the last 16 bytes of a chunk. Its release
        // parse loop (the algorithm) enforces `match_zone_end - to_ptr >= lrl` with
        // match_zone_end = chunk_end - 16: the match start
        // (= literal-run end) must be <= chunk_end - 16. A match that starts later drifts the decode
        // pointer and the block is rejected with SCE_COMPRESSION_ERROR_DECOMPRESSION_FAILED (-1007), even
        // though our own (lenient) decoder round-trips it. So the last legal match-start is chunkEnd-NoMatchZone.
        int matchStartLimit = chunkEnd - NoMatchZone;
        int firstMatchPos = withSeed ? chunkStart + 8 : chunkStart; // seed is the first 8 bytes
        // The seed bytes are valid copy sources (the decoder emits them before the first command), so
        // index them in the hash chain. Without this the parser cannot find a match that references the
        // first 8 bytes of a seeded chunk and the first match is delayed by up to 8 literals, which is
        // exactly how the parses a periodic block (e.g. a distance-16 match at position 16 referencing
        // position 0). The seedless second chunk needs nothing here — its predecessors are already indexed.
        if (withSeed)
        {
            for (int p = chunkStart; p < firstMatchPos; p++)
                Insert(data, p, head, prev);
        }
        // Literals before the first match begin where matching begins (the seed is emitted separately).
        // Production byte-identity: a single-chunk block (allowOptimal) has no cross-chunk backward
        // dependency, so it is parsed with the Optimal3 multi-candidate selection — greedy
        // mml=4/3/8 plus one seeded forward-DP, choosing the candidate with the smallest real
        // entropy-coded emit size, exactly as the encoder does. Where a greedy candidate wins
        // this reproduces the block byte-for-byte, and it never enlarges the block (the plain
        // greedy is always one of the candidates). The forward-DP needs mml=3 (UseDpMml3) to surface the
        // reference length-3 matches. Multi-chunk blocks stay on the shared-chain greedy so the seedless
        // second chunk can still reference the first.
        //
        // The matcher is a bounded suffix-trie; this managed DP is O(n^2) in the block length,
        // so the optimal parse is limited to genuinely small standalone blocks (ProductionOptimalMaxBlock)
        // — the small config/text system files the itself stores as per-file standalone blocks —
        // keeping build times fast. Larger single-chunk blocks fall back to the linear greedy parse.
        bool optimal = UseOptimalParse
            || (allowOptimal && ProductionOptimalSingleChunk && (chunkEnd - chunkStart) <= ProductionOptimalMaxBlock);
        List<Command> commands;
        if (optimal)
        {
            bool savedMml3 = UseDpMml3;
            UseDpMml3 = true;
            try
            {
                commands = ParseOptimal(data, head, prev, firstMatchPos, firstMatchPos, matchLimit, matchStartLimit,
                    chunkStart, chunkEnd, withSeed, useHuffmanArrays);
            }
            finally { UseDpMml3 = savedMml3; }
        }
        else
        {
            commands = Parse(data, head, prev, firstMatchPos, firstMatchPos, matchLimit, matchStartLimit);
        }
        if (commands.Count == 0)
            return null;

        int literalMode = allowSubLiterals
            ? LitModeForParse(data, commands, chunkEnd, useHuffmanArrays)
            : 1;
        byte[]? payload = EmitChunkFromCommands(
            data,
            commands,
            chunkStart,
            chunkEnd,
            withSeed,
            useHuffmanArrays,
            literalMode);
        return payload is null ? null : new EncodedChunk(payload, literalMode);
    }

    /// <summary>
    /// Builds the newLZ stream arrays from an already-computed parse and assembles the chunk bytes
    /// (entropy-coding the lit/cmd/length arrays when beneficial). Factored out of <see cref="EncodeChunk"/>
    /// so a diagnostic can measure the actual entropy-coded emit size of an externally supplied parse
    /// (the vs the DP's) — the metric the level-7 producer actually minimises in its final
    /// greedy-vs-DP selection (actual-emit-size pick). Returns null when the parse needs a store-raw
    /// fallback (a literal run over MaxLitRun or a match starting inside the no-match zone).
    /// </summary>
    private static byte[]? EmitChunkFromCommands(ReadOnlySpan<byte> data, List<Command> commands,
        int chunkStart, int chunkEnd, bool withSeed, bool useHuffmanArrays, int litMode = 1)
    {
        int matchStartLimit = chunkEnd - NoMatchZone;
        // Store-raw safety net: a match may not start inside the no-match zone (the last 16 bytes of the
        // chunk). The parser already enforces this, so in practice this never triggers.
        foreach (var cmd in commands)
        {
            if (cmd.MatchLen > 0 && cmd.LitStart + cmd.LitLen > matchStartLimit)
                return null;
        }

        var litRaw = new List<byte>(chunkEnd - chunkStart); // mode 1:raw literals
        var litSub = new List<byte>(chunkEnd - chunkStart); // mode 0:sub/delta literals (byte - dst[p+lastOffset])
        BuildLiteralStreams(data, commands, chunkEnd, litRaw, litSub);
        var cmdStream = new List<byte>();
        var packedOffs = new List<byte>();
        var packedLitLen = new List<byte>();
        var forward = new KrakenBitWriter();
        var backward = new KrakenBitWriter();
        // Length-escape u32 values (one per 0xFF packed_litlen marker), collected in packed_litlen order.
        // They are written into the trailing excess sub-stream after the main streams are assembled.
        var escapeValues = new List<uint>();

        // Local helper: append a length's packed value to packed_litlen, escaping when it reaches 255.
        // A literal run longer than 257 bytes (packed value litLen-3 >= 255) escapes; matches are split
        // into <= MaxMatch pieces below, so their packed length (piece-17 <= 254) never escapes.
        void EmitLen(int packedValue)
        {
            if (packedValue < 255)
            {
                packedLitLen.Add((byte)packedValue);
            }
            else
            {
                packedLitLen.Add(255);                        // u32 length-escape marker
                escapeValues.Add((uint)(packedValue - 255));  // decoder: length value = u32 + 255
            }
        }

        int offsetIndex = 0;
        foreach (var c in commands)
        {
            // Literal streams (litRaw/litSub) were built up-front by BuildLiteralStreams; this loop only
            // assembles the command/offset/length streams. The encoder emits exactly ONE command
            // per parse command regardless of match length: a match longer than 16 sets matchField=15 and
            // transmits (matchLen-17) through the shared length stream, escaping to the trailing excess
            // sub-stream when the packed value reaches 255 (matchLen >= 272). A trailing command with
            // MatchLen==0 (the final literal run) contributes no command byte -- the decoder copies its
            // literals in the tail loop. Splitting an over-long match into rep0 continuation pieces would
            // still round-trip through our lenient decoder, but it is NOT what the emits, so the
            // block bytes would differ (extra command bytes, no escape) -- hence one command, one escape.
            if (c.MatchLen == 0)
                continue;

            int curLit = c.LitLen;
            int litField = curLit >= 3 ? 3 : curLit;
            int matchField = c.MatchLen <= 16 ? c.MatchLen - 2 : 15;
            cmdStream.Add((byte)((c.OffsIndex << 6) | (matchField << 2) | litField));

            if (litField == 3)
                EmitLen(curLit - 3);

            if (c.OffsIndex == 3)
            {
                // Only a new offset is transmitted: one packed_offs byte plus its E bits in the dual
                // bitstream, alternating forward/backward per new offset. Recent-offset reuse
                // (index 0/1/2) writes nothing here.
                byte v = (offsetIndex & 1) == 0
                    ? forward.WriteDistance(c.Distance)
                    : backward.WriteDistance(c.Distance);
                packedOffs.Add(v);
                offsetIndex++;
            }

            if (matchField == 15)
                EmitLen(c.MatchLen - 17);
        }

        if (escapeValues.Count > MaxEscapes)
            return null; // more length escapes than the decoder accepts; store raw instead

        // Both literal models hold the same number of literals; the array-length guard is mode-independent.
        if (litRaw.Count > MaxArrayLength || cmdStream.Count > MaxArrayLength ||
            packedOffs.Count > MaxArrayLength || packedLitLen.Count > MaxArrayLength)
        {
            return null; // arrays too large for the raw 3-byte header; store raw instead
        }

        // Literal model selection (newLZ "sub" vs "raw"): the only chunk array that depends on the
        // model. The encoder keeps whichever
        // yields the smaller entropy-coded literal array; litMode forces it (0 = sub, 1 = raw) for
        // diagnostics, -1 = auto (ChooseLitMode = the validated decision).
        List<byte> lit;
        if (litMode == 0) lit = litSub;
        else if (litMode == 1) lit = litRaw;
        else lit = ChooseLitMode(litRaw, litSub, useHuffmanArrays) == 0 ? litSub : litRaw;

        byte[] forwardBytes = forward.ToBytes();
        byte[] backwardBytes = backward.ToBytes();

        var outBuf = new List<byte>(chunkEnd - chunkStart);
        if (withSeed)
        {
            for (int i = 0; i < 8; i++)
                outBuf.Add(data[chunkStart + i]); // seed
        }
        // Trailing excess sub-stream = the length-escape u32 values, split even index -> forward writer,
        // odd index -> backward writer, then laid out forward ++ reverse(backward) exactly like the main
        // bitstream so the decoder's paired readers meet.
        var excessF = new KrakenBitWriter();
        var excessB = new KrakenBitWriter();
        for (int i = 0; i < escapeValues.Count; i++)
        {
            if ((i & 1) == 0) excessF.WriteLength(escapeValues[i]);
            else excessB.WriteLength(escapeValues[i]);
        }
        byte[] excessFwd = excessF.ToBytes();
        byte[] excessBwd = excessB.ToBytes();
        int excessCount = excessFwd.Length + excessBwd.Length;
        if (excessCount > 0x1FFF)
            return null; // continuation byte cannot encode this many excess bytes; store raw instead

        // Post-seed control byte: 0x80 | low6(excessCount). When excessCount > 0x1F a continuation byte
        // carries the high bits: low6 = 0x20 | (excessCount & 0x1F), continuation = (excessCount >> 5) - 1
        // (decoder: excessCount = low6 + continuation * 0x20).
        if (excessCount <= 0x1F)
        {
            outBuf.Add((byte)(CtrlExcessMode | excessCount));
        }
        else
        {
            outBuf.Add((byte)(CtrlExcessMode | 0x20 | (excessCount & 0x1F)));
            outBuf.Add((byte)((excessCount >> 5) - 1));
        }
        WriteArray(outBuf, lit, useHuffmanArrays);
        WriteArray(outBuf, cmdStream, useHuffmanArrays);
        // packed_offs: the Huffman-codes this array when beneficial (single-table offset mode).
        // The offset-mode reader inspects this array's first byte for bit 0x80 (set = two-table scaling
        // byte). KrakenHuffmanArrayEncoder always emits the 5-byte long-form entropy header whose first
        // byte is (chunkType<<4)|... = 0x20..0x2F for chunkType 2 (bit 0x80 CLEAR), and a raw array's
        // first byte is (len>>16) <= 3 (also clear), so either form stays in single-table mode -- exactly
        // how the encodes it. (A previous validity-only version forced this raw; the Huffman
        // form is what makes real text/data offset arrays byte-identical to the reference.)
        WriteArray(outBuf, packedOffs, useHuffmanArrays);
        WriteArray(outBuf, packedLitLen, useHuffmanArrays);
        // main dual bitstream region = forward ++ reverse(backward)
        outBuf.AddRange(forwardBytes);
        for (int i = backwardBytes.Length - 1; i >= 0; i--)
            outBuf.Add(backwardBytes[i]);
        // trailing excess sub-stream = forward ++ reverse(backward)
        outBuf.AddRange(excessFwd);
        for (int i = excessBwd.Length - 1; i >= 0; i--)
            outBuf.Add(excessBwd[i]);

        return outBuf.ToArray();
    }

    private static void WriteRawArray(List<byte> outBuf, List<byte> array)
    {
        int len = array.Count;
        outBuf.Add((byte)((len >> 16) & 0xFF)); // high bit clear (len <= 0x3FFFF), chunk type 0
        outBuf.Add((byte)((len >> 8) & 0xFF));
        outBuf.Add((byte)(len & 0xFF));
        outBuf.AddRange(array);
    }

    /// <summary>
    /// Returns the byte length the array writer would emit for a candidate byte stream (the
    /// smaller of the raw 3-byte-header form and the Huffman form), without writing. Used to pick the
    /// cheaper literal model (sub vs raw) the way the array coder does.
    /// </summary>
    // Builds the raw and sub (delta) literal byte streams for a parse. subLastOffset tracks r0 (the
    // active offset for the current run's literals): init -8, updated to -Distance after each match.
    // The decoder applies the old lastOffset to a command's literals and only updates it after them
    // (ProcessLzRunsType0), so literals use the PREVIOUS command's offset; the trailing run after the
    // final match uses the last chosen offset. Shared by EmitChunkFromCommands and ChooseLitMode so
    // the litMode decision scores exactly the bytes the emit would write.
    private static void BuildLiteralStreams(ReadOnlySpan<byte> data, List<Command> commands,
        int chunkEnd, List<byte> litRaw, List<byte> litSub)
    {
        int subLastOffset = -8;
        foreach (var c in commands)
        {
            for (int i = 0; i < c.LitLen; i++)
            {
                int p = c.LitStart + i;
                litRaw.Add(data[p]);
                litSub.Add((byte)(data[p] - data[p + subLastOffset]));
            }
            if (c.MatchLen > 0)
                subLastOffset = -c.Distance;
        }
        var last = commands[^1];
        int tailStart = last.LitStart + last.LitLen + last.MatchLen;
        for (int i = tailStart; i < chunkEnd; i++)
        {
            litRaw.Add(data[i]);
            litSub.Add((byte)(data[i] - data[i + subLastOffset]));
        }
    }

    // validated against array-output stage at optimal level 7:
    // The literal-mode decision chooses sub vs raw.
    // * literal_count < 32 -> raw (1).
    // * else encode BOTH literal arrays for actual (array histogram encoder / our M2 array calc) and keep
    // the cheaper. Sub is evaluated first against the running budget; raw replaces it only when
    // STRICTLY cheaper (put_array_histo's budget ceiling is the incumbent sub cost), so sub wins
    // ties. Level 7 (`5 < level`) skips the level<=5 entropy-estimate pre-pick and compares the
    // actual encoded sizes directly. (The lambda space-speed term is 0 for a pure -lvl 7 ratio run.)
    // Returns 0 = sub, 1 = raw.
    internal static int ChooseLitMode(List<byte> litRaw, List<byte> litSub, bool useHuffmanArrays)
    {
        if (litSub.Count < 32) return 1; // raw: too few literals to entropy-code a sub stream
        int subSize = EncodedArraySize(litSub, useHuffmanArrays);
        int rawSize = EncodedArraySize(litRaw, useHuffmanArrays);
        return rawSize < subSize ? 1 : 0; // sub on tie (raw needs a strict win)
    }

    // Convenience overload: choose the litMode a parse would emit (used to seed the DP cost build with
    // the greedy/seed parse's litMode, mirroring the where the winning greedy's choice becomes
    // codecosts[0]).
    private static int LitModeForParse(ReadOnlySpan<byte> data, List<Command> commands,
        int chunkEnd, bool useHuffmanArrays)
    {
        if (commands.Count == 0) return 1;
        var litRaw = new List<byte>(chunkEnd);
        var litSub = new List<byte>(chunkEnd);
        BuildLiteralStreams(data, commands, chunkEnd, litRaw, litSub);
        return ChooseLitMode(litRaw, litSub, useHuffmanArrays);
    }

    private static int EncodedArraySize(List<byte> array, bool useHuffman)
    {
        int raw = array.Count + 3;
        if (useHuffman && array.Count >= 2)
        {
            byte[]? huff = KrakenHuffmanArrayEncoder.TryEncode(
                System.Runtime.InteropServices.CollectionsMarshal.AsSpan(array));
            if (huff is not null && huff.Length < raw)
                return huff.Length;
        }
        return raw;
    }

    /// <summary>
    /// Writes <paramref name="array"/> as an entropy (Huffman) array when <paramref name="useHuffman"/>
    /// is set and the Huffman form is strictly smaller than the raw form; otherwise writes it raw.
    /// The literal/command/length streams are read by the decoder via plain <c>DecodeBytes</c>, so a
    /// type-2 entropy array is transparently accepted in their place.
    /// </summary>
    private static void WriteArray(List<byte> outBuf, List<byte> array, bool useHuffman)
    {
        if (useHuffman && array.Count >= 2)
        {
            byte[]? huff = KrakenHuffmanArrayEncoder.TryEncode(
                System.Runtime.InteropServices.CollectionsMarshal.AsSpan(array));
            if (huff is not null && huff.Length < array.Count + 3) // 3 = raw header length
            {
                outBuf.AddRange(huff);
                return;
            }
        }
        WriteRawArray(outBuf, array);
    }

    /// <summary>
    /// Diagnostic only: measure the actual entropy-coded emit size, in bytes, of an
    /// externally supplied full-chunk parse (e.g. the captured command list vs the DP's command
    /// list) under the actual newLZ back-end (the same stream-build + array entropy-coder the shipping
    /// encoder uses). This is the metric the level-7 producer minimises when it picks the final
    /// parse (greedy-vs-DP actual-emit-size selection), so it is
    /// the authoritative arbiter for why the emits an integer-"costlier" near-offset rep0 cascade.
    /// The parse is the seeded first chunk (firstMatchPos = 8). litStart is reconstructed by walking.
    /// Returns the encoded byte length, or -1 when the parse falls back to store-raw.
    /// </summary>
    internal static int DiagRealEmitSize(byte[] data, int[] litLen, int[] dist, int[] match, int[] idx,
        bool useHuffmanArrays = true, int litMode = 1)
    {
        var commands = new List<Command>(litLen.Length);
        int pos = 8; // withSeed chunk: the 8-byte COPY_64 seed precedes the first command
        for (int i = 0; i < litLen.Length; i++)
        {
            commands.Add(new Command(pos, litLen[i], dist[i], match[i], idx[i]));
            pos += litLen[i] + match[i];
        }
        byte[]? bytes = EmitChunkFromCommands(data, commands, 0, data.Length, true, useHuffmanArrays, litMode);
        return bytes?.Length ?? -1;
    }

    /// <summary>
    /// Diagnostic only: same as <see cref="DiagRealEmitSize"/> but returns the actual
    /// emitted chunk bytes (seed + ctrl + arrays + dual bitstream) so a diagnostic can byte-compare my
    /// emit of an externally supplied parse against the actual section-7 chunk. Returns null on a
    /// store-raw fallback.
    /// </summary>
    internal static byte[]? DiagEmitChunkBytes(byte[] data, int[] litLen, int[] dist, int[] match, int[] idx,
        bool useHuffmanArrays = true, int litMode = 1)
    {
        var commands = new List<Command>(litLen.Length);
        int pos = 8; // withSeed chunk: the 8-byte COPY_64 seed precedes the first command
        for (int i = 0; i < litLen.Length; i++)
        {
            commands.Add(new Command(pos, litLen[i], dist[i], match[i], idx[i]));
            pos += litLen[i] + match[i];
        }
        return EmitChunkFromCommands(data, commands, 0, data.Length, true, useHuffmanArrays, litMode);
    }

    /// <summary>
    /// Value-model lazy parse over the output range, a faithful managed implementation of the reference
    /// <c>greedy optimal pre-pass</c> (the implementation). Each
    /// candidate match is scored by the exact value function (<see cref="FindMatch"/> /
    /// <c>match value</c>):<c>len*4 - (isRep ? 0 : bitlen(dist)+2)</c> — validated from
    /// <c>algorithm</c> + <c>algorithm</c> (<c>bitlen = 32 - clz</c>). Repeat-offset matches
    /// transmit no offset, so they cost 0 there and are strongly preferred; among new offsets the
    /// finder keeps the highest value and, on a value tie, the SHORTEST distance (the hash chain is
    /// walked most-recent-first, so the nearer offset is seen first and wins the tie). Picking the
    /// nearer offset on ties seeds a reusable recent-offset that subsequent positions re-use as cheap
    /// reps — exactly the rep-reuse cascade the parser produces (e.g. introducing dist=57 then
    /// reusing it for hundreds of commands instead of walking dist=552,553,554...).
    /// <para>
    /// A 2-step lazy look-ahead defers the match start while a later position yields a strictly better
    /// match, using the exact comparator and thresholds: defer by 1 when
    /// <c>value(pos+1) - value(cur) - 4 &gt;= 1</c>, else defer by 2 when
    /// <c>value(pos+2) - value(cur) - 4 &gt;= 4</c>, else emit <c>cur</c> (the <c>+4</c> incumbent bias
    /// and the <c>&lt;1</c>/<c>&lt;4</c> gates are <c>algorithm</c>'s).
    /// </para>
    /// Matches never start past <paramref name="matchStartLimit"/> (the match_zone_end, chunkEnd-16)
    /// nor extend past <paramref name="matchLimit"/> (chunkEnd-8), preserving the trailing literal run.
    /// </summary>
    private static List<Command> Parse(ReadOnlySpan<byte> data, int[] head, int[] prev,
        int startPos, int litStart0, int matchLimit, int matchStartLimit)
    {
        var commands = new List<Command>();

        int litStart = litStart0;
        int pos = startPos;
        // A match may not start past chunkEnd-16 (the match_zone_end). Everything after the last
        // legal match start is emitted as the trailing literal run, which the decoder copies verbatim.
        int maxLast = matchStartLimit;

        // The decoder's three recent offsets (distances), most-recent first, move-to-front. The
        // decoder initialises recent[3..5] = -8, i.e. distance 8.
        int r0 = MinDistance, r1 = MinDistance, r2 = MinDistance;

        // Hash-chain watermark: positions [startPos, inserted) are present in the chain. We insert
        // every position exactly once, in order, as the parse passes it (so a match at p can only
        // reference earlier positions — the decoder is causal).
        int inserted = startPos;

        while (pos <= maxLast)
        {
            inserted = InsertUpTo(data, head, prev, inserted, pos);
            Cand cur = UseExactGreedy
                ? FindMatchExact(data, pos, head, prev, matchLimit, r0, r1, r2, pos - litStart)
                : FindMatch(data, pos, head, prev, matchLimit, r0, r1, r2);
            if (!cur.Valid)
            {
                pos++;
                continue;
            }

            // 2-step lazy look-ahead: defer the match start while a strictly better match appears.
            while (pos + 1 <= maxLast)
            {
                inserted = InsertUpTo(data, head, prev, inserted, pos + 1);
                Cand m1 = UseExactGreedy
                    ? FindMatchExact(data, pos + 1, head, prev, matchLimit, r0, r1, r2, (pos + 1) - litStart)
                    : FindMatch(data, pos + 1, head, prev, matchLimit, r0, r1, r2);
                if (m1.Value - cur.Value - 4 >= 1) // pos+1 strictly better (the reference +4 bias)
                {
                    pos++;
                    cur = m1;
                    continue;
                }
                if (pos + 2 > maxLast)
                    break;
                inserted = InsertUpTo(data, head, prev, inserted, pos + 2);
                Cand m2 = UseExactGreedy
                    ? FindMatchExact(data, pos + 2, head, prev, matchLimit, r0, r1, r2, (pos + 2) - litStart)
                    : FindMatch(data, pos + 2, head, prev, matchLimit, r0, r1, r2);
                if (m2.Value - cur.Value - 4 >= 4) // pos+2 better by the larger threshold
                {
                    pos += 2;
                    cur = m2;
                    continue;
                }
                break;
            }

            commands.Add(new Command(litStart, pos - litStart, cur.Dist, cur.Len, cur.Idx));
            UpdateRecent(ref r0, ref r1, ref r2, cur.Idx, cur.Dist);
            int end = pos + cur.Len;
            inserted = InsertUpTo(data, head, prev, inserted, Math.Min(end, maxLast + 1));
            pos = end;
            litStart = end;
        }

        return commands;
    }

    /// <summary>Bit length of <paramref name="v"/> (the <c>algorithm</c>:<c>32 - clz</c>).</summary>
    private static int BitLen(uint v) =>
        v == 0 ? 0 : 32 - System.Numerics.BitOperations.LeadingZeroCount(v);

    /// <summary>
    /// A candidate match. <see cref="Idx"/> 0/1/2 = repeat-offset reuse (no offset transmitted),
    /// 3 = new offset, -1 = none. <see cref="Value"/> is the match value model
    /// (<c>algorithm</c>):<c>len*4 - (isRep ? 0 : bitlen(dist)+2)</c>. A none candidate scores a
    /// large negative value so it never wins a comparison.
    /// </summary>
    private readonly struct Cand
    {
        public readonly int Len;
        public readonly int Dist;
        public readonly int Idx;
        public Cand(int len, int dist, int idx) { Len = len; Dist = dist; Idx = idx; }
        public bool Valid => Idx >= 0;
        public int Value => Idx < 0 ? -0x40000000 : Len * 4 - (Idx < 3 ? 0 : BitLen((uint)Dist) + 2);
    }

    /// <summary>
    /// the per-position match finder (<c>algorithm</c>, value model):returns the highest-value
    /// match at <paramref name="pos"/> given the three recent offsets, preferring a repeat-offset reuse
    /// on ties (its offset is free) and otherwise the shortest-distance new offset on a value tie.
    /// </summary>
    private static Cand FindMatch(ReadOnlySpan<byte> data, int pos, int[] head, int[] prev,
        int matchLimit, int r0, int r1, int r2)
    {
        // Repeat-offset candidate: longest reuse among the three recent distances (value = len*4).
        int repLen0 = RepMatchLength(data, pos, r0, matchLimit);
        int repLen1 = RepMatchLength(data, pos, r1, matchLimit);
        int repLen2 = RepMatchLength(data, pos, r2, matchLimit);
        int bestRepLen = repLen0, bestRepIdx = 0;
        if (repLen1 > bestRepLen) { bestRepLen = repLen1; bestRepIdx = 1; }
        if (repLen2 > bestRepLen) { bestRepLen = repLen2; bestRepIdx = 2; }

        // New-offset candidate via the shared hash chain, scored by value (shortest distance wins ties
        // because the chain is walked most-recent-first and we keep the first strictly-greater value).
        int effMml = GreedyMmlOverride > 0 ? GreedyMmlOverride : MinMatch;
        int bestNewLen = 0, bestNewDist = 0, bestNewValue = -0x40000000;
        uint h = Hash(data, pos);
        int cand = head[h];
        int walk = 0;
        while (cand >= 0 && walk < ChainWalkLimit)
        {
            int dist = pos - cand;
            if (dist >= MinDistance)
            {
                int len = MatchLength(data, cand, pos, matchLimit);
                if (len >= effMml)
                {
                    int val = len * 4 - (BitLen((uint)dist) + 2);
                    if (val > bestNewValue)
                    {
                        bestNewValue = val;
                        bestNewLen = len;
                        bestNewDist = dist;
                    }
                }
            }
            cand = prev[cand];
            walk++;
        }

        bool repViable = bestRepLen >= MinRepMatch;
        bool newViable = bestNewLen >= effMml;
        int repValue = repViable ? bestRepLen * 4 : -0x40000000;
        int newValue = newViable ? bestNewValue : -0x40000000;
        if (!repViable && !newViable)
            return new Cand(0, 0, -1);
        // Repeat reuse wins ties (its offset is free and seeds future cheap reps).
        if (repValue >= newValue)
            return new Cand(bestRepLen, bestRepIdx == 0 ? r0 : bestRepIdx == 1 ? r1 : r2, bestRepIdx);
        return new Cand(bestNewLen, bestNewDist, 3);
    }

    // ===========================================================================================
    // BYTE-EXACT GREEDY SELECTOR — implementation of the per-position match heuristic
    // and its decision helpers, validated against
    // the implementation. Replaces the value-model FindMatch when UseExactGreedy is
    // set so Tally(the greedy parse) == Tally(the greedy). The 2-step lazy main loop (Parse) is
    // unchanged — only the per-position selector it calls switches.
    // ===========================================================================================

    // algorithm short-match offset thresholds [ml]: a new match of length ml &lt; 6 is
    // allowed only when off &lt; threshold[ml]. ml is always &gt;= 3 (the asserted minimum).
    private static readonly int[] NormalMatchOffsetThreshold = { 0, 0, 0, 0x4000, 0x20000, 0x100000 };

    /// <summary>
    /// Byte-exact implementation of the per-position selector:
    /// rep search (mml2-quantized via <see cref="RepExtendMml2"/>, algorithm) with an early return on a
    /// length-&gt;=4 rep; otherwise the 4-pair Pareto new-match scan gated by <see cref="IsAllowedNormalMatch"/>
    /// and ranked by <see cref="IsNormalMatchBetter"/>; final rep-vs-new pick
    /// by <see cref="TakeNewOverRep"/>. <paramref name="lrl"/> is the current literal-run
    /// length (pos − litStart):only the rare <c>lrl &gt; 0x37</c> long-run adjustment consumes it.
    /// </summary>
    private static Cand FindMatchExact(ReadOnlySpan<byte> data, int pos, int[] head, int[] prev,
        int matchLimit, int r0, int r1, int r2, int lrl)
    {
        // Rep search over the three recent distances (loi 0,1,2). Strict '<' ⇒ the lowest loi wins ties.
        int rl0 = RepExtendMml2(data, pos, r0, matchLimit);
        int rl1 = RepExtendMml2(data, pos, r1, matchLimit);
        int rl2 = RepExtendMml2(data, pos, r2, matchLimit);
        int bestRepLen = -1, bestRepIdx = -1;
        if (bestRepLen < rl0) { bestRepLen = rl0; bestRepIdx = 0; }
        if (bestRepLen < rl1) { bestRepLen = rl1; bestRepIdx = 1; }
        if (bestRepLen < rl2) { bestRepLen = rl2; bestRepIdx = 2; }

        // A rep of length >= 4 short-circuits: the returns it immediately with no new-match search.
        if (bestRepLen >= 4)
            return new Cand(bestRepLen, bestRepIdx == 0 ? r0 : bestRepIdx == 1 ? r1 : r2, bestRepIdx);

        int mml = GreedyMmlOverride > 0 ? GreedyMmlOverride : MinMatch;
        if (lrl > 0x37)
        {
            if (bestRepLen < 3) bestRepLen = 0; // a short (len-2) rep is dropped after a long literal run
            mml += 1;
        }

        // New-match candidates = the 4-pair Pareto frontier (length-descending), exactly what the reference
        // suffix-trie match finder feeds the selector. NO synthetic off-8 candidate (f9b90 reads
        // only matchTable[0..3]).
        Span<int> cl = stackalloc int[4];
        Span<int> co = stackalloc int[4];
        int np = FindParetoPairs(data, pos, head, prev, matchLimit, cl, co);
        int bestNewLen = 0, bestNewOff = 0;
        for (int i = 0; i < np; i++)
        {
            int ml = cl[i], off = co[i];
            if (ml < mml) break; // length-descending ⇒ every later pair is shorter still
            int useLen = ml, useOff = off;
            if (UseTinyOffsetRemap && off < MinDistance)
            {
                // f9b90: a sub-8 distance is rounded up to a codeable one, the match length is
                // recomputed at the rounded distance, and the candidate is kept only if it still reaches mml.
                int rounded = RoundUpTiny(off);
                if (rounded == 0 || rounded > pos) continue;     // <= absPos (valid backref) else skip
                int rlen = MatchLength(data, pos - rounded, pos, matchLimit);
                if (rlen < mml) continue;                        // <= recomputed len else skip
                useLen = rlen;
                useOff = rounded;
            }
            if (IsAllowedNormalMatch(useLen, useOff) && IsNormalMatchBetter(useLen, useOff, bestNewLen, bestNewOff))
            {
                bestNewLen = useLen;
                bestNewOff = useOff;
            }
        }

        // Final pick: keep the rep unless the new match is clearly longer. When the rep is
        // kept its length is >= 2 (TakeNewOverRep returns false only for repLen >= 2), so bestRepIdx is valid.
        if (!TakeNewOverRep(bestRepLen, bestNewLen, bestNewOff))
            return new Cand(bestRepLen, bestRepIdx == 0 ? r0 : bestRepIdx == 1 ? r1 : r2, bestRepIdx);
        return bestNewLen > 0 ? new Cand(bestNewLen, bestNewOff, 3) : new Cand(0, 0, -1);
    }

    /// <summary>
    /// Reproduces the suffix-trie match output: the per-position Pareto frontier (closest
    /// offset per achievable length), capped to the 4 longest pairs, length-descending. Walks the full-history
    /// 4-byte hash chain most-recent-first (distance ascending) and records (len,dist) only when len exceeds
    /// the running best. This is the same walk <see cref="FindCandidates"/> uses for the DP, minus the
    /// synthetic off-8 append the greedy selector must not see.
    /// </summary>
    private static int FindParetoPairs(ReadOnlySpan<byte> data, int pos, int[] head, int[] prev,
        int matchLimit, Span<int> outLen, Span<int> outDist)
    {
        Span<int> fl = stackalloc int[64];
        Span<int> fd = stackalloc int[64];
        int fn = 0;
        int bestLen = 0;
        int distFloor = UseTinyOffsetRemap ? 1 : MinDistance; // include dist 1..7 so the selector can round them up
        // the suffix-trie matcher (num_firstbytes=2) records the closest match of EVERY achievable length down to
        // its minimum, and a single such table is shared by all three greedy pre-passes (mml 4/3/8). The
        // mml=3 pass therefore sees length-3 NEW matches the mml=4/8 passes filter out. Mirror that by
        // recording down to the pass's effective mml (3 when GreedyMmlOverride==3) rather than the constant
        // MinMatch. Production (GreedyMmlOverride==0) is unchanged: it still gates at MinMatch (4).
        int recordMml = GreedyMmlOverride > 0 ? GreedyMmlOverride : MinMatch;
        uint hs = Hash(data, pos);
        int c = head[hs];
        while (c >= 0)
        {
            int dist = pos - c;
            if (dist >= distFloor)
            {
                int len = MatchLength(data, c, pos, matchLimit);
                if (len > bestLen)
                {
                    bestLen = len;
                    if (len >= recordMml && fn < fl.Length) { fl[fn] = len; fd[fn] = dist; fn++; }
                }
            }
            c = prev[c];
        }
        int keep = fn > 4 ? 4 : fn;
        for (int i = 0; i < keep; i++)
        {
            int idx = fn - 1 - i; // length-ascending walk → take the last 'keep' validated = longest first
            outLen[i] = fl[idx];
            outDist[i] = fd[idx];
        }
        return keep;
    }

    /// <summary>
    /// Rep-match length with the mml2 quantization:0 for fewer than 2 matching leading
    /// bytes, exactly 2 or 3 for a 2- or 3-byte lead, or the full forward length for a 4+-byte lead. The raw
    /// count already yields 2/3/full for those cases; only a raw count of 1 must be clamped to 0 (a rep is
    /// never length 1).
    /// </summary>
    private static int RepExtendMml2(ReadOnlySpan<byte> data, int pos, int dist, int limit)
    {
        int rl = RepMatchLength(data, pos, dist, limit);
        return rl < 2 ? 0 : rl;
    }

    /// <summary>
    /// algorithm (newLZ asymmetric match comparator):is the new (len,off) strictly better than the current
    /// best (len,off)? Longer always wins; equal length prefers the closer offset; one byte longer wins only if
    /// the new offset is within 128× the incumbent; two-or-more longer always wins. The first candidate
    /// (best = 0) is always accepted since any candidate length is &gt;= mml &gt;= 2.
    /// </summary>
    private static bool IsNormalMatchBetter(int newml, int newoff, int bestml, int bestoff)
    {
        if (newml < bestml) return false;
        if (newml == bestml) return newoff < bestoff;
        if (newml >= bestml + 2) return true;
        return (newoff >> 7) <= bestoff; // newml == bestml + 1
    }

    /// <summary>
    /// The algorithm decides whether the new match be taken over the rep match? the is strongly rep-biased — a new
    /// match must be at least 2 longer than the rep, and longer still as its offset grows (3+ longer for
    /// offset &gt;= 0x400, 4+ longer for offset &gt;= 0x10000). A rep shorter than 2 always loses.
    /// </summary>
    private static bool TakeNewOverRep(int repLen, int newLen, int newOff)
    {
        if (repLen < 2) return true;
        if (newLen < repLen + 2) return false;
        if (newLen < repLen + 3 && newOff >= 0x400) return false;
        if (newLen < repLen + 4 && newOff >= 0x10000) return false;
        return true;
    }

    /// <summary>
    /// algorithm (IsAllowedNormalMatch). Short matches (ml &lt; 6) are gated by an offset ceiling
    /// (<see cref="NormalMatchOffsetThreshold"/>); ml &gt;= 6 is always allowed. The far-offset gate
    /// algorithm is a proven no-op for our window: cfg[0x44] = window bits = 18, so
    /// <c>off &lt; (1&lt;&lt;18)</c> holds for every offset in a &lt;=256KB window and f2350 returns
    /// <c>off &lt; 0x100000 = true</c>.
    /// </summary>
    private static bool IsAllowedNormalMatch(int ml, int off)
    {
        if (ml < 6) return off < NormalMatchOffsetThreshold[ml];
        return true;
    }

    /// <summary>Inserts every position in <c>[inserted, target)</c> into the hash chain, in order.</summary>
    private static int InsertUpTo(ReadOnlySpan<byte> data, int[] head, int[] prev, int inserted, int target)
    {
        while (inserted < target)
        {
            Insert(data, inserted, head, prev);
            inserted++;
        }
        return inserted;
    }

    /// <summary>
    /// Applies the decoder's recent-offset move-to-front update for the chosen offset index. Index
    /// 0/1/2 promotes that recent distance to the front; index 3 pushes a brand-new distance to the
    /// front and evicts the oldest. This exactly mirrors the <c>recent[]</c> shuffle in
    /// <see cref="KrakenDecoder"/>'s LZ-run loop.
    /// </summary>
    private static void UpdateRecent(ref int r0, ref int r1, ref int r2, int idx, int dist)
    {
        switch (idx)
        {
            case 0:
                break; // [r0, r1, r2] unchanged
            case 1:
                (r0, r1) = (r1, r0); // [r1, r0, r2]
                break;
            case 2:
                { int t = r2; r2 = r1; r1 = r0; r0 = t; } // [r2, r0, r1]
                break;
            default:
                r2 = r1; r1 = r0; r0 = dist; // new offset:[dist, r0, r1]
                break;
        }
    }

    /// <summary>
    /// Length of a repeat-offset match at <paramref name="dist"/> bytes back from <paramref name="pos"/>,
    /// capped so the match ends at or before <paramref name="limit"/>. Returns 0 when the source would
    /// fall before the start of the buffer.
    /// </summary>
    private static int RepMatchLength(ReadOnlySpan<byte> data, int pos, int dist, int limit)
    {
        int src = pos - dist;
        if (src < 0)
            return 0;
        int len = 0;
        int max = limit - pos;
        while (len < max && data[src + len] == data[pos + len])
            len++;
        return len;
    }

    private static void Insert(ReadOnlySpan<byte> data, int pos, int[] head, int[] prev)
    {
        uint h = Hash(data, pos);
        prev[pos] = head[h];
        head[h] = pos;
    }

    private static uint Hash(ReadOnlySpan<byte> data, int pos)
    {
        // The mml=3 greedy pre-pass needs length-3 matches, so positions that share only 3 bytes must
        // collide; a 3-byte hash makes them. The 4-byte hash is the production default.
        if (GreedyHashBytesOverride == 3)
        {
            uint x3 = (uint)(data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16));
            return (x3 * 506832829u) >> (32 - HashBits);
        }
        uint x = (uint)(data[pos] | (data[pos + 1] << 8) | (data[pos + 2] << 16) | (data[pos + 3] << 24));
        return (x * 2654435761u) >> (32 - HashBits);
    }

    private static int MatchLength(ReadOnlySpan<byte> data, int a, int b, int limit)
    {
        int len = 0;
        int max = limit - b;
        while (len < max && data[a + len] == data[b + len])
            len++;
        return len;
    }

    // ===========================================================================================
    // Reference Optimal3 (Kraken level-7) forward float-cost DP — validated against
    // the algorithm (level-7 optimal parse, single-TLL
    // path, num_tlls=1, max_search_lrl=3) against reference behavior. Opt-in: the shipped value-model greedy Parse
    // stays the validated production default; when UseOptimalParse is set, EncodeChunk routes here.
    // The integer cost model (KrakenOptimalCost) is validated byte-exact and validated separately.
    // ===========================================================================================

    /// <summary>
    /// When true, <see cref="EncodeChunk"/> parses with the validated reference Optimal3 forward cost DP
    /// (<see cref="ParseOptimal"/>) instead of the value-model greedy <see cref="Parse"/>. Default off:
    /// the greedy parse is the validated production default until the DP is byte-identical to the reference.
    /// </summary>
    internal static bool UseOptimalParse = false;

    /// <summary>
    /// Production switch (default ON) for the Optimal3 multi-candidate parse on single-chunk
    /// blocks. A single-chunk block has no cross-chunk backward dependency, so the reference's
    /// best-of-{greedy mml=4/3/8, seeded forward-DP} selection (by real entropy-coded emit size)
    /// reproduces the codec byte-for-byte where a greedy candidate wins, and never enlarges the
    /// block (the plain greedy is always one candidate). Multi-chunk blocks are unaffected (their seedless
    /// second chunk needs the shared match chain). Set false to force the plain value-model greedy on all
    /// blocks (useful for deterministic debugging or maximum throughput).
    /// </summary>
    internal static bool ProductionOptimalSingleChunk = true;

    /// <summary>
    /// Upper bound (in bytes) on a single-chunk block that <see cref="ProductionOptimalSingleChunk"/> will
    /// parse with the Optimal3 DP. The matcher is a bounded suffix-trie; this managed
    /// encoder's forward-DP is O(n^2) in the block length (≈0.2 s at 4 KiB, seconds by 8–16 KiB), so optimal
    /// parsing is restricted to genuinely small standalone blocks — the small config/text system files the
    /// reference itself compresses as per-file standalone blocks — where it is both fast and byte-faithful.
    /// Larger single-chunk blocks fall back to the linear greedy parse. Raising this trades build time for
    /// fidelity on medium blocks and is only worthwhile with a bounded suffix-trie matcher in place.
    /// </summary>
    internal static int ProductionOptimalMaxBlock = 0x1000;

    /// <summary>
    /// When true (and <see cref="UseOptimalParse"/> is set), the forward DP's candidate finder is the reference
    /// CacheTableMatchFinder (CTMF) instead of an unbounded hash chain. validated against
    /// the implementation <c>cache-table match finder</c>: a
    /// <b>two-row, sixteen-way</b> check-bit cache. Each entry is a u32 {position:26, check:6}; a query scans
    /// the 32 most-recent same-context positions (16 ways × 2 hash rows) and emits strictly-length-improving
    /// (len,dist) pairs (the <c>len &gt; prevml</c> selection in match finder). The bounded cache evicts the
    /// cheap periodic near-copies the unbounded chain surfaces, which is what forces the farther-offset
    /// choices. The far periodic copies the 16-way recency eviction drops (text cmd-20 dist-551, cmd-34
    /// dist-950) come from the windowed long-range matcher (see <see cref="UseLrmSupplement"/>), unioned in.
    /// </summary>
    internal static bool UseCtmfFinder = true;

    /// <summary>
    /// Diagnostic: when CTMF is active, ALSO walk the unbounded hash chain and union both candidate sets
    /// (the <c>find_all_matches</c> returns up to 4 pairs unioned from the CTMF and a long-range matcher).
    /// Lets the DP see far periodic copies the 4-way cache evicted (e.g. the text-vector cmd-34 dist-950 match).
    /// </summary>
    /// <summary>Diagnostic (default 0 = 16):override the CTMF bucket depth (ways per bucket, power of two).</summary>
    internal static int CtmfWaysOverride = 0;

    internal static bool UseChainUnion = false;

    /// <summary>
    /// Diagnostic (LRM-equivalent): when the CTMF is active, ALSO walk the deep hash chain but contribute ONLY
    /// matches STRICTLY LONGER than the CTMF's best at this position. This mirrors the windowed long-range
    /// matcher (windowed long-range matcher, algorithm), which surfaces the FAR periodic copy the
    /// CTMF's 16-way recency eviction drops (text-vector cmd-20 dist-551, cmd-34 dist-950) — without re-introducing
    /// the equal-length NEAR copies a naive <see cref="UseChainUnion"/> surfaces (which re-breaks cmd-20). The
    /// strictly-longer gate is the faithful "len &gt; prevml" pair-selection semantics observed in match finder.
    /// </summary>
    internal static bool UseLrmSupplement = false;

    /// <summary>
    /// Reproduces the OUTPUT of the level-7 (Optimal3) match finder
    /// <c>suffix-trie match finder</c> (the implementation
    /// algorithm; ctor algorithm installs <c>suffix-trie vtable</c>,
    /// source <c>suffixtrie2.inl</c>; created by <c>suffix-trie match-finder creation</c> algorithm,
    /// selected for levels ≥6 by <c>level-based matcher selection</c> algorithm). The optimal parser asserts
    /// <c>find_all_matches_num_pairs == 4</c>, i.e. up to 4 (len,offset) pairs
    /// per position.
    /// <para>★ ROOT-CAUSE CORRECTION: levels 0-4 (greedy/fast) use the 2-row 16-way
    /// <c>CacheTableMatchFinder</c> (the <see cref="Ctmf"/> implementation); levels 5/6+ (Optimal1/2/3…) use this
    /// <b>full-history suffix trie</b>. A suffix trie keeps the ENTIRE window (no 16-way recency eviction),
    /// so it retains the far periodic copy the cache drops (text cmd-34 dist-950 @ pos 6, ~17 periods back).
    /// That is exactly why the faithful 16-way cache could not surface dist-950 while the emits it.</para>
    /// <para>A suffix trie is only an acceleration structure; its <c>find_all_matches</c> output is the
    /// per-position <b>Pareto frontier</b> (closest offset for each achievable length), capped to the 4
    /// longest, ml-descending. That output is reproducible by an exhaustive full-depth walk of the 4-byte
    /// hash chain: every length≥4 match source shares the position's first 4 bytes, so it is in the bucket;
    /// <see cref="MatchLength"/> verifies the bytes. When set (with <see cref="UseOptimalParse"/>), the
    /// finder supplies this exhaustive Pareto set instead of the cache query.</para>
    /// <para>★★★ EMPIRICALLY DECISIVE (diagnostic comparison fixpoint reference, analysis-grounded): switching the finder from
    /// the 16-way cache to this full-history Pareto walk advanced the text-vector parse divergence from
    /// <b>cmd 34 → cmd 124</b> (90 commands) — the single largest convergence jump of the whole effort, and
    /// proof the suffix-trie-full-history model is the correct level-7 finder (the prior "check-bit cache
    /// retention" / "LRM union" conclusions were artifacts of modeling the wrong, levels-0-4 finder). LRM
    /// stays delta-0 (DP invariant holds). Default ON so <see cref="UseOptimalParse"/> uses the validated-
    /// correct finder; it stays gated behind <see cref="UseOptimalParse"/> (default off) so production is
    /// unaffected.</para>
    /// <para>★ THE cmd-124 RESIDUAL is NOT this finder and NOT the sublen-fill window. The sublen-fill gate
    /// <c>algorithm(cfg,len) = (uint)(len-cfg.lo) &lt; cfg.range</c> with level-7 cfg <c>rep={3,125}</c>,
    /// <c>new={mml+1,123}</c> reduces to <c>len &lt; (1&lt;&lt;min(level,8)) = 128</c> (algorithm lines
    /// 376-379) — every text match (len ≤ ~57) fills sublens, exactly like this implementation's FILL-ALL, so there is
    /// no over-supply there. The DP min-match is <c>mml = max(4, options[4]) = 4</c>; the reference
    /// length-3 NEW matches (text cmd-125 <c>mat=3 dist=237</c>) come ONLY from the <b>mml=3 greedy
    /// pre-pass</b> not the DP. The residual is the outer selection:
    /// it runs greedy pre-passes at mml=3, mml=4 and mml=8 (<c>greedy optimal pre-pass</c>
    /// algorithm), seeds the histogram from the cheapest, and keeps the min-cost parse across
    /// {greedy-mml-3/4/8, DP} under a FLOAT size estimate. That float-cost
    /// multi-greedy-mml selection is the documented reference-less cost-fixpoint wall (same class as
    /// cmd-23/cmd-35), now pushed from cmd-34 to cmd-124. Reproducing it byte-exact needs the short-match
    /// (3-byte) greedy finder + the float outer-cost order — not yet validated; not speculated.</para>
    /// </summary>
    internal static bool UseSuffixTrieFinder = true;

    /// <summary>Diagnostic (default off):query only CTMF row B (the validated 8-byte hash2), ignoring row A.</summary>
    internal static bool CtmfRowAOff = false;

    /// <summary>Diagnostic (default 0 = auto):override the CTMF table bits (tableBits) used by the finder.</summary>
    internal static int CtmfBitsOverride = 0;

    /// <summary>
    /// Greedy minimum-match override (0 = use <see cref="MinMatch"/> = 4). the level-7 optimal encoder
    /// runs <c>greedy optimal pre-pass</c> as up to three pre-passes with
    /// mml ∈ {4, 3, 8} (mml=4 always, mml=3 when level&gt;6 &amp;&amp; opt[4]&lt;4,
    /// mml=8 when opt[4]&lt;8) and keeps each whose float emit-cost is lower. The mml=3 pre-pass is the ONLY
    /// source of the length-3 NEW matches (the DP min-match is fixed at 4). Set per-thread by
    /// <see cref="DiagGreedyParse"/> so a single parameterised greedy can model each pre-pass.
    /// </summary>
    [ThreadStatic] internal static int GreedyMmlOverride;

    /// <summary>
    /// Greedy hash-chain width override (0 = the default 4-byte hash). For the mml=3 pre-pass the finder must
    /// surface length-3 new matches, which a 4-byte hash chain cannot (its members share 4 bytes). Set to 3
    /// to switch <see cref="Hash"/> to a 3-byte hash so positions sharing only 3 bytes land in the same
    /// bucket; <see cref="MatchLength"/> still verifies the true match length. Set per-thread by
    /// <see cref="DiagGreedyParse"/>.
    /// </summary>
    [ThreadStatic] internal static int GreedyHashBytesOverride;

    /// <summary>
    /// When true (and <see cref="UseOptimalParse"/> is set), each match relax also runs the rep0-continuation
    /// pre-relax: after placing a match ending at E with new front-offset d, it values the
    /// immediate rep0 continuation [3-byte transition + forward rep0 match at d] and relaxes the arrival at its
    /// end, bundling the continuation into field [6] of that arrival. This is a "poor man's multi-arrival" that
    /// lets a locally-non-minimal match still propagate its free rep cascade (the cmd-21 defer-to-lock-rep case).
    /// validated against the pre-relax helper and its two call sites.
    /// </summary>
    internal static bool UseFaef0 = true;

    /// <summary>
    /// When set (with the greedy <see cref="Parse"/>), the per-position selector is the byte-exact implementation of
    /// the <c>match heuristic</c> — <see cref="FindMatchExact"/> — instead of the
    /// value-model <see cref="FindMatch"/>. It reproduces the greedy decision chain exactly: rep search with
    /// mml2 quantization, <see cref="IsAllowedNormalMatch"/> (algorithm + the always-true
    /// far gate algorithm for ≤256KB windows), <see cref="IsNormalMatchBetter"/> and
    /// <see cref="TakeNewOverRep"/>, reading the 4-pair Pareto frontier from the full-history
    /// suffix-trie walk. The goal is <c>Tally(the greedy parse) == Tally(the greedy)</c> so the single level-7 DP
    /// pass under the greedy histogram reproduces the emitted parse (the one-DP-pass byte-identity model).
    /// Thread-static, default off ⇒ the production greedy path is byte-identical to before.
    /// </summary>
    [ThreadStatic] internal static bool UseExactGreedy;

    /// <summary>
    /// Diagnostic (default off): apply the <see cref="DecaySeedPassinfo"/> per-region
    /// histogram decay to the greedy seed Tally before the single DP pass builds its cost tables, exactly
    /// as the does for a standalone level-7 chunk. Thread-static so the production path is unaffected.
    /// </summary>
    [ThreadStatic] internal static bool UseSeedDecay = false;

    /// <summary>
    /// Diagnostic (default off): run the level-7 forward DP with the suffix-trie match finder
    /// minimum match length of <b>3</b> (mml=3, <c>suffix-trie match-finder creation</c>
    /// firstbytes=2 ⇒ the trie reports length-3 matches at lvl7). The DP's candidate chain is built with a
    /// 3-byte hash so positions sharing only 3 bytes collide, the Pareto frontier records length-3 pairs, and
    /// a length-3 NEW match is relaxed as a primary (the sublen-FILL floor stays 4 per the new cfg
    /// <c>lo = 4</c>). This surfaces the text cmd-125 <c>mat3 dist237</c> the 4-byte finder
    /// structurally cannot. Thread-static so the production path (4-byte finder) is unaffected.
    /// </summary>
    [ThreadStatic] internal static bool UseDpMml3;

    /// <summary>The suffix-trie match finder minimum match length at level 7 (firstbytes=2 ⇒ 3).</summary>
    private const int DpMml3 = 3;

    /// <summary>
    /// Diagnostic (default off): enable the per-match <b>sublen-FILL</b> in <see cref="ForwardDp"/>
    /// instead of filling every sublength unconditionally. The per-pass config uses a high bound of 128 at level 7.
    /// REP cfg is <c>{3, 125}</c>; NEW cfg is <c>{mml+1, 128-(mml+1)}</c>.
    /// Both collapse to "fill sublengths only when the match length &lt; 128": the DP always relaxes the
    /// full-length match, then fills shorter lengths only inside the window. Earlier FILL-ALL over-relaxed
    /// long matches (≥128 B, e.g. the rep8_4k/zeros4k 4080-byte runs), creating thousands of extra arrivals.
    /// Thread-static, default off so the production path is byte-identical to before; A/B'd via diagnostic comparison.
    /// </summary>
    [ThreadStatic] internal static bool UseSublenGate = false;

    /// <summary>the sublen-fill window high bound (level 7 ⇒ 128).</summary>
    private const int SublenFillThreshold = 128;

    /// <summary>
    /// The sublen-fill predicate: fill is allowed iff <c>(uint)(len − lo) &lt; range</c>
    /// (cfg <c>{lo, range}</c> from the helper-style <c>{A, B−A}</c>). Unsigned compare folds
    /// the lower bound (<c>len &lt; lo</c> underflows to a huge value ⇒ false) into a single branch.
    /// </summary>
    private static bool SublenFillAllowed(int lo, int range, int len) => (uint)(len - lo) < (uint)range;

    /// <summary>
    /// Diagnostic (default off): on an EXACT-cost arrival tie, keep the LATER-tried relaxation instead of the
    /// first one (i.e. use <c>total &lt;= arr[dst].Cost</c> rather than strict <c>&lt;</c> in
    /// <see cref="RelaxRep"/>/<see cref="RelaxNew"/>). validated from the cmd-20 divergence: under the exact
    /// captured seed the two local paths (<c>1 lit + match@556</c> vs <c>2 lit + match@557</c>, both len-47,
    /// distances 551 vs 496 in the SAME offset bucket) cost <b>byte-identically</b> (proven term-by-term via the
    /// diagnostic comparison cost probe: lit/packet/offset all equal, delta 0). The tie-break keeps the path whose match starts one
    /// byte EARLIER (src 603, the longer LRL=2 run at pos 605) — i.e. with the ascending LRL loop the last equal
    /// relaxation wins. Strict-<c>&lt;</c> kept the first (src 604) path. Thread-static, default off so the
    /// production path is unchanged; A/B'd via diagnostic comparison (must extend EXTSEED call0 past cmd-20 while keeping the
    /// zeros/rep8_4k vectors byte-exact).
    /// </summary>
    [ThreadStatic] internal static bool UseTieBreakLast = false;

    /// <summary>
    /// Diagnostic (default off): run <see cref="ForwardDp"/> as the reference's LIMITED-LOOKAHEAD, GREEDY-COMMITTED,
    /// ADAPTIVE WINDOWED optimal parse (num_tlls==1 / lvl7) instead of a single monolithic
    /// full-chunk DP. Reversed byte-exact: the parse advances in a 256-byte <b>commit stride</b>
    /// (<see cref="WindowCommitStride"/>) with a 4096-byte <b>lookahead window</b>
    /// (<see cref="WindowLookahead"/>). A segment is committed at a clean re-anchor when the
    /// frontier <see cref="DpMaxReached"/> satisfies <c>maxReached &lt;= pos</c> (⇒ nothing relaxed
    /// past <c>pos</c>, so all later arrivals are still unreached — the invariant that makes the cut clean), or on a
    /// window overflow (<c>maxReached &gt; windowEnd</c>). On each mid-commit the committed segment's commands are
    /// tallied into a cumulative passinfo (<see cref="Tally"/>) and the cost tables are rebuilt
    /// (<see cref="KrakenOptimalCost.BuildFromPassinfo"/>); at lvl7 the rebuild
    /// interval is 1 ⇒ rebuild on EVERY commit. Requires an <c>adaptPassinfo</c> seed (the
    /// post-decay greedy Tally) to be threaded into <see cref="ForwardDp"/>; when null the classic single-pass DP runs
    /// unchanged (preserving the shipped manifest.json 279==279 byte-identity). Thread-static, default off.
    /// </summary>
    [ThreadStatic] internal static bool UseWindowedParse = false;

    /// <summary>The optimal-parse frontier: the furthest position any relaxation has
    /// reached in the current segment. Updated by <see cref="RelaxRep"/>/<see cref="RelaxNew"/>/<see cref="Faef0"/>
    /// (only when <see cref="UseWindowedParse"/> is set) to <c>max(DpMaxReached, dst)</c>; the windowed segment loop
    /// commits when it satisfies <c>maxReached &lt;= pos</c> (clean re-anchor) or exceeds the lookahead window.</summary>
    [ThreadStatic] internal static int DpMaxReached;

    /// <summary>the commit stride (256) — the windowed parse re-anchors/commits in strides
    /// of this many positions.</summary>
    private const int WindowCommitStride = 0x100;

    /// <summary>the lookahead window (4096) — a segment may look ahead at most this far
    /// before a forced window-overflow commit.</summary>
    private const int WindowLookahead = 0x1000;

    /// <summary>Diagnostic (default 0/0 = off): when <see cref="DpProbeHi"/> &gt; 0, <see cref="ForwardDp"/>
    /// dumps the final arrival row (cost, src, lrl, ml, idx, dist, reps) for every position in
    /// <c>[DpProbeLo, DpProbeHi]</c> after the forward pass. Lets the diagnostic see exactly which arrivals the DP
    /// materialized at the cmd-20 reconvergence (is the match@556→arrival[603] path even created?).</summary>
    [ThreadStatic] internal static int DpProbeLo = 0;
    /// <summary>Upper bound (inclusive) of the <see cref="DpProbeLo"/> arrival dump; 0 disables.</summary>
    [ThreadStatic] internal static int DpProbeHi = 0;
    /// <summary>Diagnostic (default 0 = off): when a rep/new relax writes (or attempts) arr[DiagWatchDst],
    /// log pos / ml / loi / base / matchcost / total / won. Pins which path sets a contested arrival cost.</summary>
    [ThreadStatic] internal static int DiagWatchDst = 0;
    /// <summary>Diagnostic / reference diagnostic ONLY (default null): when set, <see cref="FindCandidates"/>
    /// ignores the managed hash-chain finder and instead reads the captured per-position match table —
    /// a flat array of <c>npos*8</c> ints (4 <c>(len,dist)</c> pairs/pos, length-descending, len&lt;=0 terminator),
    /// exactly the suffix-trie match finder output in <c>finder_call1.bin</c>. Used to prove the LZ-parse gap is
    /// 100% the finder (len-2/3 short matches the 4-byte-hash finder can't surface) without implementing the trie.</summary>
    [ThreadStatic] internal static int[]? DiagExternalFinder = null;

    /// <summary>DIAGNOSTIC only: raw 0x1808-byte codecost blob captured live from the reference
    /// encoder. When set, <see cref="DiagDpFromExternalPassinfo"/> drives the DP
    /// with this EXACT codecost (via <see cref="KrakenOptimalCost.FromRawBlob"/>) instead of building from
    /// the passinfo seed — isolating "wrong codecost" from "wrong DP recurrence".</summary>
    [ThreadStatic] internal static byte[]? DiagExternalCodeCostBlob = null;

    /// <summary>Diagnostic (default null): when non-null, <see cref="ForwardDp"/> copies its final
    /// per-position arrival table into this array right after the forward pass (before the backward trace),
    /// so a caller can replay a known parse through arr[] to test reachability vs. trace selection.
    /// Layout per index: (cost, src, ml, idx, dist, lrl, contMl, r0). cost==int.MaxValue ⇒ unreached.</summary>
    [ThreadStatic] internal static (int cost, int src, int ml, int idx, int dist, int lrl, int contMl, int r0)[]? DiagArrCapture;

    /// <summary>Diagnostic: populated by <see cref="DiagDpFromSeed"/> — a human-readable trace of replaying the
    /// seed parse through the DP's captured arrival table, reporting the first reference command whose end-position is
    /// unreached or reached at a HIGHER cost than the cumulative (localizing a reachability/relaxation gap vs a
    /// pure backward-trace selection difference).</summary>
    [ThreadStatic] internal static string? DiagReachReport;

    /// <summary>
    /// Diagnostic (default off): implement the tiny-offset round-up branch in the exact-greedy selector
    /// and the level-7 DP candidate set. A new-match candidate whose distance is
    /// &lt; 8 (sub-<see cref="MinDistance"/>, un-codeable in the offset44 scheme) is NOT discarded as the Pareto
    /// walk otherwise does; the encoder rounds the distance up to the smallest codeable distance that preserves the
    /// tiny period (<see cref="RoundUpTinyTable"/>), recomputes the match length at that rounded distance
    /// (the same length recomputation path), and — if it still reaches the mml — feeds it through the normal
    /// allowed/better gates. This is the last not-yet-modeled greedy micro-branch; surfacing these short-period
    /// candidates perturbs the greedy <c>Tally</c> histogram that seeds the one-DP-pass cost tables. Thread-static
    /// so the production path (which never sees dist&lt;8) is byte-identical to before.
    /// </summary>
    [ThreadStatic] internal static bool UseTinyOffsetRemap = false;

    /// <summary>
    /// <c>tiny-offset round-up</c> table (read byte-exact against reference behavior): maps a
    /// tiny distance 1..7 to the smallest offset44-codeable distance (≥8) that preserves the tiny period
    /// (1→8, 2→8, 3→9, 4→8, 5→10, 6→12, 7→14). Index 0 is unused (distance is always ≥1).
    /// </summary>
    private static readonly int[] RoundUpTinyTable = { 0, 8, 8, 9, 8, 10, 12, 14 };

    /// <summary>Rounds a tiny distance (1..7) up to its offset44-codeable equivalent via <see cref="RoundUpTinyTable"/>.</summary>
    private static int RoundUpTiny(int dist) => RoundUpTinyTable[dist];

    /// <summary>A forward-DP arrival: the cheapest way to reach a buffer position (the 0x28-byte record).</summary>
    private struct Arrival
    {
        public int Cost;          // 0x7fffffff = unreached
        public int R0, R1, R2;    // the three recent offsets at this arrival
        public int Ml, Lrl, Src;  // command that produced it: Lrl literals at Src, then a match of Ml
        public int Idx, Dist;     // OffsIndex (0/1/2 rep, 3 new) and the chosen distance
        public int ContLrl, ContMl; // the reference field [6]: a free rep0 continuation bundled into this arrival
                                    // (ContLrl literals then a rep0 match of ContMl at distance R0); 0 = none
    }

    /// <summary>
    /// Reference Optimal3 (level-7) parse selection, mirroring <c>level-7 optimal parse</c>
    /// Run up to three greedy pre-passes — <b>mml=4</b> (always), <b>mml=3</b> and <b>mml=8</b>
    /// (both active at level 7) — via <c>greedy optimal pre-pass</c>, then ONE DP pass seeded
    /// from the best greedy's histogram (with the seed decay). The FINAL parse is the
    /// candidate with the smallest <b>real entropy-coded emit size</b> — NOT the integer cost proxy. For a periodic/text block the DP wins;
    /// for many small JSON/text files the mml=8 greedy wins outright (its emit is byte-identical to the reference).
    /// Every candidate is a valid parse, so selection can never yield a non-round-trippable block.
    /// </summary>
    private static List<Command> ParseOptimal(ReadOnlySpan<byte> data, int[] head, int[] prev,
        int startPos, int litStart0, int matchLimit, int matchStartLimit,
        int chunkStart, int chunkEnd, bool withSeed, bool useHuffmanArrays)
    {
        // Real entropy-coded emit size of a candidate parse (the shipping back-end, litMode=1 raw). A parse
        // that falls back to store-raw (null) scores int.MaxValue so it is never selected over a valid one.
        int RealEmit(ReadOnlySpan<byte> d, List<Command> cand)
        {
            if (cand.Count == 0) return int.MaxValue;
            byte[]? b = EmitChunkFromCommands(d, cand, chunkStart, chunkEnd, withSeed, useHuffmanArrays, litMode: 1);
            return b?.Length ?? int.MaxValue;
        }

        // One greedy pre-pass at the given minimum-match length / hash width, on a PRIVATE causal chain
        // (Parse advances whatever chain it is given, so each pre-pass needs its own). The mml=3 pass uses a
        // 3-byte hash so positions sharing only three bytes collide and length-3 matches become visible —
        // exactly the greedy pre-pass configuration.
        List<Command> Greedy(ReadOnlySpan<byte> d, int mml, int hashBytes)
        {
            int sMml = GreedyMmlOverride, sHb = GreedyHashBytesOverride; bool sEx = UseExactGreedy;
            GreedyMmlOverride = mml; GreedyHashBytesOverride = hashBytes; UseExactGreedy = true;
            try
            {
                var h = new int[HashSize]; h.AsSpan().Fill(-1);
                var pv = new int[d.Length]; pv.AsSpan().Fill(-1);
                for (int p = chunkStart; p < startPos; p++) Insert(d, p, h, pv);
                return Parse(d, h, pv, startPos, litStart0, matchLimit, matchStartLimit);
            }
            finally { GreedyMmlOverride = sMml; GreedyHashBytesOverride = sHb; UseExactGreedy = sEx; }
        }

        var g4 = Greedy(data, 4, 0);
        if (g4.Count == 0)
            return g4; // no legal parse (store-raw handled upstream)

        var best = g4;
        int bestEmit = RealEmit(data, g4);
        foreach (var g in new[] { Greedy(data, 3, 3), Greedy(data, 8, 0) })
        {
            int e = RealEmit(data, g);
            if (e < bestEmit) { bestEmit = e; best = g; }
        }
        var bestGreedy = best;

        // ONE DP pass seeded from the best greedy's histogram, decayed exactly like the reference
        // (→:table[i] = (table[i] >> 4) + 1 per 256-entry region). The DP's cost model is this
        // decayed histogram; its output competes with the best greedy purely on real emit size.
        var dpHead = new int[HashSize];
        var dpPrev = new int[data.Length];
        int seedLitMode = LitModeForParse(data, bestGreedy, chunkEnd, useHuffmanArrays);
        int[] passinfo = Tally(bestGreedy, data, startPos);
        DecaySeedPassinfo(passinfo);
        var cc = KrakenOptimalCost.BuildFromPassinfo(passinfo, seedLitMode);
        // When the adaptive windowed parse is enabled, thread the (decayed) seed passinfo + its lit mode into
        // the DP: it re-tallies each committed 256-stride segment onto this cumulative passinfo and rebuilds
        // the cost tables per commit. Null (default) ⇒ the classic single monolithic pass runs unchanged.
        int[]? adapt = UseWindowedParse ? passinfo : null;
        var dp = ForwardDp(data, dpHead, dpPrev, startPos, matchLimit, matchStartLimit, cc, adapt, seedLitMode);
        int dpEmit = RealEmit(data, dp);
        if (dpEmit < bestEmit) { best = dp; }

        return best;
    }

    // =====================================================================================
    // DIAGNOSTIC HOOK (diagnostic comparison fixpoint reference) — NOT used by production. Seeds the DP's pass
    // histogram from an externally supplied parse (e.g. the own decoded parse), then runs ONE
    // forward-DP pass under those tables and returns the DP parse + both parses' costs. If the DP
    // reproduces the seed parse, the DP recurrence + integer cost model are byte-correct and any
    // residual divergence is purely the seed/finder basin; otherwise the first differing command
    // localizes a actual DP bug. Single seeded chunk (startPos = 8; the diagnostic comparison vectors < ChunkMax).
    // Parallel arrays keep the private Command/Arrival types off the public surface.
    // =====================================================================================
    internal static void DiagDpFromSeed(
        byte[] data,
        int[] seedLitStart, int[] seedLitLen, int[] seedDist, int[] seedMatch, int[] seedIdx,
        out int[] dpLitStart, out int[] dpLitLen, out int[] dpDist, out int[] dpMatch, out int[] dpIdx,
        out long dpCost, out long seedCost)
    {
        int n = data.Length;
        int matchLimit = n - LiteralTail;
        int matchStartLimit = n - NoMatchZone;
        int startPos = 8;
        int chunkEnd = n;

        var seed = new List<Command>(seedLitStart.Length);
        for (int i = 0; i < seedLitStart.Length; i++)
            seed.Add(new Command(seedLitStart[i], seedLitLen[i], seedDist[i], seedMatch[i], seedIdx[i]));

        int seedLitMode = LitModeForParse(data, seed, chunkEnd, useHuffmanArrays: true);
        int[] passinfo = Tally(seed, data, startPos);
        if (UseSeedDecay) DecaySeedPassinfo(passinfo);
        var cc = KrakenOptimalCost.BuildFromPassinfo(passinfo, seedLitMode);

        var dpHead = new int[HashSize];
        var dpPrev = new int[n];
        DiagArrCapture = System.Array.Empty<(int, int, int, int, int, int, int, int)>(); // non-null ⇒ ForwardDp captures arr[]
        // When the adaptive windowed parse is enabled, thread the (reference-seed) passinfo + its lit mode so the DP
        // runs the committed-window recurrence under the EXACT seed — isolating the recurrence from the
        // greedy-seed basin. Null (default) ⇒ the classic single monolithic pass runs unchanged.
        int[]? adapt = UseWindowedParse ? passinfo : null;
        var dp = ForwardDp(data, dpHead, dpPrev, startPos, matchLimit, matchStartLimit, cc, adapt, seedLitMode);

        // Replay the seed through the captured arrival table: report the first command whose end-position is
        // unreached, or reached at a cost HIGHER than the cumulative to that point.
        var capArr = DiagArrCapture;
        DiagArrCapture = null;
        if (capArr != null && capArr.Length > 0)
        {
            var sb = new System.Text.StringBuilder();
            long cum = 0;
            int rr0 = MinDistance, rr1 = MinDistance, rr2 = MinDistance;
            bool found = false;
            for (int i = 0; i < seed.Count; i++)
            {
                var c = seed[i];
                int lo = rr0 < MinDistance ? MinDistance : rr0;
                cum += KrakenOptimalCost.CostLiterals(data, c.LitStart, c.LitLen, lo, cc);
                int litField = c.LitLen < 3 ? c.LitLen : 3;
                if (c.LitLen > 2) cum += KrakenOptimalCost.CostLen(cc, c.LitLen - 3);
                if (c.OffsIndex < 3)
                    cum += KrakenOptimalCost.CostLoMatch(cc, litField, c.MatchLen, c.OffsIndex);
                else
                    cum += KrakenOptimalCost.CostOffset(c.Distance, cc) +
                           KrakenOptimalCost.CostNormalMatch(cc, litField, c.MatchLen);
                UpdateRecent(ref rr0, ref rr1, ref rr2, c.OffsIndex, c.Distance);
                int endPos = c.LitStart + c.LitLen + c.MatchLen;
                int arrCost = (endPos >= 0 && endPos < capArr.Length) ? capArr[endPos].cost : int.MaxValue;
                if (arrCost == int.MaxValue || arrCost > cum)
                {
                    sb.Append($"  REACH-GAP at seed cmd#{i} (endPos={endPos}): refCumCost={cum} arr[endPos].cost=")
                      .Append(arrCost == int.MaxValue ? "UNREACHED" : arrCost.ToString())
                      .Append(arrCost != int.MaxValue ? $" (delta {arrCost - cum}, DP costlier)" : "")
                      .Append('\n');
                    var a = endPos < capArr.Length ? capArr[endPos] : default;
                    sb.Append($"    ref cmd: ls={c.LitStart} ll={c.LitLen} ml={c.MatchLen} dist={c.Distance} oi={c.OffsIndex}\n");
                    sb.Append($"    arr[{endPos}] (if reached): src={a.src} ml={a.ml} idx={a.idx} dist={a.dist} lrl={a.lrl} contMl={a.contMl} r0={a.r0}\n");
                    found = true;
                    break;
                }
            }
            if (!found)
                sb.Append("  NO REACH-GAP: every reference command end-position is reached at cost <= the reference cumulative.\n" +
                          "  => the reference parse cost is reachable in arr[]; the divergence is backward-trace/rep-state selection, not reachability.\n");
            DiagReachReport = sb.ToString();
        }

        dpLitStart = new int[dp.Count]; dpLitLen = new int[dp.Count];
        dpDist = new int[dp.Count]; dpMatch = new int[dp.Count]; dpIdx = new int[dp.Count];
        for (int i = 0; i < dp.Count; i++)
        {
            dpLitStart[i] = dp[i].LitStart; dpLitLen[i] = dp[i].LitLen;
            dpDist[i] = dp[i].Distance; dpMatch[i] = dp[i].MatchLen; dpIdx[i] = dp[i].OffsIndex;
        }
        dpCost = CostOfParse(dp, data, startPos, chunkEnd, cc);
        seedCost = CostOfParse(seed, data, startPos, chunkEnd, cc);
    }

    // =====================================================================================
    // DIAGNOSTIC HOOK (interop reference) — NOT production. Runs ONE forward-DP pass using
    // the EXACT seed histogram captured by the seeddump diagnostic (the passinfo arg, dumped
    // from rcx). The dump is in the passinfo layout (int offsets):
    // [0] lit mode (1 = raw)
    // [2..0x101] lit histogram (256)
    // [0x102..0x201] packet histogram (256)
    // [0x202] offset_alt_modulo
    // [0x203..0x302] offset-bucket histogram (256)
    // [0x303..0x402] offset-alt histogram (256)
    // [0x403..0x502] length histogram (256)
    // This is TRANSLATED into the BuildFromPassinfo 0x601-int layout (raw@0/sub@0x100/packet@0x200/
    // length@0x300/modulo@0x400/offbucket@0x401/offalt@0x501), cost tables are built via the byte-exact
    // implementation, and ONE ForwardDp pass runs under them. Decisive test: if DP(the true seed) ==
    // the parse, the residual is purely the seed (match the greedy/decay in managed code); if it
    // still diverges, it is a DP bug the fixpoint reference's flatter histogram happened to avoid.
    // =====================================================================================
    internal static void DiagDpFromExternalPassinfo(
        byte[] data, int[] referencePassinfo, int litMode,
        out int[] dpLitLen, out int[] dpDist, out int[] dpMatch, out int[] dpIdx)
    {
        int n = data.Length;
        int matchLimit = n - LiteralTail;
        int matchStartLimit = n - NoMatchZone;
        int startPos = 8;

        // CORRECTED LAYOUT (proven byte-exact via the ccdiff diagnostic): the seeddump `call*_rcx`
        // capture is the `passinfo` arg (rcx), and the reads it in EXACTLY my
        // BuildFromPassinfo 0x601-int layout — raw@0, sub@0x100, packet@0x200, length@0x300,
        // modulo@0x400, offbucket@0x401, offalt@0x501. No translation is needed; copy verbatim.
        // litMode is NOT in passinfo — it is codecosts[0] (`*`, the winning greedy's choice),
        // captured separately in `call*_rdx`. The caller passes it in explicitly.
        var pi = new int[0x601];
        Array.Copy(referencePassinfo, pi, Math.Min(referencePassinfo.Length, 0x601));

        // DIAGNOSTIC only: if a raw codecost blob is injected, drive the DP with the reference
        // EXACT captured codecost instead of building from the passinfo seed. This
        // isolates "wrong codecost" from "wrong DP recurrence".
        var cc = DiagExternalCodeCostBlob != null
            ? KrakenOptimalCost.FromRawBlob(DiagExternalCodeCostBlob)
            : KrakenOptimalCost.BuildFromPassinfo(pi, litMode);

        var dpHead = new int[HashSize];
        var dpPrev = new int[n];
        var dp = ForwardDp(data, dpHead, dpPrev, startPos, matchLimit, matchStartLimit, cc);

        dpLitLen = new int[dp.Count]; dpDist = new int[dp.Count];
        dpMatch = new int[dp.Count]; dpIdx = new int[dp.Count];
        for (int i = 0; i < dp.Count; i++)
        {
            dpLitLen[i] = dp[i].LitLen; dpDist[i] = dp[i].Distance;
            dpMatch[i] = dp[i].MatchLen; dpIdx[i] = dp[i].OffsIndex;
        }
    }

    // =====================================================================================
    // DIAGNOSTIC HOOK (diagnostic comparison one-pass reference) — NOT production. Reproduces the level-7
    // structure byte-faithfully per the ONE-DP-PASS algorithm: run the greedy at
    // the given mml (one of the 4/3/8 pre-passes), tally ITS parse into passinfo, build cost
    // tables, and run EXACTLY ONE forward-DP pass under those tables. Returns both the greedy parse
    // and the one-pass DP parse so the diagnostic can check whether ForwardDp(Tally(greedy)) reproduces
    // the emitted parse (the make-or-break: if the greedy parse ≈ the greedy, the single DP pass under
    // the greedy histogram = the parse). Seeded exactly like a actual chunk (8 COPY_64 positions).
    // =====================================================================================
    internal static void DiagOnePassFromGreedy(
        byte[] data, int mml, int hashBytes,
        out int[] gLitLen, out int[] gDist, out int[] gMatch, out int[] gIdx,
        out int[] dpLitLen, out int[] dpDist, out int[] dpMatch, out int[] dpIdx)
    {
        int saveMml = GreedyMmlOverride, saveHb = GreedyHashBytesOverride;
        bool saveExact = UseExactGreedy;
        GreedyMmlOverride = mml;
        GreedyHashBytesOverride = hashBytes;
        UseExactGreedy = true; // the one-DP-pass model needs the byte-exact greedy seed
        try
        {
            int n = data.Length;
            int matchLimit = n - LiteralTail;
            int matchStartLimit = n - NoMatchZone;
            int startPos = 8;

            var head = new int[HashSize]; head.AsSpan().Fill(-1);
            var prev = new int[n]; prev.AsSpan().Fill(-1);
            for (int p = 0; p < startPos; p++) Insert(data, p, head, prev);

            var greedy = Parse(data, head, prev, startPos, startPos, matchLimit, matchStartLimit);

            // Tally(greedy) → [seed decay] → cost tables → ONE forward-DP pass (the level-7 structure).
            int[] passinfo = Tally(greedy, data, startPos);
            if (UseSeedDecay) DecaySeedPassinfo(passinfo);
            var cc = KrakenOptimalCost.BuildFromPassinfo(passinfo, LitModeForParse(data, greedy, n, useHuffmanArrays: true));
            var dpHead = new int[HashSize]; dpHead.AsSpan().Fill(-1);
            var dpPrev = new int[n];
            var dp = ForwardDp(data, dpHead, dpPrev, startPos, matchLimit, matchStartLimit, cc);

            gLitLen = new int[greedy.Count]; gDist = new int[greedy.Count];
            gMatch = new int[greedy.Count]; gIdx = new int[greedy.Count];
            for (int i = 0; i < greedy.Count; i++)
            {
                gLitLen[i] = greedy[i].LitLen; gDist[i] = greedy[i].Distance;
                gMatch[i] = greedy[i].MatchLen; gIdx[i] = greedy[i].OffsIndex;
            }
            dpLitLen = new int[dp.Count]; dpDist = new int[dp.Count];
            dpMatch = new int[dp.Count]; dpIdx = new int[dp.Count];
            for (int i = 0; i < dp.Count; i++)
            {
                dpLitLen[i] = dp[i].LitLen; dpDist[i] = dp[i].Distance;
                dpMatch[i] = dp[i].MatchLen; dpIdx[i] = dp[i].OffsIndex;
            }
        }
        finally { GreedyMmlOverride = saveMml; GreedyHashBytesOverride = saveHb; UseExactGreedy = saveExact; }
    }

    // =====================================================================================
    // DIAGNOSTIC HOOK (diagnostic comparison codecost reference) — NOT production. Builds the DP codecost EXACTLY
    // as the one-pass level-7 model does (greedy at mml/hashBytes -> Tally -> BuildFromPassinfo) and
    // exposes the four cost tables so the diagnostic can byte-diff them against the actual DP codecost
    // (capture). Decides whether the greedy parse Tally builds the codecost: if a table
    // differs, the greedy/tally is the lever (not the DP recurrence, proven byte-exact under cc).
    // =====================================================================================
    // Diagnostic: build the GREEDY SEED passinfo exactly as the does for verification — tally the
    // greedy parse with a chosen increment (the seed uses +1; the DP re-tally uses +2) and include
    // the trailing-tail literals (chunkEnd). Returns the raw passinfo so the diagnostic can compare to the reference
    // captured pre-decay seed (decayin0.bin) and, after DecaySeedPassinfo, to the input (call1_rcx).
    internal static int[] DiagSeedPassinfo(byte[] data, int mml, int hashBytes, int inc, bool includeTail)
    {
        int saveMml = GreedyMmlOverride, saveHb = GreedyHashBytesOverride;
        bool saveExact = UseExactGreedy;
        GreedyMmlOverride = mml;
        GreedyHashBytesOverride = hashBytes;
        UseExactGreedy = true;
        try
        {
            int n = data.Length;
            int matchLimit = n - LiteralTail;
            int matchStartLimit = n - NoMatchZone;
            int startPos = 8;
            var head = new int[HashSize]; head.AsSpan().Fill(-1);
            var prev = new int[n]; prev.AsSpan().Fill(-1);
            for (int p = 0; p < startPos; p++) Insert(data, p, head, prev);
            var greedy = Parse(data, head, prev, startPos, startPos, matchLimit, matchStartLimit);
            return Tally(greedy, data, startPos, inc, includeTail ? n : -1);
        }
        finally { GreedyMmlOverride = saveMml; GreedyHashBytesOverride = saveHb; UseExactGreedy = saveExact; }
    }

    internal static void DiagGreedyCodeCost(
        byte[] data, int mml, int hashBytes, int litModeOverride,
        out int[] packet, out int[] length, out int[] lit, out int[] offbucket,
        out int litModeUsed, out int[] passinfoOut)
    {
        int saveMml = GreedyMmlOverride, saveHb = GreedyHashBytesOverride;
        bool saveExact = UseExactGreedy;
        GreedyMmlOverride = mml;
        GreedyHashBytesOverride = hashBytes;
        UseExactGreedy = true;
        try
        {
            int n = data.Length;
            int matchLimit = n - LiteralTail;
            int matchStartLimit = n - NoMatchZone;
            int startPos = 8;
            var head = new int[HashSize]; head.AsSpan().Fill(-1);
            var prev = new int[n]; prev.AsSpan().Fill(-1);
            for (int p = 0; p < startPos; p++) Insert(data, p, head, prev);
            var greedy = Parse(data, head, prev, startPos, startPos, matchLimit, matchStartLimit);
            int[] passinfo = Tally(greedy, data, startPos);
            int litMode = litModeOverride >= 0 ? litModeOverride
                : LitModeForParse(data, greedy, n, useHuffmanArrays: true);
            litModeUsed = litMode;
            var cc = KrakenOptimalCost.BuildFromPassinfo(passinfo, litMode);
            packet = (int[])cc.Packet.Clone();
            length = (int[])cc.Length.Clone();
            lit = (int[])cc.Lit.Clone();
            offbucket = (int[])cc.OffsetBucket.Clone();
            passinfoOut = passinfo;
        }
        finally { GreedyMmlOverride = saveMml; GreedyHashBytesOverride = saveHb; UseExactGreedy = saveExact; }
    }

    /// <summary>
    /// Diagnostic: run the value-model greedy (<see cref="Parse"/>) as one of the pre-passes at a chosen
    /// minimum match length (<paramref name="mml"/>) and hash width (<paramref name="hashBytes"/>, 3 or 4),
    /// seeded exactly like a actual chunk (8 COPY_64 seed positions indexed before parsing). the level-7
    /// encoder runs this at mml ∈ {4, 3, 8}; the mml=3 pass is the only producer of length-3 NEW matches.
    /// Returns the parse so the fixpoint diagnostic can test whether a faithful mml=3 greedy
    /// reproduces the exact text parse (the make-or-break for the float emit-size selection).
    /// </summary>
    internal static void DiagGreedyParse(
        byte[] data, int mml, int hashBytes,
        out int[] litStart, out int[] litLen, out int[] dist, out int[] match, out int[] idx)
    {
        int saveMml = GreedyMmlOverride, saveHb = GreedyHashBytesOverride;
        bool saveExact = UseExactGreedy;
        GreedyMmlOverride = mml;
        GreedyHashBytesOverride = hashBytes;
        UseExactGreedy = true; // model the reference greedy with the byte-exact selector for the comparison
        try
        {
            int n = data.Length;
            int matchLimit = n - LiteralTail;
            int matchStartLimit = n - NoMatchZone;
            int firstMatchPos = 8;
            var head = new int[HashSize]; head.AsSpan().Fill(-1);
            var prev = new int[n]; prev.AsSpan().Fill(-1);
            for (int p = 0; p < firstMatchPos; p++) Insert(data, p, head, prev);
            var parse = Parse(data, head, prev, firstMatchPos, firstMatchPos, matchLimit, matchStartLimit);
            litStart = new int[parse.Count]; litLen = new int[parse.Count];
            dist = new int[parse.Count]; match = new int[parse.Count]; idx = new int[parse.Count];
            for (int i = 0; i < parse.Count; i++)
            {
                litStart[i] = parse[i].LitStart; litLen[i] = parse[i].LitLen;
                dist[i] = parse[i].Distance; match[i] = parse[i].MatchLen; idx[i] = parse[i].OffsIndex;
            }
        }
        finally { GreedyMmlOverride = saveMml; GreedyHashBytesOverride = saveHb; UseExactGreedy = saveExact; }
    }

    /// <summary>
    /// Diagnostic:replays the seed parse left-to-right, building the CTMF exactly as <see cref="ForwardDp"/>
    /// does (same seed-index, same scan-then-insert order), and at each command's match-start position reports
    /// the CTMF's emitted (len,dist) pairs and whether the chosen distance was among them. Pinpoints whether
    /// a far new match (e.g. cmd-34 dist-950) is a genuine 16-way eviction or a implementation bug.
    /// </summary>
    internal static void DiagFinderAlongSeed(
        byte[] data, int[] seedLitStart, int[] seedLitLen, int[] seedDist, int[] seedMatch, int[] seedIdx,
        Action<string> log)
    {
        int n = data.Length;
        int matchLimit = n - LiteralTail;
        int startPos = 8;

        int ctmfBits;
        {
            int len = data.Length < 1 ? 1 : data.Length;
            int cl = 0;
            while (cl < 24 && (1 << cl) < len) cl++;
            ctmfBits = cl < 18 ? 18 : cl;
        }
        if (CtmfBitsOverride > 0) ctmfBits = CtmfBitsOverride;

        var dpHead = new int[HashSize]; dpHead.AsSpan().Fill(-1);
        var dpPrev = new int[n];
        var ctmf = new Ctmf(ctmfBits, data.Length);
        int inserted = startPos > LiteralTail ? startPos - LiteralTail : 0;
        int ctmfIns = inserted;

        Span<int> qlen = stackalloc int[40];
        Span<int> qdist = stackalloc int[40];

        for (int k = 0; k < seedLitStart.Length; k++)
        {
            if (seedIdx[k] < 0) break; // tail
            int matchPos = seedLitStart[k] + seedLitLen[k];
            if (matchPos > matchLimit) break;
            inserted = InsertUpTo(data, dpHead, dpPrev, inserted, matchPos);
            while (ctmfIns < inserted) { ctmf.Insert(data, ctmfIns); ctmfIns++; }
            int qn = ctmf.Query(data, matchPos, matchLimit, qlen, qdist);

            bool newMatch = seedIdx[k] == 3;
            bool offered = false; int offeredLen = 0;
            for (int i = 0; i < qn; i++) if (qdist[i] == seedDist[k]) { offered = true; offeredLen = qlen[i]; }

            if (newMatch)
            {
                var sb = new StringBuilder();
                for (int i = 0; i < qn; i++) sb.Append($"({qlen[i]},{qdist[i]})");
                // Also report whether pos-seedDist is genuinely present anywhere earlier (a actual match exists)
                int cand = matchPos - seedDist[k];
                int realLen = cand >= 0 ? MatchLength(data, cand, matchPos, matchLimit) : -1;
                log($"cmd{k} pos={matchPos} REF new dist={seedDist[k]} mat={seedMatch[k]} | CTMF[{qn}]={sb} | offered={offered}({offeredLen}) realLenAtDist={realLen}");
            }
        }
    }

    private static bool SameParse(List<Command> a, List<Command> b)
    {
        if (a.Count != b.Count) return false;
        for (int i = 0; i < a.Count; i++)
        {
            if (a[i].LitStart != b[i].LitStart || a[i].LitLen != b[i].LitLen ||
                a[i].Distance != b[i].Distance || a[i].MatchLen != b[i].MatchLen ||
                a[i].OffsIndex != b[i].OffsIndex)
                return false;
        }
        return true;
    }

    /// <summary>
    /// Total cost (bits×32) of a command list under <paramref name="cc"/>, accumulated exactly as the
    /// forward DP accumulates an arrival (literal run + LRL escape + rep/new match) plus the trailing
    /// literal run to <paramref name="chunkEnd"/>. Used to pick the cheapest parse across passes.
    /// </summary>
    private static long CostOfParse(List<Command> cmds, ReadOnlySpan<byte> data, int start, int chunkEnd,
        KrakenOptimalCost.CodeCosts cc)
    {
        long cost = 0;
        int r0 = MinDistance, r1 = MinDistance, r2 = MinDistance;
        int endPos = start;
        foreach (var c in cmds)
        {
            int lo = r0 < MinDistance ? MinDistance : r0;
            cost += KrakenOptimalCost.CostLiterals(data, c.LitStart, c.LitLen, lo, cc);
            int litField = c.LitLen < 3 ? c.LitLen : 3;
            if (c.LitLen > 2) cost += KrakenOptimalCost.CostLen(cc, c.LitLen - 3);
            if (c.OffsIndex < 3)
                cost += KrakenOptimalCost.CostLoMatch(cc, litField, c.MatchLen, c.OffsIndex);
            else
                cost += KrakenOptimalCost.CostOffset(c.Distance, cc) +
                        KrakenOptimalCost.CostNormalMatch(cc, litField, c.MatchLen);
            UpdateRecent(ref r0, ref r1, ref r2, c.OffsIndex, c.Distance);
            endPos = c.LitStart + c.LitLen + c.MatchLen;
        }
        int tlo = r0 < MinDistance ? MinDistance : r0;
        cost += KrakenOptimalCost.CostLiterals(data, endPos, chunkEnd - endPos, tlo, cc);
        return cost;
    }

    /// <summary>
    /// <c>passinfo update</c>: tally a command list into a 0x601-int pass
    /// histogram (+2 per event). Tracks the three recent offsets (init distance 8) with the decoder's
    /// move-to-front so rep indices are scored correctly. litMode is raw (1); both literal histograms are
    /// filled (build picks one). Layout: [0..0xFF] lit-raw, [0x100..0x1FF] lit-sub, [0x200..0x2FF] packet,
    /// [0x300..0x3FF] length (shared LRL+ML escapes), [0x400] offset_alt_modulo (0), [0x401..0x500]
    /// offset-bucket, [0x501..0x600] offset-alt (0).
    /// </summary>
    /// <summary>
    /// <c>seed passinfo decay</c> — the per-region histogram decay applied to the seed
    /// passinfo BEFORE the single DP pass builds its codecost tables. validated against
    /// <c>algorithm</c> (the implementation), which calls <c>algorithm</c> on each
    /// 256-entry region: <c>c' = (c &gt;&gt; 4) + 1</c>. This strongly smooths the greedy's raw Tally toward
    /// uniform, flattening the cost model so the level-7 DP behaves greedy-like (it stops detouring to a
    /// nearer offset just to save a single offset bit — the cmd-20 lit=1/dist=551 vs lit=2/dist=496 flip).
    /// Applies to literals-raw (0), literals-sub (0x100), packet (0x200), length (0x300), offset-bucket
    /// (0x401), and offset-alt (0x501, only when the modulo at 0x400 &gt; 1). The scalar at int-index 0x400
    /// (offset_alt_modulo) is preserved. This is the standalone-chunk path (no carried encoder state,
    /// <c>carried state is absent</c>); the carried-merge path is the multi-chunk variant.
    /// </summary>
    internal static void DecaySeedPassinfo(int[] pi)
    {
        static void Decay(int[] p, int start)
        {
            for (int i = 0; i < 0x100; i++) p[start + i] = (p[start + i] >> 4) + 1;
        }
        Decay(pi, 0x000); // literals raw
        Decay(pi, 0x100); // literals sub
        Decay(pi, 0x401); // offset bucket
        if (pi[0x400] > 1)
            Decay(pi, 0x501); // offset alt (only when modulo > 1)
        Decay(pi, 0x200); // packet
        Decay(pi, 0x300); // length
    }

    private static int[] Tally(List<Command> commands, ReadOnlySpan<byte> data, int start, int inc = 2, int chunkEnd = -1)
    {
        var pi = new int[0x601];
        int r0 = MinDistance, r1 = MinDistance, r2 = MinDistance;
        int lastEnd = start;
        foreach (var cmd in commands)
        {
            int p = cmd.LitStart;
            for (int i = 0; i < cmd.LitLen; i++)
            {
                int b = data[p + i];
                pi[b] += inc;
                int refIdx = p + i - r0;
                int refb = refIdx >= 0 ? data[refIdx] : 0;
                pi[0x100 + ((b - refb) & 0xff)] += inc;
            }
            if (cmd.LitLen >= 3)
                pi[0x300 + Math.Min(cmd.LitLen - 3, 0xff)] += inc;

            int litField = cmd.LitLen < 3 ? cmd.LitLen : 3;
            int ml = cmd.MatchLen;
            bool isRep = cmd.OffsIndex < 3;
            int matchByte = ml < 0x11 ? ml - 2 : 0xf;
            int off3 = isRep ? cmd.OffsIndex * 0x40 : 0xc0;
            pi[0x200 + litField + matchByte * 4 + off3] += inc;
            if (ml >= 0x11)
                pi[0x300 + Math.Min(ml - 0x11, 0xff)] += inc;
            if (!isRep)
                pi[0x401 + KrakenOptimalCost.OffsetBucketByte(cmd.Distance, out _)] += inc;

            UpdateRecent(ref r0, ref r1, ref r2, cmd.OffsIndex, cmd.Distance);
            lastEnd = cmd.LitStart + cmd.LitLen + cmd.MatchLen;
        }
        // Greedy SEED only (chunkEnd >= 0): the trailing literals after the last match (to chunk end) are
        // tallied into the literal histograms ONLY (no packet/length/offset event). the builds its
        // seed passinfo this way; the DP re-tally (inc=2, chunkEnd=-1) does not add a tail.
        if (chunkEnd > lastEnd)
        {
            for (int p = lastEnd; p < chunkEnd; p++)
            {
                int b = data[p];
                pi[b] += inc;
                int refIdx = p - r0;
                int refb = refIdx >= 0 ? data[refIdx] : 0;
                pi[0x100 + ((b - refb) & 0xff)] += inc;
            }
        }
        return pi;
    }

    /// <summary>
    /// One forward-DP pass (the single-TLL algorithm). Fills the arrival table left to right
    /// with the anchor/accumulated-literal bookkeeping, the lrl loop (0..3, the 4th = the full run from
    /// the anchor), rep relaxation (longest-first gating) and new-match relaxation (new-minimum-base gate,
    /// length-desc candidates, break once a candidate is no longer than the longest rep), then backtraces
    /// the cheapest reachable arrival plus its trailing literals into a command list.
    /// </summary>
    private static List<Command> ForwardDp(ReadOnlySpan<byte> data, int[] dpHead, int[] dpPrev,
        int startPos, int matchLimit, int matchStartLimit, KrakenOptimalCost.CodeCosts cc,
        int[]? adaptPassinfo = null, int adaptLitMode = 1)
    {
        // Level-7 suffix-trie match finder mml=3 (firstbytes=2): build the DP chain AND its
        // candidate query with a 3-byte hash so positions sharing only 3 bytes collide and length-3 matches
        // become visible. Restored in finally so the thread-static never leaks past the DP.
        int saveDpHb = GreedyHashBytesOverride;
        if (UseDpMml3) GreedyHashBytesOverride = DpMml3;
        try
        {
            int chunkEnd = matchLimit + LiteralTail;
            int maxArr = matchLimit; // a match can end at most here
            var arr = new Arrival[maxArr + 1];
            for (int i = 0; i <= maxArr; i++) arr[i].Cost = int.MaxValue;
            arr[startPos] = new Arrival
            {
                Cost = 0,
                R0 = MinDistance,
                R1 = MinDistance,
                R2 = MinDistance,
                Src = startPos,
                Idx = -1,
            };

            // Seed-index the private chain with the chunk's seed bytes [startPos-LiteralTail, startPos) so the
            // DP can find matches that reference the 8-byte COPY_64 seed (e.g. a match that backward-extends
            // into the seed). EncodeChunk indexes these into the shared greedy chain; the DP's private chain
            // must mirror that or it underfinds the very first match (the cmd-0 backward-extension divergence).
            dpHead.AsSpan().Fill(-1);
            int inserted = startPos > LiteralTail ? startPos - LiteralTail : 0;

            // the CacheTableMatchFinder table-bits N = clamp(ceil_log2(len), 18, 24) (algorithm/algorithm
            // saturate then ceil-log2; <19 -> 18, else min(.,24)). Even tiny buffers use N=18 (a 2^18 zero-init table),
            // so the 16-way windows + check bits behave identically to the regardless of input size.
            int ctmfBits;
            {
                int len = data.Length < 1 ? 1 : data.Length;
                int cl = 0;
                while (cl < 24 && (1 << cl) < len) cl++; // ceil_log2(len), capped (no overflow)
                ctmfBits = cl < 18 ? 18 : cl;
            }
            if (CtmfBitsOverride > 0) ctmfBits = CtmfBitsOverride;
            Ctmf? ctmf = UseCtmfFinder ? new Ctmf(ctmfBits, data.Length) : null;
            int ctmfIns = inserted;

            Span<int> cml = stackalloc int[8];
            Span<int> cdist = stackalloc int[8];
            Span<int> coff = stackalloc int[8];

            // Adaptive windowed parse (num_tlls==1 / lvl7): advance in 256-byte
            // commit strides with a 4096-byte lookahead window, committing at a clean re-anchor (frontier fully
            // behind pos) or a window overflow, and re-tallying the committed segment + rebuilding the cost model
            // after every commit. When adaptPassinfo is null the classic single monolithic full-chunk pass runs
            // unchanged (preserving the shipped manifest.json 279==279 byte-identity).
            bool windowed = UseWindowedParse && adaptPassinfo != null;
            int end = matchStartLimit;
            int segStart = startPos;
            List<Command>? outCmds = windowed ? new List<Command>() : null;

            int anchor = startPos;
            long accLit = 0;

            while (true)
            {
                int windowEnd = end;
                if (windowed)
                {
                    anchor = segStart;
                    accLit = 0;
                    // Frontier starts one commit-stride ahead (the maxreached=min(segStart+256,end),
                    // snapped to end when within the no-match zone); relaxations grow it via DpMaxReached.
                    int mr = segStart + WindowCommitStride;
                    if (mr > end) mr = end;
                    if (end - NoMatchZone <= mr) mr = end;
                    DpMaxReached = mr;
                    windowEnd = segStart + WindowLookahead;
                    if (windowEnd > end) windowEnd = end;
                    if (end - NoMatchZone <= windowEnd) windowEnd = end;
                }
                int commitEnd = -1; // -1 ⇒ the pos loop ran to matchStartLimit ⇒ final segment

                for (int pos = segStart; pos <= matchStartLimit; pos++)
                {
                    if (windowed)
                    {
                        if (DpMaxReached > windowEnd) { commitEnd = DpMaxReached; break; } // window overflow
                        if (pos >= end) { commitEnd = -1; break; }                          // final commit at pos==end
                    }
                    if (pos > segStart)
                    {
                        int alo = arr[anchor].R0 < MinDistance ? MinDistance : arr[anchor].R0;
                        accLit += KrakenOptimalCost.CostAddLiteral(data, pos - 1, alo, cc);
                        if (arr[pos].Cost != int.MaxValue)
                        {
                            int run0 = pos - anchor;
                            long viaAnchor = (long)arr[anchor].Cost +
                                             (run0 > 2 ? KrakenOptimalCost.CostLen(cc, run0 - 3) : 0) + accLit;
                            if (arr[pos].Cost < viaAnchor)
                            {
                                anchor = pos;
                                accLit = 0;
                                // Clean re-anchor commit: the frontier is fully behind pos, so every arrival past
                                // pos is still unreached (the invariant that makes the segment cut clean).
                                if (windowed && DpMaxReached <= pos) { commitEnd = pos; break; }
                            }
                        }
                    }

                    inserted = InsertUpTo(data, dpHead, dpPrev, inserted, pos);
                    if (ctmf != null)
                        while (ctmfIns < inserted) { ctmf.Insert(data, ctmfIns); ctmfIns++; }
                    int nc = FindCandidates(data, pos, dpHead, dpPrev, matchLimit, cc, cml, cdist, coff, ctmf);

                    long minBase = long.MaxValue;
                    for (int lrl = 0; lrl <= 3; lrl++)
                    {
                        int run = lrl;
                        if (lrl == 3 && 3 < pos - anchor) run = pos - anchor; // 4th iteration = full run from anchor
                        int src = pos - run;
                        if (src < startPos) continue;
                        if (arr[src].Cost == int.MaxValue) continue;

                        int slo = arr[src].R0 < MinDistance ? MinDistance : arr[src].R0;
                        long litcost = (run == pos - anchor)
                            ? accLit
                            : KrakenOptimalCost.CostLiterals(data, pos - run, run, slo, cc);
                        long baseCost = (long)arr[src].Cost + litcost;
                        int litField = run < 3 ? run : 3;
                        if (run > 2) baseCost += KrakenOptimalCost.CostLen(cc, run - 3);

                        int sr0 = arr[src].R0, sr1 = arr[src].R1, sr2 = arr[src].R2;

                        // Rep matches, longest-first: a shorter rep than one already relaxed is never tried.
                        int longestlo = 0;
                        for (int loi = 0; loi < 3; loi++)
                        {
                            int rdist = loi == 0 ? sr0 : loi == 1 ? sr1 : sr2;
                            if (rdist < MinDistance) continue;
                            int repLen = RepMatchLength(data, pos, rdist, matchLimit);
                            if (repLen < MinRepMatch || repLen <= longestlo) continue;
                            longestlo = repLen;

                            int n1, n2;
                            if (loi == 0) { n1 = sr1; n2 = sr2; }
                            else if (loi == 1) { n1 = sr0; n2 = sr2; }
                            else { n1 = sr0; n2 = sr1; }

                            if (UseSublenGate)
                            {
                                // Full-length relax always; fill rep sublengths only when repLen < 128.
                                RelaxRep(arr, pos, repLen, loi, baseCost, litField, rdist, n1, n2, run, src, cc);
                                if (SublenFillAllowed(3, SublenFillThreshold - 3, repLen))
                                    for (int m = MinRepMatch; m < repLen; m++)
                                        RelaxRep(arr, pos, m, loi, baseCost, litField, rdist, n1, n2, run, src, cc);
                            }
                            else
                            {
                                int hi = repLen < MinRepMatch + 8192 ? repLen : MinRepMatch + 8192;
                                for (int m = MinRepMatch; m <= hi; m++)
                                    RelaxRep(arr, pos, m, loi, baseCost, litField, rdist, n1, n2, run, src, cc);
                                if (repLen > hi)
                                    RelaxRep(arr, pos, repLen, loi, baseCost, litField, rdist, n1, n2, run, src, cc);
                            }

                            // Value the immediate rep0 continuation off this full-length rep match.
                            if (UseFaef0)
                            {
                                long costAtE = baseCost + KrakenOptimalCost.CostLoMatch(cc, litField, repLen, loi);
                                Faef0(arr, data, pos + repLen, costAtE, repLen, run, loi, rdist, src,
                                      rdist, n1, n2, rdist, matchLimit, cc);
                            }
                        }

                        // New-offset matches only when this lrl iteration set a new minimum base. On an EXACT base
                        // tie the DP still relaxes the (later, longer-LRL) run so its earlier-source path can win the
                        // arrival tie (see UseTieBreakLast): the gate becomes <= and RelaxNew keeps the last equal.
                        if (UseTieBreakLast ? baseCost <= minBase : baseCost < minBase)
                        {
                            minBase = baseCost;
                            for (int i = 0; i < nc; i++)
                            {
                                int cm = cml[i];
                                if (cm <= longestlo) break; // candidates are length-desc
                                int d = cdist[i];
                                if (d == sr0 || d == sr1 || d == sr2) continue; // a recent distance is a rep, not new
                                long baseOff = baseCost + coff[i];
                                if (UseSublenGate)
                                {
                                    // Full-length relax always; fill new-match sublengths only when cm < 128.
                                    int newFloor = UseDpMml3 ? 3 : 4;
                                    int newLo = newFloor + 1;
                                    RelaxNew(arr, pos, cm, baseOff, litField, d, sr0, sr1, run, src, cc);
                                    if (SublenFillAllowed(newLo, SublenFillThreshold - newLo, cm))
                                        for (int m = newFloor; m < cm; m++)
                                            RelaxNew(arr, pos, m, baseOff, litField, d, sr0, sr1, run, src, cc);
                                }
                                else
                                {
                                    // the algorithm (faafdump ground truth, pos=1123 d567): the NEW-match
                                    // relax loop runs over EVERY length from the DP mml (3 on the lvl7 mml=3 path,
                                    // else MinMatch=4) up to the full candidate length cm — NOT from MinMatch. A
                                    // len-3 sublen of a longer (cm>=4) match (e.g. arr[1126]=NEW(3,d567)) is the
                                    // FIRST arrival-cost divergence vs the reference; flooring at MinMatch=4 skipped it.
                                    int newFloor = UseDpMml3 ? 3 : MinMatch;
                                    int hi = cm < newFloor + 8192 ? cm : newFloor + 8192;
                                    for (int m = newFloor; m <= hi; m++)
                                        RelaxNew(arr, pos, m, baseOff, litField, d, sr0, sr1, run, src, cc);
                                    if (cm > hi)
                                        RelaxNew(arr, pos, cm, baseOff, litField, d, sr0, sr1, run, src, cc);
                                    else if (cm < newFloor)
                                        // a finder match shorter than the floor (only possible when mml>cm):
                                        // relax it directly as the primary so it is not dropped entirely.
                                        RelaxNew(arr, pos, cm, baseOff, litField, d, sr0, sr1, run, src, cc);
                                }

                                // Value the immediate rep0 continuation off this full-length new match.
                                if (UseFaef0)
                                {
                                    long costAtE = baseOff + KrakenOptimalCost.CostNormalMatch(cc, litField, cm);
                                    Faef0(arr, data, pos + cm, costAtE, cm, run, 3, d, src,
                                          d, sr0, sr1, d, matchLimit, cc);
                                }
                            }
                        }
                    }
                }

                // ---- per-segment commit ----
                if (!windowed)
                {
                    // Classic single monolithic pass (adaptPassinfo == null):unchanged from before.
                    if (DiagArrCapture != null)
                    {
                        var cap = new (int, int, int, int, int, int, int, int)[maxArr + 1];
                        for (int i = 0; i <= maxArr; i++)
                        {
                            Arrival a = arr[i];
                            cap[i] = (a.Cost, a.Src, a.Ml, a.Idx, a.Dist, a.Lrl, a.ContMl, a.R0);
                        }
                        DiagArrCapture = cap;
                    }
                    if (DpProbeHi > 0)
                    {
                        for (int q = DpProbeLo; q <= DpProbeHi && q < arr.Length; q++)
                        {
                            Arrival a = arr[q];
                            if (a.Cost == int.MaxValue)
                                Console.WriteLine($"        [dpprobe] arr[{q}] UNREACHED");
                            else
                                Console.WriteLine($"        [dpprobe] arr[{q}] cost={a.Cost} src={a.Src} lrl={a.Lrl} ml={a.Ml} idx={a.Idx} dist={a.Dist} reps=({a.R0},{a.R1},{a.R2}) cont(lrl={a.ContLrl},ml={a.ContMl})");
                        }
                    }
                    int bestEndNw = EstarSelect(arr, data, startPos, matchLimit, chunkEnd, cc);
                    if (bestEndNw < 0) return new List<Command>();
                    var revNw = BackTraceSeg(arr, startPos, bestEndNw, maxArr);
                    return revNw ?? new List<Command>();
                }

                // Windowed parse: commit this segment.
                bool finalSeg = commitEnd < 0 || commitEnd >= end;
                if (finalSeg)
                {
                    int bestEndF = EstarSelect(arr, data, segStart, matchLimit, chunkEnd, cc);
                    if (bestEndF > segStart)
                    {
                        var segF = BackTraceSeg(arr, segStart, bestEndF, maxArr);
                        if (segF != null) outCmds!.AddRange(segF);
                    }
                    return outCmds!;
                }

                var seg = BackTraceSeg(arr, segStart, commitEnd, maxArr);
                if (seg == null) return outCmds!; // trace failed → return the committed prefix (ParseOptimal reselects)
                outCmds!.AddRange(seg);
                // Re-tally the committed segment into the cumulative passinfo and rebuild the cost tables (the
                // reference lvl7 rebuild interval = 1 ⇒ rebuild on every commit).
                int[] tal = Tally(seg, data, segStart);
                int nAdapt = adaptPassinfo!.Length < tal.Length ? adaptPassinfo.Length : tal.Length;
                for (int i = 0; i < nAdapt; i++) adaptPassinfo[i] += tal[i];
                cc = KrakenOptimalCost.BuildFromPassinfo(adaptPassinfo, adaptLitMode);
                segStart = commitEnd;
                if (segStart >= end)
                {
                    int bestEndT = EstarSelect(arr, data, segStart, matchLimit, chunkEnd, cc);
                    if (bestEndT > segStart)
                    {
                        var tail = BackTraceSeg(arr, segStart, bestEndT, maxArr);
                        if (tail != null) outCmds!.AddRange(tail);
                    }
                    return outCmds!;
                }
            } // end while(true) — process the next segment
        }
        finally { GreedyHashBytesOverride = saveDpHb; }
    }

    /// <summary>
    /// Reference E* selection: the cheapest reachable arrival in <c>(from, matchLimit]</c> plus its trailing
    /// literal run to <paramref name="chunkEnd"/>. Returns the winning end index, or -1 if none is reachable.
    /// </summary>
    private static int EstarSelect(Arrival[] arr, ReadOnlySpan<byte> data, int from, int matchLimit,
        int chunkEnd, KrakenOptimalCost.CodeCosts cc)
    {
        int bestEnd = -1;
        long bestTotal = long.MaxValue;
        for (int e = from + 1; e <= matchLimit; e++)
        {
            if (arr[e].Cost == int.MaxValue) continue;
            int lo = arr[e].R0 < MinDistance ? MinDistance : arr[e].R0;
            long total = (long)arr[e].Cost + KrakenOptimalCost.CostLiterals(data, e, chunkEnd - e, lo, cc);
            if (total < bestTotal)
            {
                bestTotal = total;
                bestEnd = e;
            }
        }
        return bestEnd;
    }

    /// <summary>
    /// Backward-traces the arrival chain from <paramref name="to"/> to <paramref name="from"/>, emitting one
    /// <see cref="Command"/> per arrival (a two-step bundle emits its free rep0 continuation first). Returns the
    /// commands in forward order, or null if the chain does not cleanly reach <paramref name="from"/>.
    /// </summary>
    private static List<Command>? BackTraceSeg(Arrival[] arr, int from, int to, int maxArr)
    {
        var rev = new List<Command>();
        int p2 = to;
        int guard = 0;
        while (p2 != from && guard++ <= maxArr)
        {
            Arrival a = arr[p2];
            if (a.Ml <= 0 || a.Src < from || a.Src >= p2)
                break;
            if (a.ContMl > 0)
            {
                // Two-step arrival: a primary match then a free rep0 continuation. Emit later-first
                // (continuation, then primary); the rep0 reuses the primary's distance (idx 0).
                int sCont = a.Src + a.Lrl + a.Ml; // end of primary = start of continuation literals
                rev.Add(new Command(sCont, a.ContLrl, a.R0, a.ContMl, 0));
            }
            rev.Add(new Command(a.Src, a.Lrl, a.Dist, a.Ml, a.Idx));
            p2 = a.Src;
        }
        if (p2 != from)
            return null; // trace did not reach the origin → discard
        rev.Reverse();
        return rev;
    }

    private static void RelaxRep(Arrival[] arr, int pos, int ml, int loi, long baseCost, int litField,
        int r0, int r1, int r2, int run, int src, KrakenOptimalCost.CodeCosts cc)
    {
        long total = baseCost + KrakenOptimalCost.CostLoMatch(cc, litField, ml, loi);
        int dst = pos + ml;
        if (UseWindowedParse && dst > DpMaxReached) DpMaxReached = dst;
        if (DiagWatchDst != 0 && dst == DiagWatchDst)
            Console.WriteLine($"        [watch REP] dst={dst} pos={pos} src={src} run={run} ml={ml} loi={loi} litField={litField} base={baseCost} mc={KrakenOptimalCost.CostLoMatch(cc, litField, ml, loi)} total={total} cur={(arr[dst].Cost == int.MaxValue ? -1 : arr[dst].Cost)} won={(UseTieBreakLast ? total <= arr[dst].Cost : total < arr[dst].Cost)}");
        if (UseTieBreakLast ? total <= arr[dst].Cost : total < arr[dst].Cost)
        {
            arr[dst].Cost = (int)total;
            arr[dst].R0 = r0; arr[dst].R1 = r1; arr[dst].R2 = r2;
            arr[dst].Ml = ml; arr[dst].Lrl = run; arr[dst].Src = src;
            arr[dst].Idx = loi; arr[dst].Dist = r0;
            arr[dst].ContLrl = 0; arr[dst].ContMl = 0;
        }
    }

    private static void RelaxNew(Arrival[] arr, int pos, int ml, long baseWithOff, int litField,
        int dist, int sr0, int sr1, int run, int src, KrakenOptimalCost.CodeCosts cc)
    {
        long total = baseWithOff + KrakenOptimalCost.CostNormalMatch(cc, litField, ml);
        int dst = pos + ml;
        if (UseWindowedParse && dst > DpMaxReached) DpMaxReached = dst;
        if (DiagWatchDst != 0 && dst == DiagWatchDst)
            Console.WriteLine($"        [watch NEW] dst={dst} pos={pos} src={src} run={run} ml={ml} dist={dist} litField={litField} baseWithOff={baseWithOff} mc={KrakenOptimalCost.CostNormalMatch(cc, litField, ml)} total={total} cur={(arr[dst].Cost == int.MaxValue ? -1 : arr[dst].Cost)} won={(UseTieBreakLast ? total <= arr[dst].Cost : total < arr[dst].Cost)}");
        if (UseTieBreakLast ? total <= arr[dst].Cost : total < arr[dst].Cost)
        {
            arr[dst].Cost = (int)total;
            arr[dst].R0 = dist; arr[dst].R1 = sr0; arr[dst].R2 = sr1;
            arr[dst].Ml = ml; arr[dst].Lrl = run; arr[dst].Src = src;
            arr[dst].Idx = 3; arr[dst].Dist = dist;
            arr[dst].ContLrl = 0; arr[dst].ContMl = 0;
        }
    }

    /// <summary>
    /// the rep0-continuation pre-relax. Given a primary match ending at <paramref name="s"/>
    /// whose post-match front offset is <paramref name="contDist"/>, this values the immediate rep0 continuation
    /// — a 3-byte literal/back-extend transition followed by a forward rep0 match at <paramref name="contDist"/> —
    /// and, when the bundled (primary + free continuation) arrival is cheaper, writes it into <c>arr[e2]</c> with
    /// the continuation packet recorded in <see cref="Arrival.ContLrl"/>/<see cref="Arrival.ContMl"/>. The
    /// continuation is always rep0, so the post-continuation recents equal the post-primary recents
    /// (<paramref name="pr0"/>,<paramref name="pr1"/>,<paramref name="pr2"/>). This is the "two-step arrival":
    /// it lets a locally non-minimal match still propagate its free rep cascade. validated against
    /// the forward-extend end cap and recent offsets.
    /// </summary>
    private static void Faef0(Arrival[] arr, ReadOnlySpan<byte> data, int s, long costAtE,
        int primaryMl, int primaryLrl, int primaryIdx, int primaryDist, int src,
        int pr0, int pr1, int pr2, int contDist, int matchLimit,
        KrakenOptimalCost.CodeCosts cc)
    {
        int d = contDist;
        if (s + 3 > matchLimit) return;            // forward-extend window must lie inside the match zone
        if (d < MinDistance || s + 1 - d < 0) return;

        // backExt: 2 if both s+1 and s+2 match their -d back-refs; 1 if only s+2; 0 otherwise.
        int backExt = data[s + 2] == data[s + 2 - d] ? (data[s + 1] == data[s + 1 - d] ? 2 : 1) : 0;
        int fwd = RepMatchLength(data, s + 3, d, matchLimit);
        int lrl2 = 3 - backExt;
        int ml2 = fwd + backExt;
        if (ml2 < MinRepMatch) return;             // guard: only when 1 < ml2

        long cost = costAtE + KrakenOptimalCost.CostLiterals(data, s, lrl2, d, cc);
        int litField2 = lrl2;
        if (lrl2 > 2) { litField2 = 3; cost += KrakenOptimalCost.CostLen(cc, 0); }
        cost += KrakenOptimalCost.CostLoMatch(cc, litField2, ml2, 0);   // loi 0 = rep0

        int e2 = s + lrl2 + ml2;                   // == s + 3 + fwd, always <= matchLimit
        if (UseWindowedParse && e2 > DpMaxReached) DpMaxReached = e2;
        if (DiagWatchDst != 0 && e2 == DiagWatchDst)
            Console.WriteLine($"        [watch FAEF] e2={e2} s={s} src={src} d={d} costAtE={costAtE} backExt={backExt} fwd={fwd} lrl2={lrl2} ml2={ml2} lits={KrakenOptimalCost.CostLiterals(data, s, lrl2, d, cc)} lomatch={KrakenOptimalCost.CostLoMatch(cc, litField2, ml2, 0)} total={cost} cur={(arr[e2].Cost == int.MaxValue ? -1 : arr[e2].Cost)} won={(UseTieBreakLast ? cost <= arr[e2].Cost : cost < arr[e2].Cost)}");
        if (UseTieBreakLast ? cost <= arr[e2].Cost : cost < arr[e2].Cost)
        {
            arr[e2].Cost = (int)cost;
            arr[e2].R0 = pr0; arr[e2].R1 = pr1; arr[e2].R2 = pr2;
            arr[e2].Ml = primaryMl; arr[e2].Lrl = primaryLrl; arr[e2].Src = src;
            arr[e2].Idx = primaryIdx; arr[e2].Dist = primaryDist;
            arr[e2].ContLrl = lrl2; arr[e2].ContMl = ml2;
        }
    }

    /// <summary>
    /// Collects up to four longest distinct-distance new-offset candidates from the causal hash chain plus
    /// a forced distance-8 (init offset) candidate, sorted by length descending, caching each one's
    /// <see cref="KrakenOptimalCost.CostOffset"/>. Approximates the find_all_matches 4-pair table.
    /// </summary>
    private static int FindCandidates(ReadOnlySpan<byte> data, int pos, int[] dpHead, int[] dpPrev,
        int matchLimit, KrakenOptimalCost.CodeCosts cc, Span<int> cml, Span<int> cdist, Span<int> coff,
        Ctmf? ctmf)
    {
        int n = 0;
        if (DiagExternalFinder != null)
        {
            // Reference diagnostic: use the captured match finder table verbatim (4 pairs, len-desc).
            int baseI = pos * 8;
            if (baseI + 8 <= DiagExternalFinder.Length)
            {
                int recMinE = UseDpMml3 ? DpMml3 : MinMatch;
                for (int k = 0; k < 4; k++)
                {
                    int len = DiagExternalFinder[baseI + k * 2];
                    int dist = DiagExternalFinder[baseI + k * 2 + 1];
                    if (len <= 0) break; // length-descending, len<=0 terminates
                    if (dist < MinDistance)
                    {
                        // Mirror the normal SuffixTrie path's sub-8 handling (tiny-offset round-up or skip).
                        if (!UseTinyOffsetRemap) continue;
                        int rounded = RoundUpTiny(dist);
                        if (rounded == 0 || rounded > pos) continue;
                        int rlen = MatchLength(data, pos - rounded, pos, matchLimit);
                        if (rlen < recMinE) continue;
                        len = rlen; dist = rounded;
                    }
                    if (len < recMinE) continue;
                    if (pos + len > matchLimit) len = matchLimit - pos;
                    if (len < recMinE) continue;
                    n = InsertCandidate(cml, cdist, n, len, dist, 4);
                }
            }
            int off8e = RepMatchLength(data, pos, MinDistance, matchLimit);
            if (off8e >= MinMatch)
                n = InsertCandidate(cml, cdist, n, off8e, MinDistance, cml.Length);
            for (int i = 0; i < n; i++)
                coff[i] = KrakenOptimalCost.CostOffset(cdist[i], cc);
            return n;
        }
        if (UseSuffixTrieFinder)
        {
            // Full-history Pareto finder = output-equivalent to the suffix-trie matcher.
            // Walk the whole 4-byte hash chain (most-recent-first ⇒ distance ascending). A
            // candidate is on the Pareto frontier iff it is strictly longer than every CLOSER candidate, so
            // recording (len,dist) only when len exceeds the running best yields the closest offset for each
            // achievable length. Keep the 4 LONGEST pairs (find_all_matches num_pairs==4), ml-descending.
            Span<int> fl = stackalloc int[64];
            Span<int> fd = stackalloc int[64];
            int fn = 0;
            int bestLen = 0;
            int recMin = UseDpMml3 ? DpMml3 : MinMatch; // lvl7 suffix-trie match finder mml (3 vs 4)
            int distFloor = UseTinyOffsetRemap ? 1 : MinDistance; // include dist 1..7 for the round-up below
            uint hs = Hash(data, pos);
            int c = dpHead[hs];
            while (c >= 0)
            {
                int dist = pos - c;
                if (dist >= distFloor)
                {
                    int len = MatchLength(data, c, pos, matchLimit);
                    if (len > bestLen)
                    {
                        bestLen = len;
                        if (len >= recMin && fn < fl.Length) { fl[fn] = len; fd[fn] = dist; fn++; }
                    }
                }
                c = dpPrev[c];
            }
            int keep = fn > 4 ? 4 : fn;
            for (int i = 0; i < keep; i++)
            {
                int idx = fn - 1 - i; // length-ascending array → longest first
                int clen = fl[idx], cdst = fd[idx];
                if (UseTinyOffsetRemap && cdst < MinDistance)
                {
                    // The DP rounds a sub-8 distance up and recomputes its length too.
                    int rounded = RoundUpTiny(cdst);
                    if (rounded == 0 || rounded > pos) continue;
                    int rlen = MatchLength(data, pos - rounded, pos, matchLimit);
                    if (rlen < recMin) continue;
                    clen = rlen;
                    cdst = rounded;
                }
                n = InsertCandidate(cml, cdist, n, clen, cdst, 4);
            }
            int off8s = RepMatchLength(data, pos, MinDistance, matchLimit);
            if (off8s >= MinMatch)
                n = InsertCandidate(cml, cdist, n, off8s, MinDistance, cml.Length);
            for (int i = 0; i < n; i++)
                coff[i] = KrakenOptimalCost.CostOffset(cdist[i], cc);
            return n;
        }
        int bestCtmfLen = 0;
        if (ctmf != null)
        {
            // the CacheTableMatchFinder emits strictly-length-improving (len,dist) pairs scanning row A then
            // row B (shared monotonic prevml), already distinct/ascending in length. Feed them
            // longest-first into the length-descending candidate set.
            Span<int> qlen = stackalloc int[40];
            Span<int> qdist = stackalloc int[40];
            int qn = ctmf.Query(data, pos, matchLimit, qlen, qdist);
            for (int i = qn - 1; i >= 0; i--)
            {
                n = InsertCandidate(cml, cdist, n, qlen[i], qdist[i], 4);
                if (qlen[i] > bestCtmfLen) bestCtmfLen = qlen[i];
            }
        }
        if (ctmf == null || UseChainUnion || UseLrmSupplement)
        {
            // Strictly-longer-only when supplementing the CTMF (the LRM-equivalent path); full union otherwise.
            bool supplement = ctmf != null && !UseChainUnion;
            uint h = Hash(data, pos);
            int cand = dpHead[h];
            int walk = 0;
            while (cand >= 0 && walk < ChainWalkLimit)
            {
                int dist = pos - cand;
                if (dist >= MinDistance)
                {
                    int len = MatchLength(data, cand, pos, matchLimit);
                    if (len >= MinMatch && (!supplement || len > bestCtmfLen))
                        n = InsertCandidate(cml, cdist, n, len, dist, 4);
                }
                cand = dpPrev[cand];
                walk++;
            }
        }
        int off8 = RepMatchLength(data, pos, MinDistance, matchLimit);
        if (off8 >= MinMatch)
            n = InsertCandidate(cml, cdist, n, off8, MinDistance, cml.Length);
        for (int i = 0; i < n; i++)
            coff[i] = KrakenOptimalCost.CostOffset(cdist[i], cc);
        return n;
    }

    /// <summary>
    /// DIAGNOSTIC (default-unused, TEST-ONLY): dumps the per-position level-7 finder Pareto table so it can be
    /// diffed against the <c>match finder</c> (find_all_matches) output captured
    /// by the findump diagnostic. For each position it walks the SAME 4-byte hash chain <see cref="FindCandidates"/>
    /// uses (most-recent-first ⇒ distance ascending) and records the closest-offset-per-length frontier,
    /// length-descending, up to 4 pairs — the pure find_all_matches analog (NO rep0/off-8 supplement, which the
    /// DP adds separately). Layout = <c>data.Length * 8</c> ints = {len0,dist0,len1,dist1,len2,dist2,len3,dist3}
    /// per position (0 = unused slot). <paramref name="recMin"/> sets the minimum recorded length (4 = production
    /// mml; the num_firstbytes=2 finder also reports len 2/3 which a 4-byte hash cannot surface).
    /// </summary>
    internal static int[] DiagDumpFinderTable(ReadOnlySpan<byte> data, int recMin = MinMatch)
    {
        int n = data.Length;
        var head = new int[HashSize];
        var prev = new int[n];
        head.AsSpan().Fill(-1);
        int inserted = 0;
        var table = new int[n * 8];
        Span<int> fl = stackalloc int[128];
        Span<int> fd = stackalloc int[128];
        int matchLimit = n;
        int posEnd = n - 3; // Hash reads data[pos+3]; tail positions [n-3,n) left as empty slots
        for (int pos = 0; pos < posEnd; pos++)
        {
            inserted = InsertUpTo(data, head, prev, inserted, pos);
            int fn = 0, bestLen = 0;
            uint hs = Hash(data, pos);
            int c = head[hs];
            while (c >= 0)
            {
                int dist = pos - c;
                if (dist >= MinDistance)
                {
                    int len = MatchLength(data, c, pos, matchLimit);
                    if (len > bestLen)
                    {
                        bestLen = len;
                        if (len >= recMin && fn < fl.Length) { fl[fn] = len; fd[fn] = dist; fn++; }
                    }
                }
                c = prev[c];
            }
            int keep = fn > 4 ? 4 : fn;
            int bas = pos * 8;
            for (int i = 0; i < keep; i++)
            {
                int idx = fn - 1 - i; // length-ascending record → longest first
                table[bas + i * 2] = fl[idx];
                table[bas + i * 2 + 1] = fd[idx];
            }
        }
        return table;
    }

    /// <summary>Inserts (len,dist) into the length-descending candidate arrays, deduping by distance, capped at <paramref name="cap"/>.</summary>
    private static int InsertCandidate(Span<int> cml, Span<int> cdist, int n, int len, int dist, int cap)
    {
        for (int k = 0; k < n; k++)
            if (cdist[k] == dist)
                return n; // keep the first (longest) occurrence of this distance
        int posi = 0;
        while (posi < n && cml[posi] >= len) posi++;
        if (posi >= cap)
            return n;
        int last = n < cap ? n : cap - 1;
        for (int k = last; k > posi; k--) { cml[k] = cml[k - 1]; cdist[k] = cdist[k - 1]; }
        cml[posi] = len; cdist[posi] = dist;
        return n < cap ? n + 1 : n;
    }

    /// <summary>
    /// The level-7 match finder is a <b>flat 2-row, 16-way check-bit cache table</b> (NOT a hash chain):
    /// <list type="bullet">
    /// <item><b>One flat table</b> <c>uint[1&lt;&lt;N]</c>, <b>zero-initialised</b> (memset 0), shared by both rows;
    /// N = <c>clamp(ceil_log2(len), 18, 24)</c> (so N=18 for our vectors). Each entry packs
    /// <c>{position: low 26 bits (0x03FFFFFF), check: top 6 bits (0xFC000000)}</c>; window = 2^26.</item>
    /// <item><b>Row A (4-byte context):</b> <c>hash1 = rotl32(low32(read32(ptr)·0xB7A56463), N)</c>; index =
    /// <c>hash1 &amp; ((1&lt;&lt;N)−16)</c> (bits [4..N), 16-aligned); the stored/compared <c>check</c> = the top
    /// 6 bits of hash1. <b>Row B (8-byte context):</b> index =
    /// <c>((read64(ptr)·0xCF1BBCDCB7A56463) &gt;&gt; (64−N)) &amp; ~0xF</c> (16-aligned). Both select a 16-entry
    /// window <c>table[idx.. idx+16)</c>; the rows are decorrelated.</item>
    /// <item><b>Insert</b> FIFO-shifts both rows: <c>memmove(ways+1, ways, 15·4)</c> then
    /// <c>ways[0] = (pos &amp; 0x3FFFFFF) | (check &amp; 0xFC000000)</c> — newest at slot 0.</item>
    /// <item><b>Query</b> scans row A then row B (newest-first). Per way: reject unless
    /// <c>(entry &amp; 0xFC000000) == check</c>; <c>dist = ((pos−1−epos) &amp; 0x3FFFFFF) + 1</c>; require
    /// <c>dist &lt;= pos</c> (in-window); 4-byte verify; full length; emit <c>(len,dist)</c> only when
    /// <c>len &gt; prevml</c> (the asserted <c>"len &gt; prevml"</c>, ctmf.cpp:0xe7/0x11d). <c>prevml</c>
    /// is <b>reset to 0 at the start of each row</b> (match finder), so each row emits its
    /// own strictly length-increasing subsequence; the two rows' emissions are then sort+dedup-by-length, keep ≤4.</item>
    /// </list>
    /// Empty slots (entry 0) are naturally rejected by the check compare + 4-byte verify (a position-0 spurious
    /// hit only survives when the bytes truly match — the reference-faithful, benign). This exact bounded retention is what
    /// the depth sweep proved no hash-chain depth reproduces (shallow under-supplies cmd-34's far copy, deep
    /// over-supplies cmd-35). the separate windowed long-range matcher emits only matches ≥256 B and is
    /// excluded here (it cannot supply the 55-byte far copy).
    /// </summary>
    private sealed class Ctmf
    {
        private const uint Mul4 = 0xB7A56463u;            // row-A 4-byte context multiplier (shared mul >> 32)
        private const ulong Mul8 = 0xCF1BBCDCB7A56463UL;  // row-B 8-byte context multiplier
        private const int Ways = 16;                       // 16 entries per row window (the reference SIMD 16-lane width)
        private const uint PosMask = 0x03FFFFFFu;          // entry low 26 bits = position
        private const uint CheckMask = 0xFC000000u;        // entry top 6 bits = check

        private readonly int _bits;
        private readonly int _ways;                        // window length (16 = faithful; CtmfWaysOverride probes retention depth)
        private readonly int _maskA;                       // (1<<bits) - 16 (row-A index mask, 16-aligned, faithful)
        private readonly int _shiftB;                      // 64 - bits (row-B top-bits shift)
        private readonly uint[] _table;                    // ONE flat 2^bits table (+pad), zero-init (both rows share it)

        public Ctmf(int bits, int dataLength)
        {
            _ = dataLength;
            _bits = bits & 31;
            if (_bits < 5) _bits = 5;                      // need >= 4 index bits above the 16-way window
            _ways = CtmfWaysOverride > 0 ? CtmfWaysOverride : Ways;
            _maskA = (1 << _bits) - Ways;                  // index stays 16-aligned; only the window length varies
            _shiftB = 64 - _bits;
            _table = new uint[(1 << _bits) + 64];          // memset 0; +64 pads windows longer than 16
        }

        private static uint Read32(ReadOnlySpan<byte> d, int p)
        {
            uint v = 0; int n = d.Length;
            for (int i = 0; i < 4; i++) { int q = p + i; if ((uint)q < (uint)n) v |= (uint)d[q] << (8 * i); }
            return v;
        }

        private static ulong Read64(ReadOnlySpan<byte> d, int p)
        {
            ulong v = 0; int n = d.Length;
            for (int i = 0; i < 8; i++) { int q = p + i; if ((uint)q < (uint)n) v |= (ulong)d[q] << (8 * i); }
            return v;
        }

        private static uint Rotl32(uint v, int r) { r &= 31; return r == 0 ? v : (v << r) | (v >> (32 - r)); }

        // row-A / hash1 = rotl32(low32(read32(ptr) * 0xB7A56463), bits ); the top 6 bits are the stored check.
        private uint Hash1(ReadOnlySpan<byte> d, int p) => Rotl32(Read32(d, p) * Mul4, _bits);
        private int RowA(uint h1) => (int)(h1 & (uint)_maskA);
        // row-B index = ((read64(ptr) * 0xCF1BBCDCB7A56463) >> (64-bits)) & ~0xF (16-aligned, in [0, 2^bits)).
        private int RowB(ReadOnlySpan<byte> d, int p) => (int)((uint)((Read64(d, p) * Mul8) >> _shiftB) & ~(uint)0xF);

        /// <summary>Inserts position <paramref name="p"/> into both hash rows (16-way FIFO shift, newest at slot 0).</summary>
        public void Insert(ReadOnlySpan<byte> d, int p)
        {
            uint h1 = Hash1(d, p);
            uint entry = ((uint)p & PosMask) | (h1 & CheckMask);
            InsertRow(RowA(h1), entry);
            InsertRow(RowB(d, p), entry);
        }

        private void InsertRow(int row, uint entry)
        {
            uint[] t = _table;
            for (int k = Ways - 1; k > 0; k--) t[row + k] = t[row + k - 1];
            t[row] = entry;
        }

        /// <summary>
        /// Scans row A then row B (newest-first), emitting strictly-length-improving (len,dist) pairs into
        /// <paramref name="outLen"/>/<paramref name="outDist"/> with a shared monotonic prevml (the
        /// across both rows). Returns the pair count (ascending, distinct lengths == the post sort+dedup set).
        /// </summary>
        public int Query(ReadOnlySpan<byte> d, int pos, int matchLimit, Span<int> outLen, Span<int> outDist)
        {
            int n = 0;
            uint h1 = Hash1(d, pos);
            uint check = h1 & CheckMask;
            if (!CtmfRowAOff)
            {
                int prevmlA = 0;   // the reference resets the threshold to 0 at the start of EACH row (match finder)
                n = ScanRow(d, pos, matchLimit, RowA(h1), check, ref prevmlA, outLen, outDist, n);
            }
            int prevmlB = 0;       // row B starts its strictly-increasing subsequence fresh (NOT continuing row A)
            n = ScanRow(d, pos, matchLimit, RowB(d, pos), check, ref prevmlB, outLen, outDist, n);
            return n;
        }

        private int ScanRow(ReadOnlySpan<byte> d, int pos, int matchLimit, int row, uint check,
            ref int prevml, Span<int> outLen, Span<int> outDist, int n)
        {
            uint[] t = _table;
            for (int w = 0; w < Ways; w++)
            {
                uint entry = t[row + w];
                if ((entry & CheckMask) != check) continue;          // check-bit reject (also drops empty slots)
                int epos = (int)(entry & PosMask);
                int dist = (int)(((uint)(pos - 1 - epos) & PosMask) + 1);
                if (dist < MinDistance) continue;
                if (dist > pos) continue;                            // in-window: dist <= (ptr - base) = pos
                int cand = pos - dist;
                if (Read32(d, cand) != Read32(d, pos)) continue;     // 4-byte verify
                int len = MatchLength(d, cand, pos, matchLimit);
                if (len > prevml)                                    // strictly longer (assert "len > prevml")
                {
                    if (n < outLen.Length) { outLen[n] = len; outDist[n] = dist; n++; }
                    prevml = len;
                }
            }
            return n;
        }
    }
}
