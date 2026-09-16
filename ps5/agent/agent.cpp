#include "../common/client.hpp"
#include "../common/version.hpp"
#include <chrono>
#include <thread>
#include <fstream>
#include <unordered_map>
#include <cstdio>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#ifdef PS5
#include <ps5/kernel.h>
struct SystemSoftwareVersion {uint64_t size;char text[28];uint32_t version;uint64_t reserved;};
extern "C" int sceKernelGetProsperoSystemSwVersion(SystemSoftwareVersion*);
#endif
namespace ps5library {
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
Agent::Agent(const fs::path& configPath):config_(readJson(configPath)),statePath_(configPath.parent_path()/"device-state.json"),client(config_) {
  state_=loadDeviceState(configPath,config_);
  if(!state_["firmwareChecked"].boolean()){state_.set("firmware",measureFirmware(config_));state_.set("firmwareChecked",true);}
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
  configured.add(Json::object({{"storageId","internal-installed"},{"displayName","Internal Storage"},{"path","/user"},{"inventoryOnly",true}}));
  for(int index=0;index<10;index++) {
    const auto id=index<2?"ext"+std::to_string(index):"usb"+std::to_string(index-2),root="/mnt/"+id;
    bool exists=false;for(size_t i=0;i<configured.size();i++)if(configured[i]["path"].string()==root)exists=true;
    struct stat device{},parent{};
    if(!exists&&stat(root.c_str(),&device)==0&&stat("/mnt",&parent)==0&&device.st_dev!=parent.st_dev)configured.add(Json::object({{"storageId",id},{"displayName",index==0?"Extended Storage":index==1?"M.2 SSD":"USB Storage "+std::to_string(index-1)},{"path",root}}));
  }
#endif
  for(size_t i=0;i<configured.size();i++) {
    auto item=configured[i]; auto root=item["path"].string();
    if(!fs::is_directory(root)) continue;
    std::error_code error; auto space=fs::space(root,error); if(error) continue;
    auto methods=Json::array();if(!item["inventoryOnly"].boolean())methods.add("HOMEBREW");
#ifdef PS5
    if(!item["inventoryOnly"].boolean() && shadowMountSupported(shadowMount_)) methods.add("SHADOWMOUNT");
    if(root=="/data"&&!item["inventoryOnly"].boolean()&&(config_["nativePackageDownloads"].null()||config_["nativePackageDownloads"].boolean())&&nativeDownloadsAvailable())methods.add("FPKG");
#endif
    result.add(Json::object({{"storageId",item["storageId"]},{"displayName",item["displayName"]},{"path",fs::canonical(root).string()},
      {"totalBytes",static_cast<int64_t>(space.capacity)},{"freeBytes",static_cast<int64_t>(space.available)},{"writable",!item["inventoryOnly"].boolean()&&access(root.c_str(),W_OK)==0},{"installMethodsSupported",methods}}));
  }
  return result;
}
Json Agent::inventory() {
  auto result=Json::array(); auto volumes=storage();inventoryComplete_=true;
  // Hash on first sight and after a size/mtime change; never rehash a 50 GB file every heartbeat.
  for(size_t i=0;i<volumes.size();i++) {
    auto root=fs::path(volumes[i]["path"].string()); auto receipts=beneath(root,".ps5library/receipts");
    if(!fs::exists(receipts)) continue;
    for(const auto& entry:fs::directory_iterator(receipts)) {
      if(entry.is_symlink() || !entry.is_regular_file() || entry.path().extension()!=".json") continue;
      auto receipt=readJson(entry.path());
      if(receipt["serverUrl"].string()!=state_["serverUrl"].string()||receipt["consoleId"].string().empty()||receipt["consoleId"].string()!=state_["consoleId"].string())continue;
      auto file=receipt["method"].string()=="FPKG"?installedNativePackage(receipt["titleId"].string()):beneath(root,receipt["relativePath"].string());
      bool present=fs::is_regular_file(file) && static_cast<int64_t>(fs::file_size(file))==receipt["size"].number();
      if(present) {
        auto stamp=fs::last_write_time(file); auto found=verified_.find(file.string());
        if(found==verified_.end() || found->second.first!=stamp) verified_[file.string()]={stamp,fileHash(file,client.cancelled)};
        present=verified_[file.string()].second==receipt["sha256"].string();
      }
      if(present&&!receipt["backport"].null())try{present=verifyBackport(beneath(receipt["backport"]["root"].string(),receipt["backport"]["relativePath"].string()),receipt["backport"]);}catch(...){present=false;}
      if(present&&receipt["method"].string()=="FPKG")present=nativePackageRegistered(receipt);
      receipt.set("available",present); result.add(receipt);
    }
  }
  auto existing=discoverDumps(volumes);for(size_t i=0;i<existing.size();i++)result.add(existing[i]);
  auto installed=discoverInstalled(volumes);for(size_t i=0;i<installed.size();i++)result.add(installed[i]);
  return result;
}
void Agent::heartbeat() {
  auto observed=runtimeStatus();
  auto capabilities=Json::object({{"homebrew",true},{"storageEnumeration",true},{"inventoryScan",true},{"rangeDownloads",true},{"persistentAgent",false},{"nativeNotifications",false},{"shadowMount",false},{"fpkgInstall",false},{"backportOverlay",false},{"shellIntegration",false}});
  Json firmware=state_["firmware"];
#ifdef PS5
  capabilities.set("nativeNotifications",config_["nativeNotifications"].boolean());
  capabilities.set("nativeDownloads",(config_["nativePackageDownloads"].null()||config_["nativePackageDownloads"].boolean())&&nativeDownloadsAvailable());capabilities.set("fpkgInstall",capabilities["nativeDownloads"]);
  shadowMount_=Json();shadowMountRoots_=Json::array();shadowMountPort_=0;
  if(observed["shadowMount"].string()=="RUNNING")try{
    std::string settings;auto file=fs::path("/data/shadowmount/config.ini");if(fs::is_regular_file(file)){if(fs::file_size(file)>65536)throw std::runtime_error("ShadowMount settings too large");std::ifstream input(file);settings.assign(std::istreambuf_iterator<char>(input),{});}
    shadowMountPort_=shadowMountPort(settings);if(shadowMountPort_)shadowMount_=shadowMountRequest(shadowMountPort_,"/api/v1/version",Json::object(),client.cancelled);
    if(shadowMountSupported(shadowMount_))shadowMountRoots_=shadowMountScanRoots(shadowMountRequest(shadowMountPort_,"/api/v1/settings",Json::object(),client.cancelled),shadowMount_);
  }catch(const std::exception&){/* A running process does not prove its registration API is available. */}
  capabilities.set("shadowMount",shadowMountSupported(shadowMount_));
  capabilities.set("gameDeletion",shadowMountDeletionSupported(shadowMount_));
  capabilities.set("backportOverlay",shadowMountSupported(shadowMount_)&&shadowMount_["shadowmount_version"].string().rfind("1.7",0)==0&&shadowMountRoots_.size()>0&&observed["fakelibEnabled"].boolean()&&observed["backPork"].string()!="RUNNING");
#endif
  auto volumes=storage(),items=inventory();auto runtime=config_["runtime"].string("unknown");if((runtime.empty()||runtime=="unknown")&&!detectedRuntime_.empty())runtime=detectedRuntime_;
  auto revision=state_["libraryRevision"].number()+1; state_.set("libraryRevision",revision); atomicJson(statePath_,state_);
  auto body=Json::object({{"firmware",firmware},{"runtime",runtime},{"runtimeStatus",observed},{"clientVersion",appVersion},{"agentVersion",appVersion},{"trophySummary",trophies()},{"capabilities",capabilities},{"storage",volumes},{"libraryRevision",revision},{"inventoryComplete",inventoryComplete_},{"inventory",items},{"activeTransfers",Json::array()},
    {"shadowMountVersion",shadowMountSupported(shadowMount_)?shadowMount_["shadowmount_version"]:Json()},{"shadowMountFakelib",observed["fakelibEnabled"].boolean()},{"standaloneBackPork",observed["backPork"].string()=="RUNNING"}});
  auto reply=client.request("POST","/api/v1/device/heartbeat",body);
  heartbeatBody_=Json::parse(body.dump());heartbeatBody_.set("inventory",Json::array());heartbeatBody_.set("inventoryComplete",false);
  if(!reply["firmwareRequestId"].string().empty()){
    auto value=measureFirmware(config_);
    client.request("POST","/api/v1/device/firmware",Json::object({{"requestId",reply["firmwareRequestId"]},{"firmware",value}}));
    state_.set("firmware",value);atomicJson(statePath_,state_);
  }
  syncArtwork(items);
}
static bool registered(const std::string& titleId,const std::string& file) {
  std::ifstream status("/data/shadowmount/manual.status"); std::string line;
  const auto prefix="installed\t"+titleId+"\t"+file+"\t";
  while(std::getline(status,line)) if(line.rfind(prefix,0)==0) return true; return false;
}
void Agent::tick() {
  if(!paired()) { pair(); return; }
  heartbeat();removals(); auto tasks=client.request("GET","/api/v1/device/tasks"); auto volumes=storage();
  if(config_["nativeNotifications"].boolean()){
    auto notices=client.request("GET","/api/v1/device/notifications");for(size_t i=0;i<notices.size();i++){notify(notices[i]["message"].string());client.request("POST","/api/v1/device/notifications/"+notices[i]["id"].string()+"/ack",Json::object());}
  }
  for(size_t i=0;i<tasks.size();i++) {
    if(client.cancelled&&client.cancelled())return;
    const auto task=tasks[i]; const auto id=task["id"].string(),method=task["method"].string();
    int64_t observedBytes=task["downloadedBytes"].number();fs::path part;
    try {
    fs::path root; for(size_t n=0;n<volumes.size();n++) if(volumes[n]["storageId"].string()==task["storageId"].string()) root=volumes[n]["path"].string();
    if(root.empty()) throw std::runtime_error("Selected storage is unavailable");
    if(!task["backport"].null()&&(!shadowMountSupported(shadowMount_)||!shadowMountRoots_.size()||!runtimeStatus()["fakelibEnabled"].boolean()||runtimeStatus()["backPork"].string()=="RUNNING"))throw std::runtime_error("BACKPORT_RUNTIME_UNAVAILABLE");
    if(method=="FPKG"){nativeDownload(task,root);continue;}
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
      if(task["state"].string()=="QUEUED_FOR_PS5"&&config_["nativeNotifications"].boolean())notify(task["title"].string()+" download started");
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
    if(config_["nativeNotifications"].boolean()) notify(task["title"].string()+" is ready in your library");
    }catch(const std::exception& error){
      const std::string reason=error.what();
      const std::string code=reason.rfind("BACKPORT_",0)==0||reason.rfind("NATIVE_",0)==0||reason=="METADATA_MISMATCH"||reason=="CORRUPT_INPUT"||reason=="UNSUPPORTED_INPUT"?reason:reason=="Existing destination differs"?"DESTINATION_CONFLICT":reason=="Unsafe path"||reason=="Symlinks are not allowed"?"UNSAFE_PATH":"";
      if(code.empty()){std::fprintf(stderr,"Transfer %s: %s\n",id.c_str(),error.what());continue;}
      if(!part.empty()&&fs::is_regular_file(part))observedBytes=std::min<int64_t>(fs::file_size(part),task["totalBytes"].number());
      client.request("POST","/api/v1/device/tasks/"+id+"/progress",Json::object({{"state","ERROR"},{"downloadedBytes",observedBytes},{"error",code}}));
      if(config_["nativeNotifications"].boolean())notify(task["title"].string()+" download failed");
    }
  }
}
void Agent::nativeDownload(const Json& task,const fs::path& root){
  if(root!="/data"||task["format"].string()!="pkg"||task["releaseKind"].string()!="BASE")throw std::runtime_error("UNSUPPORTED_INPUT");
  const auto id=task["id"].string(),hash=task["sha256"].string();const auto size=task["totalBytes"].number();
  auto progress=[&](const char* stage,int64_t bytes){auto body=Json::object({{"state",stage},{"downloadedBytes",bytes},{"sha256",hash}});if(!task["backport"].null())body.set("backportProfileHash",task["backport"]["profileHash"]);client.request("POST","/api/v1/device/tasks/"+id+"/progress",body);};
  auto marker=beneath(root,".ps5library/staging/"+id+"/native.json");
  if(!fs::exists(marker)){
    if(!nativeDownloadsAvailable())throw std::runtime_error("NATIVE_INSTALLER_UNAVAILABLE");
    const auto grant=client.request("POST","/api/v1/device/tasks/"+id+"/native-download",Json::object());
    auto url=client.nativeDownloadUrl(grant["url"].string());
    progress("TRANSFERRING",0);
    // Persist intent first: after a crash, inspect the native result instead of submitting a duplicate install.
    atomicJson(marker,Json::object({{"state","SUBMITTING"},{"sha256",hash},{"serverUrl",state_["serverUrl"]},{"consoleId",state_["consoleId"]}}));
    startNativeDownload(url,task["contentId"].string(),task["title"].string());
    atomicJson(marker,Json::object({{"state","ACCEPTED"},{"sha256",hash},{"serverUrl",state_["serverUrl"]},{"consoleId",state_["consoleId"]}}));
    if(config_["nativeNotifications"].boolean())notify(task["title"].string()+" added to PS5 Downloads");
  }else{auto saved=readJson(marker);if(saved["sha256"].string()!=hash||saved["serverUrl"].string()!=state_["serverUrl"].string()||saved["consoleId"].string()!=state_["consoleId"].string())throw std::runtime_error("NATIVE_INSTALL_STATE_MISMATCH");}
  auto file=installedNativePackage(task["titleId"].string());
  if(!fs::is_regular_file(file)||static_cast<int64_t>(fs::file_size(file))!=size||!nativePackageRegistered(task))return;
  auto stamp=fs::last_write_time(file);auto known=verified_.find(file.string());
  if(known==verified_.end()||known->second.first!=stamp){
    auto last=std::chrono::steady_clock::now();
    auto digest=fileHash(file,[&]{if(client.cancelled&&client.cancelled())return true;if(std::chrono::steady_clock::now()-last>std::chrono::seconds(10)){client.request("POST","/api/v1/device/heartbeat",heartbeatBody_);last=std::chrono::steady_clock::now();}return false;});
    if(fs::last_write_time(file)!=stamp)return;verified_[file.string()]={stamp,digest};
  }
  if(verified_[file.string()].second!=hash)return; // An incomplete/native-rejected install is never READY.
  if(task["state"].string()!="REGISTERING"){progress("VERIFYING",size);progress("REGISTERING",size);}
  auto receipt=Json::object({{"releaseId",task["releaseId"]},{"title",task["title"]},{"titleId",task["titleId"]},{"contentId",task["contentId"]},{"version",task["version"]},{"storageId",task["storageId"]},{"relativePath","app/"+task["titleId"].string()+"/app.pkg"},{"size",size},{"sha256",hash},{"registered",true},{"available",true},{"method","FPKG"},{"backportProfileId",task["backport"]["profile"]["id"]},{"backportFiles",!task["backport"].null()},{"serverUrl",state_["serverUrl"]},{"consoleId",state_["consoleId"]}});
  atomicJson(beneath(root,".ps5library/receipts/"+id+".json"),receipt);heartbeat();progress("READY_ON_PS5",size);
  if(config_["nativeNotifications"].boolean())notify(task["title"].string()+" is ready to play");
}
}
