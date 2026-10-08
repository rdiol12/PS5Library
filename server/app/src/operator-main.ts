import {createServer,request as httpRequest} from 'node:http';
import {readFile,statfs} from 'node:fs/promises';
import {cpus,loadavg,uptime} from 'node:os';
import {timingSafeEqual} from 'node:crypto';
import {managedServiceIds,managedService} from './operator-client.js';
import {localTimestamp} from './logging.js';

const token=process.env.OPERATOR_TOKEN??'',port=Number(process.env.OPERATOR_PORT??3160),project=process.env.COMPOSE_PROJECT_NAME??'ps5library';
if(token.length<32||!Number.isInteger(port)||port<1||port>65535)throw new Error('Invalid operator configuration');
const socketPath='/var/run/docker.sock';
const docker=(method:string,path:string)=>new Promise<any>((resolve,reject)=>{
  const req=httpRequest({socketPath,path,method,headers:{'content-length':'0'}},response=>{const parts:Buffer[]=[];let size=0;response.on('data',chunk=>{size+=chunk.length;if(size>4*1024**2)req.destroy(Error('Docker response too large'));else parts.push(chunk);});response.on('end',()=>{if((response.statusCode??500)>=300)return reject(Error(`Docker ${response.statusCode}`));const body=Buffer.concat(parts).toString();try{resolve(body?JSON.parse(body):null);}catch{reject(Error('Invalid Docker response'));}});});
  req.setTimeout(3000,()=>req.destroy(Error('Docker timeout')));req.on('error',reject);req.end();
});
const containers=async()=>docker('GET',`/containers/json?all=1&filters=${encodeURIComponent(JSON.stringify({label:[`com.docker.compose.project=${project}`]}))}`) as Promise<Array<{Id:string;State:string;Labels:Record<string,string>}>>;
const memory=async()=>{const body=await readFile('/proc/meminfo','utf8'),values=Object.fromEntries([...body.matchAll(/^(MemTotal|MemAvailable):\s+(\d+) kB$/gm)].map(match=>[match[1],Number(match[2])*1024]));return {used:Math.max(0,values.MemTotal-values.MemAvailable),total:values.MemTotal};};
const disk=async()=>{const value=await statfs('/data',{bigint:true}),total=Number(value.blocks*value.bsize),free=Number(value.bavail*value.bsize);return {used:total-free,free,total};};
const metric=(stats:any)=>{const cpuDelta=(stats.cpu_stats?.cpu_usage?.total_usage??0)-(stats.precpu_stats?.cpu_usage?.total_usage??0),systemDelta=(stats.cpu_stats?.system_cpu_usage??0)-(stats.precpu_stats?.system_cpu_usage??0),count=stats.cpu_stats?.online_cpus??stats.cpu_stats?.cpu_usage?.percpu_usage?.length??1,usage=Math.max(0,(stats.memory_stats?.usage??0)-(stats.memory_stats?.stats?.cache??0));return {cpuPercent:systemDelta>0?Math.round(cpuDelta/systemDelta*count*1000)/10:0,memoryBytes:usage,memoryLimit:stats.memory_stats?.limit??0};};
async function status(){
  const list=await containers(),byService=new Map(list.map(item=>[item.Labels['com.docker.compose.service'],item]));
  const services=await Promise.all(managedServiceIds.map(async id=>{const container=byService.get(id);if(!container)return {id,status:'MISSING' as const};if(container.State!=='running')return {id,status:'STOPPED' as const};try{return {id,status:'RUNNING' as const,...metric(await docker('GET',`/containers/${container.Id}/stats?stream=false`))};}catch{return {id,status:'RUNNING' as const};}}));
  return {host:{uptimeSeconds:Math.floor(uptime()),loadAverage:loadavg() as [number,number,number],cpuCount:cpus().length,memory:await memory(),disk:await disk()},services};
}
const authorized=(value:string|undefined)=>{if(!value?.startsWith('Bearer '))return false;const supplied=Buffer.from(value.slice(7)),expected=Buffer.from(token);return supplied.length===expected.length&&timingSafeEqual(supplied,expected);};
const send=(response:any,code:number,body:unknown)=>{response.writeHead(code,{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'});response.end(JSON.stringify(body));};
createServer(async(req,response)=>{
  try{
    if(req.method==='GET'&&req.url==='/health')return send(response,200,{status:'ok'});
    if(!authorized(req.headers.authorization))return send(response,401,{error:'UNAUTHORIZED'});
    if(req.method==='GET'&&req.url==='/v1/status')return send(response,200,await status());
    const match=req.method==='POST'&&req.url?.match(/^\/v1\/services\/([^/]+)\/restart$/);if(!match)return send(response,404,{error:'NOT_FOUND'});
    const service=managedService.parse(match[1]),chunks:Buffer[]=[];let size=0;for await(const chunk of req){size+=chunk.length;if(size>1024)throw Error('REQUEST_TOO_LARGE');chunks.push(chunk);}const body=JSON.parse(Buffer.concat(chunks).toString());if(body?.confirm!==service)return send(response,400,{error:'CONFIRMATION_REQUIRED'});
    const container=(await containers()).find(item=>item.Labels['com.docker.compose.service']===service);if(!container)return send(response,404,{error:'SERVICE_NOT_FOUND'});
    send(response,202,{accepted:true});setTimeout(()=>docker('POST',`/containers/${container.Id}/restart?t=10`).then(()=>console.log(JSON.stringify({timestamp:localTimestamp(),service:'operator',event:'service.restarted',target:service}))).catch(error=>console.error(JSON.stringify({timestamp:localTimestamp(),service:'operator',event:'service.restart_failed',target:service,message:error.message}))),300);
  }catch(error){send(response,400,{error:error instanceof Error?error.message:'REQUEST_FAILED'});}
}).listen(port,'0.0.0.0',()=>console.log(JSON.stringify({timestamp:localTimestamp(),service:'operator',event:'operator.ready',port})));
