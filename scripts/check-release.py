"""Check the frontend export or built release before publication."""
import hashlib
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys


def check_source():
    files = subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0')[:-1]
    if not files:
        raise ValueError('No tracked frontend files')
    roots = {'ps5', 'ios', 'scripts', 'docker', '.github', 'licenses'}
    standalone = {'.gitignore', '.gitattributes', '.dockerignore', 'LICENSE', 'NOTICE.txt', 'README.md'}
    for name in files:
        path = Path(name)
        if (path.parts[0] not in roots and name not in standalone or
                path.suffix.lower() in {'.log', '.elf', '.key'} or
                (path.suffix.lower() == '.md' and name != 'README.md') or
                'build' in path.parts or path.name.startswith('.env') or path.is_symlink()):
            raise ValueError('Excluded file in export: ' + name)
        if path.suffix.lower() in {'.png', '.dds', '.gz', '.xz', '.zip'}:
            continue
        if path.suffix.lower() == '.otf':
            data = path.read_bytes()
            if data[:4] != b'OTTO' or not 64 <= len(data) <= 2 * 1024 * 1024:
                raise ValueError('Invalid bundled OpenType font: ' + name)
            continue
        text = path.read_text(encoding='utf-8')
        if re.search(r'-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]+|192\.168\.50\.', text):
            raise ValueError('Private material in export: ' + name)
    print(f'Checked {len(files)} frontend files; no excluded files or private credentials')


def check_release(folder):
    source = Path('ps5/common/version.hpp').read_text()
    version = re.search(r'appVersion="([0-9.]+)"', source)[1]
    build = int(re.search(r'appBuild=([0-9]+)', source)[1])
    ref = os.environ.get('GITHUB_REF', '')
    if ref.startswith('refs/tags/') and ref != 'refs/tags/v' + version:
        raise ValueError('Release tag must equal the application version: v' + version)
    metadata = json.loads((folder / 'ps5library-install.elf.json').read_text())
    hashes = {}
    for name in ('ps5library.elf', 'ps5library-install.elf'):
        data = (folder / name).read_bytes()
        if (len(data) < 64 or data[:6] != b'\x7fELF\x02\x01' or
                struct.unpack_from('<H', data, 18)[0] != 62 or
                not 0 < len(data) <= 96 * 1024 * 1024):
            raise ValueError('Invalid PS5 x86-64 ELF: ' + name)
        hashes[name] = hashlib.sha256(data).hexdigest()
    if (metadata['version'] != version or metadata['build'] != build or
            metadata['sha256'] != hashes['ps5library-install.elf']):
        raise ValueError('Installer metadata/hash mismatch')
    (folder / 'SHA256SUMS').write_text(''.join(f'{value}  {name}\n' for name, value in hashes.items()))
    print(json.dumps(dict(version=version, build=build, hashes=hashes)))


if __name__ == '__main__':
    if sys.argv[1:] == ['--source']:
        check_source()
    else:
        check_release(Path(sys.argv[1]))
