#include "../common/client.hpp"
#include <sqlite3.h>
#include <cstdio>
#include <fstream>
#include <map>
#include <unistd.h>

static void fixture(const ps5library::fs::path& file,const char* values) {
  sqlite3* db=nullptr;
  if(sqlite3_open(file.c_str(),&db)!=SQLITE_OK)throw std::runtime_error("Cannot create save fixture");
  const char* schema="CREATE TABLE savedata(title_id TEXT,game_title_id TEXT,dir_name TEXT,main_title TEXT,sub_title TEXT,detail TEXT,size_kib INTEGER,mtime TEXT);";
  char* error=nullptr;
  if(sqlite3_exec(db,schema,nullptr,nullptr,&error)!=SQLITE_OK||sqlite3_exec(db,values,nullptr,nullptr,&error)!=SQLITE_OK){std::string message=error?error:"SQLite fixture failed";sqlite3_free(error);sqlite3_close(db);throw std::runtime_error(message);}
  sqlite3_close(db);
}

int main(){
  using namespace ps5library;
  const auto root=fs::temp_directory_path()/("ps5library-saves-"+std::to_string(getpid()));
  try{
    if(!fs::create_directory(root))throw std::runtime_error("Refusing to reuse test directory");
    fixture(root/"ps4.db","INSERT INTO savedata VALUES('CUSA00001','CUSA00001','slot-a','Legacy Game','Chapter 2','At the lighthouse',128,'2026-09-10T12:00:00.00Z');");
    fixture(root/"ps5.db","INSERT INTO savedata VALUES('PPSA10000','PPSA10001','autosave','Current Game','Autosave','Mission 7',4096,'2026-09-12T18:30:00.00Z'); INSERT INTO savedata VALUES('../escape','PPSA10002','bad','Bad','','',1,'2026-09-13T00:00:00.00Z');");
    const auto snapshot=readSaveData(root/"ps4.db",root/"ps5.db","12345678");
    if(!saveTaskMatchesUser(Json::object({{"localUserId","12345678"}}),"12345678")||saveTaskMatchesUser(Json::object({{"localUserId","87654321"}}),"12345678")||saveTaskMatchesUser(Json::object({{"localUserId","12345678"}}),""))throw std::runtime_error("Save tasks are not bound to the foreground user");
    const auto items=snapshot["items"];
    if(!snapshot["complete"].boolean()||snapshot["localUserId"].string()!="12345678"||items.size()!=2)throw std::runtime_error("Save snapshot shape is wrong: "+snapshot.dump());
    if(items[size_t(0)]["gameTitleId"].string()!="PPSA10001"||items[size_t(0)]["saveTitleId"].string()!="PPSA10000"||items[size_t(0)]["sizeBytes"].number()!=4096*1024||items[size_t(0)]["platform"].string()!="PS5")throw std::runtime_error("PS5 save metadata was not normalized or sorted");
    if(items[size_t(1)]["gameTitleId"].string()!="CUSA00001"||items[size_t(1)]["platform"].string()!="PS4")throw std::runtime_error("PS4 save metadata was not read");
    if(!readSaveData(root/"ps4.db",root/"missing.db","../bad").null())throw std::runtime_error("Unsafe local user id was accepted");
    std::FILE* corrupt=std::fopen((root/"corrupt.db").c_str(),"wb");std::fputs("not sqlite",corrupt);std::fclose(corrupt);
    const auto partial=readSaveData(root/"ps4.db",root/"corrupt.db","12345678");
    if(partial["complete"].boolean()||partial["items"].size()!=1)throw std::runtime_error("A corrupt database must retain valid rows but mark the snapshot incomplete");
    const auto home=root/"home",user=home/"12345678";
    fs::create_directories(user/"savedata_prospero/PPSA10000");fs::create_directories(user/"savedata_prospero_meta/user/PPSA10000");
    atomicBytes(user/"savedata_prospero/PPSA10000/sdimg_autosave",std::string(0x900,'p'));
    atomicBytes(user/"savedata_prospero_meta/user/PPSA10000/sce_bu_autosave.sfo","save metadata");
    atomicBytes(user/"savedata_prospero_meta/user/PPSA10000/autosave_icon0.png","icon");
    const auto task=Json::object({{"localUserId","12345678"},{"platform","PS5"},{"gameTitleId","PPSA10001"},{"saveTitleId","PPSA10000"},{"directory","autosave"}});const auto archive=root/"ps5.ps5save";
    const auto built=buildSaveBackup(home,task,archive);
    if(built["manifest"]["files"].size()!=3||built["totalBytes"].number()!=static_cast<int64_t>(fs::file_size(archive))||built["sha256"].string()!=fileHash(archive))throw std::runtime_error("PS5 backup manifest is incomplete");
    auto read16=[](std::istream& in){unsigned char b[2];in.read(reinterpret_cast<char*>(b),2);return static_cast<uint16_t>((b[0]<<8)|b[1]);};
    auto read32=[](std::istream& in){unsigned char b[4];in.read(reinterpret_cast<char*>(b),4);return (uint32_t(b[0])<<24)|(uint32_t(b[1])<<16)|(uint32_t(b[2])<<8)|b[3];};
    auto read64=[](std::istream& in){uint64_t value=0;for(int i=0;i<8;i++){unsigned char b=0;in.read(reinterpret_cast<char*>(&b),1);value=(value<<8)|b;}return value;};
    std::ifstream input(archive,std::ios::binary);char magic[8];input.read(magic,8);if(std::string(magic,8)!="PS5LSV01")throw std::runtime_error("Backup magic is wrong");
    std::map<std::string,std::string> records;for(uint32_t count=read32(input),i=0;i<count;i++){std::string name(read16(input),'\0');input.read(name.data(),name.size());std::string data(read64(input),'\0');input.read(data.data(),data.size());records[name]=data;}
    if(records["encrypted/save-image"]!=std::string(0x900,'p')||records["metadata/save.sfo"]!="save metadata"||records["metadata/icon0.png"]!="icon"||input.peek()!=EOF)throw std::runtime_error("PS5 backup records are wrong");
    fs::create_directories(user/"savedata/CUSA00001");atomicBytes(user/"savedata/CUSA00001/sdimg_slot-a","encrypted ps4 image");atomicBytes(user/"savedata/CUSA00001/slot-a.bin",std::string(96,'k'));
    const auto ps4=buildSaveBackup(home,Json::object({{"localUserId","12345678"},{"platform","PS4"},{"gameTitleId","CUSA00001"},{"saveTitleId","CUSA00001"},{"directory","slot-a"}}),root/"ps4.ps5save");
    if(ps4["manifest"]["files"].size()!=2)throw std::runtime_error("PS4 backup omitted its sealed key");
    fs::remove(user/"savedata/CUSA00001/slot-a.bin");bool rejected=false;try{buildSaveBackup(home,Json::object({{"localUserId","12345678"},{"platform","PS4"},{"gameTitleId","CUSA00001"},{"saveTitleId","CUSA00001"},{"directory","slot-a"}}),root/"bad.ps5save");}catch(const std::exception&){rejected=true;}if(!rejected)throw std::runtime_error("An incomplete PS4 save was backed up");
    const auto plain=root/"plain",restored=root/"restored";fs::create_directories(plain/"progress");fs::create_directories(plain/"sce_sys");atomicBytes(plain/"progress/slot.dat","portable progress");atomicBytes(plain/"profile.bin","profile");atomicBytes(plain/"empty.dat","");atomicBytes(plain/"sce_sys/param.sfo","source account metadata");atomicBytes(plain/"sce_sys/keystone","source keystone");
    const auto portableTask=Json::object({{"platform","PS5"},{"gameTitleId","PPSA10001"},{"saveTitleId","PPSA10000"},{"directory","autosave"},{"gameVersion","01.020"},{"firmware","4.50"},{"runtime","test"}});const auto portableFile=root/"portable.ps5save";const auto portable=buildPortableSaveArchive(plain,portableTask,portableFile);if(portable["manifest"]["fileCount"].number()!=3||!portable["manifest"]["portability"]["platformMetadataExcluded"].boolean()||portable["manifest"]["portability"]["embeddedAccountIdentifiersRemoved"].boolean())throw std::runtime_error("Portable manifest is wrong");
    atomicBytes(plain/"reserved.ps5library.tmp","reserved");rejected=false;try{buildPortableSaveArchive(plain,portableTask,root/"reserved.ps5save");}catch(const std::exception&){rejected=true;}fs::remove(plain/"reserved.ps5library.tmp");if(!rejected)throw std::runtime_error("Portable export accepted its reserved temporary suffix");
    fs::create_directories(restored/"sce_sys");atomicBytes(restored/"sce_sys/param.sfo","target account metadata");atomicBytes(restored/"sce_sys/keystone","target keystone");atomicBytes(restored/"obsolete.bin","old");applyPortableSaveArchive(portableFile,restored);std::ifstream progress(restored/"progress/slot.dat"),profile(restored/"profile.bin"),metadata(restored/"sce_sys/param.sfo"),keystone(restored/"sce_sys/keystone");std::string progressText((std::istreambuf_iterator<char>(progress)),{}),profileText((std::istreambuf_iterator<char>(profile)),{}),metadataText((std::istreambuf_iterator<char>(metadata)),{}),keystoneText((std::istreambuf_iterator<char>(keystone)),{});if(progressText!="portable progress"||profileText!="profile"||metadataText!="target account metadata"||keystoneText!="target keystone"||!fs::is_regular_file(restored/"empty.dat")||fs::file_size(restored/"empty.dat")||fs::exists(restored/"obsolete.bin"))throw std::runtime_error("Portable restore did not preserve target metadata, keystone or empty files");
    const auto ps5Plain=root/"ps5-plain",ps5Restored=root/"ps5-restored",sourceSfo=root/"source.sfo",targetSfo=root/"target.sfo",ps5Portable=root/"portable-ps5.ps5save";fs::create_directories(ps5Plain);fs::create_directories(ps5Restored);atomicBytes(ps5Plain/"slot.dat","ps5 progress");atomicBytes(sourceSfo,"source external account metadata");atomicBytes(targetSfo,"target external account metadata");atomicBytes(ps5Restored/"old.dat","old");buildPortableSaveArchive(ps5Plain,portableTask,ps5Portable,sourceSfo);applyPortableSaveArchive(ps5Portable,ps5Restored,targetSfo);std::ifstream ps5Progress(ps5Restored/"slot.dat"),ps5Metadata(targetSfo);std::string ps5ProgressText((std::istreambuf_iterator<char>(ps5Progress)),{}),ps5MetadataText((std::istreambuf_iterator<char>(ps5Metadata)),{});if(ps5ProgressText!="ps5 progress"||ps5MetadataText!="target external account metadata"||fs::exists(ps5Restored/"old.dat"))throw std::runtime_error("PS5 external account metadata was not preserved");
    const auto unbound=root/"unbound";fs::create_directories(unbound);atomicBytes(unbound/"existing.bin","keep");rejected=false;try{applyPortableSaveArchive(portableFile,unbound);}catch(const std::exception&){rejected=true;}if(!rejected||!fs::exists(unbound/"existing.bin"))throw std::runtime_error("Portable restore accepted a target without account metadata");
    const auto corruptPortable=root/"corrupt-portable.ps5save";fs::copy_file(portableFile,corruptPortable);{std::fstream changed(corruptPortable,std::ios::in|std::ios::out|std::ios::binary);changed.seekp(-1,std::ios::end);changed.put('x');}atomicBytes(restored/"sentinel","keep");rejected=false;try{applyPortableSaveArchive(corruptPortable,restored);}catch(const std::exception&){rejected=true;}if(!rejected||!fs::exists(restored/"sentinel"))throw std::runtime_error("Corrupt portable save mutated its target");
    fs::remove_all(root);std::puts("PASS: save metadata and immutable encrypted backups");return 0;
  }catch(const std::exception& e){std::fprintf(stderr,"FAIL: %s\n",e.what());fs::remove_all(root);return 1;}
}
