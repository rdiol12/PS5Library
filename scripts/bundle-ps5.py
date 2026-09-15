"""Embed built assets without introducing a binary packager dependency."""
import json
import pathlib
import sys

output, frontend, assets, config, font, license_file, certificates = map(pathlib.Path, sys.argv[1:])
files = dict(frontend=frontend, icon=assets/'icon0.png', param=assets/'param.json', launch=assets/'launch.html',
             config=config, font=font, font_license=license_file, certificates=certificates)
lines = []
for name, filename in files.items():
    if not filename.is_file():
        raise SystemExit(f'Missing bundle input: {filename}')
    path = filename.resolve().as_posix()
    assembly = f'.section .rodata\n.balign 16\n.global {name}\n{name}:\n.incbin "{path}"\n.global {name}_size\n.balign 8\n{name}_size:\n.quad {filename.stat().st_size}\n.previous\n'
    lines.append('__asm__(' + json.dumps(assembly) + ');')
output.write_text('\n'.join(lines) + '\n', encoding='utf-8')
