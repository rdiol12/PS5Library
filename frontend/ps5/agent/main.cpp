#include "../common/client.hpp"
#include "../common/version.hpp"
#include "config.hpp"
#include "cheats.hpp"
#include "launch_trace.hpp"
#include "local.hpp"
#include "storage_format.hpp"
#ifdef PS5LIBRARY_EXPERIMENTAL_SHELL_INDICATOR
#include "../shell-indicator/agent_runtime.hpp"
#endif
#include <algorithm>
#include <array>
#include <cctype>
#include <chrono>
#include <string_view>
#include <thread>
#include <memory>
#include <vector>
#include <cstdio>
#include <cerrno>
#include <csignal>
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#ifdef PS5
#include <ps5/kernel.h>
#include <sys/syscall.h>
struct AgentLaunchContext {std::uint32_t size,user,options;std::uint64_t crashReport;std::uint32_t checkFlag;};
struct AgentLaunchResult {int initialize,user,launch;};
static_assert(sizeof(AgentLaunchContext)==32);
extern "C" int sceSystemServiceGetAppIdOfRunningBigApp();
extern "C" int sceSystemServiceKillApp(int,int,int,int);
extern "C" int sceSystemServiceLaunchApp(const char*,char**,AgentLaunchContext*);
extern "C" int sceLncUtilGetAppTitleId(std::uint32_t,char*);
extern "C" int sceUserServiceInitialize(void*);
extern "C" int sceUserServiceGetForegroundUser(std::uint32_t*);
extern "C" int sceKernelDebugGetSdkLogText(void*,size_t,char**,std::uint64_t*);
static AgentLaunchResult launchTitle(const std::string& title){AgentLaunchContext context{};context.size=sizeof(context);AgentLaunchResult result{sceUserServiceInitialize(nullptr),-1,-1};result.user=sceUserServiceGetForegroundUser(&context.user);if(!result.user){char* arguments[]={nullptr};result.launch=sceSystemServiceLaunchApp(title.c_str(),arguments,&context);}return result;}

class SdkLogCredentials {
  pid_t pid_=getpid();std::uint64_t auth_=0;std::array<unsigned char,16> caps_{};bool active_=false;
  bool restore()noexcept{if(!active_)return true;std::array<unsigned char,16> observed{};const bool ok=!kernel_set_ucred_caps(pid_,caps_.data())&&!kernel_set_ucred_authid(pid_,auth_)&&kernel_get_ucred_authid(pid_)==auth_&&!kernel_get_ucred_caps(pid_,observed.data())&&observed==caps_;if(ok)active_=false;return ok;}
public:
  SdkLogCredentials(){auth_=kernel_get_ucred_authid(pid_);if(!auth_||kernel_get_ucred_caps(pid_,caps_.data()))throw std::runtime_error("SDK_LOG_UNAVAILABLE");active_=true;std::array<unsigned char,16> full{};full.fill(0xff);if(kernel_set_ucred_authid(pid_,0x4800000000000006ULL)||kernel_set_ucred_caps(pid_,full.data())){if(!restore())_exit(72);throw std::runtime_error("SDK_LOG_UNAVAILABLE");}}
  ~SdkLogCredentials(){if(!restore())_exit(72);}SdkLogCredentials(const SdkLogCredentials&)=delete;SdkLogCredentials& operator=(const SdkLogCredentials&)=delete;
};
class SdkLogCapture {
  static constexpr size_t limit_=16*1024*1024;std::string previous_;
public:
  void poll(ps5library::LaunchTrace& trace)noexcept{try{std::vector<char> storage(limit_);char* text=nullptr;std::uint64_t length=0;int result;{SdkLogCredentials credentials;result=sceKernelDebugGetSdkLogText(storage.data(),storage.size(),&text,&length);}const auto begin=reinterpret_cast<std::uintptr_t>(storage.data()),value=reinterpret_cast<std::uintptr_t>(text);if(result||!text||value<begin||value>begin+storage.size()||length>storage.size()-(value-begin)){trace.klogStatus(false,"sdk-log-read-failed");return;}const std::string_view current(text,static_cast<size_t>(length));trace.appendKlog(ps5library::launchLogDelta(previous_,current));previous_.assign(current.data(),current.size());trace.klogStatus(true);}catch(...){trace.klogStatus(false,"sdk-log-unavailable");}}
};
#endif
static volatile std::sig_atomic_t running=1;
static bool enabled(const std::filesystem::path& marker){try{return std::filesystem::is_regular_file(marker)&&ps5library::readJson(marker).boolean();}catch(...){return false;}}
static std::int64_t unixMilliseconds(){return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch()).count();}
#ifdef PS5
class ShellCheatSession {
  std::filesystem::path root_ = "/system_tmp/ps5library";
  std::string session_ = ps5library::randomHex(16);
  std::string token_ = ps5library::randomHex(32);
  Json profiles_ = Json::array(), memoryTarget_, memoryScan_;
  std::chrono::steady_clock::time_point written_{};

  static bool process(std::string_view value) {
    return !value.empty() && value.size() <= 128 &&
           std::all_of(value.begin(), value.end(), [](unsigned char c) {
             return std::isalnum(c) || c == '.' || c == '_' || c == '-';
           });
  }
  void protect(const std::filesystem::path& path) {
    if (chmod(path.c_str(), 0600))
      throw std::runtime_error("Shell cheat state permission failed");
    struct stat status {};
    if (lstat(path.c_str(), &status) || !S_ISREG(status.st_mode) ||
        S_ISLNK(status.st_mode))
      throw std::runtime_error("Shell cheat state unavailable");
  }
  void publishSnapshot() {
    std::string rows;
    std::size_t count = 0;
    bool truncated = false;
#if defined(PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER)
    constexpr std::size_t profileRowBudget = 32 * 1024;
#else
    constexpr std::size_t profileRowBudget = 64 * 1024 - 256;
#endif
    for (std::size_t p = 0; p < profiles_.size() && !truncated; ++p) {
      const auto profile = profiles_[p], entries = profile["entries"];
      for (std::size_t e = 0; e < entries.size(); ++e) {
        const auto entry = entries[e];
        const auto profileId = profile["id"].string();
        const auto entryId = entry["id"].string();
        if (profileId.size() != 64 || entryId.size() != 64) continue;
        const auto row =
            "C\t" + profileId + "\t" + entryId + "\t" +
            profile["titleId"].string() + "\t" +
            profile["version"].string() + "\t" +
            ps5library::localHex(profile["process"].string()) + "\t" +
            profile["validation"].string() + "\t" +
            profile["trust"].string() + "\t" +
            (profile["installedMatch"].boolean() ? "1" : "0") + "\t" +
            profile["runtime"].string() + "\t" +
            (entry["enabled"].boolean() ? "1" : "0") + "\t" +
            ps5library::localHex(entry["name"].string()) + "\t" +
            ps5library::localHex(entry["description"].string()) + "\n";
        if (count >= 128 || rows.size() + row.size() > profileRowBudget) {
          truncated = true;
          break;
        }
        rows += row;
        ++count;
      }
    }
#if defined(PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER)
    if (memoryTarget_.isObject()) {
      const bool available = memoryTarget_["available"].boolean();
      const bool enabled = memoryTarget_["enabled"].boolean();
      const bool writeEnabled = memoryTarget_["writeEnabled"].boolean();
      const auto title = memoryTarget_["titleId"].string();
      const auto version = memoryTarget_["version"].string();
      const auto processName = memoryTarget_["process"].string();
      if ((!available || (ps5library::localTitleId(title) &&
                          ps5library::localGameVersion(version) &&
                          process(processName))) &&
          (!writeEnabled || enabled)) {
        rows += "M\t" + std::string(available ? "1" : "0") + "\t" +
                (enabled ? "1" : "0") + "\t" +
                (writeEnabled ? "1" : "0") + "\t" +
                (available ? title : "") + "\t" +
                (available ? version : "") + "\t" +
                (available ? ps5library::localHex(processName) : "") + "\n";
        if (available && memoryScan_.isObject() &&
            memoryScan_["titleId"].string() == title &&
            memoryScan_["version"].string() == version &&
            memoryScan_["process"].string() == processName &&
            memoryScan_["scope"].string() == "MODULE_WRITABLE" &&
            ps5library::localLowerHex(memoryScan_["scanId"].string(), 32) &&
            ps5library::localMemoryType(memoryScan_["valueType"].string()) &&
            memoryScan_["candidateCount"].number(-1) >= 0) {
          std::string resultRows;
          bool resultsTruncated = memoryScan_["resultsTruncated"].boolean();
          const auto results = memoryScan_["results"];
          for (std::size_t index = 0;
               index < results.size() && index < 256; ++index) {
            const auto item = results[index];
            const auto resultId = item["resultId"].string();
            const auto value = item["value"].string();
            if (!ps5library::localLowerHex(resultId, 32) ||
                !ps5library::localScalarValue(value)) {
              resultsTruncated = true;
              continue;
            }
            resultRows +=
                "R\t" + resultId + "\t" + value + "\t" +
                (item["changed"].boolean() ? "1" : "0") + "\t" +
                (item["writable"].boolean() ? "1" : "0") + "\t" +
                (item["modified"].boolean() ? "1" : "0") + "\t" +
                (item["frozen"].boolean() ? "1" : "0") + "\n";
          }
          if (results.size() > 256) resultsTruncated = true;
          rows += "S\t" + memoryScan_["scanId"].string() + "\t" + title +
                  "\t" + version + "\t" +
                  ps5library::localHex(processName) + "\t" +
                  memoryScan_["valueType"].string() +
                  "\tREADY\t" +
                  std::to_string(memoryScan_["candidateCount"].number()) +
                  "\t" + (resultsTruncated ? "1" : "0") + "\n" +
                  resultRows;
        }
      }
    }
#endif
    const auto content =
        "PS5LC1\t" + session_ + "\t" +
        std::to_string(unixMilliseconds()) + "\t" +
        std::to_string(count) + "\t" + (truncated ? "1" : "0") +
        "\n" + rows;
    if (content.size() > 64 * 1024)
      throw std::runtime_error("Shell cheat snapshot too large");
    const auto path = root_ / "cheats.snapshot.v1";
    ps5library::atomicBytes(path, content);
    protect(path);
  }
  void publish() {
    const auto path = root_ / "cheat-shell-session";
    ps5library::atomicJson(
        path, Json::object({{"schemaVersion", 1},
                            {"session", session_},
                            {"token", token_},
                            {"agentPid", static_cast<int64_t>(getpid())},
                            {"heartbeatAtUnixMs", unixMilliseconds()}}));
    protect(path);
    publishSnapshot();
    written_ = std::chrono::steady_clock::now();
  }

 public:
  ShellCheatSession() {
    std::error_code error;
    std::filesystem::create_directories(root_, error);
    struct stat status {};
    if (error || lstat(root_.c_str(), &status) || !S_ISDIR(status.st_mode) ||
        S_ISLNK(status.st_mode))
      throw std::runtime_error("Shell cheat session directory unavailable");
    try {
      publish();
    } catch (...) {
      std::filesystem::remove(root_ / "cheat-shell-session", error);
      std::filesystem::remove(root_ / "cheats.snapshot.v1", error);
      throw;
    }
  }
  ~ShellCheatSession() {
    std::error_code error;
    std::filesystem::remove(root_ / "cheat-shell-session", error);
    std::filesystem::remove(root_ / "cheats.snapshot.v1", error);
  }
  const std::string& token() const { return token_; }
  void heartbeat() {
    if (std::chrono::steady_clock::now() - written_ >=
        std::chrono::seconds(5))
      publish();
  }
  void snapshot(const Json& profiles, const Json& memoryTarget = {},
                const Json& memoryScan = {}) {
    profiles_ = profiles.deepCopy();
    memoryTarget_ = memoryTarget.deepCopy();
    memoryScan_ = memoryScan.deepCopy();
    publishSnapshot();
  }
  void memory(const Json& target, const Json& scan) {
    memoryTarget_ = target.deepCopy();
    memoryScan_ = scan.deepCopy();
    publishSnapshot();
  }
};
#endif
int main(int argc,char** argv) {
  try {
#ifdef PS5
    syscall(SYS_thr_set_name,-1,"ps5library-agent");
#endif
    auto config=std::filesystem::absolute(argc>1?argv[1]:"/data/ps5library/config.json");
    auto offline=config.parent_path()/"offline-mode.json";
    std::filesystem::create_directories(config.parent_path());
    auto settings=ps5library::bootstrapAgentConfig(config,{});
    int lock=open((config.parent_path()/"agent.lock").c_str(),O_CREAT|O_RDWR|O_NOFOLLOW,0600);
    if(lock<0 || flock(lock,LOCK_EX|LOCK_NB)!=0) throw std::runtime_error("An agent is already running or its configuration directory is unavailable");
#ifdef PS5LIBRARY_EXPERIMENTAL_SHELL_INDICATOR
    ps5library::shell_indicator::AgentRuntime shellIndicator(config.parent_path());
    std::fprintf(stderr,"Shell indicator: %s\n",shellIndicator.status().c_str());
#endif
#ifdef PS5
    const auto usbPatch=ps5library::applyUsbHighSpeedStoragePatch();
    std::fprintf(stderr,"USB High-Speed storage patch: %s\n",usbPatch.c_str());
    try{ps5library::atomicJson(config.parent_path()/"usb-storage-patch.json",Json::object({{"status",usbPatch}}));}catch(const std::exception& e){std::fprintf(stderr,"USB storage patch receipt: %s\n",e.what());}
    const auto externalFpkgPatch=ps5library::applyExternalFpkgStoragePatch();
    std::fprintf(stderr,"External FPKG launch patch: %s\n",externalFpkgPatch.c_str());
    try{ps5library::atomicJson(config.parent_path()/"external-fpkg-patch.json",Json::object({{"status",externalFpkgPatch}}));}catch(const std::exception& e){std::fprintf(stderr,"External FPKG patch receipt: %s\n",e.what());}
    const bool externalFpkgReady=externalFpkgPatch=="APPLIED"||externalFpkgPatch=="ALREADY_APPLIED";
#else
    const bool externalFpkgReady=false;
#endif
    auto agent=std::make_unique<ps5library::Agent>(config,externalFpkgReady);
#ifdef PS5
    ShellCheatSession shellCheats;
#endif
    bool networkAuthorized=!settings["serverUrl"].string().empty()&&!enabled(offline);
#ifndef PS5
    ps5library::LocalAgentServer localApi;
#endif
    std::unique_ptr<ps5library::LocalAgentServer> appApi,updateApi;
#ifdef PS5
    std::unique_ptr<ps5library::LocalAgentServer> shellCheatApi;
#endif
    std::filesystem::path activePath;auto appApiRetry=std::chrono::steady_clock::time_point{},updateApiRetry=std::chrono::steady_clock::time_point{},shellCheatApiRetry=std::chrono::steady_clock::time_point{};std::string appControl,appApiError,updateApiError,shellCheatApiError,appCheatToken,pendingLaunch,pendingUpdateTitle,pendingUpdateBase,homeUpdateTitle,homeUpdateBase;auto launchDeadline=std::chrono::steady_clock::time_point{};bool appNotified=false,pendingClose=false,closeRequested=false;
    const auto launchTracePath=config.parent_path()/"launch-last.json";
    ps5library::LaunchTrace launchTrace(launchTracePath);
    auto traceObserveDeadline=std::chrono::steady_clock::time_point{},traceCriticalDeadline=std::chrono::steady_clock::time_point{},traceUploadRetry=std::chrono::steady_clock::time_point{};ps5library::LaunchProcessWatch traceProcessWatch,traceBigAppWatch;bool traceExitPending=false,traceUploadPending=false;
    try{auto saved=ps5library::readJsonIfPresent(launchTracePath,1024*1024);traceUploadPending=saved&&(*saved)["traceCompletedAtUnixMs"].isInteger();}catch(...){}
#ifdef PS5
    SdkLogCapture launchLog;
    auto tracePoll=std::chrono::steady_clock::time_point{},traceFinish=std::chrono::steady_clock::time_point{},tracePidPoll=std::chrono::steady_clock::time_point{};
#endif
    auto captureLaunchLog=[&]{
#ifdef PS5
      launchLog.poll(launchTrace);
#endif
    };
    auto finishLaunchTrace=[&](int64_t at,const std::string& state="PROCESS_EXITED"){
      captureLaunchLog();launchTrace.finish(at,state);
      try{auto saved=ps5library::readJsonIfPresent(launchTracePath,1024*1024);traceUploadPending=saved&&(*saved)["traceCompletedAtUnixMs"].isInteger();}catch(...){traceUploadPending=false;}
    };
    auto uploadLaunchTrace=[&]{
      const auto now=std::chrono::steady_clock::now();if(!traceUploadPending||!networkAuthorized||!agent->paired()||now<traceUploadRetry)return;traceUploadRetry=now+std::chrono::seconds(10);
      try{agent->client.uploadLaunchTrace(launchTracePath);traceUploadPending=false;}catch(const std::exception& e){std::fprintf(stderr,"Launch trace upload: %s\n",e.what());}
    };
    Json cached;
#if defined(PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER)
    Json memoryTarget, memoryScan;
#endif
    auto scanned=std::chrono::steady_clock::time_point{};
    std::unordered_map<std::string,std::pair<std::filesystem::file_time_type,std::string>> mediaHashes;
    auto isMemoryAction=[](ps5library::LocalAgentAction action){
      return action>=ps5library::LocalAgentAction::MemoryScanTarget &&
             action<=ps5library::LocalAgentAction::MemoryScanClear;
    };
    auto reload=[&](Json next){
#if defined(PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER)
      try{agent->localMemoryScanRestoreAll();}catch(const std::exception& e){std::fprintf(stderr,"Memory scanner restore before reload failed: %s\n",e.what());throw;}
#endif
      settings=std::move(next);agent=std::make_unique<ps5library::Agent>(config,externalFpkgReady);cached=Json();scanned={};
#if defined(PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER)
      memoryTarget=Json();memoryScan=Json();
#endif
    };
    auto cache=[&](Json local){auto state=agent->status();ps5library::addLocalMedia(local,mediaHashes,[&]{return !running;});auto device=Json::object({{"deviceId",state["deviceId"]},{"consoleId",state["consoleId"]},{"pairingCode",state["pairing"]["code"]}});cached=Json::object({{"snapshot",local},{"device",device}});scanned=std::chrono::steady_clock::now();
#ifdef PS5
      try{
#if defined(PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER)
        memoryTarget=agent->localMemoryScanTarget();
        shellCheats.snapshot(local["cheats"],memoryTarget,memoryScan);
#else
        shellCheats.snapshot(local["cheats"]);
#endif
      }catch(const std::exception& e){std::fprintf(stderr,"Shell cheat snapshot: %s\n",e.what());}
#endif
      return cached;};
    auto refresh=[&]{auto previous=cached["snapshot"]["storageFormat"]["formatState"].string();const bool wasActive=previous=="STARTING"||previous=="FORMATTING";auto format=ps5library::storageFormatCoordinator().state();if(!cached.null()){auto local=cached["snapshot"];local.set("storageFormat",format);cached.set("snapshot",local);}if(ps5library::storageFormatCoordinator().active()){if(cached.null())throw std::runtime_error("STORAGE_FORMAT_BUSY");return cached;}auto age=std::chrono::steady_clock::now()-scanned;const bool nativeBecameReady=!cached.null()&&!cached["snapshot"]["capabilities"]["nativeDownloads"].boolean()&&ps5library::nativeDownloadsAvailable();if(nativeBecameReady||wasActive)agent->invalidateSnapshot();if(cached.null()||wasActive||nativeBecameReady||age>=std::chrono::seconds(60))return cache(agent->localSnapshot());return cached;};
    auto snapshot=[&]{if(cached.null())throw std::runtime_error("Local snapshot not ready");return cached;};
#if defined(PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER)
    auto publishMemory=[&]{
#ifdef PS5
      shellCheats.memory(memoryTarget,memoryScan);
#endif
    };
    auto refreshMemoryState=[&]{
      auto next=agent->localMemoryScanTarget();
      const bool sameTarget=next["available"].boolean()&&
        memoryTarget["available"].boolean()&&
        next["titleId"].string()==memoryTarget["titleId"].string()&&
        next["version"].string()==memoryTarget["version"].string()&&
        next["process"].string()==memoryTarget["process"].string();
      memoryTarget=std::move(next);
      if(!sameTarget)memoryScan=Json();
      else if(memoryScan.isObject())try{
        memoryScan=agent->localMemoryScanWatch(memoryScan["scanId"].string());
      }catch(...){memoryScan=Json();}
      publishMemory();
    };
    auto memoryHandle=[&](const ps5library::LocalAgentRequest& request)->Json{
      Json response;
      switch(request.action){
        case ps5library::LocalAgentAction::MemoryScanTarget:
          refreshMemoryState();return memoryTarget;
        case ps5library::LocalAgentAction::MemoryScanStart:
          memoryTarget=agent->localMemoryScanTarget();
          memoryScan=agent->localMemoryScanStart(request.titleId,request.version,
              request.valueType,request.scanMode,request.scalarValue);
          response=memoryScan;break;
        case ps5library::LocalAgentAction::MemoryScanRefine:
          memoryScan=agent->localMemoryScanRefine(request.scanId,
              request.scanMode,request.scalarValue);
          response=memoryScan;break;
        case ps5library::LocalAgentAction::MemoryScanWatch:
          memoryScan=agent->localMemoryScanWatch(request.scanId);
          response=memoryScan;break;
        case ps5library::LocalAgentAction::MemoryScanWrite:
#if defined(PS5LIBRARY_EXPERIMENTAL_MEMORY_WRITES)
          if(!request.explicitApproval)
            throw std::runtime_error("LOCAL_APPROVAL_REQUIRED");
          response=agent->localMemoryScanWrite(request.scanId,request.resultId,
              request.scalarValue,request.freeze);
          memoryScan=agent->localMemoryScanWatch(request.scanId);break;
#else
          throw std::runtime_error("MEMORY_WRITE_DISABLED");
#endif
        case ps5library::LocalAgentAction::MemoryScanRestore:
#if defined(PS5LIBRARY_EXPERIMENTAL_MEMORY_WRITES)
          if(!request.explicitApproval)
            throw std::runtime_error("LOCAL_APPROVAL_REQUIRED");
          response=agent->localMemoryScanRestore(request.scanId,
              request.resultId);
          memoryScan=agent->localMemoryScanWatch(request.scanId);break;
#else
          throw std::runtime_error("MEMORY_WRITE_DISABLED");
#endif
        case ps5library::LocalAgentAction::MemoryScanClear:
          agent->localMemoryScanClear();memoryScan=Json();
          response=Json::object({{"cleared",true}});break;
        default: throw std::runtime_error("MEMORY_ACTION_REQUIRED");
      }
      memoryTarget=agent->localMemoryScanTarget();
      publishMemory();
      return response;
    };
#endif
    auto handle=[&](const ps5library::LocalAgentRequest& request){
      if(isMemoryAction(request.action)){
#if defined(PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER)
        return memoryHandle(request);
#else
        throw std::runtime_error("MEMORY_SCANNER_DISABLED");
#endif
      }
      if(request.action==ps5library::LocalAgentAction::Connect||request.action==ps5library::LocalAgentAction::Offline){auto server=ps5library::normalizeServerUrl(request.serverUrl,request.allowInsecureLan),fallback=request.fallbackServerUrl.empty()?std::string():ps5library::normalizeServerUrl(request.fallbackServerUrl,request.allowInsecureLan);if(fallback==server)fallback.clear();auto control=std::string(request.action==ps5library::LocalAgentAction::Connect?"online:":"offline:")+(request.allowInsecureLan?"1:":"0:")+server+":"+fallback;if(control!=appControl){bool changed=settings["serverUrl"].string()!=server||settings["fallbackServerUrl"].string()!=fallback||settings["allowInsecureLan"].boolean()!=request.allowInsecureLan;if(changed)reload(ps5library::connectAgentConfig(config,server,request.allowInsecureLan,fallback));networkAuthorized=request.action==ps5library::LocalAgentAction::Connect;ps5library::atomicJson(offline,Json(!networkAuthorized));appControl=control;}return refresh();}if(request.action==ps5library::LocalAgentAction::Disconnect){if(appControl!="disconnected"){networkAuthorized=false;ps5library::atomicJson(offline,Json(true));auto state=agent->status();const bool changed=!settings["serverUrl"].string().empty()||settings["allowInsecureLan"].boolean()||!state["serverUrl"].string().empty()||!state["credential"].string().empty()||!state["consoleId"].string().empty()||!state["pairing"].null();if(changed)reload(ps5library::disconnectAgentConfig(config));appControl="disconnected";}return refresh();}if(request.action==ps5library::LocalAgentAction::HardwareProof)return Json::object({{"hardwareProof",agent->hardwareProof()}});if(request.action==ps5library::LocalAgentAction::Refresh){cached=Json();agent->invalidateSnapshot();return refresh();}if(request.action==ps5library::LocalAgentAction::Online){return Json::object({{"online",networkAuthorized}});}if(request.action==ps5library::LocalAgentAction::Cheats)return Json::object({{"cheats",agent->localCheats()}});if(request.action==ps5library::LocalAgentAction::CheatEnable){cached=Json();return agent->localCheatEnable(request.profileId,request.entryId,request.explicitApproval);}if(request.action==ps5library::LocalAgentAction::CheatDisable){cached=Json();return agent->localCheatDisable(request.profileId,request.entryId);}if(ps5library::storageFormatCoordinator().active()&&(request.action==ps5library::LocalAgentAction::Delete||request.action==ps5library::LocalAgentAction::Move||request.action==ps5library::LocalAgentAction::FormatPrepare))throw std::runtime_error("STORAGE_FORMAT_BUSY");if(request.action==ps5library::LocalAgentAction::Delete){auto result=agent->localDelete(request.titleId,request.storageId);cached=Json();agent->invalidateSnapshot();return result;}if(request.action==ps5library::LocalAgentAction::Move){auto result=agent->localMove(request.titleId,request.sourceStorageId,request.storageId);cached=Json();agent->invalidateSnapshot();return result;}if(request.action==ps5library::LocalAgentAction::Close){if(pendingClose)throw std::runtime_error("APP_TRANSITION_BUSY");pendingLaunch.clear();pendingUpdateTitle.clear();pendingUpdateBase.clear();pendingClose=true;closeRequested=false;launchDeadline=std::chrono::steady_clock::now()+std::chrono::seconds(15);return Json::object({{"queued",true}});}if(request.action==ps5library::LocalAgentAction::Launch){if(pendingClose)throw std::runtime_error("APP_TRANSITION_BUSY");if(!ps5library::localLaunchable(refresh()["snapshot"],request.titleId))throw std::runtime_error("TITLE_NOT_AVAILABLE");traceProcessWatch.reset();traceBigAppWatch.reset();traceCriticalDeadline={};captureLaunchLog();launchTrace.beginAgent(request.titleId,unixMilliseconds());traceObserveDeadline=std::chrono::steady_clock::now()+std::chrono::seconds(45);pendingLaunch=request.titleId;pendingUpdateTitle.clear();pendingUpdateBase.clear();pendingClose=true;closeRequested=false;launchDeadline=std::chrono::steady_clock::now()+std::chrono::seconds(15);return Json::object({{"queued",true}});}if(request.action==ps5library::LocalAgentAction::AppUpdate){if(pendingClose||!networkAuthorized||!ps5library::nativeDownloadsAvailable())throw std::runtime_error("APP_UPDATE_UNAVAILABLE");pendingLaunch.clear();pendingUpdateTitle=request.titleId;pendingUpdateBase=request.version;pendingClose=true;closeRequested=false;launchDeadline=std::chrono::steady_clock::now()+std::chrono::seconds(15);return Json::object({{"queued",true}});}if(request.action==ps5library::LocalAgentAction::FormatPrepare)return ps5library::storageFormatCoordinator().prepare(request.storageId);if(request.action==ps5library::LocalAgentAction::FormatConfirm){auto result=ps5library::storageFormatCoordinator().confirm(request.storageId,request.challenge);agent->invalidateSnapshot();return result;}return snapshot();};
    auto shellCheatHandle=[&](const ps5library::LocalAgentRequest& request){
#if defined(PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER)
      if(isMemoryAction(request.action))return memoryHandle(request);
#endif
      if(request.action==ps5library::LocalAgentAction::CheatEnable){cached=Json();return agent->localCheatEnable(request.profileId,request.entryId,request.explicitApproval);}if(request.action==ps5library::LocalAgentAction::CheatDisable){cached=Json();return agent->localCheatDisable(request.profileId,request.entryId);}throw std::runtime_error("CHEAT_ACTION_REQUIRED");};
    auto file=[&](const ps5library::LocalAgentRequest& request){return cached.null()||ps5library::storageFormatCoordinator().active()?std::filesystem::path():ps5library::localMediaPath(cached["snapshot"],request.titleId,request.kind);};auto serve=[&]{
#ifndef PS5
      localApi.poll(handle,file);
#endif
#ifdef PS5
      auto now=std::chrono::steady_clock::now();if(now>=appApiRetry){appApiRetry=now+std::chrono::milliseconds(appApi?2000:ps5library::localAgentRefreshDelay(false));auto desired=ps5library::localAgentSharedPath();if(activePath!=desired){appApi.reset();if(!activePath.empty()){std::error_code error;std::filesystem::remove(activePath/"cheat-session",error);}activePath=desired;appCheatToken.clear();appControl.clear();appApiError.clear();appNotified=false;cached=Json();scanned={};}if(appApi&&!appApi->available()){appApi.reset();appCheatToken.clear();appControl.clear();appNotified=false;}if(!appApi&&!desired.empty())try{appCheatToken=ps5library::randomHex(32);const auto tokenPath=desired/"cheat-session";ps5library::atomicBytes(tokenPath,appCheatToken);if(chmod(tokenPath.c_str(),0644))throw std::runtime_error("Cheat session permission failed");appApi=std::make_unique<ps5library::LocalAgentServer>(ps5library::localAgentPort,nullptr,appCheatToken);appApiError.clear();std::fprintf(stderr,"Agent IPC ready: %s\n",ps5library::localAgentUrl().c_str());}catch(const std::exception& e){appCheatToken.clear();if(appApiError!=e.what()){appApiError=e.what();std::fprintf(stderr,"Agent IPC unavailable: %s\n",e.what());}} }
      if(now>=updateApiRetry){updateApiRetry=now+std::chrono::seconds(2);if(updateApi&&!updateApi->available()){updateApi.reset();ps5library::setNativeUpdateBridgeAvailable(false);cached=Json();scanned={};}if(!updateApi)try{updateApi=std::make_unique<ps5library::LocalAgentServer>(ps5library::nativeUpdateBridgePort);ps5library::setNativeUpdateBridgeAvailable(true);updateApiError.clear();cached=Json();scanned={};std::fprintf(stderr,"Native update bridge ready: http://%s:%u\n",ps5library::localAgentAddress().c_str(),ps5library::nativeUpdateBridgePort);}catch(const std::exception& e){ps5library::setNativeUpdateBridgeAvailable(false);if(updateApiError!=e.what()){updateApiError=e.what();std::fprintf(stderr,"Native update bridge unavailable: %s\n",e.what());}}}
      if(now>=shellCheatApiRetry){shellCheatApiRetry=now+std::chrono::seconds(2);if(shellCheatApi&&!shellCheatApi->available())shellCheatApi.reset();if(!shellCheatApi)try{shellCheatApi=std::make_unique<ps5library::LocalAgentServer>(ps5library::localCheatShellPort,"127.0.0.1","",shellCheats.token(),true);shellCheatApiError.clear();}catch(const std::exception& e){if(shellCheatApiError!=e.what()){shellCheatApiError=e.what();std::fprintf(stderr,"Shell cheat IPC unavailable: %s\n",e.what());}}}
#endif
      if(appApi)try{appApi->poll(handle,file,[&]{ps5library::notifyLocalAgentConnection(appNotified,[]{return ps5library::notify("PS5Library Agent connected");});});}catch(const std::exception& e){std::fprintf(stderr,"Agent IPC reset: %s\n",e.what());appApi.reset();appNotified=false;}
#ifdef PS5
      if(updateApi)try{updateApi->poll(handle,{},{},[&](const ps5library::LocalAgentRequest& request){if(homeUpdateBase.empty()){homeUpdateTitle=request.titleId;homeUpdateBase=request.version;}});}catch(const std::exception& e){std::fprintf(stderr,"Native update bridge reset: %s\n",e.what());updateApi.reset();ps5library::setNativeUpdateBridgeAvailable(false);cached=Json();scanned={};}
      if(shellCheatApi)try{shellCheatApi->poll(shellCheatHandle);}catch(const std::exception& e){std::fprintf(stderr,"Shell cheat IPC reset: %s\n",e.what());shellCheatApi.reset();}
      try{shellCheats.heartbeat();}catch(const std::exception& e){std::fprintf(stderr,"Shell cheat heartbeat: %s\n",e.what());}
#endif
    };
    auto launchReceipt=[&](const std::string& title,const std::string& state,int initialize=0,int user=0,int launch=0){
      try{
        if(!title.empty()&&launchTrace.matches(title)){
          if(state=="ACCEPTED"||state=="REJECTED")launchTrace.launchResult(initialize,user,launch,unixMilliseconds());else launchTrace.state(state,unixMilliseconds());
          if(state=="ACCEPTED")traceObserveDeadline=std::chrono::steady_clock::now()+std::chrono::seconds(30);
          else if(state=="REJECTED"||state=="APP_DID_NOT_CLOSE"||state=="OTHER_BIG_APP_RUNNING"||state=="CLOSE_REJECTED"){finishLaunchTrace(unixMilliseconds(),state);traceExitPending=false;traceProcessWatch.reset();traceBigAppWatch.reset();}
          return;
        }
        if(launchTrace.active())return;
        ps5library::atomicJson(config.parent_path()/"launch-last.json",Json::object({{"titleId",title},{"state",state},{"initialize",initialize},{"user",user},{"launch",launch}}));
      }catch(const std::exception& e){std::fprintf(stderr,"Launch receipt: %s\n",e.what());}
    };
    auto launchPending=[&]{
#ifdef PS5
      if(!pendingClose&&pendingLaunch.empty()&&pendingUpdateBase.empty())return;if(std::chrono::steady_clock::now()>=launchDeadline){auto title=std::move(pendingLaunch);pendingLaunch.clear();pendingUpdateTitle.clear();pendingUpdateBase.clear();pendingClose=false;closeRequested=false;launchReceipt(title,"APP_DID_NOT_CLOSE");ps5library::notify(title.empty()?"PS5Library could not close":"PS5Library could not open the selected game");return;}const int app=sceSystemServiceGetAppIdOfRunningBigApp();if(app>0){if(closeRequested)return;char title[16]{};if(sceLncUtilGetAppTitleId(static_cast<std::uint32_t>(app),title)||std::string(title)!=ps5library::nativeTitleId){auto target=std::move(pendingLaunch);pendingLaunch.clear();pendingUpdateTitle.clear();pendingUpdateBase.clear();pendingClose=false;launchReceipt(target,"OTHER_BIG_APP_RUNNING");ps5library::notify(target.empty()?"PS5Library could not close":"Another app is currently running");return;}std::unique_lock<std::mutex> lock(ps5library::nativeApiMutex(),std::try_to_lock);if(!lock.owns_lock())return;const int result=sceSystemServiceKillApp(app,-1,0,0);usleep(200000);launchReceipt(pendingLaunch,result?"CLOSE_REJECTED":"CLOSE_REQUESTED",0,0,result);if(result){pendingLaunch.clear();pendingUpdateTitle.clear();pendingUpdateBase.clear();pendingClose=false;ps5library::notify("PS5Library could not close");}else closeRequested=true;return;}if(!closeRequested)return;if(!pendingUpdateBase.empty()){auto title=std::move(pendingUpdateTitle),base=std::move(pendingUpdateBase);pendingUpdateTitle.clear();pendingUpdateBase.clear();pendingClose=false;closeRequested=false;try{agent->nativeAppUpdate(title,base);}catch(const std::exception& e){launchReceipt("",e.what());ps5library::notify("PS5Library update failed: "+std::string(e.what()));}return;}if(pendingLaunch.empty()){pendingClose=false;closeRequested=false;return;}std::unique_lock<std::mutex> lock(ps5library::nativeApiMutex(),std::try_to_lock);if(!lock.owns_lock())return;auto title=std::move(pendingLaunch);pendingLaunch.clear();pendingClose=false;closeRequested=false;launchReceipt(title,"STARTING");auto result=launchTitle(title);usleep(200000);launchReceipt(title,result.user||result.launch<0?"REJECTED":"ACCEPTED",result.initialize,result.user,result.launch);if(result.user||result.launch<0)ps5library::notify("PS5Library could not open "+title);
#endif
    };
    auto observeLaunch=[&]{
#ifdef PS5
      try{
        const auto now=std::chrono::steady_clock::now();if(now<tracePoll)return;tracePoll=now+std::chrono::milliseconds(100);const auto stamp=unixMilliseconds();
        const auto traceDeadline=launchTrace.appeared()?traceCriticalDeadline:traceObserveDeadline;
        if(launchTrace.active()&&traceDeadline!=std::chrono::steady_clock::time_point{}&&now>=traceDeadline){finishLaunchTrace(stamp,traceExitPending?"PROCESS_EXITED":launchTrace.appeared()?"TRACE_WINDOW_EXPIRED":"PROCESS_NOT_OBSERVED");traceExitPending=false;traceProcessWatch.reset();traceBigAppWatch.reset();return;}
        const int app=sceSystemServiceGetAppIdOfRunningBigApp();std::string title;bool titleRead=app==0;
        if(app>0){char value[16]{};if(!sceLncUtilGetAppTitleId(static_cast<std::uint32_t>(app),value)){title=value;titleRead=true;}}
        if(app<0||!titleRead){if(launchTrace.active()&&launchTrace.appeared()&&!traceExitPending&&traceBigAppWatch.observe(-1)){launchTrace.exited(stamp);traceFinish=now+std::chrono::seconds(3);traceExitPending=true;}if(traceExitPending&&now>=traceFinish){finishLaunchTrace(stamp);traceExitPending=false;traceProcessWatch.reset();traceBigAppWatch.reset();}return;}
        const bool game=app>0&&!title.empty()&&title!=ps5library::nativeTitleId;
        if(game){
          traceBigAppWatch.observe(app);
          std::optional<int> pid;const bool pidPolled=now>=tracePidPoll;
          if(pidPolled){tracePidPoll=now+std::chrono::milliseconds(500);try{pid=ps5library::ps5TitleProcessId(app,title);}catch(...) {}}
          if(traceExitPending){
            if(!launchTrace.matches(title)||(pidPolled&&pid&&*pid>0)){finishLaunchTrace(stamp,launchTrace.matches(title)?"PROCESS_RESTARTED":"PROCESS_REPLACED");traceExitPending=false;traceProcessWatch.reset();traceBigAppWatch.reset();tracePidPoll={};}
            else{if(now>=traceFinish){finishLaunchTrace(stamp);traceExitPending=false;traceProcessWatch.reset();traceBigAppWatch.reset();}return;}
          }
          if(launchTrace.active()&&!launchTrace.matches(title)){if(launchTrace.appeared())launchTrace.exited(stamp);finishLaunchTrace(stamp,"PROCESS_REPLACED");traceProcessWatch.reset();traceBigAppWatch.reset();}
          if(!launchTrace.active()){
            if(!pidPolled||!pid||*pid<=0)return;
            captureLaunchLog();launchTrace.appeared(title,stamp);launchTrace.process(*pid,stamp);traceCriticalDeadline=now+std::chrono::seconds(60);traceProcessWatch.reset();traceProcessWatch.observe(pid);traceBigAppWatch.observe(app);
          }else if(!launchTrace.appeared()){
            if(pidPolled&&pid&&*pid>0){captureLaunchLog();launchTrace.appeared(title,stamp);launchTrace.process(*pid,stamp);traceCriticalDeadline=now+std::chrono::seconds(60);traceProcessWatch.reset();traceProcessWatch.observe(pid);traceBigAppWatch.observe(app);}
            else{if(traceObserveDeadline!=std::chrono::steady_clock::time_point{}&&now>=traceObserveDeadline){finishLaunchTrace(stamp,"PROCESS_NOT_OBSERVED");traceProcessWatch.reset();traceBigAppWatch.reset();}return;}
          }else if(pidPolled){
            if(pid&&*pid>0&&!launchTrace.processObserved())launchTrace.process(*pid,stamp);
            if(traceProcessWatch.observe(pid)){launchTrace.exited(stamp);traceFinish=now+std::chrono::seconds(3);traceExitPending=true;return;}
          }
          if(!launchTrace.active()){traceProcessWatch.reset();traceBigAppWatch.reset();return;}
          return;
        }
        if(launchTrace.active()&&launchTrace.appeared()&&!traceExitPending){if(!traceBigAppWatch.observe(-1))return;launchTrace.exited(stamp);traceFinish=now+std::chrono::seconds(3);traceExitPending=true;traceProcessWatch.reset();}
        if(traceExitPending&&now>=traceFinish){finishLaunchTrace(stamp);traceExitPending=false;traceProcessWatch.reset();traceBigAppWatch.reset();}
      }catch(const std::exception& e){std::fprintf(stderr,"Launch trace: %s\n",e.what());}
#endif
    };
    auto homeUpdatePending=[&]{
#ifdef PS5
      if(homeUpdateBase.empty())return;auto title=std::move(homeUpdateTitle),base=std::move(homeUpdateBase);homeUpdateTitle.clear();homeUpdateBase.clear();if(sceSystemServiceGetAppIdOfRunningBigApp()>0){ps5library::notify(std::string(ps5library::nativeUpdateIdentity(title)->name)+" update could not start while an app is open");return;}try{agent->nativeAppUpdate(title,base);}catch(const std::exception& e){launchReceipt(title,e.what());ps5library::notify(std::string(ps5library::nativeUpdateIdentity(title)->name)+" update failed: "+e.what());}
#endif
    };
    std::signal(SIGINT,[](int){running=0;}); std::signal(SIGTERM,[](int){running=0;});
    std::signal(SIGPIPE,SIG_IGN);
    while(running) {serve();launchPending();observeLaunch();homeUpdatePending();uploadLaunchTrace();agent->localCheatReconcile();
#if defined(PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER)
      try{refreshMemoryState();}catch(const std::exception& e){std::fprintf(stderr,"Memory scanner refresh: %s\n",e.what());}
#endif
      bool local=!networkAuthorized||enabled(offline)||settings["serverUrl"].string().empty(),authenticatedHeartbeat=false;
      agent->client.cancelled=[&]{return !running;};try {
        if(!pendingClose){if(local||ps5library::storageFormatCoordinator().active())refresh();else{auto latest=agent->tick();authenticatedHeartbeat=!latest.null();if(authenticatedHeartbeat)cache(std::move(latest));}}
      } catch(const std::exception& e) { std::fprintf(stderr,"Agent: %s\n",e.what()); }
#ifdef PS5LIBRARY_EXPERIMENTAL_SHELL_INDICATOR
      shellIndicator.serverHeartbeat(authenticatedHeartbeat);
#endif
      if(argc>2 && std::string(argv[2])=="--once") break;
      const int waitTicks=(local?5:agent->heartbeatIntervalSeconds())*10;for(int i=0;i<waitTicks&&running&&local==(!networkAuthorized||enabled(offline)||settings["serverUrl"].string().empty());i++){serve();launchPending();observeLaunch();homeUpdatePending();agent->localCheatReconcile();std::this_thread::sleep_for(std::chrono::milliseconds(100));}
    }
    int exitCode=0;
#if defined(PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER)
    try{agent->localMemoryScanRestoreAll();}catch(const std::exception& e){std::fprintf(stderr,"Memory scanner restore during shutdown failed: %s\n",e.what());exitCode=1;}
#endif
    ps5library::setNativeUpdateBridgeAvailable(false);close(lock); return exitCode;
  } catch(const std::exception& e) { std::fprintf(stderr,"%s\n",e.what()); return 1; }
}
