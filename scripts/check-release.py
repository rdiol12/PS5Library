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
    files = subprocess.check_output(
        ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard']
    ).decode().split('\0')[:-1]
    if not files:
        raise ValueError('No tracked release files')
    roots = {'frontend', 'server', 'scripts', '.github'}
    standalone = {'.gitignore', '.gitattributes', 'LICENSE', 'NOTICE.txt', 'README.md'}
    synthetic_archives = {
        'server/worker/Tests/Fixtures/homebrew.part1.rar',
        'server/worker/Tests/Fixtures/homebrew.part2.rar',
        'server/worker/Tests/Fixtures/homebrew.part3.rar',
        'server/worker/Tests/Fixtures/homebrew.part4.rar',
    }
    public_modulus_path = 'server/upstream/LibProsperoPKG-drakmor/src/LibProsperoPkg/Keys/Data/token.hex'
    public_modulus_digest = '45add04f296a01dcc291f5b1c938ae2fe463304ae3a0b40bead59ed0832566ec'
    vendored_resources = {
        'server/upstream/LibProsperoPKG-drakmor/src/LibProsperoPkg/Keys/Data/passcode.bin': '81e8283d582f522d8da34565ecd6ab39a38b3d3c0cacef078df97d2b285ec24e',
        'server/upstream/LibProsperoPKG-drakmor/src/LibProsperoPkg/Keys/Data/mount_image.bin': '4510462812321cea26b4c0155e363955b16e31b89252b92510accad02eca5cd0',
        'server/upstream/LibProsperoPKG-drakmor/src/LibProsperoPkg/PlayGo/Data/right.sprx': 'acb7d999f31ffc73bbfff703c7866455a89f35f8a7f4feebc152edf40f707d50',
    }
    vendored_resources[public_modulus_path] = public_modulus_digest
    forbidden_suffixes = {'.log', '.elf', '.pkg', '.ffpkg', '.ffpfs', '.ffpfsc',
                          '.exfat', '.pup', '.key', '.exe', '.dll', '.pdb', '.db',
                          '.sqlite', '.sqlite3', '.dmp', '.core'}
    for name in files:
        path = Path(name)
        if not path.exists():
            continue
        if (path.parts[0] not in roots and name not in standalone or
                path.suffix.lower() in forbidden_suffixes or
                (path.suffix.lower() in {'.zip', '.7z', '.rar'} and name not in synthetic_archives) or
                (path.suffix.lower() in {'.bin', '.sprx'} and name not in vendored_resources) or
                (path.suffix.lower() == '.md' and path.name != 'README.md') or
                any(part in {'build', 'dist', 'bin', 'obj', 'node_modules', 'TestResults'} for part in path.parts) or
                (path.name.startswith('.env') and path.name != '.env.example') or path.is_symlink()):
            raise ValueError('Excluded file in export: ' + name)
        if name in vendored_resources:
            if hashlib.sha256(path.read_bytes()).hexdigest() != vendored_resources[name]:
                raise ValueError('Vendored resource hash mismatch: ' + name)
            continue
        if path.suffix.lower() in {'.png', '.dds', '.gz', '.xz', '.rar', '.at9', '.ttf'}:
            continue
        if path.suffix.lower() == '.otf':
            data = path.read_bytes()
            if data[:4] != b'OTTO' or not 64 <= len(data) <= 2 * 1024 * 1024:
                raise ValueError('Invalid bundled OpenType font: ' + name)
            continue
        text = path.read_text(encoding='utf-8')
        if re.search(r'-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----|gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]+|C:\\Users\\|192\.168\.50\.', text):
            raise ValueError('Private material in export: ' + name)
    print(f'Checked {len(files)} public files; no excluded files or private credentials')


def check_release(folder):
    source = Path('frontend/ps5/common/version.hpp').read_text()
    version = re.search(r'appVersion="([0-9.]+)"', source)[1]
    build = int(re.search(r'appBuild=([0-9]+)', source)[1])
    ref = os.environ.get('GITHUB_REF', '')
    if ref.startswith('refs/tags/') and ref != 'refs/tags/v' + version:
        raise ValueError('Release tag must equal the application version: v' + version)
    metadata = json.loads((folder / 'ps5library-install.elf.json').read_text())
    hashes = {}
    for name in ('ps5library.elf', 'ps5library-agent.elf', 'ps5library-install.elf'):
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
