import assert from 'node:assert/strict';
import test from 'node:test';
import { externalInfo, parseGamePage, slugFor } from '../src/metadata/playstationdb.js';

const page = `<html><head>
<script type="application/ld+json">{"@type":"schema:VideoGame","schema:name":"Sample Quest","schema:thumbnailUrl":"https://imagedelivery.net/acct/cover/psdbsqlg","schema:datePublished":"2025-05-20"}</script>
</head><body>
<h1>Sample Quest</h1><div>Details</div><div>Genre</div><div>Simulation</div>
<div>Metacritic Score</div><div>78</div>
<h2>Game Description</h2><p>First &amp; best.</p><p>Second paragraph.</p>
<h2>More simulation games</h2><img src="https://imagedelivery.net/acct/other/psdbsq">
<h2>Videos</h2><img src="https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg">
<img src="https://i.ytimg.com/vi/AAAAAAAAAAA/hqdefault.jpg"><img src="https://i.ytimg.com/vi/BBBBBBBBBBB/hqdefault.jpg">
</body></html>`;

test('PlayStationDB slugs follow the site convention', () => {
  assert.equal(slugFor("Castlevania: Belmont's Curse"), 'castlevania-belmont-s-curse');
  assert.equal(slugFor('K-Pop Rising: Dream to Shine™'), 'k-pop-rising-dream-to-shine');
  assert.equal(slugFor('Pokémon®  Legends'), 'pokemon-legends');
});

test('a PlayStationDB page yields its own fields and only for the exact title', () => {
  assert.deepEqual(parseGamePage(page, 'sample-quest'), {
    source: 'PlayStationDB',
    url: 'https://playstationdb.com/games/sample-quest/',
    description: 'First & best.\n\nSecond paragraph.',
    genre: 'Simulation',
    releaseDate: '2025-05-20',
    metacritic: 78,
    imageUrl: 'https://imagedelivery.net/acct/cover/psdbsqlg',
    videos: ['AAAAAAAAAAA', 'BBBBBBBBBBB'],
  });
  assert.equal(parseGamePage(page, 'sample-quest-2'), null, 'A near-miss title gets nothing');
  assert.equal(parseGamePage('<html></html>', 'sample-quest'), null);
});

test('external details are never looked up while the feature is off', () => {
  assert.equal(externalInfo('Sample Quest'), null);
});
