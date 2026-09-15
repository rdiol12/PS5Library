import { copyFile,mkdir,readFile,stat,writeFile } from 'node:fs/promises';
import path from 'node:path';
import { configuration } from '../server/src/config.js';
import { database } from '../server/src/db.js';
import { fileHash } from '../server/src/downloads/stream.js';
import { uuid } from '../shared/schemas/index.js';
const userId=uuid.parse(process.argv[2]),config=configuration(),db=database(config.DATABASE_URL);
try{
  if(!(await db.query('SELECT id FROM users WHERE id=$1',[userId])).rowCount)throw Error('Create your account first');
  const folder=path.join(config.SOURCE_ROOT,userId,'ps5library-homebrew');await mkdir(folder,{recursive:true});
  const elf=path.resolve('ps5/build/ps5/ps5library.elf');await copyFile(elf,path.join(folder,'store.elf'));await copyFile('ps5/assets/icon0.png',path.join(folder,'icon.png'));
  const size=(await stat(elf)).size,sha256=await fileHash(elf);
  await writeFile(path.join(folder,'library.json'),JSON.stringify({schemaVersion:1,releases:[{key:'ps5library-0.1.0',game:{title:'PS5Library',titleId:'BREW05001',contentId:'IV0000-BREW05001_00-PS5LIBRARYAPP000',description:'Your private native homebrew storefront.',genres:['Homebrew'],artwork:{cover:'icon.png',hero:'icon.png',icon:'icon.png'}},version:'01.00',size,sha256,format:'elf',location:'store.elf',minimumFirmware:null}]},null,2));
  console.log('Created an authorized source containing our own built ELF. In Sources, add Local Folder: ps5library-homebrew. Minimum firmware remains unknown until tested.');
}finally{await db.end();}
