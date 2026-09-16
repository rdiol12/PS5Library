"""Package pinned dependency sources and their original license texts for release."""
import hashlib
import json
import os
from pathlib import Path
import tempfile
import urllib.request
import zipfile

entries = json.loads(Path('licenses/sources.json').read_text())
output = Path('dist/PS5Library-dependencies.zip')
output.parent.mkdir(exist_ok=True)
cache = os.environ.get('SOURCE_CACHE')
with tempfile.TemporaryDirectory(dir=output.parent) as temporary:
    part = Path(temporary) / output.name
    with zipfile.ZipFile(part, 'w', compression=zipfile.ZIP_STORED) as bundle:
        bundle.write('licenses/sources.json', 'sources.json')
        bundle.write('NOTICE.txt')
        for entry in entries:
            name = entry['filename']
            if Path(name).name != name or not entry['url'].startswith('https://'):
                raise ValueError('Invalid source manifest')
            print('Packaging source:', entry['name'], flush=True)
            local = Path(cache, name) if cache else None
            request = urllib.request.Request(entry['url'], headers={'User-Agent': 'PS5Library-source-packaging/1.0'})
            with local.open('rb') if local and local.is_file() else urllib.request.urlopen(request, timeout=90) as source:
                digest, size = hashlib.sha256(), 0
                with bundle.open(name, 'w') as target:
                    for block in iter(lambda: source.read(1024 * 1024), b''):
                        size += len(block)
                        if size > 256 * 1024 * 1024:
                            raise ValueError('Source archive exceeds limit')
                        digest.update(block)
                        target.write(block)
                if digest.hexdigest() != entry['sha256']:
                    raise ValueError('Source hash mismatch: ' + name)
    part.replace(output)
with Path('dist/SHA256SUMS').open('a') as sums, output.open('rb') as source:
    sums.write(hashlib.file_digest(source, 'sha256').hexdigest() + '  ' + output.name + '\n')
