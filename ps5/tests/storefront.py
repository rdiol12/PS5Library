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
              'releases': [{'id': name.lower() + '-base', 'kind': 'BASE', 'version': '1.00'}]}
             for name in ('Alpha', 'Beta', 'Gamma')]
    (root / 'preview.json').write_text(json.dumps({
        'catalog': games, 'consoles': [{'id': 'test-console', 'name': 'Test PS5'}],
        'device': {'consoleId': 'test-console'}, 'profile': {'username': 'Tester'},
    }))

    def check(script, page, focus, size='1920x1080'):
        result = subprocess.run([sys.argv[1], str(root / 'config.json'), '--preview',
                                 '--script=' + script, '--size=' + size,
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
    print('PASS: filtered collections, return focus, search, settings and profile at console resolutions')
