#include "../common/client.hpp"
#include <atomic>
#include <thread>
#include <mutex>
#include <regex>
#include <cstring>
#include <cstdio>
#include <limits>
#include <array>
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
int nativeMoveStorageType(const std::string& path,const std::string& device,const std::string& filesystem){
  if(path=="/user")return 0;
  if(path=="/mnt/ext0"&&filesystem=="ufs"&&device.size()>=6&&device.compare(device.size()-6,6,".crypt")==0)return 1;
  if(path=="/mnt/ext1"&&filesystem=="bfs"&&(device.rfind("/dev/ssd",0)==0||device.rfind("/dev/nvme",0)==0))return 2;
  return -1;
}
#ifdef PS5
// 4.50/4.51 ShellCore ABI: title IDs occupy 12-byte slots and progress is a 0x150-byte record with state at offset zero.
struct NativeMoveApi {
  using Exists=int(*)(const char*,unsigned char*);using GetStorage=int(*)(const char*,int*);using Request=int(*)(int,int,const char*,size_t,int);using Progress=int(*)(void*);using Cancel=int(*)();
  void* module=nullptr;Exists exists=nullptr;GetStorage getStorage=nullptr;Request request=nullptr;Progress progress=nullptr;Cancel cancel=nullptr;
  NativeMoveApi(){
    module=dlopen("libSceAppInstUtil.sprx",RTLD_NOW|RTLD_LOCAL);if(!module)module=dlopen("/system/common/lib/libSceAppInstUtil.sprx",RTLD_NOW|RTLD_LOCAL);if(!module)return;
    exists=reinterpret_cast<Exists>(dlsym(module,"sceAppInstUtilAppExists"));getStorage=reinterpret_cast<GetStorage>(dlsym(module,"sceAppInstUtilAppGetStorageDestType"));request=reinterpret_cast<Request>(dlsym(module,"sceAppInstUtilAppRequestMoveApps"));progress=reinterpret_cast<Progress>(dlsym(module,"sceAppInstUtilGetAppMoveProgressInfo"));cancel=reinterpret_cast<Cancel>(dlsym(module,"sceAppInstUtilAppCancelMoveApps"));
  }
  explicit operator bool() const{return exists&&getStorage&&request&&progress&&cancel;}
};
static NativeMoveApi& nativeMoveApi(){static NativeMoveApi api;return api;}
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
bool nativeMoveTargetAvailable(const Json& volumes,int sourceStorageType){
  if(sourceStorageType<0||sourceStorageType>2)return false;
  for(size_t i=0;i<volumes.size();i++){const auto type=volumes[i]["nativeMoveStorageType"].number(-1);if(type>=0&&type<=2&&type!=sourceStorageType)return true;}
  return false;
}
fs::path observedNativePackage(const Json& installed,const Json& volumes){
  if(!installed["nativeRegistered"].boolean())return {};
  const auto titleId=installed["titleId"].string(),storageId=installed["storageId"].string();if(!std::regex_match(titleId,std::regex("PPSA[0-9]{5}"))||storageId.empty())return {};
  for(size_t i=0;i<volumes.size();i++)if(volumes[i]["storageId"].string()==storageId){const auto type=volumes[i]["nativeMoveStorageType"].number(-1);if(type<0||type>2)continue;auto file=installedNativePackage(titleId,volumes[i]["path"].string());if(fs::is_regular_file(file)&&sameStorageDevice(file,volumes[i]["path"].string()))return file;}
  return {};
}
bool verifiedReceiptFile(const fs::path& file,const Json& receipt,std::unordered_map<std::string,std::pair<fs::file_time_type,std::string>>& cache,const std::function<bool()>& cancelled){
  if(!fs::is_regular_file(file)||static_cast<int64_t>(fs::file_size(file))!=receipt["size"].number())return false;auto stamp=fs::last_write_time(file);auto found=cache.find(file.string());if(found==cache.end()||found->second.first!=stamp)cache[file.string()]={stamp,fileHash(file,cancelled)};return cache[file.string()].second==receipt["sha256"].string();
}
Json nativeMoveTitle(const std::string& titleId,const std::string& contentId,int sourceStorageType,int destinationStorageType){
  if(!std::regex_match(titleId,std::regex("(PPSA|CUSA)[0-9]{5}"))||!std::regex_match(contentId,std::regex("[A-Z]{2}[0-9]{4}-"+titleId+"_[0-9]{2}-[A-Z0-9]{16}"))||sourceStorageType<0||sourceStorageType>2||destinationStorageType<0||destinationStorageType>2||sourceStorageType==destinationStorageType)throw std::runtime_error("MOVE_UNAVAILABLE");
#ifdef PS5
  if(!nativeDownloadsAvailable())throw std::runtime_error("NATIVE_INSTALLER_UNAVAILABLE");auto& api=nativeMoveApi();if(!api)throw std::runtime_error("NATIVE_MOVE_UNAVAILABLE");NativeApiLock lock;
  const auto current=nativeTitleStorageType(api,titleId,contentId);if(current<0)throw std::runtime_error("NATIVE_MOVE_TITLE_NOT_FOUND");if(current!=sourceStorageType)throw std::runtime_error("NATIVE_MOVE_SOURCE_MISMATCH");
  const auto state=nativeMoveState(api);if(state==2)throw std::runtime_error("NATIVE_MOVE_BUSY");
  std::array<char,12> ids{};std::memcpy(ids.data(),titleId.data(),titleId.size());nativeMoveResult("REJECTED",api.request(sourceStorageType,destinationStorageType,ids.data(),1,0));
  return Json::object({{"accepted",true},{"operation","native-move"},{"sourceStorageType",sourceStorageType},{"destinationStorageType",destinationStorageType}});
#else
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
void acceptNativeSubmission(const fs::path& marker,const std::string& sha256,const std::string& serverUrl,const std::string& consoleId){atomicJson(marker,submissionMarker("ACCEPTED",sha256,serverUrl,consoleId));}
void resetNativeSubmission(const fs::path& marker){std::error_code error;fs::remove(marker,error);if(error)throw std::runtime_error("NATIVE_INSTALL_STATE_MISMATCH");}
bool nativeDownloadsAvailable(){
#ifdef PS5
  static std::atomic<int> status{-1};static std::once_flag once;
  // Initialize off the render/heartbeat thread, once only. A hung initializer is never retried concurrently.
  std::call_once(once,[]{std::thread([]{NativeApiLock lock;status.store(sceAppInstUtilInitialize());}).detach();});return status.load()==0;
#else
  return false;
#endif
}
void startNativeDownload(const std::string& url,const std::string& contentId,const std::string& title,const std::string& iconUrl){
  if(!nativeDownloadsAvailable())throw std::runtime_error("NATIVE_INSTALLER_UNAVAILABLE");
  const auto http=[](const std::string& value){return value.rfind("http://",0)==0||value.rfind("https://",0)==0;};
  if(url.size()>2048||!http(url)||!validContentId(contentId)||title.size()>200||iconUrl.size()>2048||(!iconUrl.empty()&&!http(iconUrl)))throw std::runtime_error("UNSUPPORTED_INPUT");
#ifdef PS5
  NativeApiLock lock;PackageInfo info{};PlayGoInfo playgo{};MetaInfo meta{url.c_str(),"","",contentId.c_str(),title.c_str(),iconUrl.c_str()};
  const int result=sceAppInstUtilInstallByPackage(&meta,&info,&playgo);
  if(result){char code[64];std::snprintf(code,sizeof(code),"NATIVE_INSTALL_REJECTED_%08X",static_cast<unsigned>(result));throw NativeSubmissionRejected(code);}
  if(std::string(info.contentId,strnlen(info.contentId,sizeof(info.contentId)))!=contentId)throw std::runtime_error("METADATA_MISMATCH");
  // Acceptance is not completion. Never call GetInstallStatus: upstream reports process crashes.
#endif
}
void submitNativeDownload(const fs::path& marker,const std::string& sha256,const std::string& serverUrl,const std::string& consoleId,const std::string& url,const std::string& contentId,const std::string& title,const std::string& iconUrl){
  beginNativeSubmission(marker,sha256,serverUrl,consoleId);
  try{startNativeDownload(url,contentId,title,iconUrl);}catch(const NativeSubmissionRejected&){resetNativeSubmission(marker);throw;}
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
void uninstallNativeTitle(const std::string& titleId){
  if(!std::regex_match(titleId,std::regex("(PPSA|CUSA)[0-9]{5}")))throw std::runtime_error("METADATA_MISMATCH");
#ifdef PS5
  if(!nativeDownloadsAvailable())throw std::runtime_error("NATIVE_INSTALLER_UNAVAILABLE");NativeApiLock lock;const int result=sceAppInstUtilAppUnInstall(titleId.c_str());if(result){char code[64];std::snprintf(code,sizeof(code),"NATIVE_UNINSTALL_REJECTED_%08X",static_cast<unsigned>(result));throw std::runtime_error(code);}
#else
  throw std::runtime_error("NATIVE_INSTALLER_UNAVAILABLE");
#endif
}
}
