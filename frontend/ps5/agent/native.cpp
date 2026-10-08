#include "../common/client.hpp"
#include <atomic>
#include <thread>
#include <mutex>
#include <regex>
#include <cstring>
#include <cstdio>
#include <limits>
#include <array>
#include <cerrno>
#include <fcntl.h>
#include <fstream>
#include <map>
#include <vector>
#include <sys/stat.h>
#include <unistd.h>
#ifdef PS5
#include <dlfcn.h>
// Verified ABI: etaHEN pkg-writeup.md; cy33hc/ps5-ezremote-dpi cff181ca source/sceAppInstUtil.h.
struct PackageInfo {char contentId[48];int contentType,contentPlatform;};
struct MetaInfo {const char *uri,*extraUri,*scenario,*contentId,*name,*icon;};
struct PlayGoInfo {char languages[30][8],scenarios[64][3],contentIds[64][48];unsigned char reserved[6480];};
struct InstallError {int32_t code,version;char description[512],type[9];};
struct InstallStatus {char status[16],source[8];uint32_t remaining;uint64_t downloaded,initial,total;uint32_t promote;InstallError error;int32_t copyPercent;bool copyOnly;};
static_assert(sizeof(PackageInfo)==56&&sizeof(MetaInfo)==48&&sizeof(PlayGoInfo)==9984&&sizeof(InstallError)==532&&sizeof(InstallStatus)==600);
extern "C" int sceAppInstUtilInitialize();
extern "C" int sceAppInstUtilInstallByPackage(MetaInfo*,PackageInfo*,PlayGoInfo*);
extern "C" int sceAppInstUtilGetInstallStatus(const char*,InstallStatus*);
extern "C" int sceAppInstUtilAppUnInstall(const char*);
#endif
namespace ps5library {
static std::atomic<bool> updateBridgeAvailable{false};
bool nativeUpdateBridgeAvailable(){return updateBridgeAvailable.load();}
void setNativeUpdateBridgeAvailable(bool available){updateBridgeAvailable.store(available);}
std::mutex& nativeApiMutex(){static std::mutex mutex;return mutex;}
#ifdef PS5
struct NativeApiLock {std::unique_lock<std::mutex> lock{nativeApiMutex()};~NativeApiLock(){usleep(200000);}};
#endif
static bool validContentId(const std::string& value){return std::regex_match(value,std::regex("[A-Z]{2}[0-9]{4}-PPSA[0-9]{5}_[0-9]{2}-[A-Z0-9]{16}"));}
#ifdef PS5
using PlayGoManifest=std::map<std::string,std::pair<uintmax_t,std::string>>;
static PlayGoManifest playGoManifest(const fs::path& root){
  if(fs::is_symlink(root)||!fs::is_directory(root))throw std::runtime_error("NATIVE_MOVE_PLAYGO_MISSING");
  PlayGoManifest result;uintmax_t bytes=0;size_t count=0;
  for(const auto& entry:fs::recursive_directory_iterator(root)){
    if(++count>4096||entry.is_symlink())throw std::runtime_error("NATIVE_MOVE_PLAYGO_UNSAFE");
    const auto relative=fs::relative(entry.path(),root).generic_string();
    if(entry.is_directory())result[relative]={std::numeric_limits<uintmax_t>::max(),{}};
    else if(entry.is_regular_file()){const auto size=entry.file_size();if(size>256*1024*1024||bytes>256*1024*1024-size)throw std::runtime_error("NATIVE_MOVE_PLAYGO_TOO_LARGE");bytes+=size;result[relative]={size,fileHash(entry.path())};}
    else throw std::runtime_error("NATIVE_MOVE_PLAYGO_UNSAFE");
  }
  return result;
}
static void copyPlayGoFile(const fs::path& source,const fs::path& target){
  std::ifstream input(source,std::ios::binary);int fd=open(target.c_str(),O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW,0600);if(!input||fd<0){if(fd>=0){close(fd);unlink(target.c_str());}throw std::runtime_error("NATIVE_MOVE_PLAYGO_COPY_FAILED");}
  try{std::vector<char> buffer(1024*1024);while(input){input.read(buffer.data(),buffer.size());size_t written=0,size=static_cast<size_t>(input.gcount());while(written<size){const auto count=write(fd,buffer.data()+written,size-written);if(count<0&&errno==EINTR)continue;if(count<=0)throw std::runtime_error("NATIVE_MOVE_PLAYGO_COPY_FAILED");written+=static_cast<size_t>(count);}}if(!input.eof()||fsync(fd)!=0)throw std::runtime_error("NATIVE_MOVE_PLAYGO_COPY_FAILED");const auto closed=close(fd);fd=-1;if(closed!=0)throw std::runtime_error("NATIVE_MOVE_PLAYGO_COPY_FAILED");fs::permissions(target,fs::status(source).permissions());}
  catch(...){if(fd>=0)close(fd);unlink(target.c_str());throw;}
}
static void copyPlayGoTree(const fs::path& source,const fs::path& target){
  const auto expected=playGoManifest(source);uintmax_t bytes=0;for(const auto& [_,file]:expected)if(file.first!=std::numeric_limits<uintmax_t>::max())bytes+=file.first;
  fs::create_directories(target.parent_path());if(fs::space(target.parent_path()).available<bytes)throw std::runtime_error("NATIVE_MOVE_PLAYGO_NO_SPACE");
  try{
    fs::create_directory(target);fs::permissions(target,fs::status(source).permissions());
    for(const auto& entry:fs::recursive_directory_iterator(source)){const auto destination=target/fs::relative(entry.path(),source);if(entry.is_directory()){fs::create_directory(destination);fs::permissions(destination,entry.status().permissions());}else copyPlayGoFile(entry.path(),destination);}
    if(playGoManifest(source)!=expected||playGoManifest(target)!=expected)throw std::runtime_error("NATIVE_MOVE_PLAYGO_COPY_MISMATCH");
  }catch(...){std::error_code ignored;fs::remove_all(target,ignored);throw;}
}
static fs::path playGoDirectory(const fs::path& root,const std::string& contentId){if(!validContentId(contentId)||fs::is_symlink(root)||!fs::is_directory(root))throw std::runtime_error("NATIVE_MOVE_PLAYGO_MISSING");return beneath(root,contentId+"/00");}
static fs::path playGoBackupDirectory(const fs::path& root,const std::string& contentId){if(!validContentId(contentId))throw std::runtime_error("NATIVE_MOVE_PLAYGO_MISSING");fs::create_directories(root);if(fs::is_symlink(root)||!fs::is_directory(root))throw std::runtime_error("NATIVE_MOVE_PLAYGO_UNSAFE");return beneath(root,contentId);}
static void preserveNativeMovePlayGo(const std::string& contentId,const fs::path& backupRoot,const fs::path& playGoRoot){
  const auto source=playGoDirectory(playGoRoot,contentId),backup=playGoBackupDirectory(backupRoot,contentId),target=backup/"00";const auto expected=playGoManifest(source);
  if(fs::exists(backup)){if(fs::is_directory(target)&&playGoManifest(target)==expected)return;throw std::runtime_error("NATIVE_MOVE_PLAYGO_BACKUP_MISMATCH");}
  const auto stage=beneath(backupRoot,contentId+".part");std::error_code ignored;fs::remove_all(stage,ignored);copyPlayGoTree(source,stage/"00");fs::rename(stage,backup);
}
static void discardNativeMovePlayGo(const std::string& contentId,const fs::path& backupRoot,const fs::path& playGoRoot){
  const auto source=playGoDirectory(playGoRoot,contentId),backup=playGoBackupDirectory(backupRoot,contentId);if(fs::is_directory(backup/"00")&&playGoManifest(source)==playGoManifest(backup/"00"))fs::remove_all(backup);
}
static void restoreNativeMovePlayGo(const std::string& contentId,const fs::path& backupRoot,const fs::path& playGoRoot){
  const auto backup=playGoBackupDirectory(backupRoot,contentId),source=backup/"00";if(!fs::is_directory(source))throw std::runtime_error("NATIVE_MOVE_PLAYGO_BACKUP_MISMATCH");
  fs::create_directories(playGoRoot/contentId);const auto target=playGoDirectory(playGoRoot,contentId);const auto expected=playGoManifest(source);
  if(fs::exists(target)){if(playGoManifest(target)!=expected)throw std::runtime_error("NATIVE_MOVE_PLAYGO_RESTORE_CONFLICT");fs::remove_all(backup);return;}
  const auto stage=target.parent_path()/".ps5library-restore";std::error_code ignored;fs::remove_all(stage,ignored);copyPlayGoTree(source,stage);fs::rename(stage,target);if(playGoManifest(target)!=expected)throw std::runtime_error("NATIVE_MOVE_PLAYGO_RESTORE_MISMATCH");fs::remove_all(backup);
}
#endif
int nativeMoveStorageType(const std::string& path,const std::string& device,const std::string& filesystem){
  if(path=="/user")return 0;
  if(path=="/mnt/ext0"&&filesystem=="ufs"&&device.size()>=6&&device.compare(device.size()-6,6,".crypt")==0)return 1;
  if(path=="/mnt/ext1"&&filesystem=="bfs"&&(device.rfind("/dev/ssd",0)==0||device.rfind("/dev/nvme",0)==0))return 2;
  return -1;
}
#ifdef PS5
// 4.50/4.51 ShellCore ABI: title IDs occupy 12-byte slots and progress is a 0x150-byte record with state at offset zero.
struct NativeMoveApi {
  using Exists=int(*)(const char*,unsigned char*);using GetStorage=int(*)(const char*,int*);using Request=int(*)(int,const char*,size_t);using Progress=int(*)(void*);using Cancel=int(*)();
  void* module=nullptr;Exists exists=nullptr;GetStorage getStorage=nullptr;Request request=nullptr;Progress progress=nullptr;Cancel cancel=nullptr;
  NativeMoveApi(){
    module=dlopen("libSceAppInstUtil.sprx",RTLD_NOW|RTLD_LOCAL);if(!module)module=dlopen("/system/common/lib/libSceAppInstUtil.sprx",RTLD_NOW|RTLD_LOCAL);if(!module)return;
    exists=reinterpret_cast<Exists>(dlsym(module,"sceAppInstUtilAppExists"));getStorage=reinterpret_cast<GetStorage>(dlsym(module,"sceAppInstUtilAppGetStorageDestType"));request=reinterpret_cast<Request>(dlsym(module,"sceAppInstUtilAppRequestMoveApps"));progress=reinterpret_cast<Progress>(dlsym(module,"sceAppInstUtilGetAppMoveProgressInfo"));cancel=reinterpret_cast<Cancel>(dlsym(module,"sceAppInstUtilAppCancelMoveApps"));
  }
  explicit operator bool() const{return exists&&getStorage&&request&&progress&&cancel;}
};
static NativeMoveApi& nativeMoveApi(){static NativeMoveApi api;return api;}
struct NativeInstallLocationApi {
  using Get=int(*)(int,int*);using Set=int(*)(int,int);void* module=nullptr;Get get=nullptr;Set set=nullptr;
  NativeInstallLocationApi(){module=dlopen("libSceRegMgr.sprx",RTLD_NOW|RTLD_LOCAL);if(!module)module=dlopen("/system/common/lib/libSceRegMgr.sprx",RTLD_NOW|RTLD_LOCAL);if(module){get=reinterpret_cast<Get>(dlsym(module,"sceRegMgrGetInt"));set=reinterpret_cast<Set>(dlsym(module,"sceRegMgrSetInt"));}}
  explicit operator bool()const{return get&&set;}
};
static NativeInstallLocationApi& nativeInstallLocationApi(){static NativeInstallLocationApi api;return api;}
static void nativeInstallTargetError(const char* operation,int result=0){char code[80];std::snprintf(code,sizeof(code),"NATIVE_INSTALL_TARGET_%s_%08X",operation,static_cast<unsigned>(result));throw NativeSubmissionRejected(code);}
static void nativeInstallTargetFailure(const char* operation,int result=0){char code[80];std::snprintf(code,sizeof(code),"NATIVE_INSTALL_TARGET_%s_%08X",operation,static_cast<unsigned>(result));throw std::runtime_error(code);}
static void nativeMoveResult(const char* operation,int result){if(!result)return;char code[80];std::snprintf(code,sizeof(code),"NATIVE_MOVE_%s_%08X",operation,static_cast<unsigned>(result));throw std::runtime_error(code);}
static int nativeTitleStorageType(NativeMoveApi& api,const std::string& titleId,const std::string& contentId){
  unsigned char exists=0;nativeMoveResult("EXISTS_REJECTED",api.exists(titleId.c_str(),&exists));if(!exists)return -1;
  int current=-1;nativeMoveResult("STORAGE_REJECTED",api.getStorage(contentId.c_str(),&current));if(current<1||current>3)throw std::runtime_error("NATIVE_MOVE_SOURCE_MISMATCH");return current-1;
}
static int nativeMoveState(NativeMoveApi& api){alignas(8) std::array<unsigned char,0x150> progress{};nativeMoveResult("STATUS_REJECTED",api.progress(progress.data()));int state=0;std::memcpy(&state,progress.data(),sizeof(state));if(state<0||state>4)throw std::runtime_error("NATIVE_MOVE_STATUS_MISMATCH");return state;}
#endif
bool nativeMovesAvailable(){
#ifdef PS5
  return nativeDownloadsAvailable()&&static_cast<bool>(nativeMoveApi());
#else
  return false;
#endif
}
int nativeTitleStorageType(const std::string& titleId,const std::string& contentId){
  if(!std::regex_match(titleId,std::regex("(PPSA|CUSA)[0-9]{5}"))||!std::regex_match(contentId,std::regex("[A-Z]{2}[0-9]{4}-"+titleId+"_[0-9]{2}-[A-Z0-9]{16}")))throw std::runtime_error("MOVE_UNAVAILABLE");
#ifdef PS5
  if(!nativeDownloadsAvailable())throw std::runtime_error("NATIVE_INSTALLER_UNAVAILABLE");auto& api=nativeMoveApi();if(!api)throw std::runtime_error("NATIVE_MOVE_UNAVAILABLE");NativeApiLock lock;return nativeTitleStorageType(api,titleId,contentId);
#else
  return -1;
#endif
}
int nativeMoveState(){
#ifdef PS5
  if(!nativeDownloadsAvailable())throw std::runtime_error("NATIVE_INSTALLER_UNAVAILABLE");auto& api=nativeMoveApi();if(!api)throw std::runtime_error("NATIVE_MOVE_UNAVAILABLE");NativeApiLock lock;return nativeMoveState(api);
#else
  return -1;
#endif
}
void reconcileNativeMovePlayGo(const fs::path& playGoBackupRoot,const fs::path& playGoRoot){
#ifdef PS5
  if(!fs::exists(playGoBackupRoot))return;if(fs::is_symlink(playGoBackupRoot)||!fs::is_directory(playGoBackupRoot))throw std::runtime_error("NATIVE_MOVE_PLAYGO_UNSAFE");
  std::vector<std::string> pending;for(const auto& entry:fs::directory_iterator(playGoBackupRoot)){const auto contentId=entry.path().filename().string();if(!entry.is_symlink()&&entry.is_directory()&&validContentId(contentId))pending.push_back(contentId);}
  if(pending.empty())return;if(!nativeDownloadsAvailable())throw std::runtime_error("NATIVE_INSTALLER_UNAVAILABLE");auto& api=nativeMoveApi();if(!api)throw std::runtime_error("NATIVE_MOVE_UNAVAILABLE");NativeApiLock lock;if(nativeMoveState(api)==2)return;
  for(const auto& contentId:pending)restoreNativeMovePlayGo(contentId,playGoBackupRoot,playGoRoot);
#else
  (void)playGoBackupRoot;(void)playGoRoot;
#endif
}
void startNativeMoveRecovery(const fs::path& playGoBackupRoot,const fs::path& playGoRoot){
#ifdef PS5
  static std::once_flag once;std::call_once(once,[playGoBackupRoot,playGoRoot]{std::thread([playGoBackupRoot,playGoRoot]{try{if(!fs::exists(playGoBackupRoot))return;for(int attempt=0;attempt<100;attempt++){if(nativeDownloadsAvailable()){reconcileNativeMovePlayGo(playGoBackupRoot,playGoRoot);return;}std::this_thread::sleep_for(std::chrono::milliseconds(100));}}catch(const std::exception& error){std::fprintf(stderr,"Native move recovery: %s\n",error.what());}}).detach();});
#else
  (void)playGoBackupRoot;(void)playGoRoot;
#endif
}
bool nativeMoveTargetAvailable(const Json& volumes,int sourceStorageType){
  if(sourceStorageType<0||sourceStorageType>1)return false;
  for(size_t i=0;i<volumes.size();i++)if(volumes[i]["nativeMoveStorageType"].number(-1)==1-sourceStorageType)return true;
  return false;
}
fs::path observedNativePackage(const Json& installed,const Json& volumes){
  if(!installed["nativeRegistered"].boolean())return {};
  const auto titleId=installed["titleId"].string(),storageId=installed["storageId"].string();if(!std::regex_match(titleId,std::regex("PPSA[0-9]{5}"))||storageId.empty())return {};
  for(size_t i=0;i<volumes.size();i++)if(volumes[i]["storageId"].string()==storageId){const auto type=volumes[i]["nativeMoveStorageType"].number(-1);if(type<0||type>2)continue;auto file=installedNativePackage(titleId,volumes[i]["path"].string());if(fs::is_regular_file(file)&&sameStorageDevice(file,volumes[i]["path"].string()))return file;}
  return {};
}
ReceiptFileState receiptFileState(const fs::path& file,const Json& receipt,const std::unordered_map<std::string,std::pair<fs::file_time_type,std::string>>& cache){
  std::error_code error;auto status=fs::symlink_status(file,error);if(error||fs::is_symlink(status)||!fs::is_regular_file(status)||static_cast<int64_t>(fs::file_size(file,error))!=receipt["size"].number()||error)return {};
  auto stamp=fs::last_write_time(file,error);if(error)return {};auto found=cache.find(file.string());if(found==cache.end()||found->second.first!=stamp)return {true,false};const bool verified=found->second.second==receipt["sha256"].string();return {verified,verified};
}
Json nativeMoveTitle(const std::string& titleId,const std::string& contentId,int sourceStorageType,int destinationStorageType,const fs::path& playGoBackupRoot,const fs::path& playGoRoot){
  if(!std::regex_match(titleId,std::regex("(PPSA|CUSA)[0-9]{5}"))||!std::regex_match(contentId,std::regex("[A-Z]{2}[0-9]{4}-"+titleId+"_[0-9]{2}-[A-Z0-9]{16}"))||sourceStorageType<0||sourceStorageType>1||destinationStorageType!=1-sourceStorageType)throw std::runtime_error("MOVE_UNAVAILABLE");
#ifdef PS5
  if(!nativeDownloadsAvailable())throw std::runtime_error("NATIVE_INSTALLER_UNAVAILABLE");auto& api=nativeMoveApi();if(!api)throw std::runtime_error("NATIVE_MOVE_UNAVAILABLE");NativeApiLock lock;
  const auto current=nativeTitleStorageType(api,titleId,contentId);if(current<0)throw std::runtime_error("NATIVE_MOVE_TITLE_NOT_FOUND");if(current!=sourceStorageType)throw std::runtime_error("NATIVE_MOVE_SOURCE_MISMATCH");
  const auto state=nativeMoveState(api);if(state==2)throw std::runtime_error("NATIVE_MOVE_BUSY");
  const bool preserve=sourceStorageType==0&&destinationStorageType==1&&titleId.rfind("PPSA",0)==0;if(preserve)preserveNativeMovePlayGo(contentId,playGoBackupRoot,playGoRoot);
  try{std::array<char,12> ids{};std::memcpy(ids.data(),titleId.data(),titleId.size());nativeMoveResult("REJECTED",api.request(sourceStorageType,ids.data(),1));}catch(...){if(preserve)try{discardNativeMovePlayGo(contentId,playGoBackupRoot,playGoRoot);}catch(...){ }throw;}
  return Json::object({{"accepted",true},{"operation","native-move"},{"sourceStorageType",sourceStorageType},{"destinationStorageType",destinationStorageType}});
#else
  (void)playGoBackupRoot;(void)playGoRoot;
  throw std::runtime_error("NATIVE_MOVE_UNAVAILABLE");
#endif
}
void cancelNativeMove(){
#ifdef PS5
  auto& api=nativeMoveApi();if(!api)throw std::runtime_error("NATIVE_MOVE_UNAVAILABLE");NativeApiLock lock;nativeMoveResult("CANCEL_REJECTED",api.cancel());
#else
  throw std::runtime_error("NATIVE_MOVE_UNAVAILABLE");
#endif
}
static Json submissionMarker(const char* state,const std::string& sha256,const std::string& serverUrl,const std::string& consoleId){return Json::object({{"state",state},{"sha256",sha256},{"serverUrl",serverUrl},{"consoleId",consoleId}});}
NativeSubmissionDecision inspectNativeSubmission(const fs::path& marker,const std::string& sha256,const std::string& serverUrl,const std::string& consoleId,bool resetRequested){
  if(!fs::exists(marker))return NativeSubmissionDecision::Submit;
  if(fs::is_symlink(marker)||!fs::is_regular_file(marker))throw std::runtime_error("NATIVE_INSTALL_STATE_MISMATCH");
  const auto saved=readJson(marker);
  if(saved["sha256"].string()!=sha256||saved["serverUrl"].string()!=serverUrl||saved["consoleId"].string()!=consoleId)throw std::runtime_error("NATIVE_INSTALL_STATE_MISMATCH");
  if(resetRequested){resetNativeSubmission(marker);return NativeSubmissionDecision::Submit;}
  if(saved["state"].string()=="SUBMITTING")return NativeSubmissionDecision::Uncertain;
  if(saved["state"].string()=="ACCEPTED")return NativeSubmissionDecision::Monitor;
  throw std::runtime_error("NATIVE_INSTALL_STATE_MISMATCH");
}
void beginNativeSubmission(const fs::path& marker,const std::string& sha256,const std::string& serverUrl,const std::string& consoleId){atomicJson(marker,submissionMarker("SUBMITTING",sha256,serverUrl,consoleId));}
void restoreNativeInstallTarget(const fs::path& marker){
#ifdef PS5
  if(!fs::exists(marker))return;if(fs::is_symlink(marker)||!fs::is_regular_file(marker))throw std::runtime_error("NATIVE_INSTALL_STATE_MISMATCH");auto saved=readJson(marker);if(saved["installLocationPrevious"].null()||saved["installLocationRestored"].boolean())return;const int key=static_cast<int>(saved["installLocationKey"].number()),previous=static_cast<int>(saved["installLocationPrevious"].number()),desired=static_cast<int>(saved["installLocationDesired"].number());if(key!=0x02880300||previous<0||previous>2||desired<0||desired>2)throw std::runtime_error("NATIVE_INSTALL_TARGET_STATE_INVALID");auto& api=nativeInstallLocationApi();if(!api)throw std::runtime_error("NATIVE_INSTALL_TARGET_UNAVAILABLE");NativeApiLock lock;int current=0;if(const auto result=api.get(key,&current))nativeInstallTargetFailure("READ_FAILED",result);if(current==desired&&previous!=desired){if(const auto result=api.set(key,previous))nativeInstallTargetFailure("RESTORE_FAILED",result);if(const auto result=api.get(key,&current))nativeInstallTargetFailure("RESTORE_VERIFY_FAILED",result);if(current!=previous)nativeInstallTargetFailure("RESTORE_MISMATCH");}else if(current!=previous)saved.set("installLocationRestoreSkipped",true);saved.set("installLocationRestored",true);atomicJson(marker,saved);
#else
  (void)marker;
#endif
}
void acceptNativeSubmission(const fs::path& marker,const std::string& sha256,const std::string& serverUrl,const std::string& consoleId){if(!fs::is_regular_file(marker))throw std::runtime_error("NATIVE_INSTALL_STATE_MISMATCH");auto saved=readJson(marker);if(saved["sha256"].string()!=sha256||saved["serverUrl"].string()!=serverUrl||saved["consoleId"].string()!=consoleId)throw std::runtime_error("NATIVE_INSTALL_STATE_MISMATCH");saved.set("state","ACCEPTED");atomicJson(marker,saved);}
void resetNativeSubmission(const fs::path& marker){restoreNativeInstallTarget(marker);std::error_code error;fs::remove(marker,error);if(error)throw std::runtime_error("NATIVE_INSTALL_STATE_MISMATCH");}
bool nativeDownloadsAvailable(){
#ifdef PS5
  static std::atomic<int> status{-1};static std::once_flag once;
  // Initialize off the render/heartbeat thread, once only. A hung initializer is never retried concurrently.
  std::call_once(once,[]{std::thread([]{NativeApiLock lock;status.store(sceAppInstUtilInitialize());}).detach();});return status.load()==0;
#else
  return false;
#endif
}
static void validateNativeDownload(const std::string& url,const std::string& contentId,const std::string& title,const std::string& iconUrl){
  const auto http=[](const std::string& value){return value.rfind("http://",0)==0||value.rfind("https://",0)==0;};if(url.size()>2048||!http(url)||!validContentId(contentId)||title.size()>200||iconUrl.size()>2048||(!iconUrl.empty()&&!http(iconUrl)))throw std::runtime_error("UNSUPPORTED_INPUT");
}
void startNativeDownload(const std::string& url,const std::string& contentId,const std::string& title,const std::string& iconUrl){
  if(!nativeDownloadsAvailable())throw std::runtime_error("NATIVE_INSTALLER_UNAVAILABLE");
  validateNativeDownload(url,contentId,title,iconUrl);
#ifdef PS5
  NativeApiLock lock;PackageInfo info{};PlayGoInfo playgo{};MetaInfo meta{url.c_str(),"","",contentId.c_str(),title.c_str(),iconUrl.c_str()};
  const int result=sceAppInstUtilInstallByPackage(&meta,&info,&playgo);
  if(result){char code[64];std::snprintf(code,sizeof(code),"NATIVE_INSTALL_REJECTED_%08X",static_cast<unsigned>(result));throw NativeSubmissionRejected(code);}
  if(std::string(info.contentId,strnlen(info.contentId,sizeof(info.contentId)))!=contentId)throw std::runtime_error("METADATA_MISMATCH");
  // Acceptance is not completion. Never call GetInstallStatus: upstream reports process crashes.
#endif
}
void submitNativeDownload(const fs::path& marker,const std::string& sha256,const std::string& serverUrl,const std::string& consoleId,const std::string& url,const std::string& contentId,const std::string& title,const std::string& iconUrl,int storageType){
  if(storageType< -1||storageType>2)throw std::runtime_error("UNSUPPORTED_INPUT");validateNativeDownload(url,contentId,title,iconUrl);if(!nativeDownloadsAvailable())throw std::runtime_error("NATIVE_INSTALLER_UNAVAILABLE");
  if(storageType<0)beginNativeSubmission(marker,sha256,serverUrl,consoleId);
#ifdef PS5
  else{
    auto& api=nativeInstallLocationApi();if(!api)throw NativeSubmissionRejected("NATIVE_INSTALL_TARGET_UNAVAILABLE");NativeApiLock lock;constexpr int key=0x02880300;const int desired=storageType==2?2:1;int previous=0;if(const auto result=api.get(key,&previous))nativeInstallTargetError("READ_FAILED",result);if(previous<0||previous>2)nativeInstallTargetError("STATE_INVALID");auto saved=submissionMarker("SUBMITTING",sha256,serverUrl,consoleId);saved.set("installLocationKey",key);saved.set("installLocationPrevious",previous);saved.set("installLocationDesired",desired);saved.set("installLocationRestored",false);atomicJson(marker,saved);
    auto reject=[&](const char* operation,int result=0){int current=0;bool restored=!api.get(key,&current)&&(current==previous||(current==desired&&!api.set(key,previous)&&!api.get(key,&current)&&current==previous));if(!restored)nativeInstallTargetFailure("ROLLBACK_FAILED");std::error_code error;fs::remove(marker,error);if(error)throw std::runtime_error("NATIVE_INSTALL_STATE_MISMATCH");nativeInstallTargetError(operation,result);};
    if(previous!=desired){int current=0;if(const auto result=api.set(key,desired))reject("WRITE_FAILED",result);if(const auto result=api.get(key,&current))reject("VERIFY_FAILED",result);if(current!=desired)reject("MISMATCH");}
  }
#else
  else throw std::runtime_error("NATIVE_INSTALL_TARGET_UNAVAILABLE");
#endif
  try{startNativeDownload(url,contentId,title,iconUrl);}catch(const NativeSubmissionRejected&){resetNativeSubmission(marker);throw;}catch(...){restoreNativeInstallTarget(marker);throw;}
  acceptNativeSubmission(marker,sha256,serverUrl,consoleId);
}
Json nativeDownloadStatus(const std::string& contentId){
  if(!validContentId(contentId))throw std::runtime_error("UNSUPPORTED_INPUT");
#ifdef PS5
  NativeApiLock lock;InstallStatus status{};const int result=sceAppInstUtilGetInstallStatus(contentId.c_str(),&status);
  if(result)return Json::object({{"available",false},{"result",result}});
  if(status.downloaded>static_cast<uint64_t>(std::numeric_limits<int64_t>::max())||status.initial>static_cast<uint64_t>(std::numeric_limits<int64_t>::max())||status.total>static_cast<uint64_t>(std::numeric_limits<int64_t>::max()))return Json::object({{"available",false},{"result",-ERANGE}});
  return Json::object({{"available",true},{"status",std::string(status.status,strnlen(status.status,sizeof(status.status)))},{"source",std::string(status.source,strnlen(status.source,sizeof(status.source)))},{"remainingSeconds",static_cast<int64_t>(status.remaining)},{"downloadedBytes",static_cast<int64_t>(status.downloaded)},{"initialChunkBytes",static_cast<int64_t>(status.initial)},{"totalBytes",static_cast<int64_t>(status.total)},{"promoteProgress",static_cast<int64_t>(status.promote)},{"errorCode",static_cast<int64_t>(status.error.code)},{"localCopyPercent",static_cast<int64_t>(status.copyPercent)},{"copyOnly",status.copyOnly}});
#else
  return Json::object({{"available",false},{"result",-ENOSYS}});
#endif
}
fs::path installedNativePackage(const std::string& titleId,const fs::path& storageRoot){
  if(!std::regex_match(titleId,std::regex("PPSA[0-9]{5}")))throw std::runtime_error("METADATA_MISMATCH");
  if(storageRoot.empty())throw std::runtime_error("STORAGE_UNAVAILABLE");
  const auto suffix=titleId+"/app.pkg";std::vector<fs::path> candidates;
  if(storageRoot=="/user")candidates.push_back(beneath(storageRoot,"app/"+suffix));
  else{candidates.push_back(beneath(storageRoot,"user/app/"+suffix));candidates.push_back(beneath(storageRoot,"ps5/user/app/"+suffix));}
  for(const auto& candidate:candidates)if(fs::is_regular_file(candidate)&&sameStorageDevice(candidate,storageRoot))return candidate;
  auto logical=beneath("/user","app/"+suffix);if(storageRoot!="/user"&&fs::is_regular_file(logical)&&sameStorageDevice(logical,storageRoot))return logical;
  return candidates.front();
}
bool sameStorageDevice(const fs::path& path,const fs::path& storageRoot){struct stat item{},root{};return stat(path.c_str(),&item)==0&&stat(storageRoot.c_str(),&root)==0&&item.st_dev==root.st_dev;}
bool nativePackageRegistered(const Json& task){
  try{
    auto metadata=readJson(beneath("/user","appmeta/"+task["titleId"].string()+"/param.json"));
    return metadata["titleId"].string()==task["titleId"].string()&&metadata["contentId"].string()==task["contentId"].string()&&metadata["contentVersion"].string()==task["version"].string();
  }catch(...){return false;}
}
bool validateNativeUpdateBase(const Json& task,const Json& installed,int installedStorageType,int targetStorageType){
  static const std::regex version("[0-9]{2}\\.[0-9]{3}\\.[0-9]{3}");const auto base=task["baseContentVersion"].string(),target=task["version"].string();
  const auto current=installed["contentVersion"].string();if(task["releaseKind"].string()!="UPDATE"||!std::regex_match(base,version)||!std::regex_match(target,version)||target<=base||installed["titleId"].string()!=task["titleId"].string()||installed["contentId"].string()!=task["contentId"].string()||(current!=base&&current!=target))throw std::runtime_error("NATIVE_UPDATE_BASE_MISMATCH");
  if(installedStorageType<0||installedStorageType!=targetStorageType)throw std::runtime_error("NATIVE_UPDATE_STORAGE_MISMATCH");
  return current==target;
}
void uninstallNativeTitle(const std::string& titleId){
  if(!std::regex_match(titleId,std::regex("(PPSA|CUSA)[0-9]{5}")))throw std::runtime_error("METADATA_MISMATCH");
#ifdef PS5
  if(!nativeDownloadsAvailable())throw std::runtime_error("NATIVE_INSTALLER_UNAVAILABLE");NativeApiLock lock;const int result=sceAppInstUtilAppUnInstall(titleId.c_str());if(result){char code[64];std::snprintf(code,sizeof(code),"NATIVE_UNINSTALL_REJECTED_%08X",static_cast<unsigned>(result));throw std::runtime_error(code);}
#else
  throw std::runtime_error("NATIVE_INSTALLER_UNAVAILABLE");
#endif
}
}
