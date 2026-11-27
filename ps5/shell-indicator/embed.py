"""Embed one ELF as aligned read-only bytes for the agent injector."""

import json
import pathlib
import re
import sys

output, source, symbol = sys.argv[1:]
if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*", symbol):
    raise SystemExit("invalid symbol")
source_path = pathlib.Path(source)
if not source_path.is_file():
    raise SystemExit(f"missing helper ELF: {source_path}")
assembly = (
    ".section .rodata\n.balign 16\n"
    f".global {symbol}\n{symbol}:\n.incbin \"{source_path.resolve().as_posix()}\"\n"
    f".global {symbol}_size\n.balign 8\n{symbol}_size:\n"
    f".quad {source_path.stat().st_size}\n.previous\n"
)
pathlib.Path(output).write_text("__asm__(" + json.dumps(assembly) + ");\n")
