import {createHash} from 'node:crypto';
import {lstat,open,type FileHandle} from 'node:fs/promises';

export const portableSaveMagic=Buffer.from('PS5LSP01');
const maxPathBytes=240,maxFiles=10_000,maxArchive=8*1024**3;

function safePath(value:string){
  const parts=value.split('/');
  return value.length>0&&!value.startsWith('/')&&!value.includes('\\')&&!value.includes('\0')&&!value.endsWith('.ps5library.tmp')&&parts.every(part=>part&&part!=='.'&&part!=='..'&&part!=='sce_sys'&&!/[\x00-\x1f]/.test(part));
}
async function exact(handle:FileHandle,position:number,length:number){
  const data=Buffer.alloc(length);let offset=0;
  while(offset<length){const read=await handle.read(data,offset,length-offset,position+offset);if(!read.bytesRead)throw new Error('PORTABLE_ARCHIVE_TRUNCATED');offset+=read.bytesRead;}
  return data;
}
export async function validatePortableSaveArchive(filename:string,expectedSize:number,expectedFiles:number,expectedSha256:string){
  if(!Number.isSafeInteger(expectedSize)||expectedSize<12||expectedSize>maxArchive||!Number.isInteger(expectedFiles)||expectedFiles<1||expectedFiles>maxFiles||!/^[a-f0-9]{64}$/.test(expectedSha256))throw new Error('PORTABLE_ARCHIVE_INVALID');
  const handle=await open(filename,'r');
  try{
    const [pathInfo,info]=await Promise.all([lstat(filename),handle.stat()]),generation=(value:typeof info)=>`${value.dev}:${value.ino}:${value.size}:${value.mtimeMs}:${value.ctimeMs}`;
    if(pathInfo.isSymbolicLink()||!pathInfo.isFile()||!info.isFile()||pathInfo.dev!==info.dev||pathInfo.ino!==info.ino||info.size!==expectedSize)throw new Error('PORTABLE_ARCHIVE_SIZE_MISMATCH');
    const archiveDigest=createHash('sha256'),take=async(position:number,length:number)=>{const data=await exact(handle,position,length);archiveDigest.update(data);return data;};
    const header=await take(0,12);if(!header.subarray(0,8).equals(portableSaveMagic))throw new Error('PORTABLE_ARCHIVE_MAGIC');
    const count=header.readUInt32BE(8);if(count!==expectedFiles)throw new Error('PORTABLE_ARCHIVE_FILE_COUNT');
    let position=12,total=0;const names=new Set<string>(),prefixes=new Set<string>();
    for(let index=0;index<count;index++){
      const pathLength=(await take(position,2)).readUInt16BE();position+=2;if(pathLength<1||pathLength>maxPathBytes)throw new Error('PORTABLE_ARCHIVE_PATH');
      const encoded=await take(position,pathLength);position+=pathLength;const name=encoded.toString('utf8'),parts=name.split('/');if(Buffer.byteLength(name)!==pathLength||!safePath(name)||names.has(name)||prefixes.has(name))throw new Error('PORTABLE_ARCHIVE_PATH');for(let i=1;i<parts.length;i++){const prefix=parts.slice(0,i).join('/');if(names.has(prefix))throw new Error('PORTABLE_ARCHIVE_PATH');prefixes.add(prefix);}names.add(name);
      const size=Number((await take(position,8)).readBigUInt64BE());position+=8;if(!Number.isSafeInteger(size)||size<0||size>maxArchive||position+32+size>expectedSize)throw new Error('PORTABLE_ARCHIVE_SIZE_MISMATCH');
      const declared=await take(position,32);position+=32;const digest=createHash('sha256');let remaining=size;
      while(remaining){const length=Math.min(1024*1024,remaining),chunk=await take(position,length);digest.update(chunk);position+=length;remaining-=length;}
      if(!digest.digest().equals(declared))throw new Error('PORTABLE_ARCHIVE_ENTRY_HASH');total+=size;if(total>maxArchive)throw new Error('PORTABLE_ARCHIVE_SIZE_MISMATCH');
    }
    if(position!==expectedSize)throw new Error('PORTABLE_ARCHIVE_TRAILING_DATA');
    const [pathAfter,after]=await Promise.all([lstat(filename),handle.stat()]);if(pathAfter.isSymbolicLink()||pathAfter.dev!==after.dev||pathAfter.ino!==after.ino||generation(after)!==generation(info)||archiveDigest.digest('hex')!==expectedSha256)throw new Error('PORTABLE_ARCHIVE_HASH');
    return {fileCount:count,contentBytes:total};
  }finally{await handle.close();}
}
