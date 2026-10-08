import path from 'node:path';
import { z } from 'zod';
import ipaddr from 'ipaddr.js';
const featureFlag=z.enum(['true','false']).default('true').transform(value=>value==='true');
const experimentalFlag=z.enum(['true','false']).default('false').transform(value=>value==='true');
export function configuration(env = process.env) {
  const values = z.object({
    DATABASE_URL: z.string().url(), REDIS_URL: z.string().url(), BOOTSTRAP_TOKEN: z.string().min(32),
    HOST: z.string().default('127.0.0.1'), PORT: z.coerce.number().int().min(1).max(65535).default(3150),
    PUBLIC_URL: z.string().url().default('http://127.0.0.1:3150'), DATA_DIR: z.string().default('./data'),
    BROWSER_ORIGINS: z.string().default(''),
    SOURCE_ROOT: z.string().default('./data/sources'), PRIVATE_HTTP_ORIGINS: z.string().default(''),
    QUOTA_BYTES: z.coerce.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).default(100 * 1024 ** 3),
    DISK_MARGIN_BYTES: z.coerce.number().int().nonnegative().default(1024 ** 3),
    TRAILER_WORKER_IMAGE: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]*$/).default('ps5library-build:0.43'),
    TRAILER_WORKER_MODE: z.enum(['DOCKER','LOCAL','SANDBOX']).default('DOCKER'),
    PACKAGE_WORKER_SOCKET: z.string().min(1).default('/worker-ipc/worker.sock'),
    PACKAGE_WORKER_URL:z.string().default(''),PACKAGE_WORKER_TOKEN:z.string().default(''),
    DUMP_ROOT: z.string().default(''),
    DUMP_AUTO_PREPARE: z.enum(['FPKG','SHADOWMOUNT','BOTH']).default('FPKG'),
    COMMUNITY_MASTER_URL:z.string().default(''),
    HOME_UPDATE_AGENT_URL:z.string().default(''),
    TRUST_PROXY_HOPS:z.coerce.number().int().min(0).max(2).default(0),
    OPERATOR_URL:z.string().default(''), OPERATOR_TOKEN:z.string().default(''),
    ENABLE_COMPANION_APP:featureFlag,ENABLE_PS5_CONNECTIONS:featureFlag,ALLOW_ACCOUNT_REGISTRATION:featureFlag,
    ENABLE_COMMUNITY_FEATURES:featureFlag,ENABLE_NEW_DOWNLOADS:featureFlag,ENABLE_HOME_UPDATE_BRIDGE:experimentalFlag,
  }).parse(env);
  const browserOrigins = z.array(z.url({ protocol: /^https?$/ }).refine(value => new URL(value).origin === value && !value.includes('*'), 'Use an exact HTTP(S) origin without a path, credentials or wildcard'))
    .parse([new URL(values.PUBLIC_URL).origin, ...values.BROWSER_ORIGINS.split(',').map(s => s.trim()).filter(Boolean)]);
  const communityMasterUrl=values.COMMUNITY_MASTER_URL.trim();
  if(communityMasterUrl){const url=new URL(communityMasterUrl);if(url.protocol!=='https:'||url.origin!==communityMasterUrl)throw new Error('COMMUNITY_MASTER_URL must be an exact HTTPS origin');if(url.origin===new URL(values.PUBLIC_URL).origin)throw new Error('COMMUNITY_MASTER_URL must use a different origin from PUBLIC_URL');}
  const homeUpdateAgentUrl=values.HOME_UPDATE_AGENT_URL.trim();
  if(homeUpdateAgentUrl){const url=new URL(homeUpdateAgentUrl);let range='';try{range=ipaddr.process(url.hostname).range();}catch{}if(url.protocol!=='http:'||url.origin!==homeUpdateAgentUrl||url.port!=='37952'||range!=='private')throw new Error('HOME_UPDATE_AGENT_URL must be an exact private IPv4 HTTP origin on port 37952');}
  const operatorUrl=values.OPERATOR_URL.trim();
  if(operatorUrl&&!values.OPERATOR_TOKEN)throw new Error('OPERATOR_TOKEN is required when OPERATOR_URL is configured');
  if(operatorUrl){const url=new URL(operatorUrl);if(!['http:','https:'].includes(url.protocol)||url.origin!==operatorUrl||values.OPERATOR_TOKEN.length<32)throw new Error('OPERATOR_URL must be an exact HTTP(S) origin and OPERATOR_TOKEN must contain at least 32 characters');}
  const packageWorkerUrl=values.PACKAGE_WORKER_URL.trim();
  if(packageWorkerUrl){const url=new URL(packageWorkerUrl);if(url.protocol!=='http:'||url.hostname!=='host.docker.internal'||url.origin!==packageWorkerUrl||!url.port)throw new Error('PACKAGE_WORKER_URL must be an exact host.docker.internal HTTP origin with an explicit port');if(values.PACKAGE_WORKER_TOKEN.length<32)throw new Error('PACKAGE_WORKER_TOKEN must contain at least 32 characters');}
  const features={companionApp:values.ENABLE_COMPANION_APP,ps5Connections:values.ENABLE_PS5_CONNECTIONS,accountRegistration:values.ALLOW_ACCOUNT_REGISTRATION,community:values.ENABLE_COMMUNITY_FEATURES,newDownloads:values.ENABLE_NEW_DOWNLOADS,homeUpdateBridge:values.ENABLE_HOME_UPDATE_BRIDGE};
  return { ...values, COMMUNITY_MASTER_URL:communityMasterUrl,HOME_UPDATE_AGENT_URL:homeUpdateAgentUrl,OPERATOR_URL:operatorUrl,PACKAGE_WORKER_URL:packageWorkerUrl,features,browserOrigins, DATA_DIR: path.resolve(values.DATA_DIR), SOURCE_ROOT: path.resolve(values.SOURCE_ROOT), privateOrigins: values.PRIVATE_HTTP_ORIGINS.split(',').map(s => s.trim()).filter(Boolean) };
}
export type Config = ReturnType<typeof configuration>;
