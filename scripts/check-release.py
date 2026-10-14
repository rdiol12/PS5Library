"""Check the frontend export or built release before publication."""
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import struct
import subprocess
import sys
import zlib


PRIVATE_KEY = re.compile(r'-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----')
ACCESS_TOKEN = re.compile(r'gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]+')
WINDOWS_HOME = re.compile(r'[A-Za-z]:\\Users\\', re.IGNORECASE)
PERSONAL_HOME_OR_HOST = re.compile(
    r'/(?:home|Users)/(?!(?:user|example)(?:/|\b))[^/\s]+|\.ts\.net\b', re.IGNORECASE
)
IPV4 = re.compile(r'(?<![\d.])((?:\d{1,3}\.){3}\d{1,3})(?![\d.])')
IPV6 = re.compile(r'(?<![\w.-])(\[?(?:[0-9A-Fa-f]*:){2,}[0-9A-Fa-f:.]*\]?)(?![\w.-])')
EMAIL = re.compile(r'\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b', re.IGNORECASE)
URL_CREDENTIAL = re.compile(r'https?://[^\s/?#@:]+:([^\s/?#@]+)@', re.IGNORECASE)
CREDENTIAL = re.compile(
    r'(?<![-\w])(?:password|passwd|secret|token|api[_-]?key|api[_-]?token|private[_-]?key)'
    r'\b["\']?\s*[:=]\s*(["\'])([^"\'\r\n]{8,})\1',
    re.IGNORECASE,
)
UNQUOTED_CREDENTIAL = re.compile(
    r'^\s*(?:[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|API_TOKEN|PRIVATE_KEY)'
    r'[A-Z0-9_]*)\s*[:=]\s*([^\s#,"\']{8,})\s*(?:#.*)?$',
    re.IGNORECASE | re.MULTILINE,
)
ENV_CREDENTIAL = re.compile(
    r'^\s*(?:export\s+)?(?:[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_KEY|API_TOKEN|PRIVATE_KEY)'
    r'[A-Z0-9_]*)\s*[:=]\s*([^\s#,"\']{8,})\s*(?:#.*)?$',
    re.MULTILINE,
)
UNQUOTED_CONFIG_SUFFIXES = {
    '.conf',
    '.config',
    '.env',
    '.ini',
    '.properties',
    '.toml',
    '.txt',
    '.yaml',
    '.yml',
}
PLACEHOLDER = re.compile(
    r'^(?:\$\{|GENERATE_WITH_|pass(?:word)?$|sample-|example-|placeholder-|replace-|test-|\[redacted\])',
    re.IGNORECASE,
)
GENERIC_CIDRS = {
    '10.0.0.0/8',
    '100.64.0.0/10',
    '127.0.0.0/8',
    '169.254.0.0/16',
    '172.16.0.0/12',
    '192.168.0.0/16',
}
GENERIC_IPV6 = (ipaddress.ip_network('2001:db8::/32'),)
GENERIC_IPV6_CIDRS = {'::1/128', 'fc00::/7', 'fe80::/10'}
PNG_SIGNATURE = b'\x89PNG\r\n\x1a\n'
PNG_TEXT_CHUNKS = {b'eXIf', b'iTXt', b'tEXt', b'zTXt'}


def png_violation(path):
    """Return why a PNG is unsafe to publish, or None for a plain valid PNG."""
    data = path.read_bytes()
    if not data.startswith(PNG_SIGNATURE):
        return 'bad signature'
    offset = len(PNG_SIGNATURE)
    first = True
    while offset + 12 <= len(data):
        size = struct.unpack_from('>I', data, offset)[0]
        end = offset + 12 + size
        if end > len(data):
            return 'truncated chunk'
        kind = data[offset + 4 : offset + 8]
        payload = data[offset + 8 : offset + 8 + size]
        expected_crc = struct.unpack_from('>I', data, offset + 8 + size)[0]
        if zlib.crc32(kind + payload) & 0xFFFFFFFF != expected_crc:
            return 'invalid chunk checksum'
        if first and (kind != b'IHDR' or size != 13):
            return 'missing header'
        if kind in PNG_TEXT_CHUNKS:
            return 'text or EXIF metadata'
        if kind == b'IEND':
            if size != 0 or end != len(data):
                return 'invalid end chunk'
            return None
        first = False
        offset = end
    return 'missing end chunk'


def text_violation(name, text):
    """Return the first publish-blocking text finding, if any."""
    if PRIVATE_KEY.search(text) or ACCESS_TOKEN.search(text):
        return 'private key or access token'
    first_party = not name.startswith('server/upstream/')
    if not first_party:
        return None
    if WINDOWS_HOME.search(text) or PERSONAL_HOME_OR_HOST.search(text):
        return 'personal path or host'
    # SVG path data can resemble an address when decimal coordinates run together.
    scanned = re.sub(r'<svg\b[\s\S]*?</svg>', '', text, flags=re.IGNORECASE)
    for match in URL_CREDENTIAL.finditer(scanned):
        if not PLACEHOLDER.match(match.group(1)):
            return 'URL credential'
    for match in IPV4.finditer(scanned):
        value = match.group(1)
        octets = value.split('.')
        if not all(int(octet) <= 255 for octet in octets):
            continue
        try:
            address = ipaddress.ip_address(value)
        except ValueError:
            # Leading-zero version strings such as 2.00.00.00 are not IPv4 literals.
            continue
        cidr = re.match(r'/(\d{1,2})', scanned[match.end(1) :])
        if cidr and f'{address}/{cidr.group(1)}' in GENERIC_CIDRS:
            continue
        if value != '0.0.0.0' and not address.is_loopback:
            return 'non-loopback IPv4 address'
    for match in IPV6.finditer(scanned):
        value = match.group(1).strip('[]')
        try:
            address = ipaddress.ip_address(value)
        except ValueError:
            continue
        mapped = address.ipv4_mapped
        if (
            address.version != 6
            or address.is_loopback
            or address.is_unspecified
            or (mapped is not None and (mapped.is_loopback or mapped.is_unspecified))
        ):
            continue
        cidr = re.match(r'/(\d{1,3})', scanned[match.end(1) :])
        if cidr and f'{address}/{cidr.group(1)}' in GENERIC_IPV6_CIDRS:
            continue
        if any(address in network for network in GENERIC_IPV6):
            continue
        return 'non-loopback IPv6 address'
    for match in EMAIL.finditer(scanned):
        domain = match.group(0).rsplit('@', 1)[1].lower()
        if domain not in {'example.com', 'example.net', 'example.org'} and not domain.endswith(
            '.example'
        ):
            return 'non-example email address'
    for match in CREDENTIAL.finditer(scanned):
        if not PLACEHOLDER.match(match.group(2)):
            return 'embedded credential'
    for match in ENV_CREDENTIAL.finditer(scanned):
        if not PLACEHOLDER.match(match.group(1)):
            return 'embedded credential'
    path = Path(name)
    if path.suffix.lower() in UNQUOTED_CONFIG_SUFFIXES or path.name.startswith('.env'):
        for match in UNQUOTED_CREDENTIAL.finditer(scanned):
            if not PLACEHOLDER.match(match.group(1)):
                return 'embedded credential'
    if name == 'server/.env.example':
        for line in text.splitlines():
            match = re.match(
                r'^(?:[A-Z0-9_]*(?:PASSWORD|TOKEN|SECRET|PRIVATE_KEY)[A-Z0-9_]*)=(.*)$', line
            )
            if match and match.group(1) and not re.match(
                r'^(?:GENERATE_WITH_NPM_RUN_SETUP|<[^>]+>)$', match.group(1)
            ):
                return 'embedded credential'
    return None


def check_source(root=Path('.'), quiet=False):
    root = Path(root)
    files = (
        subprocess.check_output(
            ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], cwd=root
        )
        .decode()
        .split('\0')[:-1]
    )
    if not files:
        raise ValueError('No tracked release files')
    roots = {'frontend', 'server', 'scripts', '.github'}
    standalone = {
        '.clang-format',
        '.clang-format-files',
        '.editorconfig',
        '.gitattributes',
        '.gitignore',
        'LICENSE',
        'NOTICE.txt',
        'README.md',
    }
    synthetic_archives = {
        'server/worker/Tests/Fixtures/homebrew.part1.rar',
        'server/worker/Tests/Fixtures/homebrew.part2.rar',
        'server/worker/Tests/Fixtures/homebrew.part3.rar',
        'server/worker/Tests/Fixtures/homebrew.part4.rar',
    }
    package_data = 'server/upstream/LibProsperoPKG-drakmor/src/LibProsperoPkg/Keys/Data/'
    playgo_data = 'server/upstream/LibProsperoPKG-drakmor/src/LibProsperoPkg/PlayGo/Data/'
    public_modulus_path = package_data + 'token.hex'
    public_modulus_digest = '45add04f296a01dcc291f5b1c938ae2fe463304ae3a0b40bead59ed0832566ec'
    vendored_resources = {
        package_data + 'passcode.bin': (
            '81e8283d582f522d8da34565ecd6ab39a38b3d3c0cacef078df97d2b285ec24e'
        ),
        package_data + 'mount_image.bin': (
            '4510462812321cea26b4c0155e363955b16e31b89252b92510accad02eca5cd0'
        ),
        playgo_data + 'right.sprx': (
            'acb7d999f31ffc73bbfff703c7866455a89f35f8a7f4feebc152edf40f707d50'
        ),
    }
    vendored_resources[public_modulus_path] = public_modulus_digest
    forbidden_suffixes = {
        '.core',
        '.db',
        '.dll',
        '.dmp',
        '.elf',
        '.exfat',
        '.exe',
        '.ffpfs',
        '.ffpfsc',
        '.ffpkg',
        '.key',
        '.log',
        '.pdb',
        '.pkg',
        '.pup',
        '.sqlite',
        '.sqlite3',
    }
    for name in files:
        relative = Path(name)
        path = root / relative
        if path.is_symlink():
            raise ValueError('Excluded file in export: ' + name)
        if not path.exists():
            continue
        suffix = relative.suffix.lower()
        excluded_folder = any(
            part in {'build', 'dist', 'bin', 'obj', 'node_modules', 'TestResults'}
            for part in relative.parts
        )
        if (
            (relative.parts[0] not in roots and name not in standalone)
            or suffix in forbidden_suffixes
            or (suffix in {'.zip', '.7z', '.rar'} and name not in synthetic_archives)
            or (suffix in {'.bin', '.sprx'} and name not in vendored_resources)
            or (suffix == '.md' and relative.name != 'README.md')
            or excluded_folder
            or (relative.name.startswith('.env') and relative.name != '.env.example')
        ):
            raise ValueError('Excluded file in export: ' + name)
        if name in vendored_resources:
            if hashlib.sha256(path.read_bytes()).hexdigest() != vendored_resources[name]:
                raise ValueError('Vendored resource hash mismatch: ' + name)
            continue
        if suffix == '.png':
            finding = png_violation(path)
            if finding:
                raise ValueError(f'Invalid PNG in export ({finding}): {name}')
            continue
        if suffix in {'.dds', '.gz', '.xz', '.rar', '.at9', '.ttf'}:
            continue
        if suffix == '.otf':
            data = path.read_bytes()
            if data[:4] != b'OTTO' or not 64 <= len(data) <= 2 * 1024 * 1024:
                raise ValueError('Invalid bundled OpenType font: ' + name)
            continue
        try:
            text = path.read_text(encoding='utf-8')
        except UnicodeDecodeError as error:
            raise ValueError('Unreviewed binary in export: ' + name) from error
        finding = text_violation(name, text)
        if finding:
            raise ValueError(f'Private material in export ({finding}): {name}')
    if not quiet:
        print(f'Checked {len(files)} public files; no excluded files or private credentials')


def version_constants(source):
    version_match = re.search(r'appVersion\s*=\s*"([0-9.]+)"', source)
    build_match = re.search(r'appBuild\s*=\s*([0-9]+)', source)
    if not version_match or not build_match:
        raise ValueError('Application version constants are missing')
    return version_match[1], int(build_match[1])


def check_release(folder):
    source = Path('frontend/ps5/common/version.hpp').read_text()
    version, build = version_constants(source)
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
    sums = ''.join(f'{value}  {name}\n' for name, value in hashes.items())
    (folder / 'SHA256SUMS').write_text(sums)
    print(json.dumps(dict(version=version, build=build, hashes=hashes)))


if __name__ == '__main__':
    if sys.argv[1:] == ['--source']:
        check_source()
    else:
        check_release(Path(sys.argv[1]))
