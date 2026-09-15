import { configuration } from './config.js';
import { database, migrate } from './db.js';
const db = database(configuration().DATABASE_URL);
try { await migrate(db); console.log('Migrations applied.'); } finally { await db.end(); }
