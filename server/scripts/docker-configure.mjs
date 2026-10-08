import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {randomBytes} from 'node:crypto';
import path from 'node:path';
// Keep credentials in the existing ignored environment file, never in Compose or image layers.
let env=await readFile('.env','utf8');
const options={};
for(let index=2;index<process.argv.length;index+=2){const name=process.argv[index],value=process.argv[index+1];if(!['--data-dir','--source-root','--dump-root'].includes(name)||!value||value.startsWith('--'))throw Error('Usage: docker:configure [--data-dir <persistent-storage>] [--dump-root <watched-dumps>] [--source-root <local-sources>]');if(Object.hasOwn(options,name))throw Error(`Duplicate option: ${name}`);options[name]=value;}
const database=new URL(process.env.DATABASE_URL);database.hostname='postgres';database.port='5432';
const data=path.resolve(options['--data-dir']||process.env.DATA_DIR||'data'),sources=path.resolve(options['--source-root']||process.env.SOURCE_ROOT||'data/sources');
const dumps=path.resolve(options['--dump-root']||process.env.DUMP_ROOT||path.join(data,'dumps'));
for(const directory of [data,sources,dumps,...['artifacts','backports','jobs','trailers','logs','portable-saves','save-backups','native-updates'].map(name=>path.join(data,name)),path.join(data,'artwork','.staging')])await mkdir(directory,{recursive:true});
for(const [key,value] of Object.entries({DATA_DIR:data,SOURCE_ROOT:sources,DUMP_ROOT:dumps,DOCKER_DATABASE_URL:database.href,DOCKER_DATA_DIR:data,DOCKER_SOURCE_ROOT:sources,DOCKER_DUMP_ROOT:dumps})){
  const line=`${key}=${value.replaceAll('\\','/')}`;
  env=new RegExp(`^${key}=.*$`,'m').test(env)?env.replace(new RegExp(`^${key}=.*$`,'m'),()=>line):env.trimEnd()+'\n'+line+'\n';
}
if(!/^OPERATOR_TOKEN=.{32,}$/m.test(env))env=env.trimEnd()+`\nOPERATOR_TOKEN=${randomBytes(32).toString('hex')}\n`;
if(/^PACKAGE_WORKER_URL=.+$/m.test(env)){
  const workerToken=[...env.matchAll(/^PACKAGE_WORKER_TOKEN=(.*)$/gm)].map(match=>match[1].trim()).find(value=>value.length>=32)??randomBytes(32).toString('hex');
  env=env.replace(/^PACKAGE_WORKER_TOKEN=.*(?:\r?\n|$)/gm,'').trimEnd()+`\nPACKAGE_WORKER_TOKEN=${workerToken}\n`;
}
await writeFile('.env',env,{mode:0o600});console.log(JSON.stringify({configured:true,persistentStorage:data,watchedDumps:dumps,localSources:sources}));
