"""A corrupt/truncated ELF or a mismatched receipt must never pass publication."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

spec = importlib.util.spec_from_file_location('release', Path(__file__).with_name('check-release.py'))
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseCheck(unittest.TestCase):
    def test_invalid_assets_cannot_publish(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            (folder / 'ps5library-install.elf.json').write_text(json.dumps({'version': '0.2.6', 'build': 1, 'sha256': '0' * 64}))
            for data in (b'not an ELF', b'\x7fELF\x02\x01' + bytes(58)):
                (folder / 'ps5library.elf').write_bytes(data)
                with self.assertRaises(ValueError):
                    release.check_release(folder)
                self.assertFalse((folder / 'SHA256SUMS').exists())


if __name__ == '__main__':
    unittest.main()
