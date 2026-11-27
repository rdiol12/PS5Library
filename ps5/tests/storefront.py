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
        'jobs': [
            {'id': 'alpha-job', 'kind': 'DOWNLOAD', 'releaseId': 'alpha-base',
             'title': 'Alpha', 'state': 'QUEUED', 'queuePosition': 1},
            {'id': 'beta-job', 'kind': 'BUILD', 'releaseId': 'beta-base',
             'title': 'Beta', 'state': 'QUEUED', 'queuePosition': 2},
        ],
        'consoles': [{'id': 'test-console', 'name': 'Test PS5', 'storage': [
            {'storageId': 'internal', 'displayName': 'Internal Storage',
             'freeBytes': 800_000_000_000},
            {'storageId': 'm2', 'displayName': 'M.2 SSD',
             'freeBytes': 1_000_000_000_000},
            {'storageId': 'usb0', 'displayName': 'USB Extended Storage',
             'freeBytes': 900_000_000_000},
            {'storageId': 'usb1', 'displayName': 'USB Storage',
             'freeBytes': 700_000_000_000},
        ]}],
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
    home_to_games = run('next', 'Home')
    assert home_to_games['screen'] == 'My Library', home_to_games
    search_result = run('search,text:Beta,down,select')
    assert (search_result['screen'], search_result['focus']) == ('Game', 'download'), search_result
    review = run('select,select,down,down,down,down,down,down,down')
    assert review['focus'] == 'confirm-download', review
    review_shortcut = run('select,select,right')
    assert review_shortcut['focus'] == 'confirm-download', review_shortcut
    short_cross = run('select-down,select-up', 'Downloads')
    assert (short_cross['screen'], short_cross['focus']) == ('Game', 'download'), short_cross
    reordered = run('select-down,wait,wait,down,select-up,up,select,back', 'Downloads')
    assert (reordered['screen'], reordered['focus']) == ('Downloads', 'job:beta-job'), reordered
    print('PASS: home navigation, library scopes, search details and restored controller focus')
