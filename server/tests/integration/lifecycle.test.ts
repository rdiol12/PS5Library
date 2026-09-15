import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createApp } from '../../src/api/app.js';
import { configuration } from '../../src/config.js';
import { database } from '../../src/db.js';
import { runWorker } from '../../src/library/inspect.js';
import { featuredSelection } from '../../src/catalog/featured.js';

test('real PostgreSQL/Redis: pairing → catalog → verified download → transfer → inventory → restart', { timeout: 90000 }, async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ps5library-check-'));
  const config = { ...configuration(), DATA_DIR: root, SOURCE_ROOT: path.join(root, 'sources'), DISK_MARGIN_BYTES: 0 };
  const adminDb = database(config.DATABASE_URL);
  const schema = `ps5library_test_${randomUUID().replaceAll('-', '')}`;
  await adminDb.query(`CREATE SCHEMA ${schema}`);
  const databaseUrl = new URL(config.DATABASE_URL);
  databaseUrl.searchParams.set('options', `-c search_path=${schema}`);
  config.DATABASE_URL = databaseUrl.href;
  await mkdir(config.SOURCE_ROOT);
  let app = await createApp(config);
  const call = async (method: string, url: string, payload?: unknown, token?: string) => {
    const response = await app.inject({ method: method as 'GET', url: `/api/v1${url}`, payload, headers: token ? { authorization: `Bearer ${token}` } : {} });
    return { status: response.statusCode, body: response.json() };
  };
  const name = `check-${randomUUID()}`;
  try {
  // First bootstrap only; subsequent runs create an isolated account with the local bootstrap secret.
  const user = await call('POST', '/auth/register', { username: name, password: 'integration-password-12345', bootstrapToken: config.BOOTSTRAP_TOKEN });
  assert.equal(user.status, 201, JSON.stringify(user.body));
  const token = user.body.token;
  const invite = await call('POST', '/admin/invites', {}, token);
  assert.equal(invite.status, 201);
  const friend = await call('POST', '/auth/register', { username: `friend-${randomUUID()}`, password: 'friend-integration-password', inviteToken: invite.body.token });
  assert.equal(friend.status, 201);
  const friendToken = friend.body.token;
  assert.equal((await call('POST', '/admin/invites', {}, friendToken)).status, 403);
  assert.equal((await call('POST', '/auth/register', { username: `replay-${randomUUID()}`, password: 'friend-integration-password', inviteToken: invite.body.token })).status, 403);
  const pendingDevice=randomUUID(),pending=await call('POST','/pairings',{deviceId:pendingDevice,name:'Expired code check',clientKind:'SIMULATOR'});
  const pairingDb=database(config.DATABASE_URL);await pairingDb.query("UPDATE pairings SET expires_at=now()-interval '1 second' WHERE id=$1",[pending.body.id]);await pairingDb.end();
  assert.equal((await call('POST','/pairings',{deviceId:pendingDevice,name:'Renewed code',clientKind:'SIMULATOR'})).status,201,'An unclaimed expired identity can request a fresh code');
  assert.equal((await call('POST','/pairings/claim',{code:pending.body.code},token)).status,410);
  const pair = await call('POST', '/pairings', { deviceId: randomUUID(), name: 'Development console', clientKind: 'SIMULATOR' });
  assert.equal(pair.status, 201);
  assert.equal((await call('POST', '/pairings/claim', { code: pair.body.code }, token)).status, 200);
  assert.equal((await call('POST', '/pairings/claim', { code: pair.body.code }, token)).status, 409);
  const poll = await call('POST', `/pairings/${pair.body.id}/poll`, { pollSecret: pair.body.pollSecret });
  assert.equal(poll.status, 200);
  const deviceToken = poll.body.credential, consoleId = poll.body.consoleId;
  assert.equal((await call('GET', '/consoles', undefined, friendToken)).body.length, 0);
  assert.equal((await call('PATCH', `/consoles/${consoleId}`, { name: 'Stolen' }, friendToken)).status, 404);
  assert.equal((await call('POST', `/consoles/${consoleId}/revoke`, {}, friendToken)).status, 404);
  assert.equal((await call('GET', `/consoles/${consoleId}/library`, undefined, friendToken)).status, 404);
  const heartbeat = {
    firmware: '9.60', runtime: 'development', clientVersion: '0.1.0', agentVersion: '0.1.0',
    capabilities: { homebrew: true, rangeDownloads: true, storageEnumeration: true, inventoryScan: true },
    storage: [{ storageId: 'internal', displayName: 'Development storage', path: '/tmp/ps5library', totalBytes: 1000000000, freeBytes: 900000000, writable: true, installMethodsSupported: ['HOMEBREW'] }],
    libraryRevision: 1, inventory: [], inventoryComplete: true,
  };
  assert.equal((await call('POST', '/device/heartbeat', heartbeat, deviceToken)).status, 200);
  assert.equal((await call('GET', '/consoles', undefined, token)).body[0].presence, 'ONLINE');
  assert.equal((await call('GET', '/catalog', undefined, deviceToken)).status, 401);
  const sample = Buffer.alloc(65536, 0); sample.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]); sample.writeUInt16LE(2, 16); sample.writeUInt16LE(62, 18);
  sample.writeUInt32LE(1, 20); sample.writeBigUInt64LE(0x400080n, 24); sample.writeBigUInt64LE(64n, 32);
  sample.writeUInt16LE(64, 52); sample.writeUInt16LE(56, 54); sample.writeUInt16LE(1, 56);
  sample.writeUInt32LE(1, 64); sample.writeUInt32LE(5, 68); sample.writeBigUInt64LE(0x400000n, 80);
  sample.writeBigUInt64LE(BigInt(sample.length), 96); sample.writeBigUInt64LE(BigInt(sample.length), 104); sample.writeBigUInt64LE(4096n, 112); sample[128] = 0xc3;
  const digest = createHash('sha256').update(sample).digest('hex');
  const sourceFolder = path.join(config.SOURCE_ROOT, user.body.user.id, name); await mkdir(sourceFolder, { recursive: true });
  await writeFile(path.join(sourceFolder, 'demo.elf'), sample);
  const metadata = { title: 'PS5Library Homebrew', titleId: 'PPSA99999', contentId: 'IV0000-PPSA99999_00-PS5LIBRARYDEMO00', description: 'Generated integration fixture' };
  await writeFile(path.join(sourceFolder, 'library.json'), JSON.stringify({ schemaVersion: 1, releases: [{ key: 'demo', game: metadata, version: '01.00', size: sample.length, minimumFirmware: '1.00', format: 'elf', sha256: digest, location: 'demo.elf' }] }));
  const source = await call('POST', '/sources', { name: 'Local homebrew', type: 'LOCAL_FOLDER', location: name }, token);
  assert.equal(source.status, 201, JSON.stringify(source.body));
  assert.equal((await call('POST', `/sources/${source.body.id}/sync`, {}, token)).status, 200);
  const catalog = await call('GET', '/catalog', undefined, token);
  assert.equal(catalog.body.length, 1);
  assert.equal((await call('GET', '/catalog', undefined, friendToken)).body.length, 0);
  assert.equal((await call('GET', '/sources', undefined, friendToken)).body.length, 0);
  assert.equal((await call('POST', `/sources/${source.body.id}/sync`, {}, friendToken)).status, 404);
  const releaseId = catalog.body[0].releases[0].id;
  const sourceReleaseId = catalog.body[0].releases[0].sources[0].id;
  const download = await call('POST', '/downloads', { sourceReleaseId }, token);
  assert.equal(download.status, 202, JSON.stringify(download.body));
  let job: any;
  for (let i = 0; i < 100; i++) {
    job = (await call('GET', `/jobs/${download.body.id}`, undefined, token)).body;
    if (['COMPLETED', 'ERROR'].includes(job.state)) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal(job.state, 'COMPLETED', JSON.stringify(job));
  assert.equal(job.downloadedBytes, sample.length);
  assert.equal((await call('GET', `/jobs/${job.id}`, undefined, friendToken)).status, 404);
  assert.equal((await call('POST', '/downloads', { sourceReleaseId }, friendToken)).status, 404);
  assert.equal((await call('GET', '/events?after=0', undefined, friendToken)).body.length, 0);
  assert.equal((await call('GET', `/artwork/${catalog.body[0].id}/cover`, undefined, friendToken)).status, 404);
  assert.equal((await call('POST', '/transfers/plan', { releaseId, consoleId }, friendToken)).status, 404);
  const plan = await call('POST', '/transfers/plan', { releaseId, consoleId }, token);
  assert.equal(plan.body.compatibility.status, 'NATIVE_COMPATIBLE');
  const transfer = await call('POST', '/transfers', { artifactId: job.artifactId, consoleId, storageId: 'internal' }, token);
  assert.equal(transfer.status, 202, JSON.stringify(transfer.body));
  assert.equal((await call('DELETE', `/artifacts/${job.artifactId}`, undefined, token)).status, 409);
  const tasks = await call('GET', '/device/tasks', undefined, deviceToken);
  assert.equal(tasks.body[0].id, transfer.body.id);
  // A malicious/premature completed message cannot make an artifact appear installed.
  assert.equal((await call('POST', `/device/tasks/${transfer.body.id}/progress`, { state: 'READY_ON_PS5', downloadedBytes: sample.length, sha256: digest }, deviceToken)).status, 409);
  const range = await app.inject({ method: 'GET', url: `/api/v1/device/artifacts/${job.artifactId}`, headers: { authorization: `Bearer ${deviceToken}`, range: 'bytes=100-199' } });
  assert.equal(range.statusCode, 206); assert.equal(range.rawPayload.length, 100);
  assert.equal((await call('POST', `/device/tasks/${transfer.body.id}/progress`, { state: 'TRANSFERRING', downloadedBytes: 100 }, deviceToken)).status, 200);
  assert.equal((await call('POST', `/device/tasks/${transfer.body.id}/progress`, { state: 'VERIFYING', downloadedBytes: sample.length, sha256: digest }, deviceToken)).status, 200);
  heartbeat.libraryRevision = 2;
  const inventory = [{ releaseId, ...metadata, version: '01.00', storageId: 'internal', relativePath: 'homebrew/demo.elf', sha256: digest, size: sample.length, available: true, registered: false }];
  assert.equal((await call('POST', '/device/heartbeat', { ...heartbeat, inventory }, deviceToken)).status, 200);
  assert.equal((await call('POST', `/device/tasks/${transfer.body.id}/progress`, { state: 'READY_ON_PS5', downloadedBytes: sample.length, sha256: digest }, deviceToken)).status, 200);
  await app.close();
  app = await createApp(config);
    assert.equal((await call('GET', `/consoles/${consoleId}/library`, undefined, token)).body[0].state, 'READY_ON_PS5');
    assert.equal((await call('GET', '/device/tasks', undefined, deviceToken)).status, 200);
    heartbeat.libraryRevision = 3;
    await call('POST', '/device/heartbeat', heartbeat, deviceToken);
    assert.equal((await call('GET', `/consoles/${consoleId}/library`, undefined, token)).body[0].state, 'MISSING');
    assert.ok((await call('GET', '/events?after=0', undefined, token)).body.length > 0);
    assert.equal((await call('DELETE', `/artifacts/${job.artifactId}`, undefined, friendToken)).status, 404);
    assert.equal((await call('DELETE', `/artifacts/${job.artifactId}`, undefined, token)).status, 200);
    assert.equal((await call('GET', '/catalog', undefined, token)).body[0].releases[0].artifacts.length, 0);
    const prepared = path.join(sourceFolder, 'prepared'); await mkdir(path.join(prepared, 'sce_sys'), { recursive: true });
    await writeFile(path.join(prepared, 'eboot.bin'), sample);
    const game = { ...metadata, title: 'Cache check homebrew', titleId: 'PPSA99998', contentId: metadata.contentId.replace('99999','99998') };
    await writeFile(path.join(prepared, 'sce_sys', 'param.json'), JSON.stringify({ titleId: game.titleId, contentId: game.contentId, contentVersion: '01.00', localizedParameters: { 'en-US': { titleName: game.title } } }));
    const tree = await runWorker(['hash-tree', prepared]);
    await writeFile(path.join(sourceFolder, 'library.json'), JSON.stringify({ schemaVersion: 1, releases: [{ key: 'prepared', game, version: '01.00', size: tree.size, format: 'folder', sha256: tree.sha256, location: 'prepared' }] }));
    const automatic = await call('POST', '/sources', { name: 'Scheduled local source', type: 'LOCAL_FOLDER', location: name, scanIntervalMinutes: 5 }, token);
    assert.equal(automatic.status, 201);
    let buildSource: string | undefined;
    for (let i=0; i<150 && !buildSource; i++) { const games=(await call('GET','/catalog',undefined,token)).body; buildSource=games.find((g:any)=>g.titleId===game.titleId)?.releases[0]?.sources[0]?.id; if(!buildSource) await new Promise(resolve=>setTimeout(resolve,100)); }
    assert.ok(buildSource, 'Scheduled scan discovered prepared game');
    const request = { sourceReleaseId: buildSource, method: 'FPKG' };
    assert.equal((await call('POST','/preparations',request,friendToken)).status,404);
    const build = await call('POST','/preparations',request,token); assert.equal(build.status,202,JSON.stringify(build.body));
    let built: any;
    for(let i=0;i<300;i++) { built=(await call('GET',`/jobs/${build.body.id}`,undefined,token)).body; if(['COMPLETED','ERROR'].includes(built.state)) break; await new Promise(resolve=>setTimeout(resolve,100)); }
    assert.equal(built.state,'COMPLETED',JSON.stringify(built)); assert.equal(built.progress.completedStages,7);
    const again = await call('POST','/preparations',request,token);
    assert.equal(again.body.cached,true); assert.equal(again.body.artifactId,built.artifactId);
    assert.equal((await runWorker(['hash-tree',prepared])).sha256,tree.sha256,'Original dump remains unchanged');
    assert.equal((await call('DELETE',`/artifacts/${built.artifactId}`,undefined,friendToken)).status,404);
    assert.equal((await call('DELETE',`/artifacts/${built.artifactId}`,undefined,token)).status,200);
    const db = database(config.DATABASE_URL);
    const imageHash = 'b'.repeat(64);
    await db.query("INSERT INTO artwork(id,game_id,kind,sha256,relative_path,width,height,size) VALUES($1,$2,'hero',$3,'artwork/test.webp',1600,900,1)", [randomUUID(), catalog.body[0].id, imageHash]);
    const firstHero = await featuredSelection(db,user.body.user.id,new Date('2026-09-14T12:00:00Z'));
    assert.equal(firstHero.state,'SELECTED');
    assert.deepEqual(await featuredSelection(db,user.body.user.id,new Date('2026-09-18T12:00:00Z')),firstHero,'A restart/request cannot reshuffle the week');
    assert.equal((await featuredSelection(db,user.body.user.id,new Date('2026-09-21T12:00:00Z'))).state,'NEEDS_ARTWORK','Never reuse an image early to fill an empty slot');
    assert.equal((await featuredSelection(db,user.body.user.id,new Date('2026-11-16T12:00:00Z'))).state,'SELECTED');
    assert.equal((await call('GET',firstHero.heroUrl!.replace('/api/v1',''),undefined,friendToken)).status,404);
    assert.equal((await call('POST',`/games/${catalog.body[0].id}/save`,{saved:true},token)).status,200);
    assert.equal((await call('POST',`/games/${catalog.body[0].id}/save`,{saved:true},friendToken)).status,404);
    const installBody={sourceReleaseId,consoleId,storageId:'internal'};
    assert.equal((await call('POST','/installations',installBody,friendToken)).status,404);
    const install=await call('POST','/installations',installBody,deviceToken);
    assert.equal(install.status,401,'User endpoint does not accept a console credential');
    const accepted=await call('POST','/device/installations',installBody,deviceToken);
    assert.equal(accepted.status,202,JSON.stringify(accepted.body));
    assert.equal((await call('POST','/installations',installBody,token)).body.id,accepted.body.id,'Repeated confirmation is idempotent');
    await app.close();app=await createApp(config);
    let installed:any;
    for(let i=0;i<120;i++){installed=(await call('GET','/installations',undefined,token)).body.find((v:any)=>v.id===accepted.body.id);if(installed?.transferJobId||installed?.state==='ERROR')break;await new Promise(resolve=>setTimeout(resolve,100));}
    assert.ok(installed?.transferJobId,JSON.stringify(installed));
    assert.equal((await call('GET','/installations',undefined,friendToken)).body.length,0);
    assert.equal((await db.query("SELECT count(*)::int AS n FROM jobs WHERE config->>'installationId'=$1 AND kind='TRANSFER'",[accepted.body.id])).rows[0].n,1);
    assert.ok((await db.query('SELECT count(*)::int AS n FROM schema_migrations')).rows[0].n > 0);
    await db.end();
  } finally { await app.close(); await adminDb.query(`DROP SCHEMA ${schema} CASCADE`); await adminDb.end(); }
});
