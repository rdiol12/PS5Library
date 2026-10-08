import {appendFile,mkdir,readFile,readdir,rename,rm,stat,writeFile} from 'node:fs/promises';
import path from 'node:path';

export type LogLevel='INFO'|'WARN'|'ERROR';
export type LogValue=string|number|boolean|null;
export type LogEntry={timestamp:string;service:string;level:LogLevel;event:string;message?:string}&Record<string,LogValue|undefined>;
export type Logger=Awaited<ReturnType<typeof structuredLogger>>;

const reserved=new Set(['timestamp','service','level','event','message']);
const services=['server','worker'] as const;
export const localTimestamp=()=>{
  const now=new Date(),offset=-now.getTimezoneOffset(),sign=offset<0?'-':'+';
  return new Date(now.getTime()+offset*60000).toISOString().slice(0,-1)+sign+String(Math.floor(Math.abs(offset)/60)).padStart(2,'0')+':'+String(Math.abs(offset)%60).padStart(2,'0');
};
const redact=(value:string)=>value
  .replace(/Bearer\s+[a-f0-9]{64}/gi,'Bearer [redacted]')
  .replace(/\b[a-f0-9]{64}\b/gi,'[redacted]')
  .replace(/((?:[?&]|\b)(?:token|code|secret|key)=)[^&\s]+/gi,'$1[redacted]')
  .slice(0,2000);
const serviceName=(value:string)=>{
  if(!/^[a-z][a-z0-9-]{0,31}$/.test(value))throw new Error('Invalid log service name');
  return value;
};
const cleanFields=(fields:Record<string,LogValue|undefined>)=>Object.fromEntries(Object.entries(fields)
  .filter(([key,value])=>!reserved.has(key)&&value!==undefined)
  .map(([key,value])=>[key,typeof value==='string'?redact(value):value]));

async function entries(file:string,service:string,limit:number,level?:LogLevel){
  const text=await readFile(file,'utf8').catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return '';throw error;});
  const result:LogEntry[]=[];
  for(const line of text.trim().split('\n').filter(Boolean).reverse()){
    try{
      const parsed=JSON.parse(line) as LogEntry,entry={...parsed,service:parsed.service||service};
      if(!level||entry.level===level)result.push(entry);
    }catch{/* Ignore a partial final line after an unclean shutdown. */}
    if(result.length>=limit)break;
  }
  return result;
}

export async function readLogs(dataDir:string,{limit=200,level,service}:{limit?:number;level?:LogLevel;service?:string}={}){
  const selected=service?[serviceName(service)]:services;
  const found=(await Promise.all(selected.map(name=>entries(path.join(dataDir,'logs',`${name}.ndjson`),name,limit,level)))).flat();
  return found.sort((a,b)=>Date.parse(b.timestamp)-Date.parse(a.timestamp)).slice(0,limit);
}

export async function structuredLogger(dataDir:string,service:string,maxBytes=5*1024*1024){
  service=serviceName(service);
  const directory=path.join(dataDir,'logs'),file=path.join(directory,`${service}.ndjson`),previous=path.join(directory,`${service}.1.ndjson`);
  await mkdir(directory,{recursive:true});
  const rotated=new RegExp(`^(?:${services.join('|')})\\.([1-9]\\d*)\\.ndjson$`);
  await Promise.all((await readdir(directory,{withFileTypes:true})).flatMap(entry=>entry.isFile()&&rotated.test(entry.name)?[rm(path.join(directory,entry.name),{force:true})]:[]));
  let pending=Promise.resolve();
  const enqueue=(action:()=>Promise<void>)=>{
    const result=pending.then(action);pending=result.catch(error=>{process.stderr.write(JSON.stringify({timestamp:localTimestamp(),service,level:'ERROR',event:'logging.write_failed',message:error instanceof Error?redact(error.message):'unknown error'})+'\n');});return pending;
  };
  const write=(level:LogLevel,event:string,message?:string,fields:Record<string,LogValue|undefined>={})=>{
    const entry:LogEntry={timestamp:localTimestamp(),service,level,event:redact(event),...cleanFields(fields)};
    if(message)entry.message=redact(message);
    const line=JSON.stringify(entry)+'\n';
    (level==='INFO'?process.stdout:process.stderr).write(line);
    return enqueue(async()=>{
      const size=(await stat(file).catch(error=>{if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}))?.size??0;
      if(size+Buffer.byteLength(line)>maxBytes){await rm(previous,{force:true});await rename(file,previous).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});}
      await appendFile(file,line,{encoding:'utf8',mode:0o600});
    });
  };
  const list=async(limit=200,level?:LogLevel)=>{await pending;return entries(file,service,limit,level);};
  const clear=()=>enqueue(()=>writeFile(file,'',{encoding:'utf8',mode:0o600}));
  return {service,write,list,clear,flush:async()=>{await pending;},file};
}

export const serverLogger=(dataDir:string,maxBytes=5*1024*1024)=>structuredLogger(dataDir,'server',maxBytes);
