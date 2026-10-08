import { mkdir, open, stat } from 'node:fs/promises';
import { execFile, spawn } from 'node:child_process';
import { request, type ServerResponse } from 'node:http';
import { promisify } from 'node:util';
import path from 'node:path';
import { AppError } from '../security/errors.js';
import {validWorkerProgress,type WorkerProgress} from '../worker-progress.js';

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
type Tool = 'ffmpeg' | 'ffprobe';
const execute = promisify(execFile);

async function remote<T>(body: object, timeout: number, progress?: (value: WorkerProgress) => Promise<void>, socketOnly=false) {
  const url=!socketOnly&&(body as {kind?:unknown}).kind==='dotnet'?process.env.PACKAGE_WORKER_URL:undefined,token=process.env.PACKAGE_WORKER_TOKEN;
  return new Promise<T>((resolve,reject)=>{
    let pending = '', result: T | undefined, events = Promise.resolve(), finished = false;
    const fail = (error: unknown) => { if (!finished) { finished = true; req.destroy(); reject(error); } };
    const options={method:'POST',headers:{'content-type':'application/json',...(url?{authorization:`Bearer ${token}`}:{})}};
    const req = url?request(new URL('/run',url),options,res=>receive(res)):request({socketPath:process.env.PACKAGE_WORKER_SOCKET!,path:'/run',...options},res=>receive(res));
    function receive(res:import('node:http').IncomingMessage) {
      res.setEncoding('utf8');
      const interrupted=(error?:Error)=>fail(new AppError('WORKER_UNAVAILABLE',503,error?.message));
      res.on('aborted',()=>interrupted());res.on('error',interrupted);res.on('close',()=>{if(!res.complete)interrupted();});
      res.on('data',chunk=>{pending+=chunk;if(pending.length>4*1024**2){req.destroy();return fail(new AppError('WORKER_UNAVAILABLE',503));}const lines=pending.split('\n');pending=lines.pop()!;
        for(const line of lines){if(!line)continue;try{const message=JSON.parse(line);if(message.type==='progress'){if(!validWorkerProgress(message.value))throw new AppError('INVALID_WORKER_EVENT');events=events.then(()=>progress?.(message.value)).then(()=>{});void events.catch(fail);}else if(message.type==='result')result=message.value;else if(message.type==='error')fail(new AppError(message.code??'WORKER_FAILED',message.statusCode??422,message.message));}catch(error){fail(error instanceof AppError?error:new AppError('WORKER_UNAVAILABLE',503));}}});
      res.on('end', () => void events.then(() => {
        if (finished) return;
        if (res.statusCode !== 200 || result === undefined) return fail(new AppError('WORKER_UNAVAILABLE', 503));
        finished = true; resolve(result);
      }).catch(fail));
    }
    req.setTimeout(timeout,()=>req.destroy(new AppError('WORKER_TIMEOUT',504)));
    req.on('error',error=>fail(error instanceof AppError?error:new AppError('WORKER_UNAVAILABLE',503,error.message)));
    req.end(JSON.stringify(body));
  });
}

export async function runWorker(args: string[], progress?: (value: WorkerProgress) => Promise<void>) {
  if(process.env.PACKAGE_WORKER_URL||process.env.PACKAGE_WORKER_SOCKET){
    const timeout=/^(build|hash)/.test(args[0]??'')?6*60*60_000:30*60_000,body={kind:'dotnet',args};
    try{return await remote<Record<string,any>>(body,timeout,progress);}
    catch(error){
      const readOnly=['inspect','hash-file','hash-tree','hash-base-tree','archive-parts','hash-archive'].includes(args[0]??'');
      if(!readOnly||!process.env.PACKAGE_WORKER_URL||!process.env.PACKAGE_WORKER_SOCKET||!(error instanceof AppError)||!['WORKER_UNAVAILABLE','WORKER_TIMEOUT'].includes(error.code))throw error;
      return remote<Record<string,any>>(body,timeout,progress,true);
    }
  }
  return runLocalWorker(args,progress);
}

export async function runSandboxTool(command: Tool, args: string[]) {
  if (process.env.PACKAGE_WORKER_SOCKET) return remote<{ stdout: string; stderr: string }>({ kind: 'media', command, args }, 300_000);
  return runLocalTool(command, args);
}

export async function runSandboxArtwork(input: string, output: string, artworkKind: string) {
  if (process.env.PACKAGE_WORKER_SOCKET) return remote<{ width: number; height: number; size: number; sha256: string }>({ kind: 'image', input, output, artworkKind }, 300_000);
  return (await import('../artwork/optimize.js')).optimizeArtworkFile(input, output, artworkKind);
}

export async function runLocalTool(command: Tool, args: string[]) { return execute(command, args, { windowsHide: true, timeout: 300_000, maxBuffer: 1024 * 1024 }); }

export const workerTempDirectory=(args:string[])=>/^(?:build|build-verified|build-archive|build-backport)$/.test(args[0]??'')&&args[2]?path.resolve(args[2]):undefined;
export const workerDisconnectSignal=(response:ServerResponse)=>{const controller=new AbortController();response.once('close',()=>{if(!response.writableEnded)controller.abort();});return controller.signal;};

export async function runLocalWorker(args: string[], progress?: (value: WorkerProgress) => Promise<void>,signal?:AbortSignal) {
  const dll = path.resolve('worker/bin/Release/net10.0/PS5Library.Worker.dll');
  const temp=workerTempDirectory(args);if(temp)await mkdir(temp,{recursive:true});
  return new Promise<Record<string, any>>((resolve, reject) => {
    const process = spawn('dotnet', [dll, ...args], { shell: false, windowsHide: true,signal,env:temp?{...globalThis.process.env,TMPDIR:temp,TMP:temp,TEMP:temp}:globalThis.process.env });
    let output = '', pending = '', events = Promise.resolve();
    const timeout = setTimeout(() => { process.kill(); reject(new AppError('WORKER_TIMEOUT', 504)); }, /^(build|hash)/.test(args[0]??'')?6*60*60_000:30*60_000);
    process.stdout.on('data', chunk => { output += chunk; if (output.length > 4 * 1024 ** 2) process.kill(); });
    process.stderr.on('data', chunk => {
      pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop()!.slice(-8192);
      for (const line of lines) if (line.startsWith('PS5LIBRARY_PROGRESS ')) {
        try { const event = JSON.parse(line.slice(20));
          if(!validWorkerProgress(event))throw new AppError('INVALID_WORKER_EVENT');
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
