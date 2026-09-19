"""Verify the pinned native tool's FSELF round trip without ignoring mapped bytes."""
import struct


def verify_readback(original: bytes, extracted: bytes):
    assert len(original) == len(extracted), "FSELF readback size differs"
    if original == extracted:
        return
    assert original[:6] == b"\x7fELF\x02\x01", "Expected little-endian ELF64"
    offset = struct.unpack_from("<Q", original, 32)[0]
    size, count = struct.unpack_from("<HH", original, 54)
    assert size == 56 and count > 0 and offset + size * count <= len(original)
    # ProsperoTV build_tail_note() appends this non-mapped SIE build-id note.
    # self_container::select_segments() does not serialize it. Permit exactly
    # that omission; every header, mapped byte and other record must match.
    tail = len(original) - 24
    note = struct.unpack_from("<IIQQQQQQ", original, offset + size * (count - 1))
    assert note == (4, 0, tail, 0, 0, 24, 0, 4), "Unexpected trailing note"
    assert tail >= offset + size * count
    assert original[tail:tail + 16] == struct.pack("<III4s", 4, 8, 3, b"SIE\0")
    assert extracted == original[:tail] + bytes(24), "FSELF readback differs outside the omitted note"


if __name__ == "__main__":
    source = bytearray(144)
    source[:6] = b"\x7fELF\x02\x01"
    struct.pack_into("<Q", source, 32, 64)
    struct.pack_into("<HH", source, 54, 56, 1)
    struct.pack_into("<IIQQQQQQ", source, 64, 4, 0, 120, 0, 0, 24, 0, 4)
    source[120:] = struct.pack("<III4s8s", 4, 8, 3, b"SIE\0", b"build-id")
    expected = bytes(source[:120]) + bytes(24)
    verify_readback(bytes(source), bytes(source))
    verify_readback(bytes(source), expected)
    for position in (0, 63, 119, 120, 143):
        corrupt = bytearray(expected)
        corrupt[position] ^= 1
        try:
            verify_readback(bytes(source), bytes(corrupt))
        except AssertionError:
            continue
        raise AssertionError("Corrupt FSELF readback accepted")
    print("FSELF round-trip checks passed")
