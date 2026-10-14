import type { FastifyInstance } from 'fastify';
import type { DB } from '../db.js';
import type { Config } from '../config.js';
import type { Auth } from '../auth/routes.js';
import { registerCatalogRoutes } from './catalog.js';
import { createProfileService, registerProfileRoutes } from './profiles.js';
import { registerSourceRoutes, type DownloadRelease, type PrepareRelease } from './sources.js';

export { catalogFor } from './catalog.js';
export { resolveSuccessfulProfileNotices, retryProfileAfterArtifact } from './profiles.js';

export async function catalogRoutes(
  app: FastifyInstance,
  db: DB,
  config: Config,
  auth: Auth,
  prepare: PrepareRelease,
  download: DownloadRelease,
) {
  const createProfile = createProfileService(db, config);
  registerCatalogRoutes(app, db, config, auth);
  registerSourceRoutes(app, db, config, auth, createProfile, prepare, download);
  registerProfileRoutes(app, db, auth, createProfile);
}
