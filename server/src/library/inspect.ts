import { open, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { AppError } from '../security/errors.js';

export async function inspect(filename: string, format: string, expected?: { titleId: string; contentId: string; version: string }) {
  if (format === 'elf') {
    const file = await open(filename, 'r'); const header = Buffer.alloc(64);
    try { await file.read(header, 0, 64, 0); } finally { await file.close(); }
    if ((await stat(filename)).size < 64 || header.subarray(0, 7).toString('hex') !== '7f454c46020101' || header.readUInt16LE(18) !== 62) throw new AppError('CORRUPT_INPUT');
    return { format, structurallyRecognized: true, metadataVerified: false, launchTested: false, note: 'ELF header recognized; title metadata remains source-provided.' };
  }
  const result = await runWorker(['inspect', filename, ...(expected ? [JSON.stringify(expected)] : [])]);
  if (result.format !== format) throw new AppError('METADATA_MISMATCH', 409, 'Inspected format differs from the selected release.');
  return result;
}
export async function runWorker(args: string[], progress?: (value: { stage: string; completedStages: number; totalStages: number }) => Promise<void>) {
  const dll = path.resolve('worker/bin/Release/net10.0/PS5Library.Worker.dll');
  return new Promise<Record<string, any>>((resolve, reject) => {
    const process = spawn('dotnet', [dll, ...args], { shell: false, windowsHide: true });
    let output = '', pending = '', events = Promise.resolve();
    const timeout = setTimeout(() => { process.kill(); reject(new AppError('WORKER_TIMEOUT', 504)); }, 30 * 60_000);
    process.stdout.on('data', chunk => { output += chunk; if (output.length > 4 * 1024 ** 2) process.kill(); });
    process.stderr.on('data', chunk => {
      pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop()!.slice(-8192);
      for (const line of lines) if (line.startsWith('PS5LIBRARY_PROGRESS ')) {
        try { const event = JSON.parse(line.slice(20));
          if (typeof event.stage === 'string' && event.stage.length < 120 && Number.isInteger(event.completedStages) && event.totalStages === 7 && event.completedStages >= 0 && event.completedStages <= 7)
            events = events.then(() => progress?.(event)).catch(error => { process.kill(); reject(error); });
        } catch { process.kill(); reject(new AppError('INVALID_WORKER_EVENT')); }
      }
    });
    process.on('error', error => { clearTimeout(timeout); reject(error); });
    process.on('close', async code => {
      clearTimeout(timeout);
      await events;
      try {
        const result = JSON.parse(output);
        if (code) reject(new AppError(result.error ?? 'WORKER_FAILED', 422, result.message ?? 'Worker failed'));
        else resolve(result);
      } catch { reject(new AppError('WORKER_UNAVAILABLE', 503, 'Build the .NET worker before inspecting this format.')); }
    });
  });
}
