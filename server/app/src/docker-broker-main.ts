import { createServer, request as httpRequest, type ServerResponse } from 'node:http';
import { sameSecret } from './auth/credentials.js';
import { dockerBrokerAction, managedServiceIds } from './operator-client.js';

const token = process.env.OPERATOR_TOKEN ?? '';
const port = Number(process.env.DOCKER_BROKER_PORT ?? 3161);
const project = process.env.COMPOSE_PROJECT_NAME ?? 'ps5library';
const socketPath = '/var/run/docker.sock';

const validConfiguration =
  token.length >= 32 && Number.isInteger(port) && port >= 1 && port <= 65535;
if (!validConfiguration) {
  throw new Error('Invalid Docker broker configuration');
}

type DockerContainer = {
  Id: string;
  State: string;
  Labels: Record<string, string>;
};

type DockerStats = {
  cpu_stats?: {
    online_cpus?: number;
    system_cpu_usage?: number;
    cpu_usage?: { total_usage?: number; percpu_usage?: unknown[] };
  };
  precpu_stats?: {
    system_cpu_usage?: number;
    cpu_usage?: { total_usage?: number };
  };
  memory_stats?: {
    usage?: number;
    limit?: number;
    stats?: { cache?: number };
  };
};

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

function dockerRequest<T>(method: 'GET' | 'POST', path: string) {
  return new Promise<T>((resolve, reject) => {
    const request = httpRequest(
      { socketPath, path, method, headers: { 'content-length': '0' } },
      (response) => {
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size > 4 * 1024 ** 2) {
            request.destroy(new Error('Docker response too large'));
          } else {
            chunks.push(chunk);
          }
        });
        response.on('end', () => {
          if ((response.statusCode ?? 500) >= 300) {
            reject(new Error(`Docker ${response.statusCode}`));
            return;
          }
          const body = Buffer.concat(chunks).toString();
          try {
            resolve((body ? JSON.parse(body) : null) as T);
          } catch {
            reject(new Error('Invalid Docker response'));
          }
        });
      },
    );
    request.setTimeout(method === 'POST' ? 15_000 : 3_000, () => {
      request.destroy(new Error('Docker timeout'));
    });
    request.on('error', reject);
    request.end();
  });
}

function listContainers() {
  const filters = encodeURIComponent(
    JSON.stringify({ label: [`com.docker.compose.project=${project}`] }),
  );
  return dockerRequest<DockerContainer[]>('GET', `/containers/json?all=1&filters=${filters}`);
}

function containerFor(containers: DockerContainer[], service: string) {
  const isPrimaryServiceContainer = (container: DockerContainer) =>
    container.Labels['com.docker.compose.service'] === service &&
    container.Labels['com.docker.compose.container-number'] === '1';

  return (
    containers.find(
      (container) => isPrimaryServiceContainer(container) && container.State === 'running',
    ) ?? containers.find(isPrimaryServiceContainer)
  );
}

function containerMetrics(stats: DockerStats) {
  const cpuDelta =
    (stats.cpu_stats?.cpu_usage?.total_usage ?? 0) -
    (stats.precpu_stats?.cpu_usage?.total_usage ?? 0);
  const systemDelta =
    (stats.cpu_stats?.system_cpu_usage ?? 0) - (stats.precpu_stats?.system_cpu_usage ?? 0);
  const cpuCount =
    stats.cpu_stats?.online_cpus ?? stats.cpu_stats?.cpu_usage?.percpu_usage?.length ?? 1;
  const memoryBytes = Math.max(
    0,
    (stats.memory_stats?.usage ?? 0) - (stats.memory_stats?.stats?.cache ?? 0),
  );
  return {
    cpuPercent: systemDelta > 0 ? Math.round((cpuDelta / systemDelta) * cpuCount * 1000) / 10 : 0,
    memoryBytes,
    memoryLimit: stats.memory_stats?.limit ?? 0,
  };
}

async function serviceStatus() {
  const containers = await listContainers();
  const services = await Promise.all(
    managedServiceIds.map(async (id) => {
      const container = containerFor(containers, id);
      if (!container) {
        return { id, status: 'MISSING' as const };
      }
      if (container.State !== 'running') {
        return { id, status: 'STOPPED' as const };
      }
      try {
        const stats = await dockerRequest<DockerStats>(
          'GET',
          `/containers/${container.Id}/stats?stream=false`,
        );
        return { id, status: 'RUNNING' as const, ...containerMetrics(stats) };
      } catch {
        return { id, status: 'RUNNING' as const };
      }
    }),
  );
  return { services };
}

createServer(async (request, response) => {
  try {
    if (request.method === 'GET' && request.url === '/health') {
      return sendJson(response, 200, { status: 'ok' });
    }
    if (!isAuthorized(request.headers.authorization)) {
      return sendJson(response, 401, { error: 'UNAUTHORIZED' });
    }
    if (
      Number(request.headers['content-length'] ?? 0) !== 0 ||
      request.headers['transfer-encoding']
    ) {
      return sendJson(response, 400, { error: 'BODY_NOT_ALLOWED' });
    }

    const action = dockerBrokerAction(request.method ?? '', request.url ?? '');
    if (!action) {
      return sendJson(response, 404, { error: 'NOT_FOUND' });
    }
    if (action.kind === 'status') {
      return sendJson(response, 200, await serviceStatus());
    }

    const container = containerFor(await listContainers(), action.service);
    if (!container) {
      return sendJson(response, 404, { error: 'SERVICE_NOT_FOUND' });
    }
    await dockerRequest<null>('POST', `/containers/${container.Id}/restart?t=10`);
    return sendJson(response, 202, { accepted: true });
  } catch (error) {
    return sendJson(response, 400, {
      error: error instanceof Error ? error.message : 'REQUEST_FAILED',
    });
  }
}).listen(port, '0.0.0.0');
