import type { FastifyInstance } from 'fastify';
import type { Auth } from '../auth/routes.js';
import type { Config } from '../config.js';
import type { DB } from '../db.js';
import type { Logger } from '../logging.js';
import { registerNodeConnectionRoutes } from './node-connection-routes.js';
import { registerCommunityUserRoutes } from './user-routes.js';

export {
  MasterError,
  approvedMasterCredential,
  approvedMasterUserCredential,
  masterRequest,
} from './master-client.js';

export async function communityRoutes(
  app: FastifyInstance,
  db: DB,
  config: Config,
  auth: Auth,
  logs: Logger,
  fetcher: typeof fetch = fetch,
) {
  const context = { app, db, config, auth, logs, fetcher };
  registerNodeConnectionRoutes(context);
  registerCommunityUserRoutes(context);
}
