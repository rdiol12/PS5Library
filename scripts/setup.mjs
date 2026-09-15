import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const password = randomBytes(24).toString('hex');
const template = await readFile('.env.example', 'utf8');
try {
  await writeFile('.env', template.replaceAll('GENERATE_WITH_NPM_RUN_SETUP', password)
    .replace(`BOOTSTRAP_TOKEN=${password}`, `BOOTSTRAP_TOKEN=${randomBytes(32).toString('hex')}`), { flag: 'wx', mode: 0o600 });
  console.log('Created .env with random local credentials. Use BOOTSTRAP_TOKEN for first-user setup.');
} catch (error) { if (error.code !== 'EEXIST') throw error; console.log('Preserved existing .env.'); }
await mkdir('data/sources', { recursive: true });
