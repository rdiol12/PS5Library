#include "../common/client.hpp"
#include "../common/version.hpp"
#include "storage_format.hpp"
#include <chrono>
#include <thread>
#include <fstream>
#include <regex>
#include <unordered_map>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#ifdef PS5
#include <ps5/kernel.h>
#include <sys/mount.h>
struct SystemSoftwareVersion {uint64_t size;char text[28];uint32_t version;uint64_t reserved;};
extern "C" int sceKernelGetProsperoSystemSwVersion(SystemSoftwareVersion*);
#endif
namespace ps5library {
bool sameInventoryRelease(const Json& receipt,const Json& installed){return receipt["titleId"].string()==installed["titleId"].string()&&(installed["registrationBlocked"].boolean()||(receipt["contentId"].string()==installed["contentId"].string()&&receipt["version"].string()==installed["version"].string()));}
static bool numberedMount(const std::string& path,const char* prefix){const auto size=std::strlen(prefix);if(path.size()<=size||path.rfind(prefix,0)!=0)return false;for(size_t i=size;i<path.size();i++)if(path[i]<'0'||path[i]>'9')return false;return true;}
bool exactStorageMount(const std::string& path,const std::string& mountedAt){return path==mountedAt;}
bool ps5ManagedUsbStorage(const std::string& path,const std::string& device,const std::string& type){return path=="/mnt/ext0"&&device.size()>=6&&device.compare(device.size()-6,6,".crypt")==0&&type=="ufs";}
std::string discoveredStorageName(const std::string& path,const std::string& device,const std::string& type){
  if(ps5ManagedUsbStorage(path,device,type))return "USB Extended Storage";
  if(numberedMount(path,"/mnt/ext"))return type=="bfs"&&(device.rfind("/dev/ssd",0)==0||device.rfind("/dev/nvme",0)==0)?"M.2 SSD":"PS5-managed External Storage";
  if(numberedMount(path,"/mnt/usb"))return "USB Storage";
  return "Storage";
}
static Json agentClientConfig(const Json& source){auto config=Json::parse(source.dump());if(config["serverUrl"].string().empty()){config.set("serverUrl","http://127.0.0.1:9");config.set("allowInsecureLan",true);}return config;}
static Json localAgentState(const fs::path& path){Json previous;try{if(fs::is_regular_file(path)&&!fs::is_symlink(path))previous=readJson(path);}catch(...){ }auto state=Json::object({{"deviceId",previous["deviceId"].string().empty()?deviceId():previous["deviceId"]},{"serverUrl",""},{"libraryRevision",previous["libraryRevision"].number()}});if(!previous["firmware"].null())state.set("firmware",previous["firmware"]);if(!previous["firmwareChecked"].null())state.set("firmwareChecked",previous["firmwareChecked"]);return state;}
std::string firmwareVersion(uint32_t raw) {
  auto major=(raw>>24)&0xff,minor=(raw>>16)&0xff;
  if(!raw || (major&15)>9 || (major>>4)>9 || (minor&15)>9 || (minor>>4)>9) return {};
  char result[24]; std::snprintf(result,sizeof(result),"%u.%02u",(major>>4)*10+(major&15),(minor>>4)*10+(minor&15)); return result;
}
std::string registrationFirmware(uint32_t actual,uint32_t library){
  // The library records its SDK baseline (e.g. 4.50 on 4.51). Use the system API's patch version.
  // A report outside that minor family may be spoofed; leave compatibility unknown instead of guessing.
  if(firmwareVersion(library).empty()||actual<library||(actual&0xfff00000)!=(library&0xfff00000))return {};
  return firmwareVersion(actual);
}
static Json measureFirmware(const Json& config) {
#ifdef PS5
  (void)config;SystemSoftwareVersion system{};system.size=sizeof(system);
  auto value=sceKernelGetProsperoSystemSwVersion(&system)==0?registrationFirmware(system.version,kernel_get_fw_version()):std::string();return value.empty()?Json():Json(value);
#else
  return config["firmware"];
#endif
}
Agent::Agent(const fs::path& configPath):config_(readJson(configPath)),statePath_(configPath.parent_path()/"device-state.json"),client(agentClientConfig(config_)) {
  state_=config_["serverUrl"].string().empty()?localAgentState(statePath_):loadDeviceState(configPath,config_);
  if(!state_["firmwareChecked"].boolean()){state_.set("firmware",measureFirmware(config_));state_.set("firmwareChecked",true);}
#ifdef PS5
  try{const auto status=readJson(configPath.parent_path()/"external-fpkg-patch.json")["status"].string();externalFpkg_=status=="APPLIED"||status=="ALREADY_APPLIED";}catch(...){externalFpkg_=false;}
#endif
  client.credential=state_["credential"].string(); atomicJson(statePath_,state_);
}
Json Agent::pair() {
  if(paired()) return Json::object({{"status","PAIRED"}});
  if(state_["pairing"].null()) {
#ifdef PS5
    const char* kind="PS5";
#else
    const char* kind="SIMULATOR";
#endif
    auto pairing=client.request("POST","/api/v1/pairings",Json::object({{"deviceId",state_["deviceId"]},{"name",config_["name"].string("My PS5")},{"clientKind",kind},{"firmware",state_["firmware"]}}));
    state_.set("pairing",pairing); atomicJson(statePath_,state_);
    notify("Pair this console using code "+pairing["code"].string());
  }
  auto pairing=state_["pairing"];
  Json result;try{result=client.request("POST","/api/v1/pairings/"+pairing["id"].string()+"/poll",Json::object({{"pollSecret",pairing["pollSecret"]}}));}catch(const std::exception& e){if(std::string(e.what())=="PAIRING_EXPIRED"){state_.set("pairing",Json());atomicJson(statePath_,state_);}throw;}
  if(result["status"].string()=="PAIRED") {
    state_.set("credential",result["credential"]); state_.set("consoleId",result["consoleId"]); state_.set("pairing",Json());
    client.credential=result["credential"].string(); atomicJson(statePath_,state_); notify("Console connected to your library");
  }
  return paired()?result:pairing;
}
Json Agent::storage() const {
  auto result=Json::array(); auto configured=Json::parse(config_["storage"].dump());if(configured.null())configured=Json::array();
#ifdef PS5
  configured.add(Json::object({{"storageId","internal-installed"},{"displayName","PS5-managed install storage"},{"path","/user"},{"inventoryOnly",true}}));
  for(int index=0;index<10;index++) {
    const auto id=index<2?"ext"+std::to_string(index):"usb"+std::to_string(index-2),root="/mnt/"+id;
    bool exists=false;for(size_t i=0;i<configured.size();i++)if(configured[i]["path"].string()==root)exists=true;
    struct statfs mounted{};
    if(!exists&&statfs(root.c_str(),&mounted)==0&&exactStorageMount(root,std::string(mounted.f_mntonname,strnlen(mounted.f_mntonname,sizeof(mounted.f_mntonname)))))configured.add(Json::object({{"storageId",id},{"displayName",discoveredStorageName(root,mounted.f_mntfromname,mounted.f_fstypename)},{"path",root}}));
  }
#endif
  for(size_t i=0;i<configured.size();i++) {
    auto item=configured[i]; auto root=item["path"].string();
    if(!fs::is_directory(root)) continue;
#ifdef PS5
    struct statfs mounted{};
    if(statfs(root.c_str(),&mounted)||((numberedMount(root,"/mnt/usb")||numberedMount(root,"/mnt/ext"))&&
       !exactStorageMount(root,std::string(mounted.f_mntonname,strnlen(mounted.f_mntonname,sizeof(mounted.f_mntonname))))))continue;
    if(mounted.f_bsize<=0||mounted.f_blocks>UINT64_MAX/static_cast<uint64_t>(mounted.f_bsize))continue;
    const auto capacity=static_cast<uint64_t>(mounted.f_blocks)*static_cast<uint64_t>(mounted.f_bsize);
    const auto freeBlocks=mounted.f_bavail>0?std::min<uint64_t>(mounted.f_blocks,static_cast<uint64_t>(mounted.f_bavail)):0;
    const auto available=freeBlocks*static_cast<uint64_t>(mounted.f_bsize);
#else
    std::error_code error;auto space=fs::space(root,error);if(error)continue;const auto capacity=space.capacity,available=space.available;
#endif
    bool nativeInstall=false,nativeMove=false;int moveType=-1;
#ifdef PS5
    nativeInstall=root=="/user"&&(config_["nativePackageDownloads"].null()||config_["nativePackageDownloads"].boolean())&&nativeDownloadsAvailable();
    if(root=="/user"||statfs(root.c_str(),&mounted)==0)moveType=nativeMoveStorageType(root,mounted.f_mntfromname,mounted.f_fstypename);nativeMove=moveType>=0&&nativeMovesAvailable();
#endif
    bool moveInstall=false;
#ifdef PS5
    moveInstall=nativeMove&&(moveType==2||(moveType==1&&externalFpkg_&&ps5ManagedUsbStorage(root,mounted.f_mntfromname,mounted.f_fstypename)));
#endif
    auto methods=Json::array();if(!item["inventoryOnly"].boolean())methods.add("HOMEBREW");if(nativeInstall||moveInstall)methods.add("FPKG");
#ifdef PS5
    if(!item["inventoryOnly"].boolean() && shadowMountSupported(shadowMount_)) methods.add("SHADOWMOUNT");
#endif
    auto volume=Json::object({{"storageId",item["storageId"]},{"displayName",item["displayName"]},{"path",fs::canonical(root).string()},
      {"totalBytes",static_cast<int64_t>(capacity)},{"freeBytes",static_cast<int64_t>(available)},{"writable",nativeInstall||nativeMove||(!item["inventoryOnly"].boolean()&&access(root.c_str(),W_OK)==0)},{"installMethodsSupported",methods},{"nativeMoveStorageType",moveType>=0?Json(static_cast<int64_t>(moveType)):Json()}});
#ifdef PS5
    if(numberedMount(root,"/mnt/usb")){auto format=storageFormatCoordinator().describe(item["storageId"].string());for(const auto* key:{"formatEligible","formatState","formatProgress","formatError"})volume.set(key,format[key]);}
#endif
    result.add(volume);
  }
  return result;
}
Json Agent::inventory(){return inventory(storage());}
Json Agent::inventory(const Json& volumes) {
  auto result=Json::array();inventoryComplete_=true;
  // Hash on first sight and after a size/mtime change; never rehash a 50 GB file every heartbeat.
  for(size_t i=0;i<volumes.size();i++) {
    auto root=fs::path(volumes[i]["path"].string()); auto receipts=beneath(root,".ps5library/receipts");
    if(!fs::exists(receipts)) continue;
    for(const auto& entry:fs::directory_iterator(receipts)) {
      if(entry.is_symlink() || !entry.is_regular_file() || entry.path().extension()!=".json") continue;
      auto receipt=readJson(entry.path());
      if(receipt["serverUrl"].string()!=state_["serverUrl"].string()||receipt["consoleId"].string().empty()||receipt["consoleId"].string()!=state_["consoleId"].string())continue;
      fs::path expected;for(size_t v=0;v<volumes.size();v++)if(volumes[v]["storageId"].string()==receipt["storageId"].string())expected=volumes[v]["path"].string();
      auto file=receipt["method"].string()=="FPKG"?expected.empty()?fs::path():installedNativePackage(receipt["titleId"].string(),expected):beneath(root,receipt["relativePath"].string());
      bool present=verifiedReceiptFile(file,receipt,verified_,client.cancelled);
      if(present&&receipt["method"].string()=="FPKG")present=sameStorageDevice(file,expected);
      if(present&&!receipt["backport"].null())try{present=verifyBackport(beneath(receipt["backport"]["root"].string(),receipt["backport"]["relativePath"].string()),receipt["backport"]);}catch(...){present=false;}
      if(present&&receipt["method"].string()=="FPKG")present=nativePackageRegistered(receipt);
      receipt.set("available",present); result.add(receipt);
    }
  }
  auto existing=discoverDumps(volumes);for(size_t i=0;i<existing.size();i++)result.add(existing[i]);
  auto installed=discoverInstalled(volumes);for(size_t i=0;i<installed.size();i++){bool merged=false;for(size_t n=0;n<result.size();n++)if(sameInventoryRelease(result[n],installed[i])){if(installed[i]["registrationBlocked"].boolean())result[n].set("registrationBlocked",true);if(installed[i]["nativeRegistered"].boolean()){result[n].set("registered",true);result[n].set("nativeRegistered",true);if(result[n]["method"].string()=="FPKG")try{auto file=observedNativePackage(installed[i],volumes);bool present=!file.empty()&&verifiedReceiptFile(file,result[n],verified_,client.cancelled)&&nativePackageRegistered(result[n]);if(present&&!result[n]["backport"].null())present=verifyBackport(beneath(result[n]["backport"]["root"].string(),result[n]["backport"]["relativePath"].string()),result[n]["backport"]);result[n].set("available",present);if(present){result[n].set("storageId",installed[i]["storageId"]);result[n].set("relativePath",installed[i]["relativePath"]);}}catch(...){result[n].set("available",false);inventoryComplete_=false;}}merged=true;break;}if(!merged&&installed[i]["available"].boolean())result.add(installed[i]);}
  return result;
}
Json Agent::localSnapshot() {
  auto observed=runtimeStatus();
  auto capabilities=Json::object({{"homebrew",true},{"storageEnumeration",true},{"inventoryScan",true},{"rangeDownloads",true},{"persistentAgent",false},{"nativeNotifications",false},{"nativeUpdateBridge",false},{"shadowMount",false},{"fpkgInstall",false},{"backportOverlay",false},{"shellIntegration",false},{"remotePlayPairing",false},{"saveBackup",false},{"saveExport",false},{"saveImport",false},{"saveRollback",false}});
  Json firmware=state_["firmware"];
#ifdef PS5
  capabilities.set("nativeNotifications",notifications());
  capabilities.set("saveBackup",access("/user/home",R_OK)==0);
  const auto portableSaves=portableSaveAvailable();capabilities.set("saveExport",portableSaves);capabilities.set("saveImport",portableSaves);capabilities.set("saveRollback",portableSaves);
  capabilities.set("remotePlayPairing",remotePlayAvailable());
  capabilities.set("nativeDownloads",(config_["nativePackageDownloads"].null()||config_["nativePackageDownloads"].boolean())&&nativeDownloadsAvailable());capabilities.set("fpkgInstall",capabilities["nativeDownloads"]);capabilities.set("nativeUpdateBridge",capabilities["nativeDownloads"].boolean()&&nativeUpdateBridgeAvailable());
  capabilities.set("nativeDownloadProgress",capabilities["nativeDownloads"].boolean()&&config_["nativeInstallProgress"].boolean());
  const auto now=std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now().time_since_epoch()).count();
  if(observed["shadowMount"].string()!="RUNNING"){shadowMount_=Json();shadowMountRoots_=Json::array();shadowMountGames_=Json::array();shadowMountPort_=0;shadowMountCheckedMs_=0;}
  else if(shadowMountRefreshDue(shadowMountCheckedMs_,now,shadowMountSupported(shadowMount_))){
    shadowMountCheckedMs_=now;
    try{
      std::string settings;auto file=fs::path("/data/shadowmount/config.ini");if(fs::is_regular_file(file)){if(fs::file_size(file)>65536)throw std::runtime_error("ShadowMount settings too large");std::ifstream input(file);settings.assign(std::istreambuf_iterator<char>(input),{});}
      const auto port=shadowMountPort(settings);if(!port){shadowMount_=Json();shadowMountRoots_=Json::array();shadowMountGames_=Json::array();shadowMountPort_=0;}
      else {auto version=shadowMountRequest(port,"/api/v1/version",Json::object(),client.cancelled),roots=Json::array(),games=Json::array();if(shadowMountSupported(version)){roots=shadowMountScanRoots(shadowMountRequest(port,"/api/v1/settings",Json::object(),client.cancelled),version);games=shadowMountRequest(port,"/api/v1/games",Json::object({{"include_size",false}}),client.cancelled)["games"];}shadowMountPort_=port;shadowMount_=version;shadowMountRoots_=roots;shadowMountGames_=games;}
    }catch(const std::exception&){/* Keep the last verified capability snapshot after a transient API failure. */}
  }
  capabilities.set("shadowMount",shadowMountSupported(shadowMount_));
  capabilities.set("gameDeletion",shadowMountDeletionSupported(shadowMount_));
  capabilities.set("gameMove",shadowMountMoveSupported(shadowMount_));
  capabilities.set("backportOverlay",shadowMountPkgBackportSupported(shadowMount_)&&shadowMountRoots_.size()>0&&observed["fakelibEnabled"].boolean()&&observed["backPork"].string()!="RUNNING");
#endif
  auto volumes=storage(),items=inventory(volumes);auto shadowGames=shadowMountGames_;bool nativeGameMove=false;if(nativeMovesAvailable())for(size_t v=0;v<volumes.size();v++){auto source=static_cast<int>(volumes[v]["nativeMoveStorageType"].number(-1));nativeGameMove|=nativeMoveTargetAvailable(volumes,source);}
  auto itemPath=[&](const Json& item){for(size_t v=0;v<volumes.size();v++)if(volumes[v]["storageId"].string()==item["storageId"].string())return item["method"].string()=="FPKG"?installedNativePackage(item["titleId"].string(),volumes[v]["path"].string()):beneath(volumes[v]["path"].string(),item["relativePath"].string());return fs::path();};
  for(size_t i=0;i<items.size();i++){auto item=items[i];bool matched=false;for(size_t g=0;g<shadowGames.size();g++)if(shadowGames[g]["title_id"].string()==item["titleId"].string())try{const auto path=itemPath(item);if(!path.empty()&&fs::canonical(path)==fs::canonical(shadowGames[g]["path"].string())){matched=shadowGames[g]["source_available"].boolean();if(shadowGames[g]["installed"].boolean())item.set("registered",true);break;}}catch(...){ }const auto source=item["source"].string();int nativeSource=-1;for(size_t v=0;v<volumes.size();v++)if(volumes[v]["storageId"].string()==item["storageId"].string())nativeSource=static_cast<int>(volumes[v]["nativeMoveStorageType"].number(-1));const bool nativeMovable=nativeGameMove&&item["nativeRegistered"].boolean()&&nativeMoveTargetAvailable(volumes,nativeSource);item.set("canDelete",item["nativeRegistered"].boolean()||source=="INSTALLED_TITLE"||(item["method"].string()=="FPKG"&&item["registered"].boolean())||(matched&&shadowMountDeletionSupported(shadowMount_)));item.set("canMove",nativeMovable||(matched&&source!="INSTALLED_TITLE"&&shadowMountMoveSupported(shadowMount_)));}
  capabilities.set("gameMove",capabilities["gameMove"].boolean()||nativeGameMove);
  auto runtime=config_["runtime"].string("unknown");if((runtime.empty()||runtime=="unknown")&&!detectedRuntime_.empty())runtime=detectedRuntime_;
  auto revision=state_["libraryRevision"].number()+1; state_.set("libraryRevision",revision); atomicJson(statePath_,state_);
  return Json::object({{"firmware",firmware},{"runtime",runtime},{"runtimeStatus",observed},{"clientVersion",appVersion},{"agentVersion",appVersion},{"trophySummary",trophies()},{"saveData",saves()},{"capabilities",capabilities},{"storage",volumes},{"storageFormat",storageFormatCoordinator().state()},{"libraryRevision",revision},{"inventoryComplete",inventoryComplete_},{"inventory",items},{"activeTransfers",Json::array()},
    {"shadowMountVersion",shadowMountSupported(shadowMount_)?shadowMount_["shadowmount_version"]:Json()},{"shadowMountFakelib",observed["fakelibEnabled"].boolean()},{"standaloneBackPork",observed["backPork"].string()=="RUNNING"}});
}
Json Agent::localDelete(const std::string& titleId,const std::string& storageId){
  if(!std::regex_match(titleId,std::regex("(PPSA|CUSA)[0-9]{5}"))||storageId.empty())throw std::runtime_error("METADATA_MISMATCH");
  auto volumes=storage(),items=inventory();Json item;for(size_t i=0;i<items.size();i++)if(items[i]["titleId"].string()==titleId&&items[i]["storageId"].string()==storageId&&items[i]["available"].boolean()){item=items[i];break;}if(item.null())throw std::runtime_error("GAME_NOT_FOUND");
  if(item["source"].string()=="INSTALLED_TITLE"||item["method"].string()=="FPKG"){uninstallNativeTitle(titleId);return Json::object({{"accepted",true},{"operation","uninstall"}});}
  fs::path source;for(size_t i=0;i<volumes.size();i++)if(volumes[i]["storageId"].string()==storageId)source=beneath(volumes[i]["path"].string(),item["relativePath"].string());if(source.empty())throw std::runtime_error("STORAGE_UNAVAILABLE");bool matched=false;if(shadowMountDeletionSupported(shadowMount_)){auto games=shadowMountRequest(shadowMountPort_,"/api/v1/games",Json::object({{"include_size",false}}),client.cancelled)["games"];for(size_t i=0;i<games.size();i++)if(games[i]["title_id"].string()==titleId&&games[i]["source_available"].boolean())try{matched|=fs::canonical(source)==fs::canonical(games[i]["path"].string());}catch(...){ }}if(matched)return shadowMountRequest(shadowMountPort_,"/api/v1/games/delete",Json::object({{"title_id",titleId},{"confirm",true}}),client.cancelled);if(item["nativeRegistered"].boolean()){uninstallNativeTitle(titleId);return Json::object({{"accepted",true},{"operation","uninstall"}});}throw std::runtime_error("SHADOWMOUNT_SOURCE_MISMATCH");
}
Json Agent::localMove(const std::string& titleId,const std::string& sourceStorageId,const std::string& storageId){
  if(!std::regex_match(titleId,std::regex("(PPSA|CUSA)[0-9]{5}"))||sourceStorageId.empty()||storageId.empty())throw std::runtime_error("MOVE_UNAVAILABLE");
  auto volumes=storage(),items=inventory();Json item;for(size_t i=0;i<items.size();i++)if(items[i]["titleId"].string()==titleId&&items[i]["storageId"].string()==sourceStorageId&&items[i]["available"].boolean()){item=items[i];break;}if(item.null()||sourceStorageId==storageId)throw std::runtime_error("MOVE_UNAVAILABLE");
#ifdef PS5
  if(item["nativeRegistered"].boolean()){
    auto type=[&](const std::string& id){for(size_t i=0;i<volumes.size();i++)if(volumes[i]["storageId"].string()==id){auto path=volumes[i]["path"].string();if(path=="/user")return 0;struct statfs mounted{};if(statfs(path.c_str(),&mounted))return -1;return nativeMoveStorageType(path,mounted.f_mntfromname,mounted.f_fstypename);}return -1;};
    const auto source=type(sourceStorageId),destination=type(storageId);if(source<0||destination<0)throw std::runtime_error("STORAGE_UNAVAILABLE");return nativeMoveTitle(titleId,item["contentId"].string(),source,destination);
  }
#endif
  if(item["source"].string()=="INSTALLED_TITLE"||!shadowMountMoveSupported(shadowMount_))throw std::runtime_error("MOVE_UNAVAILABLE");
  fs::path source,destinationRoot;for(size_t i=0;i<volumes.size();i++){if(volumes[i]["storageId"].string()==item["storageId"].string())source=beneath(volumes[i]["path"].string(),item["relativePath"].string());if(volumes[i]["storageId"].string()==storageId)destinationRoot=volumes[i]["path"].string();}if(source.empty()||destinationRoot.empty())throw std::runtime_error("STORAGE_UNAVAILABLE");
  auto games=shadowMountRequest(shadowMountPort_,"/api/v1/games",Json::object({{"include_size",false}}),client.cancelled)["games"];bool matched=false;for(size_t i=0;i<games.size();i++)if(games[i]["title_id"].string()==titleId&&games[i]["source_available"].boolean())try{matched|=fs::canonical(source)==fs::canonical(games[i]["path"].string());}catch(...){ }if(!matched)throw std::runtime_error("SHADOWMOUNT_SOURCE_MISMATCH");
  auto destinations=shadowMountRequest(shadowMountPort_,"/api/v1/storage",Json::object(),client.cancelled)["destinations"];std::string destination;auto root=fs::canonical(destinationRoot).string();for(size_t i=0;i<destinations.size();i++){auto path=destinations[i]["path"].string();if(!destinations[i]["read_only"].boolean()&&(path==root||path.rfind(root+"/",0)==0)&&(destination.empty()||path.size()<destination.size()))destination=path;}if(destination.empty())throw std::runtime_error("STORAGE_UNAVAILABLE");return shadowMountRequest(shadowMountPort_,"/api/v1/games/move",Json::object({{"title_id",titleId},{"destination_dir",destination}}),client.cancelled);
}
Json Agent::heartbeat() {
  auto body=localSnapshot();
  auto reply=client.request("POST","/api/v1/device/heartbeat",body);
  heartbeatBody_=Json::parse(body.dump());heartbeatBody_.set("inventory",Json::array());heartbeatBody_.set("inventoryComplete",false);
  const auto serverRevision=reply["libraryRevision"].number();
  if(serverRevision>state_["libraryRevision"].number()){state_.set("libraryRevision",serverRevision);atomicJson(statePath_,state_);}
  if(!reply["firmwareRequestId"].string().empty()){
    auto value=measureFirmware(config_);
    client.request("POST","/api/v1/device/firmware",Json::object({{"requestId",reply["firmwareRequestId"]},{"firmware",value}}));
    state_.set("firmware",value);atomicJson(statePath_,state_);
  }
  return body;
}
static bool registered(const std::string& titleId,const std::string& file) {
  std::ifstream status("/data/shadowmount/manual.status"); std::string line;
  const auto prefix="installed\t"+titleId+"\t"+file+"\t";
  while(std::getline(status,line)) if(line.rfind(prefix,0)==0) return true;
  return false;
}
Json Agent::tick() {
  if(!paired()) { pair(); return Json(); }
  auto snapshot=heartbeat();remotePlayPairing();saveBackups();saveExports();saveImports();removals(); auto tasks=client.request("GET","/api/v1/device/tasks"); auto volumes=snapshot["storage"];
  if(notifications()){
    auto notices=client.request("GET","/api/v1/device/notifications");for(size_t i=0;i<notices.size();i++)if(notify(notices[i]["message"].string(),notices[i]["title"].string("PS5Library")))client.request("POST","/api/v1/device/notifications/"+notices[i]["id"].string()+"/ack",Json::object());
  }
  for(size_t i=0;i<tasks.size();i++) {
    if(client.cancelled&&client.cancelled())return snapshot;
    const auto task=tasks[i]; const auto id=task["id"].string(),method=task["method"].string();
    int64_t observedBytes=task["downloadedBytes"].number();fs::path part;
    try {
    fs::path root;bool fpkgSupported=false;for(size_t n=0;n<volumes.size();n++)if(volumes[n]["storageId"].string()==task["storageId"].string()){root=volumes[n]["path"].string();auto methods=volumes[n]["installMethodsSupported"];for(size_t m=0;m<methods.size();m++)fpkgSupported|=methods[m].string()=="FPKG";}
    if(root.empty()) throw std::runtime_error("Selected storage is unavailable");
    if(!task["backport"].null()&&(!shadowMountSupported(shadowMount_)||!shadowMountRoots_.size()||!runtimeStatus()["fakelibEnabled"].boolean()||runtimeStatus()["backPork"].string()=="RUNNING"))throw std::runtime_error("BACKPORT_RUNTIME_UNAVAILABLE");
    if(method=="FPKG"){if(!fpkgSupported)throw std::runtime_error("UNSUPPORTED_INPUT");nativeDownload(task,"/data",root);continue;}
    if(method!="HOMEBREW" && method!="SHADOWMOUNT") throw std::runtime_error("Installation method is unavailable");
    if(method=="SHADOWMOUNT"){
      const auto format=task["format"].string();if(format!="ffpkg"&&format!="ffpfs"&&format!="ffpfsc"&&format!="exfat")throw std::runtime_error("UNSUPPORTED_INPUT");
      if(!shadowMountSupported(shadowMount_))throw std::runtime_error("ShadowMount registration API is unavailable");
    }
#ifndef PS5
    if(method!="HOMEBREW") throw std::runtime_error("Simulator cannot register PS5 titles");
#endif
    const auto size=task["totalBytes"].number();if(size<=0)throw std::runtime_error("Invalid transfer size");
    const auto hash=task["sha256"].string(); if(hash.size()!=64) throw std::runtime_error("Invalid digest");
    part=beneath(root,".ps5library/staging/"+id+"/content.part");
    const auto relative="PS5Library/"+task["titleId"].string()+"-"+task["version"].string()+"-"+hash+"."+task["format"].string();
    const auto published=beneath(root,relative);
    auto progress=[&](const std::string& state,int64_t bytes,int64_t speed=0) { observedBytes=bytes;auto body=Json::object({{"state",state},{"downloadedBytes",bytes},{"speedBytesPerSecond",speed},{"sha256",hash}});if(!task["backport"].null())body.set("backportProfileHash",task["backport"]["profileHash"]);client.request("POST","/api/v1/device/tasks/"+id+"/progress",body); };
    Json overlay;
    if(task["state"].string()!="REGISTERING") {
      const auto partial=fs::exists(part)?std::min<uint64_t>(fs::file_size(part),static_cast<uint64_t>(size)):0;
      if(fs::space(root).available<static_cast<uint64_t>(size)-partial+64*1024*1024)throw std::runtime_error("Insufficient console storage");
      progress("TRANSFERRING",fs::exists(part)?static_cast<int64_t>(fs::file_size(part)):0);
      auto lastHeartbeat=std::chrono::steady_clock::now();
      client.download(task["artifactUrl"].string(),part,size,hash,[&](int64_t bytes,int64_t speed) { progress("TRANSFERRING",bytes,speed); if(std::chrono::steady_clock::now()-lastHeartbeat>std::chrono::seconds(10)) { heartbeat(); lastHeartbeat=std::chrono::steady_clock::now(); } });
      progress("VERIFYING",size);
      overlay=prepareBackport(client,root,shadowMountRoots_,task,[&](int64_t bytes,int64_t speed){client.request("POST","/api/v1/device/tasks/"+id+"/progress",Json::object({{"state","VERIFYING"},{"downloadedBytes",size},{"sha256",hash},{"backportDownloadedBytes",bytes},{"speedBytesPerSecond",speed}}));});
      fs::create_directories(published.parent_path());
      if(fs::exists(published)) { if(fileHash(published,client.cancelled)!=hash) throw std::runtime_error("Existing destination differs"); }
      else fs::rename(part,published);
      verified_[published.string()]={fs::last_write_time(published),hash};
      if(method=="SHADOWMOUNT") {
        if(!shadowMountSupported(shadowMount_)) throw std::runtime_error("ShadowMount registration API is unavailable");
        shadowMountRequest(shadowMountPort_,"/api/v1/manual/add",Json::object({{"path",published.string()}}),client.cancelled);
        shadowMountRequest(shadowMountPort_,"/api/v1/scan",Json::object({{"reset_attempts",false}}),client.cancelled);
        progress("REGISTERING",size);
      }
    }
    if(task["state"].string()=="REGISTERING")overlay=prepareBackport(client,root,shadowMountRoots_,task,[](int64_t,int64_t){});
    bool installed=method=="SHADOWMOUNT" && registered(task["titleId"].string(),published.string());
    if(method=="SHADOWMOUNT" && !installed) continue;
    auto receipt=Json::object({{"releaseId",task["releaseId"]},{"title",task["title"]},{"titleId",task["titleId"]},{"contentId",task["contentId"]},{"version",task["version"]},{"storageId",task["storageId"]},{"relativePath",relative},{"size",size},{"sha256",hash},{"registered",installed},{"available",true},{"backportProfileId",task["backport"]["profile"]["id"]},{"backportFiles",!task["backport"].null()},{"backport",overlay}});
    receipt.set("serverUrl",state_["serverUrl"]);receipt.set("consoleId",state_["consoleId"]);
    atomicJson(beneath(root,".ps5library/receipts/"+id+".json"),receipt); heartbeat(); progress("READY_ON_PS5",size);
    }catch(const std::exception& error){
      const std::string reason=error.what();
      const std::string code=reason.rfind("BACKPORT_",0)==0||reason.rfind("NATIVE_",0)==0||reason=="ARTIFACT_INSPECTION_REQUIRED"||reason=="METADATA_MISMATCH"||reason=="CORRUPT_INPUT"||reason=="UNSUPPORTED_INPUT"?reason:reason=="Existing destination differs"?"DESTINATION_CONFLICT":reason=="Unsafe path"||reason=="Symlinks are not allowed"?"UNSAFE_PATH":"";
      if(code.empty()){std::fprintf(stderr,"Transfer %s: %s\n",id.c_str(),error.what());continue;}
      if(!part.empty()&&fs::is_regular_file(part))observedBytes=std::min<int64_t>(fs::file_size(part),task["totalBytes"].number());
      client.request("POST","/api/v1/device/tasks/"+id+"/progress",Json::object({{"state","ERROR"},{"downloadedBytes",observedBytes},{"error",code}}));
    }
  }
  return snapshot;
}
void Agent::nativeDownload(const Json& task,const fs::path& root,const fs::path& storageRoot){
  if(root!="/data"||task["format"].string()!="pkg"||task["releaseKind"].string()!="BASE")throw std::runtime_error("UNSUPPORTED_INPUT");
  const auto id=task["id"].string(),hash=task["sha256"].string();const auto size=task["totalBytes"].number();
  const auto image=task["installedImage"];const auto installedSize=image["size"].number();const auto installedHash=image["sha256"].string();
  const std::regex digest("[0-9a-f]{64}");if(size<=0||!std::regex_match(hash,digest)||installedSize<=0||installedSize>size||!std::regex_match(installedHash,digest))throw std::runtime_error("ARTIFACT_INSPECTION_REQUIRED");
  auto progress=[&](const char* stage,int64_t bytes){auto body=Json::object({{"state",stage},{"downloadedBytes",bytes},{"sha256",hash}});if(!task["backport"].null())body.set("backportProfileHash",task["backport"]["profileHash"]);client.request("POST","/api/v1/device/tasks/"+id+"/progress",body);};
  Json overlay;
  if(!task["backport"].null()){
    if(!shadowMountPkgBackportSupported(shadowMount_)||!shadowMountRoots_.size())throw std::runtime_error("BACKPORT_RUNTIME_UNAVAILABLE");
    const auto current=std::max<int64_t>(0,task["downloadedBytes"].number());progress("TRANSFERRING",current);
    overlay=prepareBackport(client,root,shadowMountRoots_,task,[&](int64_t bytes,int64_t speed){client.request("POST","/api/v1/device/tasks/"+id+"/progress",Json::object({{"state","TRANSFERRING"},{"downloadedBytes",current},{"sha256",hash},{"backportProfileHash",task["backport"]["profileHash"]},{"backportDownloadedBytes",bytes},{"speedBytesPerSecond",speed}}));});
  }
  auto volumes=storage();int targetType=-1;for(size_t i=0;i<volumes.size();i++)if(volumes[i]["path"].string()==storageRoot.string())targetType=static_cast<int>(volumes[i]["nativeMoveStorageType"].number(-1));if(targetType<0||targetType>2)throw std::runtime_error("NATIVE_INSTALL_STORAGE_MISMATCH");
  const auto titleId=task["titleId"].string(),contentId=task["contentId"].string();const auto sourceType=nativeTitleStorageType(titleId,contentId);fs::path file;
  if(sourceType>=0&&sourceType<=2&&nativePackageRegistered(task))for(size_t i=0;i<volumes.size();i++)if(volumes[i]["nativeMoveStorageType"].number(-1)==sourceType){auto candidate=installedNativePackage(titleId,volumes[i]["path"].string());if(fs::is_regular_file(candidate)&&sameStorageDevice(candidate,volumes[i]["path"].string())){file=candidate;break;}}
  if(file.empty()||static_cast<int64_t>(fs::file_size(file))!=installedSize){
    auto marker=beneath(root,".ps5library/staging/"+id+"/native.json");const auto submission=inspectNativeSubmission(marker,hash,state_["serverUrl"].string(),state_["consoleId"].string(),task["state"].string()=="QUEUED_FOR_PS5");
    if(submission==NativeSubmissionDecision::Uncertain)throw std::runtime_error("NATIVE_SUBMISSION_UNCERTAIN");
    if(submission==NativeSubmissionDecision::Submit){
      if(!nativeDownloadsAvailable())throw std::runtime_error("NATIVE_INSTALLER_UNAVAILABLE");const auto grant=client.request("POST","/api/v1/device/tasks/"+id+"/native-download",Json::object());auto url=client.nativeDownloadUrl(grant["url"].string()),icon=grant["iconUrl"].string();if(!icon.empty())icon=client.nativeDownloadUrl(icon);progress("TRANSFERRING",0);
      // Persist intent first: after a crash, inspect the native result instead of submitting a duplicate install.
      submitNativeDownload(marker,hash,state_["serverUrl"].string(),state_["consoleId"].string(),url,contentId,task["title"].string(),icon);
    }
    if(config_["nativeInstallProgress"].boolean()){
      auto status=nativeDownloadStatus(contentId);
      if(status["available"].boolean()){
        if(status["errorCode"].number()){char code[64];std::snprintf(code,sizeof(code),"NATIVE_INSTALL_FAILED_%08X",static_cast<unsigned>(status["errorCode"].number()));throw std::runtime_error(code);}
        const auto bytes=std::max<int64_t>(task["downloadedBytes"].number(),std::min<int64_t>(size,std::max<int64_t>(0,status["downloadedBytes"].number())));progress("TRANSFERRING",bytes);
      }
    }
    return;
  }
  auto stamp=fs::last_write_time(file);auto known=verified_.find(file.string());
  if(known==verified_.end()||known->second.first!=stamp){
    auto last=std::chrono::steady_clock::now();
    auto digest=fileHash(file,[&]{if(client.cancelled&&client.cancelled())return true;if(std::chrono::steady_clock::now()-last>std::chrono::seconds(10)){client.request("POST","/api/v1/device/heartbeat",heartbeatBody_);last=std::chrono::steady_clock::now();}return false;});
    if(fs::last_write_time(file)!=stamp)return;
    verified_[file.string()]={stamp,digest};
  }
  if(verified_[file.string()].second!=installedHash)return; // An incomplete/native-rejected install is never READY.
  if(sourceType!=targetType){
    if(task["state"].string()!="REGISTERING"){progress("VERIFYING",size);progress("REGISTERING",size);}
    auto marker=beneath(root,".ps5library/staging/"+id+"/native-move.json");const auto decision=inspectNativeSubmission(marker,hash,state_["serverUrl"].string(),state_["consoleId"].string(),false);
    if(decision==NativeSubmissionDecision::Submit){if(nativeMoveState()==2)return;beginNativeSubmission(marker,hash,state_["serverUrl"].string(),state_["consoleId"].string());try{nativeMoveTitle(titleId,contentId,sourceType,targetType);}catch(...){resetNativeSubmission(marker);throw;}acceptNativeSubmission(marker,hash,state_["serverUrl"].string(),state_["consoleId"].string());return;}
    if(nativeMoveState()==2)return;
    if(fs::file_time_type::clock::now()-fs::last_write_time(marker)<std::chrono::seconds(30))return;
    throw std::runtime_error(decision==NativeSubmissionDecision::Uncertain?"NATIVE_MOVE_SUBMISSION_UNCERTAIN":"NATIVE_MOVE_INCOMPLETE");
  }
  if(!sameStorageDevice(file,storageRoot))throw std::runtime_error("NATIVE_INSTALL_STORAGE_MISMATCH");
  if(task["state"].string()!="REGISTERING"){progress("VERIFYING",size);progress("REGISTERING",size);}
  auto receipt=Json::object({{"releaseId",task["releaseId"]},{"title",task["title"]},{"titleId",task["titleId"]},{"contentId",task["contentId"]},{"version",task["version"]},{"storageId",task["storageId"]},{"relativePath","app/"+task["titleId"].string()+"/app.pkg"},{"size",installedSize},{"sha256",installedHash},{"registered",true},{"available",true},{"method","FPKG"},{"backportProfileId",task["backport"]["profile"]["id"]},{"backportFiles",!task["backport"].null()},{"serverUrl",state_["serverUrl"]},{"consoleId",state_["consoleId"]}});if(!overlay.null())receipt.set("backport",overlay);
  atomicJson(beneath(root,".ps5library/receipts/"+id+".json"),receipt);heartbeat();progress("READY_ON_PS5",size);
}
Json Agent::nativeAppUpdate(const std::string& titleId,const std::string& baseContentVersion){
  const std::regex version("[0-9]{2}\\.[0-9]{3}\\.[0-9]{3}"),digest("[0-9a-f]{64}");
  const auto* identity=nativeUpdateIdentity(titleId);if(!identity||!std::regex_match(baseContentVersion,version))throw std::runtime_error("INVALID_NATIVE_UPDATE");
  auto installed=readJson("/user/appmeta/"+titleId+"/param.json");
  if(installed["titleId"].string()!=identity->titleId||installed["contentId"].string()!=identity->contentId||installed["contentVersion"].string()!=baseContentVersion)throw std::runtime_error("NATIVE_UPDATE_BASE_MISMATCH");
  auto release=client.request("POST","/api/v1/device/native-updates/install",Json::object({{"titleId",titleId},{"baseContentVersion",baseContentVersion}}));
  auto valid=[&](const Json& value,bool assets){
    if(value["titleId"].string()!=identity->titleId||value["contentId"].string()!=identity->contentId||value["title"].string()!=identity->name||value["baseContentVersion"].string()!=baseContentVersion||!std::regex_match(value["contentVersion"].string(),version)||value["contentVersion"].string()<=baseContentVersion||value["revision"].number()<=0||value["size"].number()<=0||!std::regex_match(value["sha256"].string(),digest))throw std::runtime_error("INVALID_NATIVE_UPDATE");
    if(assets&&(value["packageUrl"].string().empty()||value["iconUrl"].string().empty()))throw std::runtime_error("INVALID_NATIVE_UPDATE");
  };
  valid(release,false);Json descriptor=release;std::string packageUrl,iconUrl,source=state_["serverUrl"].string();
  if(!release["activationToken"].string().empty()){
    if(!std::regex_match(release["activationToken"].string(),digest))throw std::runtime_error("INVALID_NATIVE_UPDATE");
    Json masterConfig=Json::object({{"serverUrl",release["masterUrl"]},{"allowInsecureLan",false},{"caBundle",config_["caBundle"]}});Client master(masterConfig);master.credential=release["activationToken"].string();descriptor=master.request("POST","/api/v1/native-updates/activate",Json::object());valid(descriptor,true);
    if(descriptor["contentVersion"].string()!=release["contentVersion"].string()||descriptor["revision"].number()!=release["revision"].number()||descriptor["sha256"].string()!=release["sha256"].string())throw std::runtime_error("INVALID_NATIVE_UPDATE");
    const auto package=descriptor["packageUrl"].string(),icon=descriptor["iconUrl"].string();std::smatch match;const std::regex masterPackage("^/api/v1/native-updates/grants/([0-9a-f]{64})/"+titleId+"/packages/"+descriptor["sha256"].string()+"\\.pkg$");if(!std::regex_match(package,match,masterPackage)||icon!="/api/v1/native-updates/grants/"+match[1].str()+"/"+titleId+"/icon.png")throw std::runtime_error("INVALID_NATIVE_UPDATE");
    packageUrl=master.nativeUpdateUrl(package);iconUrl=master.nativeUpdateUrl(icon);source=release["masterUrl"].string();
  }else{valid(descriptor,true);const auto package=descriptor["packageUrl"].string(),icon=descriptor["iconUrl"].string();if(package!="/api/v1/native-updates/"+titleId+"/"+std::to_string(descriptor["revision"].number())+"/packages/"+descriptor["sha256"].string()+".pkg"||icon!="/api/v1/native-updates/"+titleId+"/icon.png")throw std::runtime_error("INVALID_NATIVE_UPDATE");packageUrl=client.nativeUpdateUrl(package);iconUrl=client.nativeUpdateUrl(icon);}
  auto marker=beneath("/data",".ps5library/staging/app-update-"+descriptor["sha256"].string()+"/native.json");auto decision=inspectNativeSubmission(marker,descriptor["sha256"].string(),source,state_["consoleId"].string(),false);
  if(decision==NativeSubmissionDecision::Uncertain)throw std::runtime_error("NATIVE_SUBMISSION_UNCERTAIN");
  if(decision==NativeSubmissionDecision::Submit)submitNativeDownload(marker,descriptor["sha256"].string(),source,state_["consoleId"].string(),packageUrl,identity->contentId,identity->name,iconUrl);
  notify(std::string(identity->name)+" "+descriptor["contentVersion"].string()+" started in Downloads");return Json::object({{"accepted",true},{"titleId",titleId},{"contentVersion",descriptor["contentVersion"]}});
}
}
