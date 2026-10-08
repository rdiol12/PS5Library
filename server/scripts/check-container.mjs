import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdir,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import pg from 'pg';
const execute=promisify(execFile),schema='container_'+randomUUID().replaceAll('-',''),name='ps5library-check-'+randomUUID(),worker=name+'-worker',ipc=name+'-ipc';
const root=path.resolve('data',schema),db=new pg.Pool({connectionString:process.env.DATABASE_URL});
const docker=(...args)=>execute('docker',args,{windowsHide:true,timeout:60000,maxBuffer:1024*1024});
for(const directory of ['sources','dumps','artifacts','backports','jobs','trailers','logs',path.join('artwork','.staging')])await mkdir(path.join(root,directory),{recursive:true});
await db.query(`CREATE SCHEMA ${schema}`);const url=new URL(process.env.DOCKER_DATABASE_URL);url.searchParams.set('options',`-c search_path=${schema}`);
let token,base;
async function waitReady(){for(let i=0;i<300;i++){if(await fetch(base+'/health').then(r=>r.ok).catch(()=>false))return;await new Promise(r=>setTimeout(r,200));}const logs=await docker('logs','--tail','50',name).then(r=>r.stdout+r.stderr).catch(()=>'(logs unavailable)');throw Error('Container did not become healthy\n'+logs);}
try{
  await docker('volume','create',ipc);
  await docker('run','-d','--name',worker,'--network','none','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','256','--memory','2g','--cpus','2','--tmpfs','/tmp:rw,noexec,nosuid,size=256m','-e','PACKAGE_WORKER_SOCKET=/worker-ipc/worker.sock',
    '-v',root+':/data:ro','-v',path.join(root,'jobs')+':/data/jobs','-v',path.join(root,'trailers')+':/data/trailers','-v',path.join(root,'logs')+':/data/logs','-v',path.join(root,'artwork','.staging')+':/data/artwork/.staging','-v',path.join(root,'sources')+':/sources:ro','-v',path.join(root,'dumps')+':/dumps:ro','-v',ipc+':/worker-ipc','ps5library-worker:local','node','dist/app/src/worker-main.js');
  await docker('run','-d','--name',name,'--network','ps5library_default','--read-only','--cap-drop','ALL','--security-opt','no-new-privileges:true','--pids-limit','256','--memory','2g','--cpus','2','--tmpfs','/tmp:rw,noexec,nosuid,size=256m','-p','127.0.0.1::3150',
    '-e','BOOTSTRAP_TOKEN='+process.env.BOOTSTRAP_TOKEN,'-e','DATABASE_URL='+url.href,'-e','REDIS_URL=redis://redis:6379','-e','DUMP_ROOT=','-e','SOURCE_ROOT=/sources','-e','HOST=0.0.0.0','-e','DATA_DIR=/data','-e','PACKAGE_WORKER_SOCKET=/worker-ipc/worker.sock','-e','TRAILER_WORKER_MODE=SANDBOX',
    '-v',root+':/data','-v',path.join(root,'sources')+':/sources:ro','-v',path.join(root,'dumps')+':/dumps','-v',ipc+':/worker-ipc','ps5library-server:local');
  const binding=(await docker('port',name,'3150/tcp')).stdout.trim();base='http://'+binding;await waitReady();
  const registered=await fetch(base+'/api/v1/auth/register',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:'container-owner',password:'sample-only-password',bootstrapToken:process.env.BOOTSTRAP_TOKEN})});
  assert.equal(registered.status,201);const account=await registered.json();token=account.token;
  const avatar=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64');
  const avatarUpload=await fetch(base+'/api/v1/profile/avatar',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({data:avatar.toString('base64')})});assert.equal(avatarUpload.status,200);
  const avatarRead=await fetch(base+'/api/v1/profile/avatar',{headers:{authorization:'Bearer '+token}});assert.equal(avatarRead.status,200);assert.equal(avatarRead.headers.get('content-type'),'image/webp');
  assert.notEqual((await docker('exec',name,'id','-u')).stdout.trim(),'0','Runtime must be unprivileged');
  assert.notEqual((await docker('exec',worker,'id','-u')).stdout.trim(),'0','Worker must be unprivileged');
  await docker('exec',name,'node','-e',"require('fs').writeFileSync('/dumps/retirement-check','ok');require('fs').unlinkSync('/dumps/retirement-check')");
  await assert.rejects(()=>docker('exec',worker,'node','-e',"require('fs').writeFileSync('/dumps/forbidden','no')"));
  await assert.rejects(()=>docker('exec',worker,'node','-e',"require('fs').writeFileSync('/data/forbidden','no')"));
  const game=randomUUID();await db.query(`INSERT INTO ${schema}.games(id,user_id,title_id,title,metadata) VALUES($1,$2,'BREW09991','Container media check','{}')`,[game,account.user.id]);
  await docker('run','--rm','--network','none','-v',root+':/data','ps5library-worker:local','ffmpeg','-v','error','-f','lavfi','-i','testsrc2=s=320x180:r=15','-f','lavfi','-i','sine=frequency=440:sample_rate=48000','-t','1','-threads','2','-c:v','libx264','-c:a','aac','-y','/data/input.mp4');
  const upload=await fetch(base+'/api/v1/games/'+game+'/trailer',{method:'PUT',headers:{authorization:'Bearer '+token,'content-type':'video/mp4'},body:await readFile(path.join(root,'input.mp4'))});assert.equal(upload.status,202);
  let catalog;for(let i=0;i<300;i++){catalog=await fetch(base+'/api/v1/catalog',{headers:{authorization:'Bearer '+token}}).then(r=>r.json());if(catalog[0]?.trailer)break;await new Promise(r=>setTimeout(r,100));}
  assert.ok(catalog[0]?.trailer,'Local FFmpeg must produce a verified trailer inside the container');
  const media=await fetch(base+catalog[0].trailer.url,{headers:{authorization:'Bearer '+token,range:'bytes=0-15'}});assert.equal(media.status,206);assert.equal((await media.arrayBuffer()).byteLength,16);
  await docker('restart',name);base='http://'+(await docker('port',name,'3150/tcp')).stdout.trim();await waitReady();
  const resumed=await fetch(base+'/api/v1/catalog',{headers:{authorization:'Bearer '+token}}).then(r=>r.json());assert.equal(resumed[0].trailer.sha256,catalog[0].trailer.sha256);
  console.log('Container passed: non-root API, networkless worker, API-only dump retirement, read-only worker inputs, persistence, isolated artwork/trailer preparation and authenticated Range streaming.');
}finally{
  await docker('rm','-f',name,worker).catch(()=>{});await docker('volume','rm',ipc).catch(()=>{});await db.query(`DROP SCHEMA ${schema} CASCADE`);await db.end();
  assert.ok(root.startsWith(path.resolve('data')+path.sep));await rm(root,{recursive:true,force:true});
}
