"""Exercise real controller navigation against an isolated, offline catalog."""
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
    games = [{'id': name.lower(), 'title': name, 'genres': ['Action'], 'rail': 'popular',
              'releases': [{'id': name.lower() + '-base', 'kind': 'BASE', 'version': '1.00',
                            'sources': [{'id': name.lower() + '-source'}]}]}
             for name in ('Alpha', 'Beta', 'Gamma')]
    (root / 'preview.json').write_text(json.dumps({
        'catalog': games, 'consoles': [{'id': 'test-console', 'name': 'Test PS5'}],
        'device': {'consoleId': 'test-console'}, 'profile': {'username': 'Tester'},
        'jobs': [{'id': 'failed', 'title': 'Alpha', 'releaseId': 'alpha-base',
                  'kind': 'BUILD', 'state': 'ERROR', 'error': 'CORRUPT_INPUT',
                  'location': 'Server cache / artifacts/alpha.pkg'}],
    }))

    def check(script, page, focus, size='1920x1080', start='Discover'):
        result = subprocess.run([sys.argv[1], str(root / 'config.json'), '--preview',
                                 '--script=' + script, '--size=' + size, '--screen=' + start,
                                 '--frames=' + str(25 * len(script.split(',')) + 40)],
                                env=dict(os.environ, SDL_VIDEODRIVER='dummy', SDL_AUDIODRIVER='dummy'),
                                capture_output=True, text=True, timeout=40, check=True)
        state = json.loads(result.stdout.splitlines()[-1])
        assert (state['screen'], state['focus']) == (page, focus), (script, state)

    # View All must keep the search result set, including when the match is not the first game.
    check('search,text:Beta,enter,right,select', 'Results', 'grid:beta')
    check('right,select,back', 'Discover', 'rail3:beta')
    check('up,up,' + 'right,' * 6 + 'select', 'Discover', 'search-input', '1280x720')
    check('up,up,' + 'right,' * 7 + 'select', 'Settings', 'network')
    check('up,up,' + 'right,' * 8 + 'select', 'Profile', 'profile-picture')
    # Even when the default method has no destination, its alternative must be reachable.
    check('select,down,select,select', 'Game', 'method', start='Game')
    check('select,down,select,select,down', 'Game', 'method:FPKG', start='Game')
    fixture = json.loads((root / 'preview.json').read_text())
    fixture['consoles'][0]['storage'] = [{'storageId': 'usb', 'displayName': 'USB SSD'}]
    (root / 'preview.json').write_text(json.dumps(fixture))
    check('select,down,select,select,down,select,select', 'Game', 'confirm-download', start='Game')
    # Cross opens the title. Options opens actions for the focused download.
    check('select', 'Game', 'download', start='Downloads')
    check('settings', 'Downloads', 'job-retry', start='Downloads')
    print('PASS: navigation, method-before-storage downloads and download context actions')
