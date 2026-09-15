import { readFile,mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
const entries=JSON.parse((await readFile('docs/upstream-lock.json','utf8')).replace(/^\uFEFF/,''));
await mkdir('upstream',{recursive:true});
for(const entry of entries){
  if(!/^[a-zA-Z0-9_-]+$/.test(entry.name)||!/^[a-f0-9]{40}$/.test(entry.commit))throw Error('Invalid upstream lock entry');
  const target=path.resolve('upstream',entry.name);
  try{execFileSync('git',['-C',target,'rev-parse','--git-dir'],{stdio:'ignore',windowsHide:true});}
  catch{execFileSync('git',['clone',entry.url,target],{stdio:'inherit',windowsHide:true});}
  const origin=execFileSync('git',['-C',target,'remote','get-url','origin'],{encoding:'utf8',windowsHide:true}).trim();
  if(origin.replace(/\.git$/,'')!==entry.url.replace(/\.git$/,''))throw Error(`Unexpected origin for ${entry.name}`);
  if(execFileSync('git',['-C',target,'status','--porcelain'],{encoding:'utf8',windowsHide:true}).trim())throw Error(`Preserve local changes in upstream/${entry.name} before updating`);
  execFileSync('git',['-C',target,'fetch','origin',entry.commit],{stdio:'inherit',windowsHide:true});
  execFileSync('git',['-C',target,'checkout','--detach',entry.commit],{stdio:'inherit',windowsHide:true});
}
