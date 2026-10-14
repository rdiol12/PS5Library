import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { createApp } from '../../src/api/app.js';
import { configuration } from '../../src/config.js';
import { database } from '../../src/db.js';
import { fileHash } from '../../src/downloads/stream.js';

const nativeSource = async (...files: string[]) =>
  (await Promise.all(files.map((file) => readFile(path.join(process.cwd(), file), 'utf8'))))
    .join('\n')
    .replace(/\s+/g, '');

const storefrontSource = () =>
  nativeSource(
    '../frontend/ps5/frontend/main.cpp',
    '../frontend/ps5/frontend/storefront.cpp',
    '../frontend/ps5/frontend/storefront_core.cpp',
    '../frontend/ps5/frontend/storefront_modals.cpp',
    '../frontend/ps5/frontend/storefront_pages.cpp',
  );

test('native app and agent do not exchange mutable files through the title sandbox', async () => {
  const [agent, frontend, client, local] = await Promise.all([
    nativeSource('../frontend/ps5/agent/main.cpp'),
    storefrontSource(),
    nativeSource('../frontend/ps5/common/client.cpp', '../frontend/ps5/common/client_state.cpp'),
    nativeSource('../frontend/ps5/agent/local.hpp'),
  ]);
  assert.doesNotMatch(agent, /PPSA99051_000\/download0\/ps5library\/local-snapshot\.json/);
  assert.doesNotMatch(frontend, /refreshLocalFile|localSnapshotAdvanced/);
  assert.doesNotMatch(frontend, /Hardware quarantine/);
  assert.doesNotMatch(agent + frontend, /agent-(snapshot|control)\.json/);
  assert.match(agent, /localAgentSharedPath/);
  assert.doesNotMatch(agent, /localAgentBackingSocketPath/);
  assert.match(client, /sceNetCtlInit\(\)/);
  assert.match(client, /sceNetCtlGetInfo\(14,/);
  assert.match(client, /localAgentAddress\(\)/);
  assert.match(client, /localAgentUrl\(\)/);
  assert.match(client, /privateHttpHost/);
  assert.match(
    client,
    /nativeDownloadRelayRequired\(\)const\{return\(fallbackActive_&&!fallback_\.empty\(\)\)\?!fallbackProxy_\.empty\(\):!proxy_\.empty\(\);\}/,
    'An unused proxied fallback must not replace a directly reachable native package URL',
  );
  assert.doesNotMatch(local, /INADDR_ANY/);
  assert.match(local, /localAgentAddress\(\)/);
  assert.match(local, /frontend\.lock/);
  assert.match(
    frontend,
    /localAgentModePath\(local,allow,server,fallback\)/,
    'The storefront uses the version-compatible local control route',
  );
  assert.doesNotMatch(
    frontend,
    /fallback\.empty\(\)\?"-"/,
    'An empty fallback must not add a segment rejected by deployed agents',
  );
  assert.match(local, /accept\(listener_,reinterpret_cast<sockaddr\*>\(&\w+\),&\w+\)/);
  assert.match(
    local,
    /\.sin_addr\.s_addr\s*!=\s*\w+/,
    'The LAN listener accepts only the console own address',
  );
  assert.match(
    agent,
    /\{"pairingCode",state\["pairing"\]\["code"\]\}/,
    'The agent exposes only its short-lived local pairing code',
  );
  assert.match(
    frontend,
    /client\.request\("POST","\/api\/v1\/pairings\/claim"/,
    'The paired storefront claims its local agent through the server',
  );
});

test('native storefront recovery sends only its saved recovery token', async () => {
  const [header, client] = await Promise.all([
    nativeSource('../frontend/ps5/common/client.hpp'),
    nativeSource('../frontend/ps5/common/client.cpp', '../frontend/ps5/common/client_state.cpp'),
  ]);
  assert.doesNotMatch(header, /pairFrontend\([^;]*hardwareProof/);
  assert.match(
    client,
    /if\(!state\["recoveryChecked"\]\.boolean\(\)&&!state\["recoveryToken"\]\.string\(\)\.empty\(\)\)/,
  );
  assert.doesNotMatch(client, /body\.set\("hardwareProof"/);
});

test('production agent and storefront reuse snapshots without continuous diagnostics', async () => {
  const [header, agent, main, frontend, local] = await Promise.all([
    nativeSource('../frontend/ps5/common/client.hpp'),
    nativeSource('../frontend/ps5/agent/agent.cpp'),
    nativeSource('../frontend/ps5/agent/main.cpp'),
    storefrontSource(),
    nativeSource('../frontend/ps5/agent/local.hpp'),
  ]);
  assert.match(header, /Jsonheartbeat\(boolforceInventory=false\);Jsontick\(\);/);
  assert.match(main, /autolatest=agent->tick\(\)/);
  assert.match(
    main,
    /agent->heartbeatIntervalSeconds\(\)/,
    'The standalone agent honors the authenticated server cadence',
  );
  assert.match(
    frontend,
    /agent\.heartbeatIntervalSeconds\(\)/,
    'The embedded agent honors the authenticated server cadence',
  );
  assert.doesNotMatch(main, /agent->tick\(\);cached=Json\(\);scan\(\)/);
  assert.match(
    main,
    /seconds\(60\)[^;]+agent->localSnapshot\(\)/,
    'Only the background refresh performs a local filesystem scan',
  );
  assert.match(
    main,
    /nativeBecameReady[^;]+nativeDownloadsAvailable\(\)[\s\S]+nativeBecameReady[^;]+agent->localSnapshot\(\)/,
    'An asynchronously initialized native installer invalidates the incomplete snapshot immediately',
  );
  assert.match(main, /returnsnapshot\(\);\};/, 'Snapshot requests reuse the latest cached scan');
  assert.match(
    main,
    /autofile=.*cached\.null\(\).*localMediaPath\(cached\["snapshot"\]/,
    'Media requests reuse the latest cached scan',
  );
  assert.match(
    agent,
    /shadowMountRefreshDue[\s\S]+shadowMountGames_=games;[\s\S]+autoshadowGames=shadowMountGames_/,
    'ShadowMount status and game inventory use a throttled cache',
  );
  assert.ok(
    agent.indexOf('"/api/v1/device/heartbeat"') < agent.indexOf('"/api/v1/device/hardware"'),
    'The heartbeat rejects a stale credential before optional hardware enrollment can block recovery',
  );
  assert.doesNotMatch(main + frontend, /local-snapshot\.json/);
  assert.doesNotMatch(main, /NativeDiagnosticCollector/);
  assert.doesNotMatch(
    main,
    /pollPs5MdbgFlags\(/,
    'A game launch trace must not run a potentially blocking debug call in the heartbeat process',
  );
  assert.doesNotMatch(
    local,
    /localNativeDiagnosticDirectory|NativeDiagnosticStamp|collectNativeDiagnostics/,
  );
  assert.match(
    frontend,
    /localAgentRequest\("POST",path\)/,
    'Every local refresh reasserts the persisted online or offline preference',
  );
  assert.doesNotMatch(frontend, /performance-live\.json|drawTimes_|presentTimes_|intervalTimes_/);
});

test('PS5 agent keeps the saved online mode across agent and storefront restarts', async () => {
  const [source, frontend] = await Promise.all([
    nativeSource('../frontend/ps5/agent/main.cpp'),
    storefrontSource(),
  ]);
  assert.match(
    source,
    /boolnetworkAuthorized=!settings\["serverUrl"\]\.string\(\)\.empty\(\)&&!enabled\(offline\);/,
  );
  const ipc = source.slice(source.indexOf('autoserve=[&]'), source.indexOf('autolaunchPending='));
  assert.doesNotMatch(
    ipc,
    /networkAuthorized=false|atomicJson\(offline,Json\(true\)\)/,
    'IPC discovery and restart must not overwrite the persisted offline preference',
  );
  assert.match(frontend, /localAgentRequest\("POST",path\)/);
  assert.doesNotMatch(
    frontend,
    /localControl_|localRequestControl_|"GET","\/api\/v1\/agent\/snapshot"/,
    'A restarted agent must not inherit stale frontend control state',
  );
});

test('native FPKG keeps private state in app data and uses guarded native destinations', async () => {
  const [agent, native, discovery, installed, storage, main] = await Promise.all([
    nativeSource('../frontend/ps5/agent/agent.cpp'),
    nativeSource('../frontend/ps5/agent/native.cpp'),
    nativeSource('../frontend/ps5/agent/discovery.cpp'),
    nativeSource('../frontend/ps5/agent/installed.cpp'),
    nativeSource('../frontend/ps5/agent/storage_format.cpp'),
    nativeSource('../frontend/ps5/agent/main.cpp'),
  ]);
  assert.match(agent, /nativeInstall=root=="\/user"/);
  assert.match(
    agent,
    /if\(!hasManagedInstall\)configured\.add/,
    'The synthetic internal destination must not duplicate a configured /user volume',
  );
  assert.match(agent, /moveType==2\|\|\(moveType==1&&externalFpkg_&&ps5ManagedUsbStorage/);
  assert.doesNotMatch(agent, /root=="\/data"[^\n]+methods\.add\("FPKG"\)/);
  assert.doesNotMatch(agent, /root=="\/mnt\/usb[0-9]*"[^\n]+methods\.add\("FPKG"\)/);
  assert.match(
    agent,
    /if\(method=="FPKG"\)\{if\(!fpkgSupported\)throwstd::runtime_error\("UNSUPPORTED_INPUT"\);if\(nativeDownload\(task,"\/data",root\)\)break;continue;\}/,
    'Only an active native install or move serializes later FPKG tasks',
  );
  assert.match(agent, /native-move\.json/);
  assert.match(
    agent,
    /nativeMoveTitle\(titleId,contentId,sourceType,targetType,statePath_\.parent_path\(\)\/"native-move-playgo"\)/,
  );
  const completion = agent.slice(
    agent.indexOf('boolAgent::nativeDownload'),
    agent.indexOf('JsonAgent::nativeAppUpdate'),
  );
  const beforeNativeInstall = completion.slice(0, completion.indexOf('autovolumes=storage()'));
  assert.doesNotMatch(
    beforeNativeInstall,
    /shadowMount|prepareBackport/,
    'A stopped compatibility runtime must not block the native package download',
  );
  assert.match(
    completion,
    /progress\("REGISTERING",size\);[\s\S]+if\(!task\["backport"\]\.null\(\)\)[\s\S]+if\(!shadowMountPkgBackportSupported\(shadowMount_\)\|\|!shadowMountRoots_\.size\(\)\)returnfalse;[\s\S]+overlay=prepareBackport/,
    'An installed package waits in REGISTERING until its exact backport can be prepared',
  );
  assert.match(
    completion,
    /restoreNativeInstallTarget\(marker\);if\(task\["state"\]\.string\(\)=="QUEUED_FOR_PS5"\)progress\("TRANSFERRING",size\);/,
    'An already-installed retry follows the valid transfer state transition',
  );
  assert.doesNotMatch(
    completion,
    /throwstd::runtime_error\("BACKPORT_RUNTIME_UNAVAILABLE"\)/,
    'A stopped runtime is a wait state after download, not a terminal transfer error',
  );
  assert.match(
    completion,
    /sameStorageDevice\(file,storageRoot\)/,
    'Native completion must prove the selected physical storage device',
  );
  assert.match(
    completion,
    /file\.empty\(\)\|\|static_cast<int64_t>\(fs::file_size\(file\)\)!=installedSize/,
    'Native completion must require the inspected installed-image size',
  );
  assert.match(
    completion,
    /nativePackageRegistered\(task\)/,
    'Native completion must require the exact registered release',
  );
  assert.match(
    completion,
    /submitNativeDownload\(marker,hash,[\s\S]*?,icon,update\?-1:targetType\);/,
    'Base installs submit directly to the selected native destination; updates retain their installed destination',
  );
  assert.match(
    native,
    /metadata\["titleId"\].+metadata\["contentId"\].+metadata\["contentVersion"\]/,
    'Registration verification must compare title, content, and version',
  );
  assert.doesNotMatch(
    completion,
    /fileHash\(file/,
    'Native completion must not reread the installed package for SHA-256',
  );
  assert.equal(
    agent.match(/task\["backportProfileHash"\]/g)?.length,
    4,
    'Integrated and overlay profiles use the same verified progress receipt',
  );
  assert.match(
    agent,
    /\{"integratedBackportProfiles",true\}/,
    'The agent advertises the integrated-profile receipt protocol explicitly',
  );
  assert.equal(
    agent.match(/\{"backportProfileId",task\["backportProfileId"\]\}/g)?.length,
    2,
    'Both installation paths retain an integrated profile ID without external files',
  );
  assert.doesNotMatch(agent, /\{"backportProfileId",task\["backport"\]/);
  assert.match(
    installed,
    /root=="\/mnt\/ext0"[\s\S]+root\/"user\/app"[\s\S]+root\/"ps5\/user\/app"[\s\S]+root=="\/mnt\/ext1"[\s\S]+root\/"user\/app"/,
  );
  assert.doesNotMatch(discovery, /externalFpkgAttestation/);
  assert.match(storage, /contextOffset=0x531280/);
  assert.match(main, /external-fpkg-patch\.json/);
  assert.doesNotMatch(
    agent,
    /downloadstarted|downloadfailed|addedtoPS5Downloads|readyinyourlibrary|isreadytoplay/,
  );
});

test('Remote Play initializes User Service before reading the account ID', async () => {
  const source = await nativeSource('../frontend/ps5/agent/remote_play.cpp');
  const initialize = source.indexOf('sceUserServiceInitialize(nullptr)'),
    account = source.indexOf('intresult=sceUserServiceGetNpAccountId');
  assert.ok(initialize >= 0 && account > initialize);
});

test(
  'native setup, pairing, verified transfer and private server switching',
  { timeout: 150000 },
  async () => {
    const suffix = randomUUID().replaceAll('-', ''),
      workspace = process.cwd(),
      relative = `data/native-check-${suffix}`,
      root = path.join(workspace, relative),
      container = `ps5library-check-${suffix}`;
    const base = configuration(),
      admin = database(base.DATABASE_URL),
      schema = `native_${suffix}`;
    await admin.query(`CREATE SCHEMA ${schema}`);
    const url = new URL(base.DATABASE_URL);
    url.searchParams.set('options', `-c search_path=${schema}`);
    const config = {
      ...base,
      DATABASE_URL: url.href,
      DUMP_ROOT: '',
      DATA_DIR: root,
      SOURCE_ROOT: path.join(root, 'sources'),
      DISK_MARGIN_BYTES: 0,
    };
    await mkdir(path.join(root, 'console'), { recursive: true });
    await mkdir(path.join(root, 'storage'));
    let app = await createApp(config);
    const execute = promisify(execFile);
    const arrivals: (string | undefined)[] = [];
    const alternate = createServer((request, response) => {
      arrivals.push(request.headers.authorization);
      request.resume();
      response.writeHead(503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'TEST_SERVER_UNAVAILABLE' }));
    });
    const call = async (method: string, route: string, payload?: unknown, token?: string) => {
      const response = await app.inject({
        method: method as 'GET',
        url: '/api/v1' + route,
        payload,
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      assert.ok(response.statusCode < 400, response.body);
      return response.json();
    };
    try {
      const address = await app.listen({ host: '0.0.0.0', port: 0 }),
        port = new URL(address).port;
      const account = await call('POST', '/auth/register', {
          username: `native-${suffix}`,
          password: 'test-native-check-password-1234',
          bootstrapToken: config.BOOTSTRAP_TOKEN,
        }),
        token = account.token;
      await writeFile(
        path.join(root, 'console/config.json'),
        JSON.stringify({
          serverUrl: '',
          allowInsecureLan: false,
          name: 'Native host simulation',
          runtime: 'host-simulator',
          firmware: '4.51',
          storage: [
            {
              storageId: 'test',
              displayName: 'Host test storage',
              path: '/state/storage',
            },
          ],
        }),
      );
      await execute(
        'docker',
        [
          'run',
          '--rm',
          '--name',
          container,
          '-e',
          'SDL_VIDEODRIVER=dummy',
          '-v',
          `${path.resolve(workspace, '..')}:/workspace:ro`,
          '-v',
          `${root}:/state`,
          'ps5library-build:0.43',
          'frontend/ps5/build/host/ps5library',
          '/state/console/config.json',
          '--frames=320',
          `--script=select,text:http://host.docker.internal:${port},enter,enter,select,down,select`,
        ],
        { timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true },
      );
      const connection = JSON.parse(await readFile(path.join(root, 'console/config.json'), 'utf8'));
      assert.equal(connection.serverUrl, `http://host.docker.internal:${port}`);
      assert.equal(
        connection.allowInsecureLan,
        true,
        'HTTP requires an explicit controller selection',
      );
      assert.equal(connection.name, 'Native host simulation');
      const tick = async () => {
        try {
          await execute(
            'docker',
            [
              'run',
              '--rm',
              '--name',
              container,
              '-v',
              `${path.resolve(workspace, '..')}:/workspace:ro`,
              '-v',
              `${root}:/state`,
              'ps5library-build:0.43',
              'frontend/ps5/build/host/ps5library-agent',
              '/state/console/config.json',
              '--once',
            ],
            { timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true },
          );
        } catch (error: any) {
          throw new Error(
            `${error.message}\nstdout: ${error.stdout ?? ''}\nstderr: ${error.stderr ?? ''}\nkilled: ${error.killed} signal: ${error.signal}`,
          );
        }
      };
      await tick();
      const pending = JSON.parse(
        await readFile(path.join(root, 'console/device-state.json'), 'utf8'),
      );
      assert.ok(pending.pairing?.code, 'Native agent requested pairing');
      await call('POST', '/pairings/claim', { code: pending.pairing.code }, token);
      await tick();
      await tick();
      const consoles = await call('GET', '/consoles', undefined, token),
        consoleId = consoles[0].id;
      assert.equal(consoles[0].clientKind, 'SIMULATOR');
      const revisionDb = database(config.DATABASE_URL);
      await revisionDb.query('UPDATE consoles SET library_revision=100 WHERE id=$1', [consoleId]);
      await revisionDb.end();
      await tick();
      assert.equal(
        JSON.parse(await readFile(path.join(root, 'console/device-state.json'), 'utf8'))
          .libraryRevision,
        100,
        'A reset agent fast-forwards to the server inventory revision',
      );
      await tick();
      const acceptedRevisionDb = database(config.DATABASE_URL);
      assert.equal(
        Number(
          (
            await acceptedRevisionDb.query('SELECT library_revision FROM consoles WHERE id=$1', [
              consoleId,
            ])
          ).rows[0].library_revision,
        ),
        101,
        'The next full snapshot advances past the server revision',
      );
      await acceptedRevisionDb.end();
      const source = path.join(config.SOURCE_ROOT, account.user.id, 'own-homebrew');
      await mkdir(source, { recursive: true });
      const input = path.join(root, 'fixture.elf'),
        fixture = Buffer.alloc(64 * 1024);
      fixture.set([0x7f, 0x45, 0x4c, 0x46, 2, 1, 1]);
      fixture.writeUInt16LE(2, 16);
      fixture.writeUInt16LE(62, 18);
      await writeFile(input, fixture);
      const digest = await fileHash(input),
        size = (await stat(input)).size;
      await copyFile(input, path.join(source, 'store.elf'));
      await writeFile(
        path.join(source, 'library.json'),
        JSON.stringify({
          schemaVersion: 1,
          releases: [
            {
              key: 'store',
              game: {
                title: 'PS5Library native transfer check',
                titleId: 'BREW05001',
                contentId: 'IV0000-BREW05001_00-PS5LIBRARYAPP000',
              },
              version: '01.00',
              format: 'elf',
              size,
              sha256: digest,
              location: 'store.elf',
              minimumFirmware: '1.00',
            },
          ],
        }),
      );
      const repository = await call(
        'POST',
        '/sources',
        { name: 'Our compiled ELF', type: 'LOCAL_FOLDER', location: 'own-homebrew' },
        token,
      );
      await call('POST', `/sources/${repository.id}/sync`, {}, token);
      const games = await call('GET', '/catalog', undefined, token),
        release = games[0].releases[0];
      const frontendPair = await call('POST', '/frontend/pairings', { deviceId: randomUUID() });
      await call('POST', '/pairings/claim', { code: frontendPair.code, consoleId }, token);
      const frontend = await call('POST', `/pairings/${frontendPair.id}/poll`, {
        pollSecret: frontendPair.pollSecret,
      });
      const installation = await call(
        'POST',
        '/device/installations',
        { sourceReleaseId: release.sources[0].id, consoleId, storageId: 'test' },
        frontend.credential,
      );
      let request: any;
      for (let i = 0; i < 200; i++) {
        request = (await call('GET', '/installations', undefined, token)).find(
          (v: any) => v.id === installation.id,
        );
        if (request.transferJobId || request.state === 'ERROR') break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.ok(request.transferJobId, JSON.stringify(request));
      await tick();
      let entries = await call('GET', `/consoles/${consoleId}/library`, undefined, token);
      assert.equal(entries[0].state, 'READY_ON_PS5');
      const device = JSON.parse(
        await readFile(path.join(root, 'console/device-state.json'), 'utf8'),
      );
      assert.ok(device.credential);
      assert.equal(device.serverUrl, `http://host.docker.internal:${port}`);
      const receipt = JSON.parse(
        await readFile(
          path.join(root, 'storage/.ps5library/receipts', request.transferJobId + '.json'),
          'utf8',
        ),
      );
      assert.equal(receipt.serverUrl, device.serverUrl);
      assert.equal(receipt.consoleId, consoleId);
      const output = path.join(root, 'storage', receipt.relativePath);
      assert.equal(await fileHash(output), digest);
      assert.equal(receipt.registered, false, 'Simulator never claims installed PS5 registration');
      const withoutConfirmation = await app.inject({
        method: 'POST',
        url: `/api/v1/consoles/${consoleId}/library/remove`,
        payload: { releaseId: release.id, storageId: 'test' },
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(withoutConfirmation.statusCode, 400);
      const removal = await call(
        'POST',
        `/consoles/${consoleId}/library/remove`,
        { releaseId: release.id, storageId: 'test', confirm: true },
        token,
      );
      assert.equal(
        (
          await call(
            'POST',
            `/consoles/${consoleId}/library/remove`,
            { releaseId: release.id, storageId: 'test', confirm: true },
            token,
          )
        ).id,
        removal.id,
        'Repeated confirmation reuses the pending removal',
      );
      assert.equal(
        (
          await app.inject({
            method: 'POST',
            url: `/api/v1/device/removals/${removal.id}/progress`,
            payload: { state: 'COMPLETED' },
            headers: { authorization: `Bearer ${device.credential}` },
          })
        ).statusCode,
        409,
        'Cannot claim completion before verified disappearance',
      );
      await tick();
      await tick();
      entries = await call('GET', `/consoles/${consoleId}/library`, undefined, token);
      assert.equal(entries[0].state, 'MISSING', 'Confirmed removal must remove the console copy');
      assert.equal((await call('GET', `/jobs/${removal.id}`, undefined, token)).state, 'COMPLETED');
      assert.equal(await stat(output).catch(() => null), null);
      assert.equal(
        await fileHash(path.join(source, 'store.elf')),
        digest,
        'Original source remains intact',
      );
      const corruptTransfer = await call(
        'POST',
        '/transfers',
        { artifactId: request.artifactId, consoleId, storageId: 'test' },
        token,
      );
      const sql = database(config.DATABASE_URL);
      const artifact = (
        await sql.query('SELECT relative_path FROM artifacts WHERE id=$1', [request.artifactId])
      ).rows[0];
      await sql.end();
      const cached = path.join(root, artifact.relative_path),
        changed = await readFile(cached);
      changed[0] ^= 1;
      await writeFile(cached, changed);
      await tick();
      const failed = await call('GET', `/jobs/${corruptTransfer.id}`, undefined, token);
      assert.equal(failed.state, 'ERROR', 'A native checksum failure is reported to both clients');
      assert.equal(failed.error, 'CORRUPT_INPUT');
      const legacy = path.join(root, 'storage/PPSA03208-app0');
      await mkdir(path.join(legacy, 'sce_sys'), { recursive: true });
      const parameters = {
        titleId: 'PPSA03208',
        contentId: 'EP9000-PPSA03208_00-GHOSTSHIP0000000',
        contentVersion: '02.017.000',
        localizedParameters: {
          defaultLanguage: 'en-US',
          'en-US': { titleName: 'Existing native dump' },
        },
      };
      await writeFile(path.join(legacy, 'sce_sys/param.json'), JSON.stringify(parameters));
      await writeFile(path.join(legacy, 'eboot.bin'), 'owned fixture');
      await copyFile(
        path.join(workspace, '../frontend/ps5/assets/icon0.png'),
        path.join(legacy, 'sce_sys/icon0.png'),
      );
      await tick();
      const imported = (await call('GET', '/catalog', undefined, token)).find(
        (g: any) => g.titleId === parameters.titleId,
      );
      assert.ok(imported, 'Existing dump is imported by the actual native agent');
      const image = await app.inject({
        url: imported.coverUrl,
        headers: { authorization: `Bearer ${token}` },
      });
      assert.equal(
        image.headers['content-type'],
        'image/svg+xml',
        'The server keeps a placeholder while the console reads its local icon',
      );
      const localStatus = await app.inject({
          url: '/api/v1/device/status',
          headers: { authorization: `Bearer ${device.credential}` },
        }),
        status = localStatus.json();
      assert.equal(status.storage[0].path, '/state/storage');
      assert.equal(
        status.library.find((item: any) => item.releaseId === imported.releases[0].id).relativePath,
        'PPSA03208-app0',
      );
      assert.equal(
        JSON.parse(await readFile(path.join(legacy, 'sce_sys/param.json'), 'utf8')).contentVersion,
        parameters.contentVersion,
      );
      await rm(path.join(legacy, 'eboot.bin'));
      await tick();
      assert.equal(
        (await call('GET', `/consoles/${consoleId}/library`, undefined, token)).find(
          (r: any) => r.titleId === parameters.titleId,
        ).state,
        'MISSING',
      );
      await new Promise<void>((resolve, reject) => {
        alternate.once('error', reject);
        alternate.listen(0, '0.0.0.0', resolve);
      });
      const alternateUrl = `http://host.docker.internal:${(alternate.address() as { port: number }).port}`;
      const switchServer = async (confirm: boolean) =>
        execute(
          'docker',
          [
            'run',
            '--rm',
            '--name',
            container,
            '-e',
            'SDL_VIDEODRIVER=dummy',
            '-v',
            `${path.resolve(workspace, '..')}:/workspace:ro`,
            '-v',
            `${root}:/state`,
            'ps5library-build:0.43',
            'frontend/ps5/build/host/ps5library',
            '/state/console/config.json',
            `--frames=${confirm ? 340 : 210}`,
            `--script=settings,select,text:${alternateUrl},enter,enter,down,select${confirm ? ',wait,wait,up,select' : ''}`,
          ],
          { timeout: 45000, maxBuffer: 1024 * 1024, windowsHide: true },
        );
      const unconfirmed = await switchServer(false);
      assert.equal(
        JSON.parse(unconfirmed.stdout.trim()).focus,
        'keep-server',
        'Switching defaults to keeping the current server',
      );
      assert.equal(
        JSON.parse(await readFile(path.join(root, 'console/config.json'), 'utf8')).serverUrl,
        device.serverUrl,
      );
      assert.equal(arrivals.length, 0, 'No connection to a new server before confirmation');
      await switchServer(true);
      const switched = JSON.parse(
        await readFile(path.join(root, 'console/device-state.json'), 'utf8'),
      );
      assert.equal(switched.serverUrl, alternateUrl);
      assert.notEqual(switched.deviceId, device.deviceId);
      assert.equal(switched.credential, undefined);
      assert.ok(arrivals.length > 0, 'The new server was contacted');
      assert.ok(
        arrivals.every((header) => header === undefined),
        'The previous server credential was never forwarded',
      );
      const backup = JSON.parse(
        await readFile(path.join(root, 'console/previous-server.json'), 'utf8'),
      );
      assert.equal(backup.device.credential, undefined);
      assert.equal(backup.device.pairing, undefined);
      assert.equal(backup.device.deviceId, device.deviceId);
      assert.deepEqual(
        JSON.parse(
          await readFile(
            path.join(root, 'storage/.ps5library/receipts', request.transferJobId + '.json'),
            'utf8',
          ),
        ),
        receipt,
        'Switching preserves previous local files',
      );
    } finally {
      await execute('docker', ['rm', '-f', container], { windowsHide: true }).catch(() => {});
      if (alternate.listening)
        await new Promise<void>((resolve) => alternate.close(() => resolve()));
      await app.close();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
      if (!root.startsWith(path.join(workspace, 'data') + path.sep))
        throw Error('Unsafe test cleanup');
      await rm(root, { recursive: true, force: true });
    }
  },
);
