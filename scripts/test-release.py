"""A corrupt/truncated ELF or a mismatched receipt must never pass publication."""
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    'release', Path(__file__).with_name('check-release.py')
)
release = importlib.util.module_from_spec(spec)
spec.loader.exec_module(release)


class ReleaseCheck(unittest.TestCase):
    def test_version_constants_allow_readable_spacing(self):
        source = 'appVersion = "0.2.91";\nappBuild = 291;\n'
        self.assertEqual(release.version_constants(source), ('0.2.91', 291))

    def test_invalid_assets_cannot_publish(self):
        with tempfile.TemporaryDirectory() as temporary:
            folder = Path(temporary)
            metadata = {'version': '0.2.6', 'build': 1, 'sha256': '0' * 64}
            (folder / 'ps5library-install.elf.json').write_text(json.dumps(metadata))
            for data in (b'not an ELF', b'\x7fELF\x02\x01' + bytes(58)):
                (folder / 'ps5library.elf').write_bytes(data)
                with self.assertRaises(ValueError):
                    release.check_release(folder)
                self.assertFalse((folder / 'SHA256SUMS').exists())

    def test_untracked_private_material_cannot_publish(self):
        cases = [
            '-----BEGIN ' + 'PRIVATE KEY-----\nfixture\n',
            'C:' + '\\Users\\' + 'alice\\project',
            'C:' + '/' + 'Users' + '/alice/project',
            '/home' + '/alice/project',
            '/Users' + '/alice/project',
            'private-tailnet.' + 'ts.net',
            '.'.join(('192', '168', '50', '122')),
            'fd00:' + ':1234',
            'fc00:' + ':1',
            'fe80:' + ':1',
            'owner' + '@private.test',
            'password=' + '"correct-horse-battery-staple"',
            'password=' + 'correct-horse-battery-staple',
            'API_' + 'TOKEN=correct-horse-battery-staple',
            'https://' + 'operator:correct-horse-battery-staple@localhost:3150/status',
        ]
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(['git', 'init', '--quiet'], cwd=root, check=True)
            file = root / 'scripts' / 'untracked.txt'
            file.parent.mkdir()
            for value in cases:
                with self.subTest(value=value):
                    file.write_text(value, encoding='utf-8')
                    with self.assertRaises(ValueError):
                        release.check_source(root, quiet=True)

    def test_client_release_requires_an_explicit_manual_run(self):
        workflow = Path('.github/workflows/client-release.yml').read_text()
        self.assertRegex(workflow, r'(?m)^on:\n  workflow_dispatch:')
        self.assertNotRegex(workflow, r'(?m)^  (?:push|pull_request|schedule):')
        self.assertIn('PS5LibraryCompanion-unsigned.ipa', workflow)
        self.assertIn('ps5library-agent.elf', workflow)
        self.assertIn('ps5library-native-build', workflow)
        self.assertIn('if: ${{ inputs.publish_release }}', workflow)
        self.assertIn('git ls-remote --exit-code --tags origin', workflow)
        self.assertFalse(Path('.github/workflows/ios-ipa.yml').exists())
        self.assertFalse(Path('.github/workflows/elf.yml').exists())

    def test_unquoted_environment_secret_in_source_cannot_publish(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(['git', 'init', '--quiet'], cwd=root, check=True)
            folder = root / 'scripts'
            folder.mkdir()
            for suffix in ('sh', 'ts'):
                with self.subTest(suffix=suffix):
                    file = folder / f'untracked.{suffix}'
                    file.write_text('API_' + 'TOKEN=correct-horse-battery-staple')
                    with self.assertRaises(ValueError):
                        release.check_source(root, quiet=True)
                    file.unlink()

    def test_untracked_file_named_png_must_be_a_valid_png(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(['git', 'init', '--quiet'], cwd=root, check=True)
            file = root / 'scripts' / 'untracked.png'
            file.parent.mkdir()
            file.write_bytes(b'password=correct-horse-battery-staple')
            with self.assertRaisesRegex(ValueError, 'Invalid PNG'):
                release.check_source(root, quiet=True)

    def test_public_placeholders_and_update_key_can_publish(self):
        content = '''
http://127.0.0.1:3150
/home/user/project
/Users/example/project
fc00::/7
2001:db8::1
developer@example.com
token="example-token"
POSTGRES_PASSWORD=${POSTGRES_PASSWORD:?required}
https://name:password@one.example
https://library.example
-----BEGIN PUBLIC KEY-----
MCowBQYDK2VwAyEA111111111111111111111111111111111111111=
-----END PUBLIC KEY-----
'''
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(['git', 'init', '--quiet'], cwd=root, check=True)
            file = root / 'scripts' / 'untracked.txt'
            file.parent.mkdir()
            file.write_text(content, encoding='utf-8')
            release.check_source(root, quiet=True)

    def test_ipv4_mapped_loopback_is_not_private_material(self):
        self.assertIsNone(release.text_violation('scripts/test.txt', '::ffff:127.0.0.1'))
        self.assertIsNotNone(
            release.text_violation(
                'scripts/test.txt', '::ffff:' + '.'.join(('192', '168', '1', '1'))
            )
        )

    def test_untracked_unknown_binary_cannot_publish(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(['git', 'init', '--quiet'], cwd=root, check=True)
            file = root / 'scripts' / 'untracked.data'
            file.parent.mkdir()
            file.write_bytes(b'\xff\x00private')
            with self.assertRaisesRegex(ValueError, 'Unreviewed binary'):
                release.check_source(root, quiet=True)

    def test_only_the_reviewed_public_tool_folder_can_publish(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            subprocess.run(['git', 'init', '--quiet'], cwd=root, check=True)
            public = root / 'tools' / 'native-pkg-updater' / 'README.md'
            public.parent.mkdir(parents=True)
            public.write_text('# Public updater\n', encoding='utf-8')
            release.check_source(root, quiet=True)

            unreviewed = public.parent / 'private-helper.py'
            unreviewed.write_text('print("private")\n', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'Excluded file'):
                release.check_source(root, quiet=True)
            unreviewed.unlink()

            private = root / 'tools' / 'private' / 'README.md'
            private.parent.mkdir()
            private.write_text('# Private tool\n', encoding='utf-8')
            with self.assertRaisesRegex(ValueError, 'Excluded file'):
                release.check_source(root, quiet=True)


if __name__ == '__main__':
    unittest.main()
