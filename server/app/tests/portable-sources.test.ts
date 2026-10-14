import test from 'node:test';
import assert from 'node:assert/strict';
import { portableRelease, relativeSource } from '../../scripts/portable-sources.js';
test('moving Windows sources preserves portable identities and rejects escaping the configured root', () => {
  const root = 'X:\\fixtures\\sources',
    source = {
      location: root + '\\wrapper\\game',
      key: 'old',
      game: { artwork: { cover: root + '\\wrapper\\game\\sce_sys\\icon0.png' } },
    };
  const portable = portableRelease(source, root, '.', true);
  assert.equal(portable.location, 'wrapper/game');
  assert.equal(portable.game.artwork.cover, 'wrapper/game/sce_sys/icon0.png');
  assert.deepEqual(
    portableRelease(portable, '/dumps', '.', true),
    portable,
    'Migration is idempotent and uses the same stable key on Linux',
  );
  assert.equal(relativeSource(root, 'wrapper/game'), 'wrapper/game');
  assert.throws(() => relativeSource(root, 'X:\\fixtures\\sources-other\\game'));
  assert.throws(() => relativeSource(root, '..\\secrets'));
  assert.throws(() => portableRelease(source, root, 'unrelated', true));
  assert.equal(source.key, 'old', 'Original metadata remains unchanged');
});
