#include "cheats.hpp"
#include "memory_scanner.hpp"
#include "../common/client.hpp"
#include <algorithm>
#include <array>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <cstring>
#include <fcntl.h>
#include <fstream>
#include <map>
#include <mutex>
#include <regex>
#include <set>
#include <stdexcept>
#include <sys/stat.h>
#include <unistd.h>
#include <openssl/evp.h>
#ifdef PS5
#include <ps5/kernel.h>
#include <sys/syscall.h>
#include <sys/sysctl.h>
#include <sys/user.h>
#endif

namespace ps5library {
namespace {
const std::regex titlePattern("(PPSA|CUSA)[0-9]{5}"),versionPattern("[0-9]{1,3}(\\.[0-9]{1,3}){1,2}"),processPattern("[A-Za-z0-9][A-Za-z0-9._-]{0,127}"),hashPattern("[a-f0-9]{64}"),uuidPattern("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}");

std::string digest(std::string_view bytes){
  unsigned char value[EVP_MAX_MD_SIZE]{};unsigned size=0;if(EVP_Digest(bytes.data(),bytes.size(),value,&size,EVP_sha256(),nullptr)!=1||size!=32)throw std::runtime_error("CHEAT_HASH_FAILED");
  static constexpr char hex[]="0123456789abcdef";std::string result(64,'0');for(unsigned i=0;i<size;i++){result[i*2]=hex[value[i]>>4];result[i*2+1]=hex[value[i]&15];}return result;
}
std::string safeRead(const fs::path& file,std::uintmax_t limit=maxCheatProfileBytes){
  struct stat before{};if(lstat(file.c_str(),&before)!=0||!S_ISREG(before.st_mode)||S_ISLNK(before.st_mode)||before.st_nlink!=1||before.st_size<=0||static_cast<std::uintmax_t>(before.st_size)>limit)throw std::runtime_error("INVALID_CHEAT_FILE");
  int descriptor=open(file.c_str(),O_RDONLY|O_NOFOLLOW);if(descriptor<0)throw std::runtime_error("INVALID_CHEAT_FILE");struct File{int value;~File(){close(value);}} guard{descriptor};struct stat opened{};if(fstat(descriptor,&opened)!=0||opened.st_dev!=before.st_dev||opened.st_ino!=before.st_ino||opened.st_size!=before.st_size)throw std::runtime_error("CHEAT_FILE_CHANGED");
  std::string result(static_cast<std::size_t>(opened.st_size),'\0');std::size_t offset=0;while(offset<result.size()){auto count=read(descriptor,result.data()+offset,result.size()-offset);if(count<0&&errno==EINTR)continue;if(count<=0)throw std::runtime_error("CHEAT_FILE_CHANGED");offset+=static_cast<std::size_t>(count);}struct stat after{};if(fstat(descriptor,&after)!=0||after.st_size!=opened.st_size||after.st_mtime!=opened.st_mtime||after.st_ctime!=opened.st_ctime)throw std::runtime_error("CHEAT_FILE_CHANGED");return result;
}
std::vector<unsigned char> unhex(const std::string& value){
  if(value.empty()||value.size()>8192||value.size()%2||value.find_first_not_of("0123456789abcdefABCDEF")!=std::string::npos)throw std::runtime_error("INVALID_CHEAT_PROFILE");std::vector<unsigned char> result(value.size()/2);
  for(std::size_t i=0;i<result.size();i++){unsigned byte=0;auto parsed=std::from_chars(value.data()+i*2,value.data()+i*2+2,byte,16);if(parsed.ec!=std::errc())throw std::runtime_error("INVALID_CHEAT_PROFILE");result[i]=static_cast<unsigned char>(byte);}return result;
}
std::uint64_t offset(const std::string& value){
  if(value.empty()||value.size()>16||value.find_first_not_of("0123456789abcdefABCDEF")!=std::string::npos)throw std::runtime_error("INVALID_CHEAT_PROFILE");std::uint64_t result=0;auto parsed=std::from_chars(value.data(),value.data()+value.size(),result,16);if(parsed.ec!=std::errc()||parsed.ptr!=value.data()+value.size())throw std::runtime_error("INVALID_CHEAT_PROFILE");return result;
}
bool exact(const CheatTarget& target,const CheatProfile& profile){return target.titleId==profile.titleId&&target.version==profile.version&&target.process==profile.process&&(!profile.contentId.size()||profile.contentId==target.contentId)&&(!profile.targetExecutableSha256.size()||profile.targetExecutableSha256==target.executableSha256);}
bool same(const CheatTarget& left,const CheatTarget& right){if(left.token!=right.token||left.pid!=right.pid||left.startedSeconds!=right.startedSeconds||left.startedMicroseconds!=right.startedMicroseconds||left.moduleBase!=right.moduleBase||left.moduleSize!=right.moduleSize||left.titleId!=right.titleId||left.version!=right.version||left.process!=right.process||left.contentId!=right.contentId||left.executableSha256!=right.executableSha256||left.ranges.size()!=right.ranges.size())return false;for(std::size_t i=0;i<left.ranges.size();i++){const auto& a=left.ranges[i];const auto& b=right.ranges[i];if(a.offset!=b.offset||a.size!=b.size||a.readable!=b.readable||a.writable!=b.writable)return false;}return true;}
bool inModule(const CheatTarget& target,std::uint64_t offset,std::size_t size){return target.moduleBase&&target.moduleSize&&size&&offset<=target.moduleSize&&size<=target.moduleSize-offset&&target.moduleBase<=UINT64_MAX-offset&&target.moduleBase+offset<=UINT64_MAX-size;}
[[maybe_unused]] bool inMappedRange(const CheatTarget& target,std::uint64_t offset,std::size_t size,bool write){for(const auto& range:target.ranges)if((write?range.writable:range.readable)&&offset>=range.offset&&offset-range.offset<=range.size&&size<=range.size-(offset-range.offset))return true;return false;}
std::mutex runtimeMutex;
std::int64_t changedAt(){return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();}
std::string decode64(const std::string& value){
  if(value.empty()||value.size()>4*((maxCheatProfileBytes+2)/3)||value.size()%4||value.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=")!=std::string::npos)throw std::runtime_error("INVALID_CHEAT_DELIVERY");
  std::string output(value.size()/4*3,'\0');auto count=EVP_DecodeBlock(reinterpret_cast<unsigned char*>(output.data()),reinterpret_cast<const unsigned char*>(value.data()),static_cast<int>(value.size()));if(count<0)throw std::runtime_error("INVALID_CHEAT_DELIVERY");if(value.back()=='=')count--;if(value.size()>1&&value[value.size()-2]=='=')count--;if(count<=0||static_cast<std::size_t>(count)>maxCheatProfileBytes)throw std::runtime_error("INVALID_CHEAT_DELIVERY");output.resize(static_cast<std::size_t>(count));std::string encoded(4*((output.size()+2)/3),'\0');auto encodedSize=EVP_EncodeBlock(reinterpret_cast<unsigned char*>(encoded.data()),reinterpret_cast<const unsigned char*>(output.data()),static_cast<int>(output.size()));encoded.resize(static_cast<std::size_t>(encodedSize));if(encoded!=value)throw std::runtime_error("INVALID_CHEAT_DELIVERY");return output;
}
std::string errorCode(const std::exception& error){auto value=std::string(error.what());if(value.empty()||value.size()>120||value.find_first_not_of("ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_")!=std::string::npos)return "CHEAT_OPERATION_FAILED";return value;}
bool inventoryMatch(const CheatProfile& profile,const Json& inventory){for(std::size_t i=0;i<inventory.size();i++){auto item=inventory[i];if(item["available"].boolean()&&item["titleId"].string()==profile.titleId&&item["version"].string()==profile.version&&(!profile.contentId.size()||item["contentId"].string()==profile.contentId))return true;}return false;}
}

std::string cheatEntryId(const std::string& profileId,const std::string& name){return digest(profileId+"\n"+name);}

CheatProfile parseCheatProfile(const fs::path& file,const Json& receipt){
  const auto bytes=safeRead(file),fileName=file.filename().string();std::smatch match;const std::regex filename("^((PPSA|CUSA)[0-9]{5})_([0-9]{1,3}(\\.[0-9]{1,3}){1,2})(_([A-Za-z0-9][A-Za-z0-9._-]{0,127}))?\\.(json|mc4|shn)$");
  if(!std::regex_match(fileName,match,filename))throw std::runtime_error("INVALID_CHEAT_FILENAME");CheatProfile profile;profile.id=digest(bytes);profile.fileName=fileName;profile.titleId=match[1];profile.version=match[3];profile.process=match[6];auto extension=match[7].str();std::transform(extension.begin(),extension.end(),extension.begin(),[](unsigned char c){return static_cast<char>(std::toupper(c));});profile.format=extension;
  if(profile.format!="JSON"){profile.validation="UNSUPPORTED_FORMAT";return profile;}
  Json root;try{root=Json::parse(bytes);}catch(...){throw std::runtime_error("INVALID_CHEAT_PROFILE");}if(!root.isObject()||root["id"].string()!=profile.titleId||root["version"].string()!=profile.version||!std::regex_match(root["process"].string(),processPattern)||(!profile.process.empty()&&profile.process!=root["process"].string())||!root["name"].isString()||root["name"].string().empty()||root["name"].string().size()>200||!root["mods"].isArray()||!root["mods"].size()||root["mods"].size()>128)throw std::runtime_error("CHEAT_METADATA_MISMATCH");profile.process=root["process"].string();
  std::set<std::string> names;std::size_t total=0;for(std::size_t i=0;i<root["mods"].size();i++){
    auto mod=root["mods"][i];const auto name=mod["name"].string();if(!mod.isObject()||name.empty()||name.size()>120||!names.insert(name).second||mod["type"].string()!="checkbox"||!mod["memory"].isArray()||!mod["memory"].size()||mod["memory"].size()>64)throw std::runtime_error("INVALID_CHEAT_PROFILE");CheatEntry entry;entry.name=name;entry.description=mod["description"].string(mod["hint"].string());if(entry.description.size()>500)throw std::runtime_error("INVALID_CHEAT_PROFILE");entry.id=cheatEntryId(profile.id,name);std::vector<std::pair<std::uint64_t,std::uint64_t>> ranges;
    for(std::size_t n=0;n<mod["memory"].size();n++){auto value=mod["memory"][n];if(!value.isObject()||!value["absolute"].null()||(!value["section"].null()&&!((value["section"].isInteger()&&value["section"].number()==0)||(value["section"].isString()&&value["section"].string()=="0"))))throw std::runtime_error("UNSUPPORTED_CHEAT_PATCH");CheatPatch patch;patch.offset=offset(value["offset"].string());patch.enabled=unhex(value["on"].string());patch.expected=unhex(value["off"].string());if(patch.enabled.size()!=patch.expected.size()||patch.enabled.empty()||patch.offset>0x7fffffffffffffffULL-patch.enabled.size())throw std::runtime_error("INVALID_CHEAT_PROFILE");auto end=patch.offset+patch.enabled.size();for(const auto& range:ranges)if(patch.offset<range.second&&end>range.first)throw std::runtime_error("OVERLAPPING_CHEAT_PATCH");ranges.push_back({patch.offset,end});total+=patch.enabled.size();if(total>maxCheatPatchedBytes)throw std::runtime_error("CHEAT_PATCH_LIMIT");entry.patches.push_back(std::move(patch));}
    profile.entries.push_back(std::move(entry));
  }
  if(receipt.isObject()){
    if(receipt["schemaVersion"].number()!=1||receipt["source"].string()!="SERVER"||!receipt["approved"].boolean()||receipt["profileSha256"].string()!=profile.id||receipt["fileName"].string()!=profile.fileName||receipt["titleId"].string()!=profile.titleId||receipt["gameVersion"].string()!=profile.version||receipt["process"].string()!=profile.process||receipt["format"].string()!=profile.format)throw std::runtime_error("CHEAT_RECEIPT_MISMATCH");
    profile.contentId=receipt["contentId"].string();profile.targetExecutableSha256=receipt["targetExecutableSha256"].string();if((!profile.contentId.empty()&&(profile.contentId.size()<16||profile.contentId.substr(7,9)!=profile.titleId))||!std::regex_match(profile.targetExecutableSha256,hashPattern))throw std::runtime_error("CHEAT_RECEIPT_MISMATCH");profile.serverApproved=true;
  }
  return profile;
}

struct CheatEngine::Active {
  struct Applied {std::uint64_t offset;std::vector<unsigned char> enabled,original;};
  std::string profileId,entryId,name;CheatTarget target;std::vector<Applied> patches;
};
CheatEngine::CheatEngine(CheatRuntime& runtime,fs::path journalRoot):runtime_(runtime),journalRoot_(std::move(journalRoot)){fs::create_directories(journalRoot_);}
CheatEngine::~CheatEngine(){stop();}
void CheatEngine::journal(const Active& active,const std::string& state,const std::string& error)const{auto value=Json::object({{"schemaVersion",1},{"profileId",active.profileId},{"entryId",active.entryId},{"name",active.name},{"titleId",active.target.titleId},{"version",active.target.version},{"process",active.target.process},{"targetExecutableSha256",active.target.executableSha256},{"state",state},{"changedAtUnixMs",changedAt()}});if(!error.empty())value.set("error",error);atomicJson(journalRoot_/(active.profileId+"-"+active.entryId+".json"),value);}
bool CheatEngine::enabled(const std::string& profileId,const std::string& entryId)const{return std::any_of(active_.begin(),active_.end(),[&](const auto& item){return item->profileId==profileId&&item->entryId==entryId;});}
Json CheatEngine::enable(const CheatProfile& profile,const std::string& entryId){
  std::lock_guard lock(runtimeMutex);if(profile.validation!="VALID"||(!profile.serverApproved&&!profile.localApproved)||profile.process.empty())throw std::runtime_error("LOCAL_APPROVAL_REQUIRED");if(!runtime_.canPatch())throw std::runtime_error("CHEAT_RUNTIME_UNVERIFIED");if(enabled(profile.id,entryId))return Json::object({{"profileId",profile.id},{"entryId",entryId},{"enabled",true},{"state","ENABLED"},{"changedAtUnixMs",changedAt()}});auto found=std::find_if(profile.entries.begin(),profile.entries.end(),[&](const auto& entry){return entry.id==entryId;});if(found==profile.entries.end())throw std::runtime_error("CHEAT_ENTRY_NOT_FOUND");auto running=runtime_.running(profile.process);if(!running||!exact(*running,profile))throw std::runtime_error("CHEAT_TARGET_MISMATCH");
  auto active=std::make_unique<Active>();active->profileId=profile.id;active->entryId=found->id;active->name=found->name;active->target=*running;for(const auto& patch:found->patches){if(!inModule(*running,patch.offset,patch.expected.size()))throw std::runtime_error("CHEAT_PATCH_OUT_OF_BOUNDS");for(const auto& other:active_)if(same(other->target,*running))for(const auto& applied:other->patches)if(patch.offset<applied.offset+applied.enabled.size()&&patch.offset+patch.enabled.size()>applied.offset)throw std::runtime_error("CHEAT_PATCH_CONFLICT");auto current=runtime_.read(*running,patch.offset,patch.expected.size());if(current!=patch.expected)throw std::runtime_error("CHEAT_PREIMAGE_MISMATCH");active->patches.push_back({patch.offset,patch.enabled,std::move(current)});}
  auto unchanged=[&]{auto current=runtime_.running(profile.process);return current&&same(*current,*running);};std::size_t applied=0;try{while(applied<active->patches.size()){if(!unchanged())throw std::runtime_error("CHEAT_TARGET_CHANGED");auto& patch=active->patches[applied];runtime_.write(*running,patch.offset,patch.enabled);applied++;if(!unchanged()||runtime_.read(*running,patch.offset,patch.enabled.size())!=patch.enabled)throw std::runtime_error("CHEAT_WRITE_VERIFY_FAILED");}}catch(const std::exception& error){bool restored=true;while(applied){auto& patch=active->patches[--applied];try{if(!unchanged()){restored=false;break;}runtime_.write(*running,patch.offset,patch.original);restored=runtime_.read(*running,patch.offset,patch.original.size())==patch.original&&restored;}catch(...){restored=false;}}journal(*active,restored?"FAILED":"ROLLBACK_FAILED",restored?errorCode(error):"CHEAT_ROLLBACK_FAILED");if(!restored)throw std::runtime_error("CHEAT_ROLLBACK_FAILED");throw;}auto profileResult=active->profileId,entryResult=active->entryId;journal(*active,"ENABLED");active_.push_back(std::move(active));return Json::object({{"profileId",profileResult},{"entryId",entryResult},{"enabled",true},{"state","ENABLED"},{"changedAtUnixMs",changedAt()}});
}
Json CheatEngine::disable(const std::string& profileId,const std::string& entryId){
  std::lock_guard lock(runtimeMutex);auto found=std::find_if(active_.begin(),active_.end(),[&](const auto& item){return item->profileId==profileId&&item->entryId==entryId;});if(found==active_.end())return Json::object({{"profileId",profileId},{"entryId",entryId},{"enabled",false},{"state","DISABLED"},{"changedAtUnixMs",changedAt()}});auto& active=**found;auto running=runtime_.running(active.target.process);if(!running||!same(*running,active.target)){journal(active,"PROCESS_EXITED");active_.erase(found);return Json::object({{"profileId",profileId},{"entryId",entryId},{"enabled",false},{"state","PROCESS_EXITED"},{"changedAtUnixMs",changedAt()}});}auto unchanged=[&]{auto current=runtime_.running(active.target.process);return current&&same(*current,*running);};for(const auto& patch:active.patches)if(!unchanged()||runtime_.read(*running,patch.offset,patch.enabled.size())!=patch.enabled)throw std::runtime_error("CHEAT_PATCH_CHANGED");std::size_t restored=0;try{while(restored<active.patches.size()){auto index=active.patches.size()-1-restored;auto& patch=active.patches[index];if(!unchanged())throw std::runtime_error("CHEAT_TARGET_CHANGED");runtime_.write(*running,patch.offset,patch.original);restored++;if(!unchanged()||runtime_.read(*running,patch.offset,patch.original.size())!=patch.original)throw std::runtime_error("CHEAT_RESTORE_FAILED");}}catch(...){bool rolledBack=true;while(restored){auto index=active.patches.size()-restored--;auto& patch=active.patches[index];try{if(!unchanged()){rolledBack=false;break;}runtime_.write(*running,patch.offset,patch.enabled);rolledBack=runtime_.read(*running,patch.offset,patch.enabled.size())==patch.enabled&&rolledBack;}catch(...){rolledBack=false;}}journal(active,rolledBack?"ENABLED":"ROLLBACK_FAILED",rolledBack?"CHEAT_RESTORE_FAILED":"CHEAT_ROLLBACK_FAILED");throw std::runtime_error(rolledBack?"CHEAT_RESTORE_FAILED":"CHEAT_ROLLBACK_FAILED");}journal(active,"DISABLED");active_.erase(found);return Json::object({{"profileId",profileId},{"entryId",entryId},{"enabled",false},{"state","DISABLED"},{"changedAtUnixMs",changedAt()}});
}
void CheatEngine::disableProfile(const std::string& profileId){for(std::size_t i=active_.size();i>0;i--)if(active_[i-1]->profileId==profileId)disable(profileId,active_[i-1]->entryId);}
void CheatEngine::reconcile(){std::lock_guard lock(runtimeMutex);for(std::size_t i=active_.size();i>0;i--){std::optional<CheatTarget> running;try{running=runtime_.running(active_[i-1]->target.process);}catch(...){continue;}if(!running||!same(*running,active_[i-1]->target)){journal(*active_[i-1],"PROCESS_EXITED");active_.erase(active_.begin()+static_cast<std::ptrdiff_t>(i-1));}}}
void CheatEngine::stop()noexcept{for(std::size_t i=active_.size();i>0;i--){auto profile=active_[i-1]->profileId,entry=active_[i-1]->entryId;try{disable(profile,entry);}catch(const std::exception& error){try{journal(*active_[i-1],"RESTORE_FAILED",errorCode(error));}catch(...){ }active_.erase(active_.begin()+static_cast<std::ptrdiff_t>(i-1));}}}

#ifdef PS5
namespace {
#ifndef SYS_dl_get_list
#define SYS_dl_get_list 0x217
#endif
#ifndef SYS_dl_get_info_2
#define SYS_dl_get_info_2 0x2cd
#endif
#ifndef SYS_mdbg_call
#define SYS_mdbg_call 573
#endif
constexpr std::uint64_t ps5PageSize=0x4000;
constexpr std::size_t maxCheatTransferBytes=4096;
constexpr std::size_t maxMemoryScanTransferBytes=256*1024;
constexpr std::uint64_t coredumpAuthId=0x4800000000000006ULL;
struct Ps5AppInfo {std::uint32_t appId;std::uint32_t padding;std::uint64_t unknown;char titleId[14];char reserved[0x3c];};
struct Ps5ModuleSection {std::uint64_t address,size;std::uint32_t protection;std::uint32_t padding;};
struct Ps5ModuleInfo {char filename[128];std::uint64_t handle;std::uint8_t unknown0[32];std::uint64_t init,fini,ehFrameHeader,ehFrameHeaderSize,ehFrame,ehFrameSize;Ps5ModuleSection sections[4];std::uint8_t unknown1[1176],fingerprint[20];std::uint32_t unknown2;char libraryName[128];std::uint32_t unknown3;char sandboxedPath[1024];std::uint64_t sdkVersion;};
struct Ps5MdbgCommand {std::uint64_t type,command;};
struct Ps5MdbgMemory {std::int32_t pid;std::uint32_t padding;std::uint64_t source,destination,length;};
struct Ps5MdbgResult {std::int32_t status;std::uint32_t padding;std::uint64_t length;};
struct Ps5MdbgStateRequest {std::int64_t pid,subcommand;std::uint64_t argument,reserved[5];};
struct Ps5MdbgStateResult {std::int64_t status;std::uint64_t flags,reserved[2];};
struct Ps5SystemSoftwareVersion {std::uint64_t size;char text[28];std::uint32_t version;std::uint64_t reserved;};
static_assert(sizeof(Ps5AppInfo)==0x60&&sizeof(Ps5ModuleInfo)==0xa78&&sizeof(Ps5MdbgCommand)==16&&sizeof(Ps5MdbgMemory)==32&&sizeof(Ps5MdbgResult)==16&&sizeof(Ps5MdbgStateRequest)==64&&sizeof(Ps5MdbgStateResult)==32);
extern "C" int sceSystemServiceGetAppIdOfRunningBigApp();
extern "C" int sceKernelGetAppInfo(int,Ps5AppInfo*);
extern "C" int sceKernelGetProcessName(int,char*);
extern "C" int sceKernelGetProsperoSystemSwVersion(Ps5SystemSoftwareVersion*);

std::uint32_t ps5SystemFirmware(){Ps5SystemSoftwareVersion system{};system.size=sizeof(system);const auto library=kernel_get_fw_version();if(sceKernelGetProsperoSystemSwVersion(&system)||registrationFirmware(system.version,library).empty())return 0;return system.version&0xffff0000u;}

std::vector<unsigned char> ps5ProcessTable(){
  int mib[4]={CTL_KERN,KERN_PROC,KERN_PROC_PROC,0};
  for(int attempt=0;attempt<3;attempt++){size_t size=0;if(sysctl(mib,4,nullptr,&size,nullptr,0)||!size||size>16*1024*1024)throw std::runtime_error("CHEAT_TARGET_DISCOVERY_FAILED");std::vector<unsigned char> bytes(size);if(!sysctl(mib,4,bytes.data(),&size,nullptr,0)){bytes.resize(size);return bytes;}if(errno!=ENOMEM)break;}
  throw std::runtime_error("CHEAT_TARGET_DISCOVERY_FAILED");
}
std::string fixedString(const char* value,std::size_t size){return std::string(value,strnlen(value,size));}
std::string basename(const std::string& value){auto slash=value.find_last_of('/');return slash==std::string::npos?value:value.substr(slash+1);}
std::uint64_t processToken(pid_t pid,const timeval& start){std::uint64_t value=1469598103934665603ULL;for(auto part:{static_cast<std::uint64_t>(static_cast<std::uint32_t>(pid)),static_cast<std::uint64_t>(start.tv_sec),static_cast<std::uint64_t>(start.tv_usec)}){for(unsigned i=0;i<8;i++){value^=static_cast<unsigned char>(part>>(i*8));value*=1099511628211ULL;}}return value;}
std::mutex credentialMutex;
class Ps5CredentialScope {
  pid_t pid_=getpid();std::array<unsigned char,16> caps_{};std::uint64_t authId_=0;bool armed_=false;
  bool restore()noexcept{const bool authSet=kernel_set_ucred_authid(pid_,authId_)==0,capsSet=kernel_set_ucred_caps(pid_,caps_.data())==0;std::array<unsigned char,16> observed{};const auto auth=kernel_get_ucred_authid(pid_);const bool capsRead=kernel_get_ucred_caps(pid_,observed.data())==0;armed_=false;return authSet&&capsSet&&capsRead&&observed==caps_&&auth==authId_;}
public:
  Ps5CredentialScope(){if(kernel_get_ucred_caps(pid_,caps_.data())||!(authId_=kernel_get_ucred_authid(pid_)))throw std::runtime_error("CHEAT_CREDENTIAL_UNAVAILABLE");armed_=true;if(kernel_set_ucred_authid(pid_,coredumpAuthId)){if(!restore())_exit(70);throw std::runtime_error("CHEAT_CREDENTIAL_UNAVAILABLE");}static constexpr std::array<unsigned char,16> privileged={0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff,0xff};if(kernel_set_ucred_caps(pid_,privileged.data())){if(!restore())_exit(70);throw std::runtime_error("CHEAT_CREDENTIAL_UNAVAILABLE");}}
  ~Ps5CredentialScope(){if(armed_&&!restore())_exit(70);}
};
void ps5MdbgTransfer(std::uint64_t operation,pid_t pid,std::uint64_t source,std::uint64_t destination,std::size_t size){
  Ps5MdbgCommand command{1,operation};Ps5MdbgMemory args{pid,0,source,destination,size};while(args.length){Ps5MdbgResult result{};const auto remaining=args.length;auto status=syscall(SYS_mdbg_call,&command,&args,&result);if(status<0||!result.length||result.length>remaining)throw std::runtime_error("CHEAT_MEMORY_TRANSFER_FAILED");args.source+=result.length;args.destination+=result.length;args.length-=result.length;if(!result.status&&args.length)throw std::runtime_error("CHEAT_MEMORY_TRANSFER_INCOMPLETE");}
}
std::vector<Ps5ModuleInfo> ps5ModuleInfos(pid_t pid){
  size_t count=0;if(syscall(SYS_dl_get_list,pid,nullptr,0,&count)<0||count>1024)throw std::runtime_error("MODULE_LIST_UNAVAILABLE");std::vector<std::uintptr_t> handles(count);size_t returned=count;if(count&&syscall(SYS_dl_get_list,pid,handles.data(),handles.size(),&returned)<0)throw std::runtime_error("MODULE_LIST_UNAVAILABLE");if(returned>handles.size())throw std::runtime_error("MODULE_LIST_UNAVAILABLE");std::vector<Ps5ModuleInfo> result;result.reserve(returned);
  for(size_t index=0;index<returned;index++){Ps5ModuleInfo info{};if(syscall(SYS_dl_get_info_2,pid,1,handles[index],&info)<0)continue;info.filename[sizeof(info.filename)-1]=0;info.libraryName[sizeof(info.libraryName)-1]=0;info.sandboxedPath[sizeof(info.sandboxedPath)-1]=0;result.push_back(info);}return result;
}
struct Ps5ModuleRange{std::uint64_t base=0,size=0;std::vector<CheatMemoryRange> ranges;};
struct Ps5KernelSharedSection {std::uint64_t metadata,address,size;};
static_assert(sizeof(Ps5KernelSharedSection)==0x18);
std::optional<Ps5ModuleRange> ps5EbootModuleRange(pid_t pid,const std::string& process){
  if(process!="eboot"&&process!="eboot.bin")return std::nullopt;
  const auto proc=kernel_get_proc(pid);std::int32_t observedPid=0;std::uint64_t shared=0,object=0,imageBase=0,sections=0,count=0,pathAddress=0;
  if(!proc||kernel_copyout(proc+0xbc,&observedPid,sizeof(observedPid))<0||observedPid!=pid||kernel_copyout(proc+0x3e8,&shared,sizeof(shared))<0||!shared||kernel_copyout(shared,&object,sizeof(object))<0||!object||kernel_copyout(object+0x8,&pathAddress,sizeof(pathAddress))<0||!pathAddress||kernel_copyout(object+0x30,&imageBase,sizeof(imageBase))<0||!imageBase||imageBase>0x7fffffffffffffffULL||kernel_copyout(object+0x40,&sections,sizeof(sections))<0||!sections||kernel_copyout(object+0x48,&count,sizeof(count))<0||!count||count>16)return std::nullopt;
  std::array<char,1024> path{};if(kernel_copyout(pathAddress,path.data(),path.size()-1)<0)return std::nullopt;const auto pathName=basename(fixedString(path.data(),path.size()));if(pathName!="eboot"&&pathName!="eboot.bin")return std::nullopt;
  Ps5ModuleRange result{imageBase,0,{}};bool executable=false;std::uint64_t end=imageBase;
  for(std::uint64_t index=0;index<count;index++){
    if(index>(UINT64_MAX-sections)/sizeof(Ps5KernelSharedSection))return std::nullopt;Ps5KernelSharedSection section{};
    if(kernel_copyout(sections+index*sizeof(section),&section,sizeof(section))<0||!section.metadata||section.metadata>UINT64_MAX-8||!section.address||!section.size||section.address<imageBase||section.address>0x7fffffffffffffffULL-section.size||section.size>8ULL*1024*1024*1024)return std::nullopt;
    std::uint32_t type=0;if(kernel_copyout(section.metadata+8,&type,sizeof(type))<0||(type!=1&&type!=2&&type!=4&&type!=8&&type!=16))return std::nullopt;
    executable=executable||type==1||type==2;result.ranges.push_back({section.address-imageBase,section.size,type!=2,type==16});end=std::max(end,section.address+section.size);
  }
  std::sort(result.ranges.begin(),result.ranges.end(),[](const auto& a,const auto& b){return a.offset<b.offset;});std::uint64_t previous=0;for(const auto& range:result.ranges){if(range.offset<previous)return std::nullopt;previous=range.offset+range.size;}
  if(!executable||end<=imageBase||end-imageBase>8ULL*1024*1024*1024||kernel_copyout(proc+0xbc,&observedPid,sizeof(observedPid))<0||observedPid!=pid)return std::nullopt;result.size=end-imageBase;return result;
}
Ps5ModuleRange ps5ModuleRange(pid_t pid,const std::string& process){
  if(process=="eboot"||process=="eboot.bin"){if(auto eboot=ps5EbootModuleRange(pid,process))return *eboot;throw std::runtime_error("CHEAT_MODULE_NOT_FOUND");}
  for(const auto& info:ps5ModuleInfos(pid)){const auto file=fixedString(info.filename,sizeof(info.filename)),library=fixedString(info.libraryName,sizeof(info.libraryName)),path=fixedString(info.sandboxedPath,sizeof(info.sandboxedPath));if(file!=process&&library!=process&&basename(path)!=process)continue;std::uint64_t base=UINT64_MAX,end=0;for(const auto& section:info.sections)if(section.size){if(!section.address||section.address>0x7fffffffffffffffULL-section.size)throw std::runtime_error("CHEAT_MODULE_NOT_FOUND");base=std::min(base,section.address);end=std::max(end,section.address+section.size);}if(base==UINT64_MAX||end<=base)throw std::runtime_error("CHEAT_MODULE_NOT_FOUND");Ps5ModuleRange result{base,end-base,{}};for(const auto& section:info.sections)if(section.size)result.ranges.push_back({section.address-base,section.size,(section.protection&1)!=0,(section.protection&2)!=0});std::sort(result.ranges.begin(),result.ranges.end(),[](const auto& a,const auto& b){return a.offset<b.offset;});std::uint64_t previous=0;for(const auto& range:result.ranges){if(range.offset<previous)throw std::runtime_error("CHEAT_MODULE_NOT_FOUND");previous=range.offset+range.size;}return result;}
  throw std::runtime_error("CHEAT_MODULE_NOT_FOUND");
}
Json ps5TitleMetadata(const std::string& titleId){for(const auto& root:{fs::path("/user/appmeta"),fs::path("/system_data/priv/appmeta"),fs::path("/system_data/priv/appmeta/external")})try{auto file=beneath(root,titleId+"/param.json");auto value=Json::parse(safeRead(file,256*1024));const auto content=value["contentId"].string(),version=value["contentVersion"].string();if(value["titleId"].string()==titleId&&std::regex_match(version,versionPattern)&&content.size()>=16&&content.size()<=80&&content.substr(7,9)==titleId)return Json::object({{"version",version},{"contentId",content}});}catch(...){ }return Json();}
std::string ps5ExecutableHash(const std::string& titleId){
  struct Cached{std::string path,hash;dev_t device=0;ino_t inode=0;off_t size=0;time_t modified=0,changed=0;};static Cached cache;static std::mutex cacheMutex;std::lock_guard cacheLock(cacheMutex);
  for(const auto& root:{fs::path("/user/app"),fs::path("/mnt/ext0/user/app"),fs::path("/mnt/ext0/ps5/user/app"),fs::path("/mnt/ext1/user/app")})try{auto file=beneath(root,titleId+"/eboot.bin");struct stat before{};if(lstat(file.c_str(),&before)||!S_ISREG(before.st_mode)||S_ISLNK(before.st_mode)||before.st_nlink!=1||before.st_size<=0||static_cast<std::uint64_t>(before.st_size)>2ULL*1024*1024*1024)continue;if(cache.path==file.string()&&cache.device==before.st_dev&&cache.inode==before.st_ino&&cache.size==before.st_size&&cache.modified==before.st_mtime&&cache.changed==before.st_ctime)return cache.hash;int fd=open(file.c_str(),O_RDONLY|O_NOFOLLOW);if(fd<0)continue;struct Guard{int fd;~Guard(){close(fd);}}guard{fd};struct stat opened{};if(fstat(fd,&opened)||opened.st_dev!=before.st_dev||opened.st_ino!=before.st_ino||opened.st_size!=before.st_size)continue;EVP_MD_CTX* raw=EVP_MD_CTX_new();if(!raw)throw std::runtime_error("CHEAT_HASH_FAILED");struct Digest{EVP_MD_CTX* value;~Digest(){EVP_MD_CTX_free(value);}}context{raw};if(EVP_DigestInit_ex(raw,EVP_sha256(),nullptr)!=1)throw std::runtime_error("CHEAT_HASH_FAILED");std::array<unsigned char,1024*1024> buffer{};for(;;){auto count=read(fd,buffer.data(),buffer.size());if(count<0&&errno==EINTR)continue;if(count<0)throw std::runtime_error("CHEAT_HASH_FAILED");if(!count)break;if(EVP_DigestUpdate(raw,buffer.data(),static_cast<std::size_t>(count))!=1)throw std::runtime_error("CHEAT_HASH_FAILED");}struct stat after{};if(fstat(fd,&after)||after.st_dev!=opened.st_dev||after.st_ino!=opened.st_ino||after.st_size!=opened.st_size||after.st_mtime!=opened.st_mtime||after.st_ctime!=opened.st_ctime)throw std::runtime_error("CHEAT_EXECUTABLE_CHANGED");unsigned char value[32]{};unsigned length=0;if(EVP_DigestFinal_ex(raw,value,&length)!=1||length!=32)throw std::runtime_error("CHEAT_HASH_FAILED");static constexpr char hex[]="0123456789abcdef";std::string result(64,'0');for(unsigned i=0;i<length;i++){result[i*2]=hex[value[i]>>4];result[i*2+1]=hex[value[i]&15];}cache={file.string(),result,after.st_dev,after.st_ino,after.st_size,after.st_mtime,after.st_ctime};return result;}catch(const std::runtime_error& error){if(std::string(error.what()).rfind("CHEAT_",0)==0)throw;}catch(...){ }
  return {};
}
std::optional<CheatTarget> discoverPs5CheatTarget(std::string_view requested){
  if(!requested.empty()&&!std::regex_match(std::string(requested),processPattern))throw std::runtime_error("CHEAT_TARGET_MISMATCH");const auto processes=ps5ProcessTable();const auto appId=sceSystemServiceGetAppIdOfRunningBigApp();if(appId<=0)return std::nullopt;const unsigned char* cursor=processes.data();const unsigned char* end=cursor+processes.size();
  while(cursor<end){if(static_cast<std::size_t>(end-cursor)<sizeof(int))throw std::runtime_error("CHEAT_TARGET_DISCOVERY_FAILED");auto info=reinterpret_cast<const kinfo_proc*>(cursor);if(info->ki_structsize<static_cast<int>(offsetof(kinfo_proc,ki_comm)+sizeof(info->ki_comm))||static_cast<std::size_t>(info->ki_structsize)>static_cast<std::size_t>(end-cursor))throw std::runtime_error("CHEAT_TARGET_DISCOVERY_FAILED");auto command=fixedString(info->ki_comm,sizeof(info->ki_comm));if(command=="CheatRunner.elf"||command=="CheatRunner")throw std::runtime_error("CHEAT_RUNTIME_CONFLICT");cursor+=info->ki_structsize;}
  cursor=processes.data();while(cursor<end){auto info=reinterpret_cast<const kinfo_proc*>(cursor);cursor+=info->ki_structsize;Ps5AppInfo app{};if(sceKernelGetAppInfo(info->ki_pid,&app)<0||static_cast<int>(app.appId)!=appId)continue;char process[128]{};if(sceKernelGetProcessName(info->ki_pid,process)<0)continue;const auto name=fixedString(process,sizeof(process));if(name.empty()||(!requested.empty()&&name!=requested)||fixedString(info->ki_comm,sizeof(info->ki_comm))!=name)continue;app.titleId[sizeof(app.titleId)-1]=0;const auto title=fixedString(app.titleId,sizeof(app.titleId));if(!std::regex_match(title,titlePattern))continue;auto metadata=ps5TitleMetadata(title);if(metadata.null())throw std::runtime_error("CHEAT_TARGET_METADATA_UNAVAILABLE");auto module=ps5ModuleRange(info->ki_pid,name);CheatTarget target;target.pid=info->ki_pid;target.startedSeconds=info->ki_start.tv_sec;target.startedMicroseconds=info->ki_start.tv_usec;target.token=processToken(info->ki_pid,info->ki_start);target.moduleBase=module.base;target.moduleSize=module.size;target.ranges=std::move(module.ranges);target.titleId=title;target.version=metadata["version"].string();target.process=name;target.contentId=metadata["contentId"].string();target.executableSha256=ps5ExecutableHash(title);return target;}return std::nullopt;
}
class Ps5DiscoveryRuntime final:public CheatRuntime {
  std::vector<unsigned char> readBound(const CheatTarget& target,std::uint64_t moduleOffset,std::size_t size,std::size_t limit){
    if(!memoryRuntimeSupported(ps5SystemFirmware()))throw std::runtime_error("CHEAT_RUNTIME_FIRMWARE_UNVERIFIED");if(size>limit||!inModule(target,moduleOffset,size)||!inMappedRange(target,moduleOffset,size,false))throw std::runtime_error("CHEAT_PATCH_OUT_OF_BOUNDS");auto before=running(target.process);if(!before||!same(*before,target))throw std::runtime_error("CHEAT_TARGET_CHANGED");std::vector<unsigned char> bytes(size);const auto address=target.moduleBase+moduleOffset;{
      std::lock_guard lock(credentialMutex);Ps5CredentialScope credentials;std::size_t copied=0;while(copied<size){const auto current=address+copied;const auto pageRemaining=ps5PageSize-(current&(ps5PageSize-1));const auto chunk=std::min<std::size_t>(size-copied,static_cast<std::size_t>(pageRemaining));ps5MdbgTransfer(0x12,target.pid,current,reinterpret_cast<std::uint64_t>(bytes.data()+copied),chunk);copied+=chunk;}
    }auto after=running(target.process);if(!after||!same(*after,target))throw std::runtime_error("CHEAT_TARGET_CHANGED");return bytes;
  }
public:
  std::optional<CheatTarget> running(std::string_view requested={})override{
    if(!memoryRuntimeSupported(ps5SystemFirmware()))throw std::runtime_error("CHEAT_RUNTIME_FIRMWARE_UNVERIFIED");return discoverPs5CheatTarget(requested);
  }
  bool canRead()const override{
#ifdef PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER
    return memoryRuntimeSupported(ps5SystemFirmware());
#else
    return false;
#endif
  }
  bool canWrite()const override{
#ifdef PS5LIBRARY_EXPERIMENTAL_MEMORY_WRITES
    return canRead();
#else
    return false;
#endif
  }
  std::vector<unsigned char> read(const CheatTarget& target,std::uint64_t moduleOffset,std::size_t size)override{return readBound(target,moduleOffset,size,maxCheatTransferBytes);}
  std::vector<unsigned char> scanRead(const CheatTarget& target,std::uint64_t moduleOffset,std::size_t size)override{return readBound(target,moduleOffset,size,maxMemoryScanTransferBytes);}
  void write(const CheatTarget& target,std::uint64_t moduleOffset,const std::vector<unsigned char>& bytes)override{
    if(!memoryRuntimeSupported(ps5SystemFirmware()))throw std::runtime_error("CHEAT_RUNTIME_FIRMWARE_UNVERIFIED");if(bytes.size()>maxCheatTransferBytes||!inModule(target,moduleOffset,bytes.size())||!inMappedRange(target,moduleOffset,bytes.size(),true))throw std::runtime_error("MEMORY_RESULT_READ_ONLY");auto before=running(target.process);if(!before||!same(*before,target))throw std::runtime_error("CHEAT_TARGET_CHANGED");const auto address=target.moduleBase+moduleOffset;{
      std::lock_guard lock(credentialMutex);Ps5CredentialScope credentials;std::size_t copied=0;while(copied<bytes.size()){const auto current=address+copied;const auto pageRemaining=ps5PageSize-(current&(ps5PageSize-1));const auto chunk=std::min<std::size_t>(bytes.size()-copied,static_cast<std::size_t>(pageRemaining));ps5MdbgTransfer(0x13,target.pid,reinterpret_cast<std::uint64_t>(bytes.data()+copied),current,chunk);copied+=chunk;}
    }auto after=running(target.process);if(!after||!same(*after,target))throw std::runtime_error("CHEAT_TARGET_CHANGED");
  }
};
}
std::optional<CheatTarget> probePs5CheatTarget(std::string_view process){if(!memoryDiscoverySupported(ps5SystemFirmware()))throw std::runtime_error("CHEAT_RUNTIME_FIRMWARE_UNVERIFIED");return discoverPs5CheatTarget(process);}
std::optional<Ps5MdbgFlags> pollPs5MdbgFlags(int pid) noexcept {
  if(pid<=0)return Ps5MdbgFlags{-EINVAL,0,0};std::unique_lock lock(credentialMutex,std::try_to_lock);if(!lock.owns_lock())return std::nullopt;
  try{Ps5CredentialScope credentials;Ps5MdbgCommand command{1,30};Ps5MdbgStateRequest request{pid,2,0,{}};Ps5MdbgStateResult response{};errno=0;const auto result=syscall(SYS_mdbg_call,&command,&request,&response);return Ps5MdbgFlags{result<0?-(errno?errno:EIO):static_cast<int>(result),response.status,response.flags};}catch(...){return Ps5MdbgFlags{-EACCES,0,0};}
}
Json capturePs5ExceptionSnapshot(int pid,std::uint64_t stackPointer) noexcept {
  const auto captured=changedAt();auto failed=[&]{return Json::object({{"schemaVersion",1},{"status","FAILED"},{"capturedAtUnixMs",captured},{"error","EXCEPTION_SNAPSHOT_FAILED"}});};
  try{
    if(pid<=0||!stackPointer||stackPointer>0x7fffffffffffffffULL)return failed();std::unique_lock lock(credentialMutex,std::try_to_lock);if(!lock.owns_lock())return failed();Ps5CredentialScope credentials;
    const auto stackBase=stackPointer&~(ps5PageSize-1);std::array<unsigned char,ps5PageSize> stack{};ps5MdbgTransfer(0x12,pid,stackBase,reinterpret_cast<std::uint64_t>(stack.data()),stack.size());
    auto hex64=[](std::uint64_t value){static constexpr char digits[]="0123456789abcdef";char output[18]={'0','x'};for(int index=17;index>=2;index--){output[index]=digits[value&15];value>>=4;}return std::string(output,sizeof(output));};
    auto fingerprint=[](const std::uint8_t* value){static constexpr char digits[]="0123456789abcdef";std::string output(40,'0');for(unsigned index=0;index<20;index++){output[index*2]=digits[value[index]>>4];output[index*2+1]=digits[value[index]&15];}return output;};
    struct CodeRange{std::uint64_t address,size,base;std::size_t module;};std::vector<CodeRange> code;auto modules=Json::array();
    if(auto eboot=ps5EbootModuleRange(pid,"eboot.bin")){
      auto sections=Json::array();for(const auto& range:eboot->ranges){const auto protection=(range.readable?1:0)|(range.writable?2:0)|(!range.writable?4:0);sections.add(Json::object({{"address",hex64(eboot->base+range.offset)},{"size",static_cast<int64_t>(range.size)},{"protection",protection}}));if(protection&4)code.push_back({eboot->base+range.offset,range.size,eboot->base,0});}modules.add(Json::object({{"file","eboot.bin"},{"library","eboot.bin"},{"path","/app0/eboot.bin"},{"handle",hex64(0)},{"sdkVersion",hex64(0)},{"sections",sections}}));
    }
    const auto infos=ps5ModuleInfos(pid);if(infos.size()>256)return failed();
    for(const auto& info:infos){const auto module=modules.size();std::uint64_t base=UINT64_MAX;auto sections=Json::array();for(const auto& section:info.sections)if(section.size){if(!section.address||section.address>0x7fffffffffffffffULL-section.size||section.size>8ULL*1024*1024*1024)return failed();base=std::min(base,section.address);sections.add(Json::object({{"address",hex64(section.address)},{"size",static_cast<int64_t>(section.size)},{"protection",static_cast<int64_t>(section.protection)}}));}if(base==UINT64_MAX)continue;auto value=Json::object({{"file",fixedString(info.filename,sizeof(info.filename))},{"library",fixedString(info.libraryName,sizeof(info.libraryName))},{"path",fixedString(info.sandboxedPath,sizeof(info.sandboxedPath))},{"handle",hex64(info.handle)},{"fingerprint",fingerprint(info.fingerprint)},{"sdkVersion",hex64(info.sdkVersion)},{"sections",sections}});modules.add(value);for(const auto& section:info.sections)if(section.size&&(section.protection&4))code.push_back({section.address,section.size,base,module});}
    auto pointers=Json::array();for(std::size_t offset=0;offset+sizeof(std::uint64_t)<=stack.size();offset+=sizeof(std::uint64_t)){std::uint64_t address=0;std::memcpy(&address,stack.data()+offset,sizeof(address));for(const auto& range:code)if(address>=range.address&&address-range.address<range.size){pointers.add(Json::object({{"stackOffset",static_cast<int64_t>(offset)},{"address",hex64(address)},{"module",static_cast<int64_t>(range.module)},{"moduleOffset",hex64(address-range.base)}}));break;}}
    return Json::object({{"schemaVersion",1},{"status","COMPLETE"},{"capturedAtUnixMs",captured},{"stackBase",hex64(stackBase)},{"stackSize",static_cast<int64_t>(stack.size())},{"stackSha256",digest(std::string_view(reinterpret_cast<const char*>(stack.data()),stack.size()))},{"modules",modules},{"stackCodePointers",pointers}});
  }catch(...){return failed();}
}
int ps5TitleProcessId(int appId,std::string_view titleId){
  const auto processes=ps5ProcessTable();const unsigned char* cursor=processes.data();const unsigned char* end=cursor+processes.size();
  while(cursor<end){
    if(static_cast<std::size_t>(end-cursor)<sizeof(int))throw std::runtime_error("PROCESS_DISCOVERY_FAILED");auto info=reinterpret_cast<const kinfo_proc*>(cursor);if(info->ki_structsize<static_cast<int>(offsetof(kinfo_proc,ki_comm)+sizeof(info->ki_comm))||static_cast<std::size_t>(info->ki_structsize)>static_cast<std::size_t>(end-cursor))throw std::runtime_error("PROCESS_DISCOVERY_FAILED");cursor+=info->ki_structsize;if(!titleProcessAlive(static_cast<unsigned char>(info->ki_stat)))continue;
    Ps5AppInfo app{};if(sceKernelGetAppInfo(info->ki_pid,&app)<0||static_cast<int>(app.appId)!=appId)continue;app.titleId[sizeof(app.titleId)-1]=0;if(fixedString(app.titleId,sizeof(app.titleId))!=titleId)continue;
    char process[128]{};if(sceKernelGetProcessName(info->ki_pid,process)<0)continue;const auto name=fixedString(process,sizeof(process));if(name.empty()||fixedString(info->ki_comm,sizeof(info->ki_comm))!=name)continue;if(titleMainExecutable(name))return info->ki_pid;
  }
  return -1;
}
#endif

class CheatService::UnavailableRuntime final:public CheatRuntime{public:std::optional<CheatTarget> running(std::string_view={})override{throw std::runtime_error("CHEAT_RUNTIME_UNVERIFIED");}std::vector<unsigned char> read(const CheatTarget&,std::uint64_t,std::size_t)override{throw std::runtime_error("CHEAT_RUNTIME_UNVERIFIED");}void write(const CheatTarget&,std::uint64_t,const std::vector<unsigned char>&)override{throw std::runtime_error("CHEAT_RUNTIME_UNVERIFIED");}};
CheatService::CheatService(fs::path root):root_(std::move(root)){
#ifdef PS5
  runtime_=std::make_unique<Ps5DiscoveryRuntime>();
#else
  runtime_=std::make_unique<UnavailableRuntime>();
#endif
  for(const auto* directory:{"inbox","receipts","approvals","journal","staging"})fs::create_directories(root_/directory);engine_=std::make_unique<CheatEngine>(*runtime_,root_/"journal");
#ifdef PS5LIBRARY_EXPERIMENTAL_MEMORY_WRITES
  scanner_=std::make_unique<MemoryScanner>(*runtime_,true);
#else
  scanner_=std::make_unique<MemoryScanner>(*runtime_);
#endif
}
CheatService::~CheatService(){stop();}
std::vector<CheatProfile> CheatService::scan()const{
  std::vector<CheatProfile> profiles;const auto inbox=root_/"inbox";std::error_code error;for(fs::directory_iterator it(inbox,fs::directory_options::skip_permission_denied,error),end;it!=end;it.increment(error)){if(error){error.clear();continue;}auto status=it->symlink_status(error);if(error||fs::is_symlink(status)||!fs::is_regular_file(status)){error.clear();continue;}auto extension=it->path().extension().string();if(extension!=".json"&&extension!=".mc4"&&extension!=".shn")continue;try{auto hash=digest(safeRead(it->path()));auto receiptPath=beneath(root_,"receipts/"+hash+".json");auto approvalPath=beneath(root_,"approvals/"+hash+".json");Json receipt;if(fs::is_regular_file(receiptPath)&&!fs::is_symlink(receiptPath))receipt=Json::parse(safeRead(receiptPath,64*1024));auto profile=parseCheatProfile(it->path(),receipt);if(fs::is_regular_file(approvalPath)&&!fs::is_symlink(approvalPath)){auto approval=Json::parse(safeRead(approvalPath,64*1024));profile.localApproved=approval["schemaVersion"].number()==1&&approval["profileSha256"].string()==profile.id&&approval["approved"].boolean();}profiles.push_back(std::move(profile));}catch(const std::exception& exception){CheatProfile invalid;invalid.fileName=it->path().filename().string();try{invalid.id=digest(safeRead(it->path()));}catch(...){invalid.id=digest(invalid.fileName);}invalid.validation=errorCode(exception);profiles.push_back(std::move(invalid));}}
  std::sort(profiles.begin(),profiles.end(),[](const auto& left,const auto& right){return left.fileName<right.fileName;});return profiles;
}
Json CheatService::list(const Json& inventory,const Json&)const{auto result=Json::array();for(const auto& profile:scan()){auto entries=Json::array();for(const auto& entry:profile.entries)entries.add(Json::object({{"id",entry.id},{"name",entry.name},{"description",entry.description},{"enabled",engine_->enabled(profile.id,entry.id)}}));const bool installed=inventoryMatch(profile,inventory);auto trust=profile.serverApproved&&!profile.targetExecutableSha256.empty()?"SERVER_APPROVED_HASH_DECLARED":profile.localApproved?"LOCALLY_APPROVED":profile.serverApproved?"SERVER_APPROVED_UNVERIFIED_TARGET":"UNVERIFIED";auto runtime=std::string("HARDWARE_UNVERIFIED");if(profile.validation=="VALID"&&installed)try{auto target=runtime_->running(profile.process);runtime=!target?"NO_RUNNING_TARGET":exact(*target,profile)?"TARGET_DISCOVERED_UNVERIFIED":"TARGET_MISMATCH";}catch(const std::exception& error){runtime=errorCode(error);}result.add(Json::object({{"id",profile.id},{"fileName",profile.fileName},{"titleId",profile.titleId},{"version",profile.version},{"process",profile.process},{"contentId",profile.contentId},{"targetExecutableSha256",profile.targetExecutableSha256},{"format",profile.format},{"validation",profile.validation},{"trust",trust},{"installedMatch",installed},{"runtime",runtime},{"entries",entries}}));}return result;}
Json CheatService::enable(const std::string& profileId,const std::string& entryId,const Json& inventory,const Json&,bool explicitApproval){auto profiles=scan();auto found=std::find_if(profiles.begin(),profiles.end(),[&](const auto& profile){return profile.id==profileId;});if(found==profiles.end())throw std::runtime_error("CHEAT_PROFILE_NOT_FOUND");if(!inventoryMatch(*found,inventory))throw std::runtime_error("CHEAT_TARGET_NOT_INSTALLED");if(found->serverApproved&&found->targetExecutableSha256.empty())throw std::runtime_error("CHEAT_TARGET_HASH_REQUIRED");if(!found->serverApproved&&!found->localApproved){if(!explicitApproval)throw std::runtime_error("LOCAL_APPROVAL_REQUIRED");atomicJson(beneath(root_,"approvals/"+found->id+".json"),Json::object({{"schemaVersion",1},{"profileSha256",found->id},{"approved",true},{"approvedAtUnixMs",changedAt()}}));found->localApproved=true;}return engine_->enable(*found,entryId);}
Json CheatService::disable(const std::string& profileId,const std::string& entryId){return engine_->disable(profileId,entryId);}
Json CheatService::memoryScanTarget(){return scanner_->target();}
Json CheatService::memoryScanStart(const std::string& titleId,const std::string& version,const std::string& type,const std::string& mode,const std::string& value){return scanner_->start(titleId,version,type,mode,value);}
Json CheatService::memoryScanRefine(const std::string& scanId,const std::string& mode,const std::string& value){return scanner_->refine(scanId,mode,value);}
Json CheatService::memoryScanWatch(const std::string& scanId){return scanner_->watch(scanId);}
Json CheatService::memoryScanWrite(const std::string& scanId,const std::string& resultId,const std::string& value,bool freeze){return scanner_->write(scanId,resultId,value,freeze);}
Json CheatService::memoryScanRestore(const std::string& scanId,const std::string& resultId){return scanner_->restore(scanId,resultId);}
std::size_t CheatService::memoryScanRestoreAll(){return scanner_->restoreAll();}
void CheatService::memoryScanClear(){scanner_->clear();}
std::string CheatService::stage(const Json& delivery){
  if(delivery["action"].string()!="PLACE"||delivery["format"].string()!="JSON"||!std::regex_match(delivery["id"].string(),uuidPattern)||!std::regex_match(delivery["profileId"].string(),uuidPattern)||!std::regex_match(delivery["profileSha256"].string(),hashPattern)||!std::regex_match(delivery["titleId"].string(),titlePattern)||!std::regex_match(delivery["gameVersion"].string(),versionPattern)||!std::regex_match(delivery["process"].string(),processPattern))throw std::runtime_error("INVALID_CHEAT_DELIVERY");const auto fileName=delivery["fileName"].string(),expected=delivery["titleId"].string()+"_"+delivery["gameVersion"].string()+"_"+delivery["process"].string()+".json";if(fileName!=expected)throw std::runtime_error("CHEAT_METADATA_MISMATCH");const auto bytes=decode64(delivery["profileBase64"].string()),hash=digest(bytes);if(hash!=delivery["profileSha256"].string())throw std::runtime_error("CHEAT_HASH_MISMATCH");
  auto receipt=Json::object({{"schemaVersion",1},{"source","SERVER"},{"approved",true},{"deliveryId",delivery["id"]},{"profileId",delivery["profileId"]},{"profileSha256",hash},{"fileName",fileName},{"titleId",delivery["titleId"]},{"gameVersion",delivery["gameVersion"]},{"process",delivery["process"]},{"contentId",delivery["contentId"]},{"targetExecutableSha256",delivery["targetExecutableSha256"]},{"format","JSON"}});auto staging=beneath(root_,"staging/"+delivery["id"].string());fs::create_directories(staging);auto staged=beneath(staging,fileName);try{atomicBytes(staged,bytes);parseCheatProfile(staged,receipt);auto target=beneath(root_,"inbox/"+fileName);const bool existed=fs::exists(target);if(existed&&digest(safeRead(target))!=hash)throw std::runtime_error("CHEAT_FILE_CONFLICT");receipt.set("managedFileCreated",!existed);if(!existed)atomicBytes(target,bytes);try{atomicJson(beneath(root_,"receipts/"+hash+".json"),receipt);}catch(...){if(!existed&&fs::is_regular_file(target)&&!fs::is_symlink(target)&&digest(safeRead(target))==hash)fs::remove(target);throw;}fs::remove_all(staging);}catch(...){fs::remove_all(staging);throw;}return hash;
}
void CheatService::remove(const Json& delivery){if(delivery["action"].string()!="DELETE"||!std::regex_match(delivery["id"].string(),uuidPattern)||!std::regex_match(delivery["profileId"].string(),uuidPattern)||!std::regex_match(delivery["profileSha256"].string(),hashPattern))throw std::runtime_error("INVALID_CHEAT_DELIVERY");auto receiptPath=beneath(root_,"receipts/"+delivery["profileSha256"].string()+".json");if(!fs::is_regular_file(receiptPath)||fs::is_symlink(receiptPath))throw std::runtime_error("CHEAT_RECEIPT_MISSING");auto receipt=Json::parse(safeRead(receiptPath,64*1024));if(receipt["deliveryId"].string()!=delivery["id"].string()||receipt["profileId"].string()!=delivery["profileId"].string()||receipt["profileSha256"].string()!=delivery["profileSha256"].string())throw std::runtime_error("CHEAT_RECEIPT_MISMATCH");engine_->disableProfile(delivery["profileSha256"].string());auto file=beneath(root_,"inbox/"+receipt["fileName"].string());if(receipt["managedFileCreated"].boolean()&&fs::is_regular_file(file)&&!fs::is_symlink(file)&&digest(safeRead(file))==delivery["profileSha256"].string())fs::remove(file);fs::remove(receiptPath);}
void CheatService::reconcile(){try{engine_->reconcile();}catch(...){ }scanner_->reconcile();}
void CheatService::stop()noexcept{if(engine_)engine_->stop();}

Json Agent::localCheats(){auto volumes=storage();return cheats_->list(inventory(volumes),volumes);}
Json Agent::localCheatEnable(const std::string& profileId,const std::string& entryId,bool explicitApproval){auto volumes=storage();return cheats_->enable(profileId,entryId,inventory(volumes),volumes,explicitApproval);}
Json Agent::localCheatDisable(const std::string& profileId,const std::string& entryId){return cheats_->disable(profileId,entryId);}
Json Agent::localMemoryScanTarget(){return cheats_->memoryScanTarget();}
Json Agent::localMemoryScanStart(const std::string& titleId,const std::string& version,const std::string& type,const std::string& mode,const std::string& value){return cheats_->memoryScanStart(titleId,version,type,mode,value);}
Json Agent::localMemoryScanRefine(const std::string& scanId,const std::string& mode,const std::string& value){return cheats_->memoryScanRefine(scanId,mode,value);}
Json Agent::localMemoryScanWatch(const std::string& scanId){return cheats_->memoryScanWatch(scanId);}
Json Agent::localMemoryScanWrite(const std::string& scanId,const std::string& resultId,const std::string& value,bool freeze){return cheats_->memoryScanWrite(scanId,resultId,value,freeze);}
Json Agent::localMemoryScanRestore(const std::string& scanId,const std::string& resultId){return cheats_->memoryScanRestore(scanId,resultId);}
std::size_t Agent::localMemoryScanRestoreAll(){return cheats_->memoryScanRestoreAll();}
void Agent::localMemoryScanClear(){cheats_->memoryScanClear();}
void Agent::localCheatReconcile(){cheats_->reconcile();}
void Agent::syncCheats(){
  cheats_->reconcile();auto delivery=client.request("GET","/api/v1/device/cheat-deliveries");if(delivery.null())return;const auto id=delivery["id"].string(),hash=delivery["profileSha256"].string();if(!std::regex_match(id,uuidPattern)||!std::regex_match(hash,hashPattern))throw std::runtime_error("INVALID_CHEAT_DELIVERY");
  try{if(delivery["action"].string()=="PLACE")cheats_->stage(delivery);else if(delivery["action"].string()=="DELETE")cheats_->remove(delivery);else throw std::runtime_error("INVALID_CHEAT_DELIVERY");client.request("POST","/api/v1/device/cheat-deliveries/"+id+"/receipt",Json::object({{"state",delivery["action"].string()=="PLACE"?"RECEIVED":"DELETED"},{"profileSha256",hash}}));}
  catch(const std::exception& error){client.request("POST","/api/v1/device/cheat-deliveries/"+id+"/receipt",Json::object({{"state","REJECTED"},{"profileSha256",hash},{"error",errorCode(error)}}));}
}
}
