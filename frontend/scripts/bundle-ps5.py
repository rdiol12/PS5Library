"""Embed built assets without introducing a binary packager dependency."""
import json
import pathlib
import sys
import hashlib
import base64
import re

if sys.argv[1] == '--metadata':
    installer, version_file, key_file = map(pathlib.Path, sys.argv[2:])
    source = version_file.read_text()
    key = base64.b64decode(''.join(key_file.read_text().splitlines()[1:-1]), validate=True)
    metadata = dict(version=re.search(r'appVersion="([0-9.]+)"', source)[1],
                    build=int(re.search(r'appBuild=([0-9]+)', source)[1]),
                    sha256=hashlib.sha256(installer.read_bytes()).hexdigest(), keySha256=hashlib.sha256(key).hexdigest())
    pathlib.Path(str(installer) + '.json').write_text(json.dumps(metadata), encoding='utf-8')
    sys.exit(0)

if sys.argv[1] == '--ui':
    output, font, heading_font, license_file, certificates = map(pathlib.Path, sys.argv[2:])
    files = dict(ui_font=font, ui_heading_font=heading_font, ui_font_license=license_file, ui_certificates=certificates)
else:
    output, frontend, assets, config, font, heading_font, license_file, certificates = map(pathlib.Path, sys.argv[1:])
    files = dict(frontend=frontend, icon=assets/'icon0.png', icon_dds=assets/'icon0.dds', home=assets/'pic0.png', home_dds=assets/'pic0.dds', launch_background=assets/'pic1.png', launch_background_dds=assets/'pic1.dds', param=assets/'param.json', launch=assets/'launch.html',
                 config=config, font=font, heading_font=heading_font, font_license=license_file, certificates=certificates)
lines = []
for name, filename in files.items():
    if not filename.is_file():
        raise SystemExit(f'Missing bundle input: {filename}')
    path = filename.resolve().as_posix()
    assembly = f'.section .rodata\n.balign 16\n.global {name}\n{name}:\n.incbin "{path}"\n.global {name}_size\n.balign 8\n{name}_size:\n.quad {filename.stat().st_size}\n.previous\n'
    lines.append('__asm__(' + json.dumps(assembly) + ');')
output.write_text('\n'.join(lines) + '\n', encoding='utf-8')
