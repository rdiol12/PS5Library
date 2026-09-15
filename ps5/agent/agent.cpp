#include "../common/client.hpp"
#include <chrono>
#include <thread>
#include <fstream>
#include <unordered_map>
#include <cstdio>
#include <fcntl.h>
#include <unistd.h>
#ifdef PS5
#include <ps5/kernel.h>
#endif
namespace ps5library {
std::string firmwareVersion(uint32_t raw) {
  auto major=(raw>>24)&0xff,minor=(raw>>16)&0xff;
  if(!raw || (major&15)>9 || (major>>4)>9 || (minor&15)>9 || (minor>>4)>9) return {};
  char result[24]; std::snprintf(result,sizeof(result),"%u.%02u",(major>>4)*10+(major&15),(minor>>4)*10+(minor&15)); return result;
}
Agent::Agent(const fs::path& configPath):config_(readJson(configPath)),statePath_(configPath.parent_path()/"device-state.json"),client(config_) {
  state_=loadDeviceState(configPath,config_);
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
    auto pairing=client.request("POST","/api/v1/pairings",Json::object({{"deviceId",state_["deviceId"]},{"name",config_["name"].string("My PS5")},{"clientKind",kind}}));
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
  auto result=Json::array(); const auto configured=config_["storage"];
  for(size_t i=0;i<configured.size();i++) {
    auto item=configured[i]; auto root=item["path"].string();
    if(!fs::is_directory(root)) continue;
    std::error_code error; auto space=fs::space(root,error); if(error) continue;
    auto methods=Json::array(); methods.add("HOMEBREW");
#ifdef PS5
    if(config_["shadowMount"].boolean() && fs::is_regular_file("/data/shadowmount/config.ini")) methods.add("SHADOWMOUNT");
#endif
    result.add(Json::object({{"storageId",item["storageId"]},{"displayName",item["displayName"]},{"path",fs::canonical(root).string()},
      {"totalBytes",static_cast<int64_t>(space.capacity)},{"freeBytes",static_cast<int64_t>(space.available)},{"writable",access(root.c_str(),W_OK)==0},{"installMethodsSupported",methods}}));
  }
  return result;
}
Json Agent::inventory() {
  auto result=Json::array(); auto volumes=storage();
  // Hash on first sight and after a size/mtime change; never rehash a 50 GB file every heartbeat.
  for(size_t i=0;i<volumes.size();i++) {
    auto root=fs::path(volumes[i]["path"].string()); auto receipts=beneath(root,".ps5library/receipts");
    if(!fs::exists(receipts)) continue;
    for(const auto& entry:fs::directory_iterator(receipts)) {
      if(entry.is_symlink() || !entry.is_regular_file() || entry.path().extension()!=".json") continue;
      auto receipt=readJson(entry.path()); auto file=beneath(root,receipt["relativePath"].string());
      bool present=fs::is_regular_file(file) && static_cast<int64_t>(fs::file_size(file))==receipt["size"].number();
      if(present) {
        auto stamp=fs::last_write_time(file); auto found=verified_.find(file.string());
        if(found==verified_.end() || found->second.first!=stamp) verified_[file.string()]={stamp,fileHash(file)};
        present=verified_[file.string()].second==receipt["sha256"].string();
      }
      receipt.set("available",present); result.add(receipt);
    }
  }
  return result;
}
void Agent::heartbeat() {
  auto volumes=storage(); auto capabilities=Json::object({{"homebrew",true},{"storageEnumeration",true},{"inventoryScan",true},{"rangeDownloads",true},{"persistentAgent",false},{"nativeNotifications",false},{"shadowMount",false},{"fpkgInstall",false},{"backportOverlay",false},{"shellIntegration",false}});
  Json firmware=config_["firmware"];
#ifdef PS5
  auto version=firmwareVersion(kernel_get_fw_version()); firmware=version.empty()?Json():Json(version);
  capabilities.set("nativeNotifications",config_["nativeNotifications"].boolean());
  capabilities.set("shadowMount",config_["shadowMount"].boolean() && fs::is_regular_file("/data/shadowmount/config.ini"));
#endif
  auto revision=state_["libraryRevision"].number()+1; state_.set("libraryRevision",revision); atomicJson(statePath_,state_);
  auto body=Json::object({{"firmware",firmware},{"runtime",config_["runtime"].string("unknown")},{"clientVersion","0.1.0"},{"agentVersion","0.1.0"},{"capabilities",capabilities},{"storage",volumes},{"libraryRevision",revision},{"inventoryComplete",true},{"inventory",inventory()},{"activeTransfers",Json::array()},
    {"shadowMountVersion",config_["shadowMountVersion"]},{"shadowMountFakelib",config_["shadowMountFakelib"].boolean()},{"standaloneBackPork",config_["standaloneBackPork"].boolean()}});
  client.request("POST","/api/v1/device/heartbeat",body);
}
static bool registered(const std::string& titleId,const std::string& file) {
  std::ifstream status("/data/shadowmount/manual.status"); std::string line;
  const auto prefix="installed\t"+titleId+"\t"+file+"\t";
  while(std::getline(status,line)) if(line.rfind(prefix,0)==0) return true; return false;
}
void Agent::tick() {
  if(!paired()) { pair(); return; }
  heartbeat(); auto tasks=client.request("GET","/api/v1/device/tasks"); auto volumes=storage();
  for(size_t i=0;i<tasks.size();i++) {
    const auto task=tasks[i]; const auto id=task["id"].string(),method=task["method"].string();
    int64_t observedBytes=task["downloadedBytes"].number();fs::path part;
    try {
    fs::path root; for(size_t n=0;n<volumes.size();n++) if(volumes[n]["storageId"].string()==task["storageId"].string()) root=volumes[n]["path"].string();
    if(root.empty()) throw std::runtime_error("Selected storage is unavailable");
    if(method!="HOMEBREW" && method!="SHADOWMOUNT") throw std::runtime_error("Installation method is unavailable");
#ifndef PS5
    if(method!="HOMEBREW") throw std::runtime_error("Simulator cannot register PS5 titles");
#endif
    const auto size=task["totalBytes"].number();if(size<=0)throw std::runtime_error("Invalid transfer size");
    const auto hash=task["sha256"].string(); if(hash.size()!=64) throw std::runtime_error("Invalid digest");
    part=beneath(root,".ps5library/staging/"+id+"/content.part");
    const auto relative="PS5Library/"+task["titleId"].string()+"-"+task["version"].string()+"-"+hash+"."+task["format"].string();
    const auto published=beneath(root,relative);
    auto progress=[&](const std::string& state,int64_t bytes,int64_t speed=0) { observedBytes=bytes;client.request("POST","/api/v1/device/tasks/"+id+"/progress",Json::object({{"state",state},{"downloadedBytes",bytes},{"speedBytesPerSecond",speed},{"sha256",hash}})); };
    if(task["state"].string()!="REGISTERING") {
      const auto partial=fs::exists(part)?std::min<uint64_t>(fs::file_size(part),static_cast<uint64_t>(size)):0;
      if(fs::space(root).available<static_cast<uint64_t>(size)-partial+64*1024*1024)throw std::runtime_error("Insufficient console storage");
      progress("TRANSFERRING",fs::exists(part)?static_cast<int64_t>(fs::file_size(part)):0);
      if(task["state"].string()=="QUEUED_FOR_PS5"&&config_["nativeNotifications"].boolean())notify(task["title"].string()+" download started");
      auto lastHeartbeat=std::chrono::steady_clock::now();
      client.download(task["artifactUrl"].string(),part,size,hash,[&](int64_t bytes,int64_t speed) { progress("TRANSFERRING",bytes,speed); if(std::chrono::steady_clock::now()-lastHeartbeat>std::chrono::seconds(10)) { heartbeat(); lastHeartbeat=std::chrono::steady_clock::now(); } });
      progress("VERIFYING",size);
      fs::create_directories(published.parent_path());
      if(fs::exists(published)) { if(fileHash(published)!=hash) throw std::runtime_error("Existing destination differs"); }
      else fs::rename(part,published);
      verified_[published.string()]={fs::last_write_time(published),hash};
      if(method=="SHADOWMOUNT") {
        if(!config_["shadowMount"].boolean()) throw std::runtime_error("ShadowMount integration is not enabled");
        std::string line=published.string()+"\n"; int fd=open("/data/shadowmount/manual.lst",O_WRONLY|O_CREAT|O_APPEND|O_NOFOLLOW,0600);
        if(fd<0) throw std::runtime_error("Cannot request registration");
        auto written=write(fd,line.data(),line.size()); auto flushed=fsync(fd); close(fd);
        if(written!=static_cast<ssize_t>(line.size()) || flushed) throw std::runtime_error("Registration request failed");
        progress("REGISTERING",size);
      }
    }
    bool installed=method=="SHADOWMOUNT" && registered(task["titleId"].string(),published.string());
    if(method=="SHADOWMOUNT" && !installed) continue;
    auto receipt=Json::object({{"releaseId",task["releaseId"]},{"title",task["title"]},{"titleId",task["titleId"]},{"contentId",task["contentId"]},{"version",task["version"]},{"storageId",task["storageId"]},{"relativePath",relative},{"size",size},{"sha256",hash},{"registered",installed},{"available",true},{"backportProfileId",Json()}});
    atomicJson(beneath(root,".ps5library/receipts/"+id+".json"),receipt); heartbeat(); progress("READY_ON_PS5",size);
    if(config_["nativeNotifications"].boolean()) notify(task["title"].string()+" is ready in your library");
    }catch(const std::exception& error){
      const std::string reason=error.what();
      const std::string code=reason=="CORRUPT_INPUT"?reason:reason=="Existing destination differs"?"DESTINATION_CONFLICT":reason=="Unsafe path"||reason=="Symlinks are not allowed"?"UNSAFE_PATH":"";
      if(code.empty()){std::fprintf(stderr,"Transfer %s: %s\n",id.c_str(),error.what());continue;}
      if(!part.empty()&&fs::is_regular_file(part))observedBytes=std::min<int64_t>(fs::file_size(part),task["totalBytes"].number());
      client.request("POST","/api/v1/device/tasks/"+id+"/progress",Json::object({{"state","ERROR"},{"downloadedBytes",observedBytes},{"error",code}}));
      if(config_["nativeNotifications"].boolean())notify(task["title"].string()+" download failed");
    }
  }
}
}
