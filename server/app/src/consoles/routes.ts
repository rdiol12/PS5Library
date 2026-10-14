import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import type { Auth } from '../auth/routes.js';
import { registerPairingRoutes } from './pairing-routes.js';
import { registerConsoleRoutes } from './console-routes.js';
import { registerConsoleHeartbeatRoutes } from './heartbeat-routes.js';

export { deviceLiveMessageAllowed } from './heartbeat-routes.js';

export async function consoleRoutes(app: FastifyInstance, db: DB, config: Config, auth: Auth) {
  const context = { app, db, config, auth };
  registerPairingRoutes(context);
  registerConsoleRoutes(context);
  registerConsoleHeartbeatRoutes(context);
}
