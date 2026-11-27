import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const filename = 'PS5Library Native Package Worker.vbs';

const commandPath = (value) => {
  if (!value || /["\r\n]/.test(value)) throw Error('Invalid native-worker startup path.');
  return `"${value}"`;
};

export const nativeWorkerAutostartFile = (appData) => {
  if (!appData || /["\r\n]/.test(appData)) throw Error('APPDATA is unavailable or invalid.');
  return path.win32.join(
    appData,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    filename,
  );
};

export function nativeWorkerAutostartScript({ root, node, npmCli }) {
  const command = `${commandPath(node)} ${commandPath(npmCli)} --prefix ${commandPath(root)} run worker:native:start`;
  if (command.length > 8192) throw Error('The native-worker startup command is too long.');
  return `CreateObject("WScript.Shell").Run "${command.replaceAll('"', '""')}", 0, False\n`;
}

const invoked =
  process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url;
if (invoked) {
  if (process.platform !== 'win32')
    throw Error('Native-worker autostart is only needed on Windows; Linux uses the Docker worker.');
  const npmCli = process.env.npm_execpath;
  if (!npmCli) throw Error('Run this command through npm.');
  const file = nativeWorkerAutostartFile(process.env.APPDATA),
    action = process.argv[2] ?? 'status';
  if (action === 'install') {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(
      file,
      nativeWorkerAutostartScript({
        root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
        node: process.execPath,
        npmCli,
      }),
      'utf8',
    );
    console.log('Native package worker will start at user login.');
  } else if (action === 'uninstall') {
    await rm(file, { force: true });
    console.log('Native package worker autostart removed.');
  } else if (action === 'status') {
    const expected = nativeWorkerAutostartScript({
        root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
        node: process.execPath,
        npmCli,
      }),
      installed = (await readFile(file, 'utf8').catch(() => null)) === expected;
    console.log(
      `Native package worker autostart is ${installed ? 'installed' : 'missing or out of date'}.`,
    );
    process.exitCode = installed ? 0 : 1;
  } else throw Error('Usage: native-worker-autostart.mjs [install|uninstall|status]');
}
