#include "../common/client.hpp"
#include "../common/version.hpp"
#include <sqlite3.h>
#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cstring>
#include <dirent.h>
#include <fcntl.h>
#include <fstream>
#include <limits>
#include <openssl/evp.h>
#include <regex>
#include <sys/stat.h>
#include <tuple>
#include <unordered_set>
#include <vector>
#include <ctime>
#include <unistd.h>
#ifdef PS5
#include <dlfcn.h>
#include <ps5/kernel.h>
#include <sys/ioctl.h>
extern "C" int sceSystemServiceGetAppIdOfRunningBigApp(void);
extern "C" int sceLncUtilGetAppTitleId(unsigned int,char*);
#endif

namespace ps5library {
namespace {
struct Save {
  std::string platform,gameTitleId,saveTitleId,directory,title,subtitle,detail;
  int64_t sizeBytes=0,modifiedAt=0;
};

bool text(sqlite3_stmt* statement,int column,size_t limit,std::string& value){
  const auto bytes=sqlite3_column_bytes(statement,column);const auto* data=sqlite3_column_text(statement,column);
  if(bytes<0||static_cast<size_t>(bytes)>limit||(!data&&bytes))return false;
  value.assign(reinterpret_cast<const char*>(data?data:reinterpret_cast<const unsigned char*>("")),static_cast<size_t>(bytes));
  return value.find('\0')==std::string::npos;
}
bool titleId(const std::string& value){static const std::regex pattern("[A-Z]{4}[0-9]{5}");return std::regex_match(value,pattern);}
bool directory(const std::string& value){return !value.empty()&&value.size()<=128&&value!="."&&value!=".."&&std::none_of(value.begin(),value.end(),[](unsigned char c){return c<32||c=='/'||c=='\\';});}

struct BackupFile {fs::path source;std::string name;uint64_t size;fs::file_time_type modified;};
BackupFile backupFile(const fs::path& source,const std::string& name,bool allowEmpty=false){
  struct stat info{};if(lstat(source.c_str(),&info)||!S_ISREG(info.st_mode)||info.st_size<0||(!allowEmpty&&!info.st_size))throw std::runtime_error("SAVE_SOURCE_UNAVAILABLE");
  return {source,name,static_cast<uint64_t>(info.st_size),fs::last_write_time(source)};
}
void be16(std::ostream& out,uint16_t value){const unsigned char bytes[]={static_cast<unsigned char>(value>>8),static_cast<unsigned char>(value)};out.write(reinterpret_cast<const char*>(bytes),2);}
void be32(std::ostream& out,uint32_t value){const unsigned char bytes[]={static_cast<unsigned char>(value>>24),static_cast<unsigned char>(value>>16),static_cast<unsigned char>(value>>8),static_cast<unsigned char>(value)};out.write(reinterpret_cast<const char*>(bytes),4);}
void be64(std::ostream& out,uint64_t value){unsigned char bytes[8];for(int i=7;i>=0;i--){bytes[i]=static_cast<unsigned char>(value);value>>=8;}out.write(reinterpret_cast<const char*>(bytes),8);}
uint16_t read16(std::istream& in){unsigned char b[2]{};in.read(reinterpret_cast<char*>(b),2);if(!in)throw std::runtime_error("CORRUPT_INPUT");return static_cast<uint16_t>((b[0]<<8)|b[1]);}
uint32_t read32(std::istream& in){unsigned char b[4]{};in.read(reinterpret_cast<char*>(b),4);if(!in)throw std::runtime_error("CORRUPT_INPUT");return (uint32_t(b[0])<<24)|(uint32_t(b[1])<<16)|(uint32_t(b[2])<<8)|b[3];}
uint64_t read64(std::istream& in){uint64_t value=0;for(int i=0;i<8;i++){unsigned char b=0;in.read(reinterpret_cast<char*>(&b),1);if(!in)throw std::runtime_error("CORRUPT_INPUT");value=(value<<8)|b;}return value;}
void rawDigest(std::ostream& out,const std::string& hex){if(hex.size()!=64)throw std::runtime_error("SAVE_EXPORT_FAILED");for(size_t i=0;i<hex.size();i+=2){const auto byte=static_cast<unsigned char>(std::stoul(hex.substr(i,2),nullptr,16));out.write(reinterpret_cast<const char*>(&byte),1);}}
std::string utcNow(){std::time_t now=std::time(nullptr);std::tm value{};gmtime_r(&now,&value);char text[32];if(!std::strftime(text,sizeof(text),"%Y-%m-%dT%H:%M:%S.000Z",&value))throw std::runtime_error("SAVE_EXPORT_FAILED");return text;}
bool portablePath(const std::string& value){if(value.empty()||value.size()>240||value.front()=='/'||value.find('\\')!=std::string::npos||value.find('\0')!=std::string::npos||(value.size()>=15&&value.compare(value.size()-15,15,".ps5library.tmp")==0))return false;for(const auto& part:fs::path(value)){const auto text=part.string();if(text.empty()||text=="."||text==".."||text=="sce_sys"||std::any_of(text.begin(),text.end(),[](unsigned char c){return c<32;}))return false;}return true;}
std::string copyDigest(const BackupFile& file,std::ostream& output){
  std::ifstream input(file.source,std::ios::binary);if(!input)throw std::runtime_error("SAVE_SOURCE_UNAVAILABLE");
  auto* digest=EVP_MD_CTX_new();if(!digest||EVP_DigestInit_ex(digest,EVP_sha256(),nullptr)!=1){EVP_MD_CTX_free(digest);throw std::runtime_error("SAVE_BACKUP_FAILED");}
  std::vector<char> buffer(1024*1024);uint64_t copied=0;
  while(input&&copied<file.size){const auto wanted=static_cast<std::streamsize>(std::min<uint64_t>(buffer.size(),file.size-copied));input.read(buffer.data(),wanted);const auto count=input.gcount();if(count<=0){EVP_MD_CTX_free(digest);throw std::runtime_error("SAVE_SOURCE_CHANGED");}output.write(buffer.data(),count);if(!output||EVP_DigestUpdate(digest,buffer.data(),static_cast<size_t>(count))!=1){EVP_MD_CTX_free(digest);throw std::runtime_error("SAVE_BACKUP_FAILED");}copied+=static_cast<uint64_t>(count);}
  unsigned char bytes[EVP_MAX_MD_SIZE];unsigned length=0;if(copied!=file.size||EVP_DigestFinal_ex(digest,bytes,&length)!=1){EVP_MD_CTX_free(digest);throw std::runtime_error("SAVE_SOURCE_CHANGED");}EVP_MD_CTX_free(digest);
  struct stat after{};if(lstat(file.source.c_str(),&after)||!S_ISREG(after.st_mode)||static_cast<uint64_t>(after.st_size)!=file.size||fs::last_write_time(file.source)!=file.modified)throw std::runtime_error("SAVE_SOURCE_CHANGED");
  static constexpr char hex[]="0123456789abcdef";std::string result(length*2,'0');for(unsigned i=0;i<length;i++){result[i*2]=hex[bytes[i]>>4];result[i*2+1]=hex[bytes[i]&15];}
  if(fileHash(file.source)!=result)throw std::runtime_error("SAVE_SOURCE_CHANGED");
  return result;
}
}

Json buildPortableSaveArchive(const fs::path& plaintextRoot,const Json& task,const fs::path& output,const fs::path& bindingMetadata){
  if(!fs::is_directory(plaintextRoot))throw std::runtime_error("SAVE_SOURCE_UNAVAILABLE");
  const auto embedded=plaintextRoot/"sce_sys/param.sfo",binding=fs::is_regular_file(embedded)?embedded:bindingMetadata;if(!fs::is_regular_file(binding))throw std::runtime_error("SAVE_BINDING_METADATA_UNAVAILABLE");backupFile(binding,"account metadata");std::vector<BackupFile> files;
  for(const auto& entry:fs::recursive_directory_iterator(plaintextRoot,fs::directory_options::skip_permission_denied)){
    const auto relative=entry.path().lexically_relative(plaintextRoot);if(relative.empty())continue;const auto first=(*relative.begin()).string();if(first=="sce_sys"){if(entry.is_directory())continue;else continue;}if(entry.is_symlink())throw std::runtime_error("SAVE_SOURCE_UNAVAILABLE");if(entry.is_directory())continue;if(!entry.is_regular_file())throw std::runtime_error("SAVE_SOURCE_UNAVAILABLE");const auto name=relative.generic_string();if(!portablePath(name))throw std::runtime_error("SAVE_SOURCE_UNAVAILABLE");files.push_back(backupFile(entry.path(),name,true));if(files.size()>10000)throw std::runtime_error("SAVE_EXPORT_FAILED");
  }
  if(files.empty())throw std::runtime_error("SAVE_CONTENT_UNAVAILABLE");
  std::sort(files.begin(),files.end(),[](const BackupFile& a,const BackupFile& b){return a.name<b.name;});uint64_t required=12;for(const auto& file:files){const auto overhead=42+file.name.size();if(required>8589934592ULL-overhead||file.size>8589934592ULL-required-overhead)throw std::runtime_error("SAVE_EXPORT_FAILED");required+=overhead+file.size;}
  fs::create_directories(output.parent_path());if(fs::space(output.parent_path()).available<required+64*1024*1024)throw std::runtime_error("INSUFFICIENT_SPACE");const auto temporary=fs::path(output.string()+".tmp");fs::remove(temporary);
  try{std::ofstream stream(temporary,std::ios::binary|std::ios::trunc);if(!stream)throw std::runtime_error("SAVE_EXPORT_FAILED");stream.write("PS5LSP01",8);be32(stream,static_cast<uint32_t>(files.size()));for(const auto& file:files){const auto digest=fileHash(file.source);be16(stream,static_cast<uint16_t>(file.name.size()));stream.write(file.name.data(),static_cast<std::streamsize>(file.name.size()));be64(stream,file.size);rawDigest(stream,digest);if(copyDigest(file,stream)!=digest)throw std::runtime_error("SAVE_SOURCE_CHANGED");}stream.flush();if(!stream)throw std::runtime_error("SAVE_EXPORT_FAILED");stream.close();if(fs::file_size(temporary)!=required)throw std::runtime_error("SAVE_EXPORT_FAILED");fs::remove(output);fs::rename(temporary,output);
    const auto digest=fileHash(output);const auto manifest=Json::object({{"schemaVersion",1},{"platform",task["platform"]},{"gameTitleId",task["gameTitleId"]},{"saveTitleId",task["saveTitleId"]},{"directory",task["directory"]},{"gameVersion",task["gameVersion"]},{"archiveSha256",digest},{"archiveSize",static_cast<int64_t>(required)},{"fileCount",static_cast<int64_t>(files.size())},{"exportedAt",utcNow()},{"source",Json::object({{"firmware",task["firmware"]},{"runtime",task["runtime"]},{"exporterVersion",appVersion}})},{"portability",Json::object({{"format","PORTABLE_FILES"},{"platformMetadataExcluded",true},{"embeddedAccountIdentifiersRemoved",false},{"encryptionKeysIncluded",false}})},{"compatibility",Json::object({{"mode","EXACT_GAME_VERSION"},{"gameVersion",task["gameVersion"]}})}});return Json::object({{"totalBytes",static_cast<int64_t>(required)},{"sha256",digest},{"manifest",manifest}});
  }catch(...){fs::remove(temporary);throw;}
}

namespace {
void walkPortable(const fs::path& archive,const std::function<void(const std::string&,uint64_t,const std::string&,std::istream&)>& file){std::ifstream input(archive,std::ios::binary);char magic[8]{};input.read(magic,8);if(!input||std::string(magic,8)!="PS5LSP01")throw std::runtime_error("CORRUPT_INPUT");const auto count=read32(input);if(!count||count>10000)throw std::runtime_error("CORRUPT_INPUT");std::unordered_set<std::string> names,prefixes;uint64_t total=0;for(uint32_t index=0;index<count;index++){const auto length=read16(input);if(!length||length>240)throw std::runtime_error("CORRUPT_INPUT");std::string name(length,'\0');input.read(name.data(),length);if(!input||!portablePath(name)||names.count(name)||prefixes.count(name))throw std::runtime_error("CORRUPT_INPUT");for(auto slash=name.find('/');slash!=std::string::npos;slash=name.find('/',slash+1)){const auto prefix=name.substr(0,slash);if(names.count(prefix))throw std::runtime_error("CORRUPT_INPUT");prefixes.insert(prefix);}names.insert(name);const auto size=read64(input);if(size>8589934592ULL-total)throw std::runtime_error("CORRUPT_INPUT");total+=size;unsigned char expected[32]{};input.read(reinterpret_cast<char*>(expected),32);if(!input)throw std::runtime_error("CORRUPT_INPUT");const auto start=input.tellg();auto* digest=EVP_MD_CTX_new();if(!digest||EVP_DigestInit_ex(digest,EVP_sha256(),nullptr)!=1){EVP_MD_CTX_free(digest);throw std::runtime_error("CORRUPT_INPUT");}std::vector<char> buffer(1024*1024);uint64_t remaining=size;while(remaining){const auto wanted=static_cast<std::streamsize>(std::min<uint64_t>(buffer.size(),remaining));input.read(buffer.data(),wanted);const auto got=input.gcount();if(got<=0||EVP_DigestUpdate(digest,buffer.data(),static_cast<size_t>(got))!=1){EVP_MD_CTX_free(digest);throw std::runtime_error("CORRUPT_INPUT");}remaining-=static_cast<uint64_t>(got);}unsigned char actual[EVP_MAX_MD_SIZE];unsigned actualSize=0;if(EVP_DigestFinal_ex(digest,actual,&actualSize)!=1||actualSize!=32||!std::equal(actual,actual+32,expected)){EVP_MD_CTX_free(digest);throw std::runtime_error("CORRUPT_INPUT");}EVP_MD_CTX_free(digest);static constexpr char hex[]="0123456789abcdef";std::string expectedHex(64,'0');for(size_t n=0;n<32;n++){expectedHex[n*2]=hex[expected[n]>>4];expectedHex[n*2+1]=hex[expected[n]&15];}input.clear();input.seekg(start);file(name,size,expectedHex,input);input.clear();input.seekg(start+static_cast<std::streamoff>(size));if(!input)throw std::runtime_error("CORRUPT_INPUT");}if(input.peek()!=EOF)throw std::runtime_error("CORRUPT_INPUT");}
void clearPortableDirectory(int descriptor,bool preserveMetadata,size_t depth,size_t& entries){if(depth>64)throw std::runtime_error("SAVE_IMPORT_FAILED");const auto scan=dup(descriptor);if(scan<0)throw std::runtime_error("SAVE_IMPORT_FAILED");auto* directory=fdopendir(scan);if(!directory){::close(scan);throw std::runtime_error("SAVE_IMPORT_FAILED");}std::vector<std::string> names;errno=0;while(auto* entry=readdir(directory)){const std::string name=entry->d_name;if(name=="."||name==".."||(preserveMetadata&&name=="sce_sys"))continue;if(name.empty()||name.size()>255||name.find('/')!=std::string::npos||std::any_of(name.begin(),name.end(),[](unsigned char c){return c<32;})){closedir(directory);throw std::runtime_error("SAVE_IMPORT_FAILED");}names.push_back(name);if(names.size()>10000){closedir(directory);throw std::runtime_error("SAVE_IMPORT_FAILED");}}const auto readError=errno;if(closedir(directory)||readError)throw std::runtime_error("SAVE_IMPORT_FAILED");for(const auto& name:names){if(++entries>10000)throw std::runtime_error("SAVE_IMPORT_FAILED");struct stat info{};if(fstatat(descriptor,name.c_str(),&info,AT_SYMLINK_NOFOLLOW))throw std::runtime_error("SAVE_IMPORT_FAILED");if(S_ISREG(info.st_mode)){if(unlinkat(descriptor,name.c_str(),0))throw std::runtime_error("SAVE_IMPORT_FAILED");continue;}if(!S_ISDIR(info.st_mode))throw std::runtime_error("SAVE_IMPORT_FAILED");const auto child=openat(descriptor,name.c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW);if(child<0)throw std::runtime_error("SAVE_IMPORT_FAILED");try{clearPortableDirectory(child,false,depth+1,entries);}catch(...){::close(child);throw;}if(::close(child)||unlinkat(descriptor,name.c_str(),AT_REMOVEDIR))throw std::runtime_error("SAVE_IMPORT_FAILED");}}
void clearPortableSave(const fs::path& root){const auto descriptor=open(root.c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW);if(descriptor<0)throw std::runtime_error("SAVE_IMPORT_FAILED");size_t entries=0;try{clearPortableDirectory(descriptor,true,0,entries);}catch(...){::close(descriptor);throw;}if(::close(descriptor))throw std::runtime_error("SAVE_IMPORT_FAILED");}
}
void applyPortableSaveArchive(const fs::path& archive,const fs::path& plaintextRoot,const fs::path& bindingMetadata){
  const auto embedded=plaintextRoot/"sce_sys/param.sfo";const auto metadata=backupFile(fs::is_regular_file(embedded)?embedded:bindingMetadata,"target metadata");const auto metadataHash=fileHash(metadata.source);
  walkPortable(archive,[](const std::string&,uint64_t,const std::string&,std::istream&){});clearPortableSave(plaintextRoot);
  walkPortable(archive,[&](const std::string& name,uint64_t size,const std::string& expected,std::istream& input){const auto target=beneath(plaintextRoot,name),temporary=fs::path(target.string()+".ps5library.tmp");fs::create_directories(target.parent_path());std::ofstream output(temporary,std::ios::binary|std::ios::trunc);if(!output)throw std::runtime_error("SAVE_IMPORT_FAILED");std::vector<char> buffer(1024*1024);uint64_t remaining=size;while(remaining){const auto wanted=static_cast<std::streamsize>(std::min<uint64_t>(buffer.size(),remaining));input.read(buffer.data(),wanted);const auto got=input.gcount();if(got<=0)throw std::runtime_error("CORRUPT_INPUT");output.write(buffer.data(),got);if(!output)throw std::runtime_error("SAVE_IMPORT_FAILED");remaining-=static_cast<uint64_t>(got);}output.flush();output.close();fs::rename(temporary,target);if(fileHash(target)!=expected)throw std::runtime_error("SAVE_IMPORT_FAILED");});
  const auto after=backupFile(metadata.source,"target metadata");if(after.size!=metadata.size||fileHash(after.source)!=metadataHash)throw std::runtime_error("SAVE_IMPORT_FAILED");
}

#ifdef PS5
namespace {
struct SaveMountOpt{uint8_t reserved;char* budgetid;};struct SaveUmountOpt{uint8_t reserved;};struct PfsKey{uint8_t encrypted[0x60];uint8_t key[0x20];};
static_assert(sizeof(PfsKey)==0x80);
struct SaveFs{void* module=nullptr;int(*initMount)(SaveMountOpt*)=nullptr;int(*mount)(SaveMountOpt*,const char*,const char*,uint8_t*)=nullptr;int(*initUmount)(SaveUmountOpt*)=nullptr;int(*umount)(SaveUmountOpt*,const char*,int,int)=nullptr;};
SaveFs& saveFs(){static SaveFs api;static bool attempted=false;if(attempted)return api;attempted=true;for(const auto* library:{"/system/priv/lib/libSceFsInternalForVsh.sprx","/system_ex/priv/lib/libSceFsInternalForVsh.sprx","libSceFsInternalForVsh.sprx"})if((api.module=dlopen(library,RTLD_NOW|RTLD_LOCAL)))break;if(!api.module)return api;api.initMount=reinterpret_cast<decltype(api.initMount)>(dlsym(api.module,"sceFsInitMountSaveDataOpt"));api.mount=reinterpret_cast<decltype(api.mount)>(dlsym(api.module,"sceFsMountSaveData"));api.initUmount=reinterpret_cast<decltype(api.initUmount)>(dlsym(api.module,"sceFsInitUmountSaveDataOpt"));api.umount=reinterpret_cast<decltype(api.umount)>(dlsym(api.module,"sceFsUmountSaveData"));return api;}
class SavePrivileges{pid_t process_=getpid();uint64_t auth_=0;uint8_t caps_[16]{};bool active_=false;public:SavePrivileges(){auth_=kernel_get_ucred_authid(process_);if(!auth_||kernel_get_ucred_caps(process_,caps_))throw std::runtime_error("CAPABILITY_UNAVAILABLE");active_=true;uint8_t full[16];std::memset(full,0xff,sizeof(full));if(kernel_set_ucred_authid(process_,0x4800000000000010ULL)||kernel_set_ucred_caps(process_,full)){if(!close())_exit(126);throw std::runtime_error("CAPABILITY_UNAVAILABLE");}}
  bool close(){if(!active_)return true;const auto caps=kernel_set_ucred_caps(process_,caps_),auth=kernel_set_ucred_authid(process_,auth_);uint8_t observed[16]{};const auto ok=!caps&&!auth&&kernel_get_ucred_authid(process_)==auth_&&!kernel_get_ucred_caps(process_,observed)&&!std::memcmp(caps_,observed,sizeof(caps_));if(ok)active_=false;return ok;}~SavePrivileges(){if(!close())_exit(126);}SavePrivileges(const SavePrivileges&)=delete;SavePrivileges& operator=(const SavePrivileges&)=delete;};
class MountedSave{fs::path mount_;bool active_=false;public:MountedSave(const fs::path& image,const fs::path& keySource,off_t keyOffset,const fs::path& mount):mount_(mount){auto& api=saveFs();if(!api.initMount||!api.mount||!api.initUmount||!api.umount)throw std::runtime_error("CAPABILITY_UNAVAILABLE");SavePrivileges privileges;PfsKey key{};const auto source=open(keySource.c_str(),O_RDONLY|O_NOFOLLOW);if(source<0)throw std::runtime_error("SAVE_SOURCE_UNAVAILABLE");const auto read=pread(source,key.encrypted,sizeof(key.encrypted),keyOffset);::close(source);if(read!=static_cast<ssize_t>(sizeof(key.encrypted)))throw std::runtime_error("SAVE_SOURCE_UNAVAILABLE");const auto manager=open("/dev/pfsmgr",O_RDWR);if(manager<0)throw std::runtime_error("CAPABILITY_UNAVAILABLE");const auto decrypted=ioctl(manager,0xc0845302UL,&key);::close(manager);if(decrypted<0)throw std::runtime_error("SAVE_SOURCE_UNAVAILABLE");if(fs::exists(mount_))throw std::runtime_error("CAPABILITY_UNAVAILABLE");fs::create_directories(mount_);SaveMountOpt options{};if(api.initMount(&options)<0){fs::remove_all(mount_);throw std::runtime_error("SAVE_SOURCE_UNAVAILABLE");}options.budgetid=const_cast<char*>("system");if(api.mount(&options,image.c_str(),mount_.c_str(),key.key)<0){fs::remove_all(mount_);throw std::runtime_error("SAVE_SOURCE_UNAVAILABLE");}active_=true;if(!privileges.close()){SaveUmountOpt undo{};if(api.initUmount(&undo)>=0&&api.umount(&undo,mount_.c_str(),0,0)>=0)active_=false;if(!active_)fs::remove_all(mount_);throw std::runtime_error("CAPABILITY_UNAVAILABLE");}}
  bool close(){if(active_){SavePrivileges privileges;auto& api=saveFs();SaveUmountOpt options{};const auto unmounted=api.initUmount(&options)>=0&&api.umount(&options,mount_.c_str(),0,0)>=0;const auto restored=privileges.close();if(!unmounted||!restored)return false;active_=false;}std::error_code error;fs::remove_all(mount_,error);return !error;}~MountedSave(){(void)close();}MountedSave(const MountedSave&)=delete;MountedSave& operator=(const MountedSave&)=delete;};
struct SavePaths{fs::path image,key,metadata;off_t keyOffset=0;};
SavePaths savePaths(const fs::path& home,const Json& task){const auto user=task["localUserId"].string(),platform=task["platform"].string(),title=task["saveTitleId"].string(),slot=task["directory"].string();if(!std::regex_match(user,std::regex("[a-f0-9]{8}"))||(platform!="PS4"&&platform!="PS5")||!titleId(title)||!directory(slot))throw std::runtime_error("METADATA_MISMATCH");const auto root=home/user;if(platform=="PS4"){const auto save=root/"savedata"/title;return {save/("sdimg_"+slot),save/(slot+".bin"),{},0};}const auto save=root/"savedata_prospero"/title;auto image=save/("sdimg_"+slot);if(!fs::is_regular_file(image))image=save/slot;const auto metadataRoot=root/"savedata_prospero_meta/user"/title;auto metadata=metadataRoot/(slot+".sfo");if(!fs::is_regular_file(metadata))metadata=metadataRoot/("sce_bu_"+slot+".sfo");return {image,image,metadata,0x800};}
void requireClosedTitle(const Json& task,const char* failure){const auto running=sceSystemServiceGetAppIdOfRunningBigApp();if(running<=0)return;char active[16]{};if(sceLncUtilGetAppTitleId(static_cast<unsigned>(running),active))throw std::runtime_error("CAPABILITY_UNAVAILABLE");if(task["gameTitleId"].string()==active)throw std::runtime_error(failure);}
Json exportMountedSave(const fs::path& home,const Json& task,const fs::path& output){requireClosedTitle(task,"SAVE_EXPORT_FAILED");const auto paths=savePaths(home,task);const auto mount=fs::path("/data/ps5library/save-mounts")/task["id"].string();MountedSave mounted(paths.image,paths.key,paths.keyOffset,mount);auto result=buildPortableSaveArchive(mount,task,output,paths.metadata);if(!mounted.close())throw std::runtime_error("SAVE_EXPORT_FAILED");return result;}
void durableCopy(const fs::path& source,const fs::path& destination){fs::remove(destination);fs::copy_file(source,destination);const auto fd=open(destination.c_str(),O_RDWR|O_NOFOLLOW);if(fd<0||fsync(fd)!=0){if(fd>=0)::close(fd);fs::remove(destination);throw std::runtime_error("ROLLBACK_FAILED");}::close(fd);}
void restoreRollback(const fs::path& rollback,const fs::path& image){const auto temporary=fs::path(image.string()+".ps5library.restore");try{durableCopy(rollback,temporary);if(fileHash(temporary)!=fileHash(rollback))throw std::runtime_error("ROLLBACK_FAILED");fs::rename(temporary,image);if(fileHash(image)!=fileHash(rollback))throw std::runtime_error("ROLLBACK_FAILED");}catch(...){fs::remove(temporary);throw std::runtime_error("ROLLBACK_FAILED");}}
void importMountedSave(const fs::path& home,const Json& task,const fs::path& archive,const fs::path& rollback){requireClosedTitle(task,"SAVE_IMPORT_FAILED");const auto paths=savePaths(home,task);if(!fs::is_regular_file(paths.image))throw std::runtime_error("SAVE_SOURCE_UNAVAILABLE");const auto source=backupFile(paths.image,"rollback");fs::create_directories(rollback.parent_path());if(fs::space(rollback.parent_path()).available<source.size+64*1024*1024)throw std::runtime_error("INSUFFICIENT_SPACE");durableCopy(paths.image,rollback);if(fs::last_write_time(paths.image)!=source.modified||fs::file_size(paths.image)!=source.size||fileHash(paths.image)!=fileHash(rollback)){fs::remove(rollback);throw std::runtime_error("ROLLBACK_FAILED");}const auto mount=fs::path("/data/ps5library/save-mounts")/task["id"].string();MountedSave mounted(paths.image,paths.key,paths.keyOffset,mount);try{applyPortableSaveArchive(archive,mount,paths.metadata);}catch(...){if(!mounted.close())throw std::runtime_error("ROLLBACK_FAILED");restoreRollback(rollback,paths.image);fs::remove(rollback);throw;}if(!mounted.close())throw std::runtime_error("ROLLBACK_FAILED");fs::remove(rollback);}
}
#endif
bool portableSaveAvailable(){
#ifdef PS5
  try{SavePrivileges privileges;const auto manager=open("/dev/pfsmgr",O_RDWR);if(manager<0)return false;::close(manager);const auto& api=saveFs();return api.initMount&&api.mount&&api.initUmount&&api.umount&&privileges.close();}catch(...){return false;}
#else
  return false;
#endif
}
bool saveTaskMatchesUser(const Json& task,const std::string& localUserId){return !localUserId.empty()&&task["localUserId"].string()==localUserId;}

namespace {
bool readDatabase(const fs::path& file,const char* platform,std::vector<Save>& saves){
  struct stat info{};if(lstat(file.c_str(),&info)){return errno==ENOENT;}
  if(!S_ISREG(info.st_mode)||info.st_size<=0||info.st_size>256*1024*1024)return false;
  sqlite3* raw=nullptr;if(sqlite3_open_v2(file.c_str(),&raw,SQLITE_OPEN_READONLY|SQLITE_OPEN_NOMUTEX,nullptr)!=SQLITE_OK){if(raw)sqlite3_close(raw);return false;}
  struct Database{sqlite3* value;~Database(){sqlite3_close(value);}} database{raw};
  sqlite3_busy_timeout(raw,50);sqlite3_exec(raw,"PRAGMA query_only=ON",nullptr,nullptr,nullptr);
  sqlite3_stmt* rawStatement=nullptr;
  const char* query="SELECT title_id,game_title_id,dir_name,main_title,sub_title,detail,size_kib,CAST(strftime('%s',mtime) AS INTEGER) FROM savedata LIMIT 4097";
  if(sqlite3_prepare_v2(raw,query,-1,&rawStatement,nullptr)!=SQLITE_OK)return false;
  struct Statement{sqlite3_stmt* value;~Statement(){sqlite3_finalize(value);}} statement{rawStatement};
  size_t rows=0;int result=SQLITE_ROW;
  while((result=sqlite3_step(rawStatement))==SQLITE_ROW){
    if(++rows>4096)return false;
    Save save;save.platform=platform;
    if(!text(rawStatement,0,9,save.saveTitleId)||!text(rawStatement,1,9,save.gameTitleId)||!text(rawStatement,2,128,save.directory)||
       !text(rawStatement,3,200,save.title)||!text(rawStatement,4,200,save.subtitle)||!text(rawStatement,5,1000,save.detail)||
       !titleId(save.saveTitleId)||!titleId(save.gameTitleId)||!directory(save.directory))continue;
    const auto kib=sqlite3_column_int64(rawStatement,6);if(kib<0||kib>INT64_MAX/1024)continue;
    save.sizeBytes=kib*1024;save.modifiedAt=std::max<int64_t>(0,sqlite3_column_int64(rawStatement,7));saves.push_back(std::move(save));
  }
  return result==SQLITE_DONE;
}
}

Json buildSaveBackup(const fs::path& userHome,const Json& task,const fs::path& output){
  const auto localUser=task["localUserId"].string(),platform=task["platform"].string(),game=task["gameTitleId"].string(),title=task["saveTitleId"].string(),slot=task["directory"].string();
  if(!std::regex_match(localUser,std::regex("[a-f0-9]{8}"))||(platform!="PS4"&&platform!="PS5")||!titleId(game)||!titleId(title)||!directory(slot))throw std::runtime_error("METADATA_MISMATCH");
  const auto root=userHome/localUser;std::vector<BackupFile> files;
  if(platform=="PS4"){
    const auto save=root/"savedata"/title;files.push_back(backupFile(save/("sdimg_"+slot),"encrypted/save-image"));auto key=backupFile(save/(slot+".bin"),"encrypted/sealed-key");if(key.size!=96)throw std::runtime_error("SAVE_SOURCE_UNAVAILABLE");files.push_back(key);
  }else{
    const auto save=root/"savedata_prospero"/title;auto image=save/("sdimg_"+slot);if(!fs::is_regular_file(image))image=save/slot;auto saved=backupFile(image,"encrypted/save-image");if(saved.size<0x860)throw std::runtime_error("SAVE_SOURCE_UNAVAILABLE");files.push_back(saved);
    const auto metadata=root/"savedata_prospero_meta/user"/title;auto sfo=metadata/(slot+".sfo");if(!fs::is_regular_file(sfo))sfo=metadata/("sce_bu_"+slot+".sfo");files.push_back(backupFile(sfo,"metadata/save.sfo"));auto icon=metadata/(slot+"_icon0.png");if(fs::is_regular_file(icon))files.push_back(backupFile(icon,"metadata/icon0.png"));
  }
  constexpr uint64_t maxArchive=9007199254740991ULL;uint64_t required=12;for(const auto& file:files){const auto overhead=10+file.name.size();if(file.name.size()>UINT16_MAX||file.size>maxArchive||required>maxArchive-overhead||file.size>maxArchive-required-overhead)throw std::runtime_error("SAVE_BACKUP_FAILED");required+=overhead+file.size;}
  fs::create_directories(output.parent_path());if(fs::space(output.parent_path()).available<required+64*1024*1024)throw std::runtime_error("INSUFFICIENT_SPACE");const auto temporary=fs::path(output.string()+".tmp");fs::remove(temporary);
  try{
    std::ofstream stream(temporary,std::ios::binary|std::ios::trunc);if(!stream)throw std::runtime_error("SAVE_BACKUP_FAILED");stream.write("PS5LSV01",8);be32(stream,static_cast<uint32_t>(files.size()));auto listed=Json::array();
    for(const auto& file:files){be16(stream,static_cast<uint16_t>(file.name.size()));stream.write(file.name.data(),file.name.size());be64(stream,file.size);const auto hash=copyDigest(file,stream);listed.add(Json::object({{"path",file.name},{"size",static_cast<int64_t>(file.size)},{"sha256",hash}}));}
    stream.flush();if(!stream)throw std::runtime_error("SAVE_BACKUP_FAILED");stream.close();if(fs::file_size(temporary)!=required)throw std::runtime_error("SAVE_BACKUP_FAILED");fs::remove(output);fs::rename(temporary,output);
    auto description=Json::object({{"format","RAW_CONSOLE_V1"},{"localUserId",localUser},{"platform",platform},{"gameTitleId",game},{"saveTitleId",title},{"directory",slot},{"files",listed}});
    return Json::object({{"totalBytes",static_cast<int64_t>(required)},{"sha256",fileHash(output)},{"manifest",description}});
  }catch(...){fs::remove(temporary);throw;}
}

Json readSaveData(const fs::path& ps4Database,const fs::path& ps5Database,const std::string& localUserId){
  if(!std::regex_match(localUserId,std::regex("[a-f0-9]{8}")))return Json();
  std::vector<Save> saves;bool complete=readDatabase(ps4Database,"PS4",saves);if(!readDatabase(ps5Database,"PS5",saves))complete=false;
  std::sort(saves.begin(),saves.end(),[](const Save& a,const Save& b){return a.modifiedAt!=b.modifiedAt?a.modifiedAt>b.modifiedAt:std::tie(a.gameTitleId,a.saveTitleId,a.directory)<std::tie(b.gameTitleId,b.saveTitleId,b.directory);});
  auto items=Json::array();for(const auto& save:saves)items.add(Json::object({{"platform",save.platform},{"gameTitleId",save.gameTitleId},{"saveTitleId",save.saveTitleId},{"directory",save.directory},{"title",save.title},{"subtitle",save.subtitle},{"detail",save.detail},{"sizeBytes",save.sizeBytes},{"modifiedAt",save.modifiedAt}}));
  return Json::object({{"source","LOCAL_SAVE_DATABASES"},{"localUserId",localUserId},{"complete",complete},{"items",items}});
}

Json Agent::saves(){
  const auto user=localUserId();if(user.empty())return Json();
#ifdef PS5
  return readSaveData("/system_data/savedata/"+user+"/db/user/savedata.db","/system_data/savedata_prospero/"+user+"/db/user/savedata.db",user);
#else
  return Json();
#endif
}

void Agent::saveBackups(){
#ifdef PS5
  const auto task=client.request("GET","/api/v1/device/save-backups");if(task.null())return;
  const auto id=task["id"].string(),state=task["state"].string();if(!std::regex_match(id,std::regex("[a-f0-9-]{36}")))throw std::runtime_error("Invalid save-backup task");
  if(!saveTaskMatchesUser(task,localUserId())){client.request("POST","/api/v1/device/save-backups/"+id+"/error",Json::object({{"error","SAVE_SOURCE_UNAVAILABLE"}}));return;}
  const auto output=fs::path("/data/ps5library/save-backups")/(id+".ps5save");
  if(state=="VERIFYING"){client.request("POST","/api/v1/device/save-backups/"+id+"/complete",Json::object());fs::remove(output);return;}
  Json built;
  try{
    if(state=="UPLOADING"&&fs::is_regular_file(output)&&static_cast<int64_t>(fs::file_size(output))==task["totalBytes"].number()&&fileHash(output,client.cancelled)==task["sha256"].string())built=Json::object({{"totalBytes",task["totalBytes"]},{"sha256",task["sha256"]},{"manifest",task["manifest"]}});
    else {built=buildSaveBackup("/user/home",task,output);if(state=="UPLOADING"&&(built["totalBytes"].number()!=task["totalBytes"].number()||built["sha256"].string()!=task["sha256"].string()))throw std::runtime_error("SAVE_SOURCE_CHANGED");}
  }catch(const std::exception& error){
    auto code=std::string(error.what());if(code!="SAVE_SOURCE_CHANGED"&&code!="INSUFFICIENT_SPACE"&&code!="SAVE_BACKUP_FAILED")code="SAVE_SOURCE_UNAVAILABLE";
    try{client.request("POST","/api/v1/device/save-backups/"+id+"/error",Json::object({{"error",code}}));}catch(...){ }fs::remove(output);return;
  }
  Json resumed;
  try{resumed=client.request("POST","/api/v1/device/save-backups/"+id+"/start",built);}
  catch(const RequestError& error){if(error.status==409&&std::string(error.what())=="METADATA_MISMATCH"){client.request("POST","/api/v1/device/save-backups/"+id+"/error",Json::object({{"error","SAVE_SOURCE_CHANGED"}}));fs::remove(output);return;}throw;}
  auto offset=resumed["uploadedBytes"].number();const auto total=built["totalBytes"].number();if(offset<0||offset>total)throw std::runtime_error("Invalid save-backup offset");
  std::ifstream input(output,std::ios::binary);input.seekg(offset);std::vector<unsigned char> buffer(768*1024);auto lastHeartbeat=std::chrono::steady_clock::now();
  while(offset<total){if(client.cancelled&&client.cancelled())return;const auto wanted=static_cast<std::streamsize>(std::min<int64_t>(buffer.size(),total-offset));input.read(reinterpret_cast<char*>(buffer.data()),wanted);const auto count=input.gcount();if(count<=0)throw std::runtime_error("Local save backup is incomplete");
    std::string encoded(4*((static_cast<size_t>(count)+2)/3)+1,'\0');const auto length=EVP_EncodeBlock(reinterpret_cast<unsigned char*>(encoded.data()),buffer.data(),static_cast<int>(count));encoded.resize(length);
    const auto progress=client.request("POST","/api/v1/device/save-backups/"+id+"/chunks",Json::object({{"offset",offset},{"data",encoded}}));const auto next=progress["uploadedBytes"].number();if(next!=offset+count)throw std::runtime_error("Invalid save-backup progress");offset=next;
    if(std::chrono::steady_clock::now()-lastHeartbeat>std::chrono::seconds(10)){client.request("POST","/api/v1/device/heartbeat",heartbeatBody_);lastHeartbeat=std::chrono::steady_clock::now();}
  }
  client.request("POST","/api/v1/device/save-backups/"+id+"/complete",Json::object());fs::remove(output);if(notifications())notify("Save backup completed");
#endif
}

void Agent::saveExports(){
#ifdef PS5
  const auto task=client.request("GET","/api/v1/device/save-exports");if(task.null())return;const auto id=task["id"].string(),state=task["state"].string();if(!std::regex_match(id,std::regex("[a-f0-9-]{36}")))throw std::runtime_error("Invalid save-export task");const auto output=fs::path("/data/ps5library/save-exports")/(id+".ps5save");
  if(!saveTaskMatchesUser(task,localUserId())){client.request("POST","/api/v1/device/save-exports/"+id+"/error",Json::object({{"error","SAVE_SOURCE_UNAVAILABLE"}}));return;}
  if(state=="VERIFYING"){client.request("POST","/api/v1/device/save-exports/"+id+"/complete",Json::object());fs::remove(output);return;}Json built;
  try{if(state=="UPLOADING"&&fs::is_regular_file(output)&&static_cast<int64_t>(fs::file_size(output))==task["totalBytes"].number()&&fileHash(output,client.cancelled)==task["sha256"].string())built=Json::object({{"totalBytes",task["totalBytes"]},{"sha256",task["sha256"]},{"manifest",task["manifest"]}});else{built=exportMountedSave("/user/home",task,output);if(state=="UPLOADING"&&(built["totalBytes"].number()!=task["totalBytes"].number()||built["sha256"].string()!=task["sha256"].string()))throw std::runtime_error("SAVE_SOURCE_CHANGED");}}
  catch(const std::exception& error){std::fprintf(stderr,"Save export %s: %s\n",id.c_str(),error.what());auto code=std::string(error.what());if(code!="SAVE_SOURCE_CHANGED"&&code!="INSUFFICIENT_SPACE"&&code!="SAVE_EXPORT_FAILED"&&code!="CAPABILITY_UNAVAILABLE")code="SAVE_SOURCE_UNAVAILABLE";try{client.request("POST","/api/v1/device/save-exports/"+id+"/error",Json::object({{"error",code}}));}catch(...){ }fs::remove(output);return;}
  Json resumed;try{resumed=client.request("POST","/api/v1/device/save-exports/"+id+"/start",built);}catch(const RequestError& error){if(error.status==409&&std::string(error.what())=="METADATA_MISMATCH"){client.request("POST","/api/v1/device/save-exports/"+id+"/error",Json::object({{"error","SAVE_SOURCE_CHANGED"}}));fs::remove(output);return;}throw;}auto offset=resumed["uploadedBytes"].number();const auto total=built["totalBytes"].number();if(offset<0||offset>total)throw std::runtime_error("Invalid save-export offset");std::ifstream input(output,std::ios::binary);input.seekg(offset);std::vector<unsigned char> buffer(768*1024);auto lastHeartbeat=std::chrono::steady_clock::now();
  while(offset<total){if(client.cancelled&&client.cancelled())return;const auto wanted=static_cast<std::streamsize>(std::min<int64_t>(buffer.size(),total-offset));input.read(reinterpret_cast<char*>(buffer.data()),wanted);const auto count=input.gcount();if(count<=0)throw std::runtime_error("Local portable save is incomplete");std::string encoded(4*((static_cast<size_t>(count)+2)/3)+1,'\0');const auto length=EVP_EncodeBlock(reinterpret_cast<unsigned char*>(encoded.data()),buffer.data(),static_cast<int>(count));encoded.resize(length);const auto progress=client.request("POST","/api/v1/device/save-exports/"+id+"/chunks",Json::object({{"offset",offset},{"data",encoded}}));const auto next=progress["uploadedBytes"].number();if(next!=offset+count)throw std::runtime_error("Invalid save-export progress");offset=next;if(std::chrono::steady_clock::now()-lastHeartbeat>std::chrono::seconds(10)){client.request("POST","/api/v1/device/heartbeat",heartbeatBody_);lastHeartbeat=std::chrono::steady_clock::now();}}
  client.request("POST","/api/v1/device/save-exports/"+id+"/complete",Json::object());fs::remove(output);if(notifications())notify("Portable save ready to publish");
#endif
}

void Agent::saveImports(){
#ifdef PS5
  const auto task=client.request("GET","/api/v1/device/save-imports");if(task.null())return;const auto id=task["id"].string();if(!std::regex_match(id,std::regex("[a-f0-9-]{36}")))throw std::runtime_error("Invalid save-import task");const auto root=fs::path("/data/ps5library/save-imports"),archive=root/(id+".ps5save"),rollback=root/(id+".rollback");
  if(!saveTaskMatchesUser(task,localUserId())){client.request("POST","/api/v1/device/save-imports/"+id+"/error",Json::object({{"error","SAVE_IMPORT_FAILED"}}));return;}
  try{client.download(task["archiveUrl"].string(),archive,task["totalBytes"].number(),task["sha256"].string(),[&](int64_t bytes,int64_t speed){client.request("POST","/api/v1/device/save-imports/"+id+"/progress",Json::object({{"downloadedBytes",bytes},{"speedBytesPerSecond",speed}}));});}
  catch(const std::exception& error){if(std::string(error.what())!="CORRUPT_INPUT")return;try{client.request("POST","/api/v1/device/save-imports/"+id+"/error",Json::object({{"error","CORRUPT_INPUT"}}));}catch(...){ }fs::remove(archive);return;}
  try{client.request("POST","/api/v1/device/save-imports/"+id+"/start",Json::object());importMountedSave("/user/home",task,archive,rollback);client.request("POST","/api/v1/device/save-imports/"+id+"/complete",Json::object());invalidateSnapshot();fs::remove(archive);if(notifications())notify("Community save imported");}
  catch(const std::exception& error){std::fprintf(stderr,"Save import %s: %s\n",id.c_str(),error.what());auto code=std::string(error.what());if(code!="INSUFFICIENT_SPACE"&&code!="ROLLBACK_FAILED"&&code!="CORRUPT_INPUT"&&code!="CAPABILITY_UNAVAILABLE")code="SAVE_IMPORT_FAILED";try{client.request("POST","/api/v1/device/save-imports/"+id+"/error",Json::object({{"error",code}}));}catch(...){ }if(code!="ROLLBACK_FAILED")fs::remove(rollback);fs::remove(archive);}
#endif
}
}
