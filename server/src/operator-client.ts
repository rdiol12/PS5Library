import { z } from 'zod';
import type { Config } from './config.js';

export const managedServiceIds = ['server', 'worker', 'postgres', 'redis', 'proxy'] as const;
export const managedService = z.enum(managedServiceIds);
export type ManagedService = z.infer<typeof managedService>;

export function dockerBrokerAction(
  method: string,
  route: string,
): { kind: 'status' } | { kind: 'restart'; service: ManagedService } | null {
  if (method === 'GET' && route === '/v1/status') {
    return { kind: 'status' };
  }
  const match = method === 'POST' && /^\/v1\/services\/([^/]+)\/restart$/.exec(route);
  if (!match) {
    return null;
  }
  const service = managedService.safeParse(match[1]);
  return service.success ? { kind: 'restart', service: service.data } : null;
}

const bytes = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
export const managedServices = z
  .array(
    z.object({
      id: managedService,
      status: z.enum(['RUNNING', 'STOPPED', 'MISSING']),
      cpuPercent: z.number().nonnegative().optional(),
      memoryBytes: bytes.optional(),
      memoryLimit: bytes.optional(),
    }),
  )
  .length(managedServiceIds.length)
  .refine(
    (items) => managedServiceIds.every((id) => items.some((item) => item.id === id)),
    'Missing managed service',
  );
const statusSchema = z.object({
  host: z.object({
    uptimeSeconds: z.number().nonnegative(),
    loadAverage: z.tuple([z.number(), z.number(), z.number()]),
    cpuCount: z.number().int().positive(),
    memory: z.object({ used: bytes, total: bytes }),
    disk: z.object({ used: bytes, free: bytes, total: bytes }),
  }),
  services: managedServices,
});

async function operatorRequest(
  config: Config,
  route: string,
  init: RequestInit,
  fetcher: typeof fetch,
) {
  if (!config.OPERATOR_URL) {
    throw new Error('OPERATOR_UNAVAILABLE');
  }
  const response = await fetcher(new URL(route, config.OPERATOR_URL), {
    ...init,
    redirect: 'error',
    signal: AbortSignal.timeout(3000),
    headers: {
      authorization: `Bearer ${config.OPERATOR_TOKEN}`,
      'content-type': 'application/json',
      ...init.headers,
    },
  });
  if (!response.ok) {
    const error = response.status === 404 ? 'SERVICE_NOT_FOUND' : 'OPERATOR_UNAVAILABLE';
    throw new Error(error);
  }
  return response;
}

export async function operatorStatus(config: Config, fetcher: typeof fetch = fetch) {
  const response = await operatorRequest(config, '/v1/status', {}, fetcher);
  return statusSchema.parse(await response.json());
}

export async function restartManagedService(
  config: Config,
  service: ManagedService,
  fetcher: typeof fetch = fetch,
) {
  await operatorRequest(
    config,
    `/v1/services/${service}/restart`,
    { method: 'POST', body: JSON.stringify({ confirm: service }) },
    fetcher,
  );
}
