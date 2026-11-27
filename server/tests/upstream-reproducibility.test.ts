import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
import { syncUpstreams, verifyUpstreamRepository } from '../../scripts/upstream.mjs';

const execute = promisify(execFile);

async function git(cwd: string, ...args: string[]) {
  return (await execute('git', args, { cwd })).stdout.trim();
}

test('pinned upstream patches apply once and unexpected edits are preserved', async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), 'ps5library-upstream-')),
    origin = path.join(workspace, 'origin'),
    patchDirectory = path.join(workspace, 'patches', 'upstream');
  try {
    await mkdir(origin);
    await git(origin, 'init', '--quiet');
    await git(origin, 'config', 'user.email', 'upstream-test@example.com');
    await git(origin, 'config', 'user.name', 'Upstream Test');
    await git(origin, 'config', 'core.autocrlf', 'false');
    await writeFile(path.join(origin, 'source.txt'), 'base\n');
    await writeFile(path.join(origin, 'untouched.txt'), 'reviewed\n');
    await git(origin, 'add', '.');
    await git(origin, 'commit', '--quiet', '-m', 'base');
    const commit = await git(origin, 'rev-parse', 'HEAD');

    await writeFile(path.join(origin, 'source.txt'), 'patched\n');
    const patch = (
      await execute('git', ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-renames'], {
        cwd: origin,
      })
    ).stdout;
    await git(origin, 'checkout', '--', 'source.txt');
    await mkdir(patchDirectory, { recursive: true });
    await writeFile(path.join(patchDirectory, 'Fixture.patch'), patch);
    await mkdir(path.join(workspace, 'docs'));
    await writeFile(
      path.join(workspace, 'docs', 'upstream-lock.json'),
      JSON.stringify([
        {
          name: 'Fixture',
          url: origin,
          commit,
          patch: 'patches/upstream/Fixture.patch',
        },
        {
          name: 'Skipped',
          url: path.join(workspace, 'missing-origin'),
          commit,
        },
      ]),
    );

    await syncUpstreams({ workspaceRoot: workspace, names: ['Fixture'] });
    const checkout = path.join(workspace, 'upstream', 'Fixture');
    assert.equal((await readFile(path.join(checkout, 'source.txt'), 'utf8')).trim(), 'patched');
    assert.equal(
      await verifyUpstreamRepository({ workspaceRoot: workspace, repository: checkout }),
      true,
    );
    assert.equal(
      await rm(path.join(workspace, 'upstream', 'Skipped'), { recursive: true }).catch(
        () => 'missing',
      ),
      'missing',
    );

    await syncUpstreams({ workspaceRoot: workspace, names: ['Fixture'] });
    await writeFile(path.join(checkout, 'untouched.txt'), 'unexpected\n');
    await assert.rejects(
      syncUpstreams({ workspaceRoot: workspace, names: ['Fixture'] }),
      /unexpected local changes/i,
    );
    assert.equal(await readFile(path.join(checkout, 'untouched.txt'), 'utf8'), 'unexpected\n');

    await writeFile(path.join(checkout, 'untouched.txt'), 'reviewed\n');
    await writeFile(path.join(checkout, 'extra.txt'), 'not reviewed\n');
    await assert.rejects(
      verifyUpstreamRepository({ workspaceRoot: workspace, repository: checkout }),
      /unexpected local changes/i,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});
