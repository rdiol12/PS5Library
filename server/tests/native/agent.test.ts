import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir,readFile,writeFile,copyFile,rm,stat } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { createApp } from '../../src/api/app.js';
import { configuration } from '../../src/config.js';
import { database } from '../../src/db.js';
import { fileHash } from '../../src/downloads/stream.js';

test('actual native agent pairs, verifies an ELF, reconciles deletion and rejects corrupt bytes',{timeout:120000},async()=>{
  const suffix=randomUUID().replaceAll('-',''),workspace=process.cwd(),relative=`data/native-check-${suffix}`,root=path.join(workspace,relative),container=`ps5library-check-${suffix}`;
  const base=configuration(),admin=database(base.DATABASE_URL),schema=`native_${suffix}`;await admin.query(`CREATE SCHEMA ${schema}`);
  const url=new URL(base.DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
  const config={...base,DATABASE_URL:url.href,DATA_DIR:root,SOURCE_ROOT:path.join(root,'sources'),DISK_MARGIN_BYTES:0};
  await mkdir(path.join(root,'console'),{recursive:true});await mkdir(path.join(root,'storage'));
  let app=await createApp(config);const execute=promisify(execFile);
  const call=async(method:string,route:string,payload?:unknown,token?:string)=>{const response=await app.inject({method:method as 'GET',url:'/api/v1'+route,payload,headers:token?{authorization:`Bearer ${token}`}:{}});assert.ok(response.statusCode<400,response.body);return response.json();};
  try{
    const address=await app.listen({host:'0.0.0.0',port:0}),port=new URL(address).port;
    const account=await call('POST','/auth/register',{username:`native-${suffix}`,password:'native-check-password-1234',bootstrapToken:config.BOOTSTRAP_TOKEN}),token=account.token;
    await writeFile(path.join(root,'console/config.json'),JSON.stringify({serverUrl:`http://host.docker.internal:${port}`,allowInsecureLan:true,name:'Native host simulation',runtime:'host-simulator',firmware:'4.51',storage:[{storageId:'test',displayName:'Host test storage',path:`/workspace/${relative}/storage`}]}));
    const tick=async()=>{await execute('docker',['run','--rm','--name',container,'-v',`${workspace}:/workspace`,'ps5library-build:0.43','ps5/build/host/ps5library-agent',`${relative}/console/config.json`,'--once'],{timeout:45000,maxBuffer:1024*1024,windowsHide:true});};
    await tick();const pending=JSON.parse(await readFile(path.join(root,'console/device-state.json'),'utf8'));
    assert.ok(pending.pairing?.code,'Native agent requested pairing');await call('POST','/pairings/claim',{code:pending.pairing.code},token);
    await tick();await tick();const consoles=await call('GET','/consoles',undefined,token),consoleId=consoles[0].id;assert.equal(consoles[0].clientKind,'SIMULATOR');
    const source=path.join(config.SOURCE_ROOT,account.user.id,'own-homebrew');await mkdir(source,{recursive:true});
    const input=path.join(workspace,'ps5/build/ps5/ps5library.elf'),digest=await fileHash(input),size=(await stat(input)).size;await copyFile(input,path.join(source,'store.elf'));
    await writeFile(path.join(source,'library.json'),JSON.stringify({schemaVersion:1,releases:[{key:'store',game:{title:'PS5Library native transfer check',titleId:'BREW05001',contentId:'IV0000-BREW05001_00-PS5LIBRARYAPP000'},version:'01.00',format:'elf',size,sha256:digest,location:'store.elf',minimumFirmware:'1.00'}]}));
    const repository=await call('POST','/sources',{name:'Our compiled ELF',type:'LOCAL_FOLDER',location:'own-homebrew'},token);await call('POST',`/sources/${repository.id}/sync`,{},token);
    const games=await call('GET','/catalog',undefined,token),release=games[0].releases[0];
    const installation=await call('POST','/installations',{sourceReleaseId:release.sources[0].id,consoleId,storageId:'test'},token);
    let request:any;for(let i=0;i<200;i++){request=(await call('GET','/installations',undefined,token)).find((v:any)=>v.id===installation.id);if(request.transferJobId||request.state==='ERROR')break;await new Promise(resolve=>setTimeout(resolve,100));}
    assert.ok(request.transferJobId,JSON.stringify(request));await tick();
    let entries=await call('GET',`/consoles/${consoleId}/library`,undefined,token);assert.equal(entries[0].state,'READY_ON_PS5');
    const device=JSON.parse(await readFile(path.join(root,'console/device-state.json'),'utf8'));assert.ok(device.credential);assert.equal(device.serverUrl,`http://host.docker.internal:${port}`);
    const receipt=JSON.parse(await readFile(path.join(root,'storage/.ps5library/receipts',request.transferJobId+'.json'),'utf8'));
    const output=path.join(root,'storage',receipt.relativePath);assert.equal(await fileHash(output),digest);assert.equal(receipt.registered,false,'Simulator never claims installed PS5 registration');
    await rm(output);await tick();entries=await call('GET',`/consoles/${consoleId}/library`,undefined,token);assert.equal(entries[0].state,'MISSING');
    const corruptTransfer=await call('POST','/transfers',{artifactId:request.artifactId,consoleId,storageId:'test'},token);
    const sql=database(config.DATABASE_URL);const artifact=(await sql.query('SELECT relative_path FROM artifacts WHERE id=$1',[request.artifactId])).rows[0];await sql.end();
    const cached=path.join(root,artifact.relative_path),changed=await readFile(cached);changed[0]^=1;await writeFile(cached,changed);
    await tick();const failed=await call('GET',`/jobs/${corruptTransfer.id}`,undefined,token);assert.equal(failed.state,'ERROR','A native checksum failure is reported to both clients');assert.equal(failed.error,'CORRUPT_INPUT');
  }finally{await execute('docker',['rm','-f',container],{windowsHide:true}).catch(()=>{});await app.close();await admin.query(`DROP SCHEMA ${schema} CASCADE`);await admin.end();if(!root.startsWith(path.join(workspace,'data')+path.sep))throw Error('Unsafe test cleanup');await rm(root,{recursive:true,force:true});}
});
