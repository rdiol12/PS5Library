import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const files = readFileSync('.clang-format-files', 'utf8').trim().split(/\r?\n/);
const cli = resolve('node_modules/@wasm-fmt/clang-format/clang-format-cli.cjs');
const mode = process.argv.includes('--check') ? ['--dry-run', '--Werror'] : ['-i'];
const result = spawnSync(process.execPath, [cli, ...mode, ...files], { stdio: 'inherit' });

process.exitCode = result.status ?? 1;
