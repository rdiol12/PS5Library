import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

test('home tile dismisses only after a fresh frontend startup, and preserves launch errors', async () => {
  const html = await readFile('../frontend/ps5/assets/launch.html', 'utf8'),
    script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  for (const outcome of ['ready', 'failed', 'stale']) {
    let closed = 0,
      reads = 0,
      launched = false;
    const elements: Record<string, any> = {
      status: { textContent: '' },
      retry: { hidden: true, focus() {} },
    };
    const context = {
      document: { getElementById: (id: string) => elements[id] },
      URLSearchParams,
      AbortController,
      setTimeout: (fn: () => void) => {
        queueMicrotask(fn);
        return 1;
      },
      clearTimeout() {},
      window: {
        close() {
          closed++;
        },
      },
      fetch: async (url: string) => {
        if (url.startsWith('/hbldr?')) {
          launched = true;
          return { ok: outcome !== 'failed' };
        }
        assert.ok(url.startsWith('/fs/data/ps5library/update-boot.json'));
        reads++;
        return {
          ok: true,
          json: async () => ({
            launchId: (launched && outcome === 'ready' ? 'f' : 'a').repeat(32),
            frames: 60,
          }),
        };
      },
    };
    runInNewContext(script, context);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(launched, true);
    assert.equal(closed, outcome === 'ready' ? 1 : 0, outcome);
    if (outcome === 'failed') assert.equal(elements.retry.hidden, false);
    if (outcome === 'ready')
      assert.ok(reads >= 2, 'Old boot receipts cannot dismiss a failed new launch');
  }
});
