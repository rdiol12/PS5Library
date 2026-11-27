import {
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign,
  createHash,
} from 'node:crypto';
import { readFile, writeFile, mkdir, rename, stat } from 'node:fs/promises';
import path from 'node:path';

// Signing is a local operator command. The HTTP server never needs the private key.
const root = path.resolve(process.env.DATA_DIR ?? 'data'),
  signing = path.resolve(process.env.UPDATE_SIGNING_DIR ?? '.secrets/update-signing');
const publicFile = path.resolve('ps5/assets/update-public-key.pem'),
  privateFile = path.join(signing, 'private.pem');
if (process.argv.includes('--init')) {
  await mkdir(signing, { recursive: true });
  try {
    await stat(privateFile);
    throw Error('Signing key already exists; keep it for future updates.');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const key = generateKeyPairSync('ed25519');
  await writeFile(privateFile, key.privateKey.export({ type: 'pkcs8', format: 'pem' }), {
    flag: 'wx',
    mode: 0o600,
  });
  await writeFile(publicFile, key.publicKey.export({ type: 'spki', format: 'pem' }));
  console.log('Signing key created outside runtime data. Public key is ready for the PS5 build.');
} else {
  const input = path.resolve(process.argv[2] ?? 'ps5/build/ps5/ps5library-install.elf');
  const metadata = JSON.parse(await readFile(input + '.json', 'utf8'));
  if (!Number.isSafeInteger(metadata.build) || !/^\d+\.\d+\.\d+$/.test(metadata.version))
    throw Error('Invalid build metadata');
  const bytes = await readFile(input),
    sha256 = createHash('sha256').update(bytes).digest('hex');
  if (
    bytes.length > 96 * 1024 ** 2 ||
    bytes.subarray(0, 4).toString('hex') !== '7f454c46' ||
    metadata.sha256 !== sha256
  )
    throw Error('Installer does not match its build metadata');
  const privateKey = createPrivateKey(await readFile(privateFile));
  const publicKey = createPublicKey(await readFile(publicFile));
  const exported = createPublicKey(privateKey).export({ type: 'spki', format: 'der' });
  if (
    !exported.equals(publicKey.export({ type: 'spki', format: 'der' })) ||
    createHash('sha256').update(exported).digest('hex') !== metadata.keySha256
  )
    throw Error('Build/signing keys do not match');
  const updates = path.join(root, 'updates');
  await mkdir(updates, { recursive: true });
  const latest = path.join(updates, 'latest.json');
  const old = await readFile(latest, 'utf8').catch((e) => {
    if (e.code === 'ENOENT') return null;
    throw e;
  });
  if (old) {
    const previous = JSON.parse(JSON.parse(old).payload);
    if (metadata.build <= previous.build)
      throw Error('Increment appBuild before publishing a new release');
  }
  const payload = JSON.stringify({
    schemaVersion: 1,
    product: 'PS5Library',
    version: metadata.version,
    build: metadata.build,
    size: bytes.length,
    sha256,
  });
  const envelope = {
    payload,
    signature: sign(null, Buffer.from(payload), privateKey).toString('hex'),
  };
  const file = path.join(updates, sha256 + '.elf');
  await writeFile(file + '.part', bytes);
  await rename(file + '.part', file);
  await writeFile(latest + '.part', JSON.stringify(envelope));
  await rename(latest + '.part', latest);
  console.log(
    `Published PS5Library ${metadata.version} (${metadata.build}), ${bytes.length} bytes, SHA-256 ${sha256}`,
  );
}
