import {z} from 'zod';
import type {Config} from './config.js';

export const managedServiceIds=['server','worker','postgres','redis','proxy'] as const;
export const managedService=z.enum(managedServiceIds);
const bytes=z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const statusSchema=z.object({
  host:z.object({uptimeSeconds:z.number().nonnegative(),loadAverage:z.tuple([z.number(),z.number(),z.number()]),cpuCount:z.number().int().positive(),memory:z.object({used:bytes,total:bytes}),disk:z.object({used:bytes,free:bytes,total:bytes})}),
  services:z.array(z.object({id:managedService,status:z.enum(['RUNNING','STOPPED','MISSING']),cpuPercent:z.number().nonnegative().optional(),memoryBytes:bytes.optional(),memoryLimit:bytes.optional()})),
});

async function request(config:Config,route:string,init:RequestInit,fetcher:typeof fetch){
  if(!config.OPERATOR_URL)throw new Error('OPERATOR_UNAVAILABLE');
  const response=await fetcher(new URL(route,config.OPERATOR_URL),{...init,redirect:'error',signal:AbortSignal.timeout(3000),headers:{authorization:`Bearer ${config.OPERATOR_TOKEN}`,'content-type':'application/json',...init.headers}});
  if(!response.ok)throw new Error(response.status===404?'SERVICE_NOT_FOUND':'OPERATOR_UNAVAILABLE');
  return response;
}
export async function operatorStatus(config:Config,fetcher:typeof fetch=fetch){return statusSchema.parse(await (await request(config,'/v1/status',{},fetcher)).json());}
export async function restartManagedService(config:Config,service:z.infer<typeof managedService>,fetcher:typeof fetch=fetch){await request(config,`/v1/services/${service}/restart`,{method:'POST',body:JSON.stringify({confirm:service})},fetcher);}
