import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, statfs } from 'node:fs/promises';
import { cpus, loadavg, uptime } from 'node:os';
import { sameSecret } from './auth/credentials.js';
import { managedServices, managedService } from './operator-client.js';
import { localTimestamp } from './logging.js';

const token = process.env.OPERATOR_TOKEN ?? '';
const port = Number(process.env.OPERATOR_PORT ?? 3160);
const brokerUrl = process.env.DOCKER_BROKER_URL ?? '';

const validConfiguration =
  token.length >= 32 &&
  Number.isInteger(port) &&
  port >= 1 &&
  port <= 65535 &&
  /^http:\/\/docker-broker:3161$/.test(brokerUrl);
if (!validConfiguration) {
  throw new Error('Invalid operator configuration');
}

async function brokerRequest(method: 'GET' | 'POST', route: string) {
  const response = await fetch(new URL(route, brokerUrl), {
    method,
    redirect: 'error',
    signal: AbortSignal.timeout(method === 'POST' ? 20_000 : 8_000),
    headers: { authorization: `Bearer ${token}` },
  });
  if (!response.ok) {
    const error = response.status === 404 ? 'SERVICE_NOT_FOUND' : 'DOCKER_BROKER_UNAVAILABLE';
    throw new Error(error);
  }
  return response;
}

async function memoryUsage() {
  const body = await readFile('/proc/meminfo', 'utf8');
  const values = Object.fromEntries(
    [...body.matchAll(/^(MemTotal|MemAvailable):\s+(\d+) kB$/gm)].map((match) => [
      match[1],
      Number(match[2]) * 1024,
    ]),
  );
  return {
    used: Math.max(0, values.MemTotal - values.MemAvailable),
    total: values.MemTotal,
  };
}

async function diskUsage() {
  const filesystem = await statfs('/data', { bigint: true });
  const total = Number(filesystem.blocks * filesystem.bsize);
  const free = Number(filesystem.bavail * filesystem.bsize);
  return { used: total - free, free, total };
}

async function operatorStatus() {
  const response = await brokerRequest('GET', '/v1/status');
  const body = (await response.json()) as { services?: unknown };
  const services = managedServices.parse(body.services);
  return {
    host: {
      uptimeSeconds: Math.floor(uptime()),
      loadAverage: loadavg() as [number, number, number],
      cpuCount: cpus().length,
      memory: await memoryUsage(),
      disk: await diskUsage(),
    },
    services,
  };
}

function isAuthorized(value: string | undefined) {
  return value?.startsWith('Bearer ') ? sameSecret(value.slice(7), token) : false;
}

function sendJson(response: ServerResponse, code: number, body: unknown) {
  response.writeHead(code, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(JSON.stringify(body));
}

async function readRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1024) {
      throw new Error('REQUEST_TOO_LARGE');
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString()) as { confirm?: unknown };
}

function logRestart(service: string, error?: unknown) {
  const entry = {
    timestamp: localTimestamp(),
    service: 'operator',
    event: error ? 'service.restart_failed' : 'service.restarted',
    target: service,
    ...(error ? { message: error instanceof Error ? error.message : String(error) } : {}),
  };
  (error ? console.error : console.log)(JSON.stringify(entry));
}

function queueRestart(service: string) {
  setTimeout(() => {
    void brokerRequest('POST', `/v1/services/${service}/restart`)
      .then((response) => response.arrayBuffer())
      .then(() => logRestart(service))
      .catch((error) => logRestart(service, error));
  }, 300);
}

createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      return sendJson(response, 200, { status: 'ok' });
    }
    if (!isAuthorized(request.headers.authorization)) {
      return sendJson(response, 401, { error: 'UNAUTHORIZED' });
    }
    if (request.method === 'GET' && request.url === '/v1/status') {
      return sendJson(response, 200, await operatorStatus());
    }

    const restartRoute =
      request.method === 'POST' && request.url?.match(/^\/v1\/services\/([^/]+)\/restart$/);
    if (!restartRoute) {
      return sendJson(response, 404, { error: 'NOT_FOUND' });
    }

    const service = managedService.parse(restartRoute[1]);
    const body = await readRequestBody(request);
    if (body.confirm !== service) {
      return sendJson(response, 400, { error: 'CONFIRMATION_REQUIRED' });
    }

    sendJson(response, 202, { accepted: true });
    queueRestart(service);
  } catch (error) {
    sendJson(response, 400, {
      error: error instanceof Error ? error.message : 'REQUEST_FAILED',
    });
  }
}).listen(port, '0.0.0.0', () => {
  console.log(
    JSON.stringify({
      timestamp: localTimestamp(),
      service: 'operator',
      event: 'operator.ready',
      port,
    }),
  );
});
