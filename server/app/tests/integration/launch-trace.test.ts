import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { api, isolatedApp } from './test-app.js';

test(
  'completed launch traces are bounded, agent-authenticated, idempotent, and owner-readable',
  { timeout: 60000 },
  async () => {
    const { config, admin, schema, app, db } = await isolatedApp('ps5library-launch-trace-', {
      COMMUNITY_MASTER_URL: '',
    });
    const call = api(() => app);
    try {
      const owner = await call('POST', '/auth/register', {
        username: 'trace-owner',
        password: 'test-password',
        bootstrapToken: config.BOOTSTRAP_TOKEN,
      });
      const invite = await call('POST', '/admin/invites', {}, owner.body.token),
        friend = await call('POST', '/auth/register', {
          username: 'trace-friend',
          password: 'test-password',
          inviteToken: invite.body.token,
        });
      const pair = await call('POST', '/pairings', {
        deviceId: randomUUID(),
        name: 'Trace PS5',
        clientKind: 'PS5',
        firmware: '4.51',
      });
      await call('POST', '/pairings/claim', { code: pair.body.code }, owner.body.token);
      const device = await call('POST', `/pairings/${pair.body.id}/poll`, {
          pollSecret: pair.body.pollSecret,
        }),
        consoleId = device.body.consoleId;
      const gameId = randomUUID(),
        releaseId = randomUUID(),
        artifactId = randomUUID(),
        transferId = randomUUID(),
        contentId = 'UP0000-PPSA19943_00-PS5LIBRARYTEST00';
      const decoyReleaseId = randomUUID(),
        decoyArtifactId = randomUUID(),
        decoyTransferId = randomUUID();
      const sourceHash = 'a'.repeat(64),
        installedHash = 'b'.repeat(64),
        decoySourceHash = 'c'.repeat(64),
        decoyInstalledHash = 'd'.repeat(64),
        decoyCurrentHash = 'e'.repeat(64);
      await db.query(
        "INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,'PPSA19943','Crashing title','{}')",
        [gameId, owner.body.user.id],
      );
      await db.query(
        "INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) VALUES($1,$2,$3,'01.00','BASE','{}')",
        [releaseId, gameId, contentId],
      );
      await db.query(
        "INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) VALUES($1,$2,$3,'02.00','UPDATE','{}')",
        [decoyReleaseId, gameId, contentId],
      );
      await db.query(
        "INSERT INTO artifacts(id,release_id,format,relative_path,sha256,size,verified,inspection) VALUES($1,$2,'pkg',$3,$4,1024,true,$5)",
        [
          artifactId,
          releaseId,
          `artifacts/${artifactId}.pkg`,
          sourceHash,
          { installedImage: { size: 1024, sha256: installedHash } },
        ],
      );
      await db.query(
        "INSERT INTO artifacts(id,release_id,format,relative_path,sha256,size,verified,inspection) VALUES($1,$2,'pkg',$3,$4,1024,true,$5)",
        [
          decoyArtifactId,
          decoyReleaseId,
          `artifacts/${decoyArtifactId}.pkg`,
          decoySourceHash,
          { installedImage: { size: 1024, sha256: decoyInstalledHash } },
        ],
      );
      await db.query(
        'INSERT INTO ' +
          'console_storage(console_id,storage_id,display_name,path,total_bytes,free_bytes,writable,methods) ' +
          "VALUES($1,'m2','M.2 SSD','/mnt/ext1',4096,2048,true,'[\"FPKG\"]')",
        [consoleId],
      );
      await db.query(
        'INSERT INTO ' +
          'console_library_entries(console_id,release_id,storage_id,state,sha256,size,registered) ' +
          "VALUES($1,$2,'m2','READY_ON_PS5',$3,1024,true)",
        [consoleId, releaseId, installedHash],
      );
      await db.query(
        'INSERT INTO ' +
          'console_library_entries(console_id,release_id,storage_id,state,sha256,size,registered) ' +
          "VALUES($1,$2,'m2','READY_ON_PS5',$3,1024,true)",
        [consoleId, decoyReleaseId, decoyCurrentHash],
      );
      await db.query(
        'INSERT INTO ' +
          'jobs(id,user_id,kind,release_id,artifact_id,console_id,storage_id,state,total_bytes,downloaded_bytes,config,updated_at) ' +
          "VALUES($1,$2,'TRANSFER',$3,$4,$5,'m2','READY_ON_PS5',1024,1024,$6,now()-interval '1 minute')",
        [transferId, owner.body.user.id, releaseId, artifactId, consoleId, { method: 'FPKG' }],
      );
      await db.query(
        'INSERT INTO ' +
          'jobs(id,user_id,kind,release_id,artifact_id,console_id,storage_id,state,total_bytes,downloaded_bytes,config) ' +
          "VALUES($1,$2,'TRANSFER',$3,$4,$5,'m2','READY_ON_PS5',1024,1024,$6)",
        [
          decoyTransferId,
          owner.body.user.id,
          decoyReleaseId,
          decoyArtifactId,
          consoleId,
          { method: 'FPKG' },
        ],
      );
      const registers = {
        pid: 321,
        threadId: 101759,
        rax: '0x0000000000000000',
        rbx: '0x00000000056ac010',
        rcx: '0x2dc5f08537fa37cd',
        rdx: '0x0000000000000000',
        rsi: '0x0000000000000000',
        rdi: '0x0000000080198750',
        rbp: '0x00000007eeffbd60',
        rsp: '0x00000007eeffbd18',
        r8: '0xff00fffffffffff8',
        r9: '0x0000000000000040',
        r10: '0xff00fffffffffff8',
        r11: '0x0000000000000040',
        r12: '0x0000000006815cf8',
        r13: '0x0000000001655670',
        r14: '0x0000000006815eb0',
        r15: '0x00000000016ae300',
        rip: '0x0000000800032782',
        eflags: '0x0000000000000202',
      };
      const exceptionSnapshot = {
        schemaVersion: 1,
        status: 'COMPLETE',
        capturedAtUnixMs: 2501,
        stackBase: '0x00000007eeff8000',
        stackSize: 0x4000,
        stackSha256: '9'.repeat(64),
        modules: [
          {
            file: 'eboot.bin',
            library: 'eboot.bin',
            path: '/app0/eboot.bin',
            handle: '0x0000000000000000',
            sdkVersion: '0x0000000000000000',
            sections: [{ address: '0x0000000000400000', size: 0x48d4000, protection: 5 }],
          },
        ],
        stackCodePointers: [
          {
            stackOffset: 8,
            address: '0x0000000000400064',
            module: 0,
            moduleOffset: '0x0000000000000064',
          },
        ],
        registers,
      };
      const trace = {
        schemaVersion: 1,
        titleId: 'PPSA19943',
        source: 'AGENT',
        state: 'PROCESS_EXITED',
        traceStartedAtUnixMs: 1000,
        traceCompletedAtUnixMs: 5000,
        processObserved: true,
        pid: 321,
        processObservedAtUnixMs: 2000,
        mdbgPolled: true,
        mdbgAvailable: true,
        mdbgExceptionStop: true,
        mdbgCallResult: 0,
        mdbgStatus: 0,
        mdbgFlags: 0,
        mdbgObservedAtUnixMs: 3000,
        mdbgExceptionFlags: 524289,
        mdbgExceptionObservedAtUnixMs: 2500,
        klogAvailable: true,
        klogLookbackBytes: 0,
        errorHistoryAccessible: true,
        errorHistory: [{ name: 'error.json', content: { code: 'CE-108255-1' } }],
        errorHistoryTruncated: false,
        klog: 'loader failed\n',
        klogTruncated: false,
        exceptionSnapshot,
      };
      assert.equal((await call('POST', '/device/launch-traces', trace)).status, 401);
      const created = await call('POST', '/device/launch-traces', trace, device.body.credential);
      assert.equal(created.status, 201, JSON.stringify(created.body));
      const retried = await call('POST', '/device/launch-traces', trace, device.body.credential);
      assert.equal(retried.status, 200);
      assert.equal(retried.body.id, created.body.id);
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM console_heartbeats WHERE payload ? 'launchTrace'",
          )
        ).rows[0].n,
        1,
      );
      assert.equal(
        (await call('GET', `/consoles/${consoleId}/launch-traces`, undefined, friend.body.token))
          .status,
        404,
      );
      const stored = await call(
        'GET',
        `/consoles/${consoleId}/launch-traces`,
        undefined,
        owner.body.token,
      );
      assert.equal(stored.status, 200);
      assert.deepEqual(stored.body[0].trace, trace);
      assert.equal(stored.body[0].sha256, created.body.sha256);
      const artifact = (
        await db.query('SELECT verified,inspection FROM artifacts WHERE id=$1', [artifactId])
      ).rows[0];
      assert.equal(artifact.verified, true);
      assert.equal(artifact.inspection.launchFailure, undefined);
      const failedJob = (await db.query('SELECT config FROM jobs WHERE id=$1', [transferId]))
        .rows[0];
      assert.equal(failedJob.config.launchFailure.traceSha256, created.body.sha256);
      assert.equal(
        (
          await db.query("SELECT config ? 'launchFailure' AS failed FROM jobs WHERE id=$1", [
            decoyTransferId,
          ])
        ).rows[0].failed,
        false,
        'A newer job whose artifact does not match the installed bytes is not quarantined',
      );
      assert.equal(
        (await db.query('SELECT verified FROM artifacts WHERE id=$1', [decoyArtifactId])).rows[0]
          .verified,
        true,
      );
      assert.equal(
        (
          await db.query(
            'SELECT state FROM console_library_entries WHERE console_id=$1 AND release_id=$2',
            [consoleId, releaseId],
          )
        ).rows[0].state,
        'ERROR',
      );
      assert.equal(
        (
          await db.query(
            'SELECT state FROM console_library_entries WHERE console_id=$1 AND release_id=$2',
            [consoleId, decoyReleaseId],
          )
        ).rows[0].state,
        'READY_ON_PS5',
      );
      const heartbeat = {
        firmware: '4.51',
        runtime: 'kstuff',
        clientVersion: 'test',
        agentVersion: 'test',
        capabilities: { inventoryScan: true },
        storage: [
          {
            storageId: 'm2',
            displayName: 'M.2 SSD',
            path: '/mnt/ext1',
            totalBytes: 4096,
            freeBytes: 2048,
            writable: true,
            installMethodsSupported: ['FPKG'],
          },
        ],
        libraryRevision: 1,
        inventoryComplete: false,
        inventory: [
          {
            releaseId,
            titleId: 'PPSA19943',
            contentId,
            version: '01.00',
            title: 'Crashing title',
            storageId: 'm2',
            relativePath: 'app/PPSA19943/app.pkg',
            sha256: installedHash,
            size: 1024,
            available: true,
            registered: true,
            source: 'MANAGED',
          },
        ],
      };
      assert.equal(
        (await call('POST', '/device/heartbeat', heartbeat, device.body.credential)).status,
        200,
      );
      assert.equal(
        (
          await db.query(
            'SELECT state FROM console_library_entries WHERE console_id=$1 AND release_id=$2',
            [consoleId, releaseId],
          )
        ).rows[0].state,
        'ERROR',
        'Inventory cannot relabel a quarantined launch failure as ready',
      );
      const replacementArtifactId = randomUUID(),
        replacementTransferId = randomUUID(),
        replacementSourceHash = 'f'.repeat(64),
        replacementInstalledHash = '0'.repeat(64);
      await db.query(
        "INSERT INTO artifacts(id,release_id,format,relative_path,sha256,size,verified,inspection) VALUES($1,$2,'pkg',$3,$4,1024,true,$5)",
        [
          replacementArtifactId,
          releaseId,
          `artifacts/${replacementArtifactId}.pkg`,
          replacementSourceHash,
          { installedImage: { size: 1024, sha256: replacementInstalledHash } },
        ],
      );
      await db.query(
        'INSERT INTO ' +
          'jobs(id,user_id,kind,release_id,artifact_id,console_id,storage_id,state,total_bytes,downloaded_bytes,config) ' +
          "VALUES($1,$2,'TRANSFER',$3,$4,$5,'m2','REGISTERING',1024,1024,$6)",
        [
          replacementTransferId,
          owner.body.user.id,
          releaseId,
          replacementArtifactId,
          consoleId,
          { method: 'FPKG' },
        ],
      );
      const replacementHeartbeat = {
        ...heartbeat,
        libraryRevision: 2,
        inventory: [{ ...heartbeat.inventory[0], sha256: replacementInstalledHash }],
      };
      assert.equal(
        (await call('POST', '/device/heartbeat', replacementHeartbeat, device.body.credential))
          .status,
        200,
      );
      assert.equal(
        (
          await db.query(
            'SELECT state FROM console_library_entries WHERE console_id=$1 AND release_id=$2',
            [consoleId, releaseId],
          )
        ).rows[0].state,
        'READY_ON_PS5',
        'Different replacement bytes clear the per-transfer quarantine',
      );
      assert.equal(
        (
          await call(
            'POST',
            `/device/tasks/${replacementTransferId}/progress`,
            {
              state: 'READY_ON_PS5',
              downloadedBytes: 1024,
              speedBytesPerSecond: 0,
              sha256: replacementSourceHash,
            },
            device.body.credential,
          )
        ).status,
        200,
        'Replacement transfer can finish after inventory confirmation',
      );
      const ambiguousGameId = randomUUID(),
        ambiguousContentId = 'UP0000-PPSA19944_00-PS5LIBRARYTEST01',
        ambiguousJobs = [];
      await db.query(
        "INSERT INTO games(id,user_id,title_id,title,metadata) VALUES($1,$2,'PPSA19944','Ambiguous title','{}')",
        [ambiguousGameId, owner.body.user.id],
      );
      for (const [version, kind, byte] of [
        ['01.00', 'BASE', '1'],
        ['02.00', 'UPDATE', '2'],
      ]) {
        const ambiguousReleaseId = randomUUID(),
          ambiguousArtifactId = randomUUID(),
          ambiguousJobId = randomUUID(),
          ambiguousHash = byte.repeat(64);
        ambiguousJobs.push(ambiguousJobId);
        await db.query(
          "INSERT INTO game_releases(id,game_id,content_id,version,kind,metadata) VALUES($1,$2,$3,$4,$5,'{}')",
          [ambiguousReleaseId, ambiguousGameId, ambiguousContentId, version, kind],
        );
        await db.query(
          'INSERT INTO artifacts(id,release_id,format,relative_path,sha256,size,verified,inspection) ' +
            "VALUES($1,$2,'pkg',$3,$4,1024,true,$5)",
          [
            ambiguousArtifactId,
            ambiguousReleaseId,
            `artifacts/${ambiguousArtifactId}.pkg`,
            ambiguousHash,
            { installedImage: { size: 1024, sha256: ambiguousHash } },
          ],
        );
        await db.query(
          'INSERT INTO ' +
            'console_library_entries(console_id,release_id,storage_id,state,sha256,size,registered) ' +
            "VALUES($1,$2,'m2','READY_ON_PS5',$3,1024,true)",
          [consoleId, ambiguousReleaseId, ambiguousHash],
        );
        await db.query(
          'INSERT INTO ' +
            'jobs(id,user_id,kind,release_id,artifact_id,console_id,storage_id,state,total_bytes,downloaded_bytes,config) ' +
            "VALUES($1,$2,'TRANSFER',$3,$4,$5,'m2','READY_ON_PS5',1024,1024,$6)",
          [
            ambiguousJobId,
            owner.body.user.id,
            ambiguousReleaseId,
            ambiguousArtifactId,
            consoleId,
            { method: 'FPKG' },
          ],
        );
      }
      assert.equal(
        (
          await call(
            'POST',
            '/device/launch-traces',
            { ...trace, titleId: 'PPSA19944' },
            device.body.credential,
          )
        ).status,
        201,
      );
      assert.equal(
        (
          await db.query(
            "SELECT count(*)::int AS n FROM jobs WHERE id=ANY($1::uuid[]) AND config ? 'launchFailure'",
            [ambiguousJobs],
          )
        ).rows[0].n,
        0,
        'Ambiguous exact candidates are recorded without quarantining either transfer',
      );
      assert.equal(
        (
          await call(
            'POST',
            '/device/launch-traces',
            { ...trace, unknown: true },
            device.body.credential,
          )
        ).status,
        400,
      );
      const oversized = await app.inject({
        method: 'POST',
        url: '/api/v1/device/launch-traces',
        headers: {
          authorization: `Bearer ${device.body.credential}`,
          'content-type': 'application/json',
        },
        payload: JSON.stringify({ ...trace, klog: 'x'.repeat(1024 ** 2) }),
      });
      assert.equal(oversized.statusCode, 413);
    } finally {
      await app.close();
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    }
  },
);
