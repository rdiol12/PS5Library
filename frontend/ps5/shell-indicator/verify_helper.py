"""Fail closed if the injected helper no longer matches the pinned loader ABI."""

from pathlib import Path
import re
import subprocess
import sys


def readelf(tool: str, option: str, elf: str) -> str:
    return subprocess.check_output(
        [tool, option, elf], text=True, timeout=20, stderr=subprocess.STDOUT
    )


options = sys.argv[3:]
if len(options) != len(set(options)) or not set(options) <= {
    "--input-diagnostic",
    "--cheat-page",
}:
    raise SystemExit(
        "usage: verify_helper.py <readelf> <helper.elf> "
        "[--input-diagnostic] [--cheat-page]"
    )

tool, filename = sys.argv[1:3]
size = Path(filename).stat().st_size
assert 64 <= size <= 4 * 1024 * 1024, f"unexpected helper size: {size}"

header = readelf(tool, "-hW", filename)
assert re.search(r"Type:\s+DYN\b", header), "helper must be ET_DYN"
assert "Advanced Micro Devices X86-64" in header, "helper must be x86-64"
entry = re.search(r"Entry point address:\s+(0x[0-9a-fA-F]+)", header)
assert entry and int(entry.group(1), 16) != 0, "helper entry point is missing"

dynamic = readelf(tool, "-dW", filename)
needed = re.findall(r"\(NEEDED\).*\[([^]]+)\]", dynamic)
expected = {
    "libkernel_sys.sprx",
    "libSceLibcInternal.sprx",
    "libSceNet.sprx",
}
assert set(needed) == expected, f"unexpected helper dependencies: {needed}"

relocations = readelf(tool, "-rW", filename)
types = set(re.findall(r"\b(R_X86_64_[A-Z0-9_]+)\b", relocations))
# OnionHEN's pinned elfldr applies RELATIVE before entering the PS5 SDK CRT.
# crt1 then resolves GLOB_DAT imports from the supplied payload arguments.
assert "R_X86_64_RELATIVE" in types, "helper has no base relocations"
assert types <= {"R_X86_64_RELATIVE", "R_X86_64_GLOB_DAT"}, (
    f"unsupported helper relocation types: {sorted(types)}"
)

binary = Path(filename).read_bytes()
assert b"/system_tmp/ps5library/icon0.png" in binary, "embedded icon path missing"
assert b"/user/appmeta/PPSA99051/icon0.png" not in binary, (
    "helper must not depend on installed app metadata"
)
assert b"\x89PNG\r\n\x1a\n" in binary, "embedded icon data missing"
input_markers = (
    b"/system_tmp/ps5library/options-input.trace",
    b"Sce.PlayStation.Core.dll",
    b"Sce.PlayStation.Core.Input",
    b"GamePad",
    b"GetData",
)
if "--input-diagnostic" in options:
    for marker in input_markers:
        assert marker in binary, f"input diagnostic marker missing: {marker!r}"
else:
    for marker in input_markers:
        assert marker not in binary, f"input diagnostic unexpectedly enabled: {marker!r}"

cheat_markers = (
    b"/system_tmp/ps5library/cheat-shell-session",
    b"/system_tmp/ps5library/cheats.snapshot.v1",
    b"RuntimeAssembly",
    b"GetManifestResourceStream",
    b"SettingPage",
    b"OnPressed",
    b"PS5Library Cheats",
)
if "--cheat-page" in options:
    for marker in cheat_markers + (b"127.0.0.1",):
        assert marker in binary, f"cheat page marker missing: {marker!r}"
else:
    for marker in cheat_markers:
        assert marker not in binary, f"cheat page unexpectedly enabled: {marker!r}"

print(f"{filename}: injected helper ABI PASS ({size} bytes)")
