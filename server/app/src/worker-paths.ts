import path from 'node:path';
import {AppError} from './security/errors.js';

export type WorkerRoot=readonly [virtual:string,host:string];
type WorkerRequest={kind:'dotnet';args:string[]};

const inside=(root:string,value:string)=>{const relative=path.relative(root,value);return !relative.startsWith('..')&&!path.isAbsolute(relative);};

export function mapWorkerRequest(task:WorkerRequest,roots:readonly WorkerRoot[]):WorkerRequest {
  return {...task,args:task.args.map((value,index)=>{
    if(index===0||!value.startsWith('/'))return value;
    for(const [virtual,host] of roots)if(value===virtual||value.startsWith(virtual+'/')){
      const mapped=path.resolve(host,...value.slice(virtual.length).split('/').filter(Boolean));
      if(inside(path.resolve(host),mapped))return mapped;
    }
    throw new AppError('INVALID_WORKER_REQUEST',400);
  })};
}

export function mapWorkerResult<T>(value:T,roots:readonly WorkerRoot[]):T {
  const map=(item:unknown):unknown=>{
    if(typeof item==='string'&&path.isAbsolute(item)){
      for(const [virtual,host] of roots){const resolved=path.resolve(item),base=path.resolve(host);if(inside(base,resolved)){const relative=path.relative(base,resolved).split(path.sep).join('/');return relative?`${virtual}/${relative}`:virtual;}}
      throw new AppError('INVALID_WORKER_RESULT',502);
    }
    if(Array.isArray(item))return item.map(map);
    if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).map(([key,entry])=>[key,map(entry)]));
    return item;
  };
  return map(value) as T;
}
