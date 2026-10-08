import path from 'node:path';
import {mkdir,open} from 'node:fs/promises';
import {AppError} from '../security/errors.js';
import {regularFile} from '../security/paths.js';

export async function resumeUpload(file:string,totalBytes:number){
  await mkdir(path.dirname(file),{recursive:true});
  let created;
  try{created=await open(file,'wx+',0o600);}catch(error:any){if(error?.code!=='EEXIST')throw error;}finally{await created?.close();}
  let checked;try{checked=await regularFile(file,'r+');}catch{throw new AppError('CORRUPT_INPUT',409);}
  const size=checked.info.size;await checked.handle.close();
  if(size>totalBytes)throw new AppError('CORRUPT_INPUT',409);
  return size;
}

export async function appendUpload(file:string,offset:number,encoded:string,totalBytes:number){
  const data=Buffer.from(encoded,'base64');
  if(data.length<1||data.length>1024**2||data.toString('base64')!==encoded)throw new AppError('INVALID_INPUT',400);
  let checked;try{checked=await regularFile(file,'r+');}catch{throw new AppError('CORRUPT_INPUT',409);}
  const {handle,info}=checked;
  try{
    if(info.size>totalBytes||info.size+data.length>totalBytes)throw new AppError('CORRUPT_INPUT',409);
    if(offset!==info.size)throw new AppError('OFFSET_MISMATCH',409);
    let written=0;while(written<data.length)written+=(await handle.write(data,written,data.length-written,info.size+written)).bytesWritten;
    await handle.sync();
  }finally{await handle.close();}
  return info.size+data.length;
}
