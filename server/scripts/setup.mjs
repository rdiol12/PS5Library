import { randomBytes } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
const password = randomBytes(24).toString('hex');
const template = await readFile('.env.example', 'utf8');
const uid = process.platform === 'win32' ? 1654 : process.getuid?.() ?? 1000;
const gid = process.platform === 'win32' ? 1654 : process.getgid?.() ?? 1000;
try {
  await writeFile('.env', template.replaceAll('GENERATE_WITH_NPM_RUN_SETUP', password)
    .replace(`BOOTSTRAP_TOKEN=${password}`, `BOOTSTRAP_TOKEN=${randomBytes(32).toString('hex')}`)
    .replace(`OPERATOR_TOKEN=${password}`, `OPERATOR_TOKEN=${randomBytes(32).toString('hex')}`)
    .replace(/^PUID=.*$/m,`PUID=${uid}`)
    .replace(/^PGID=.*$/m,`PGID=${gid}`), { flag: 'wx', mode: 0o600 });
  console.log('Created .env with random local credentials. Use BOOTSTRAP_TOKEN for first-user setup.');
} catch (error) { if (error.code !== 'EEXIST') throw error; console.log('Preserved existing .env.'); }
await mkdir('data/sources', { recursive: true });
