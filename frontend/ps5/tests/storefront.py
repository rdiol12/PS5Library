"""Exercise the library-first controller flow against an isolated catalog."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

with tempfile.TemporaryDirectory(prefix='ps5library-ui-') as temporary:
    root = Path(temporary)
    font = Path(__file__).resolve().parents[1] / 'assets/fonts/Inter-Regular.otf'
    (root / 'config.json').write_text(json.dumps({'font': str(font)}))
    games = [
        {'id': 'alpha', 'title': 'Alpha', 'description': 'Source waiting for preparation.',
         'releases': [{'id': 'alpha-base', 'kind': 'BASE', 'version': '1.00',
                       'sources': [{'id': 'alpha-source'}], 'artifacts': []}]},
        {'id': 'beta', 'title': 'Beta', 'description': 'Prepared on the server.',
         'releases': [{'id': 'beta-base', 'kind': 'BASE', 'version': '1.01',
                       'sources': [{'id': 'beta-source'}], 'artifacts': [{'id': 'beta-artifact'}]}]},
        {'id': 'gamma', 'title': 'Gamma', 'description': 'Installed on this console.',
         'releases': [{'id': 'gamma-base', 'kind': 'BASE', 'version': '2.00',
                       'sources': [], 'artifacts': []}]},
    ]
    (root / 'preview.json').write_text(json.dumps({
        'catalog': games,
        'consoles': [{'id': 'test-console', 'name': 'Test PS5'}],
        'device': {'consoleId': 'test-console'},
        'profile': {'username': 'Tester', 'role': 'ADMIN'},
        'library': [{'releaseId': 'gamma-base', 'state': 'READY_ON_PS5',
                     'source': 'INSTALLED_TITLE', 'registered': True}],
    }))

    def run(script='', start='My Library'):
        commands = [part for part in script.split(',') if part]
        result = subprocess.run([
            sys.argv[1], str(root / 'config.json'), '--preview',
            '--script=' + script, '--screen=' + start,
            '--frames=' + str(25 * len(commands) + 60),
        ], env=dict(os.environ, SDL_VIDEODRIVER='dummy', SDL_AUDIODRIVER='dummy'),
           capture_output=True, text=True, timeout=40, check=True)
        return json.loads(result.stdout.splitlines()[-1])

    server = run()
    assert (server['screen'], server['focus']) == ('My Library', 'grid:alpha'), server
    opened = run('right,select')
    assert (opened['screen'], opened['focus']) == ('Game', 'download'), opened
    restored = run('right,select,back')
    assert (restored['screen'], restored['focus']) == ('My Library', 'grid:beta'), restored
    console = run('up,right,select')
    assert (console['screen'], console['focus']) == ('My Library', 'grid:gamma'), console
    print('PASS: library scopes, source visibility, focused details and restored controller focus')
