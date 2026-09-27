#include "../common/client.hpp"
#include "../common/version.hpp"
#include "config.hpp"
#include "local.hpp"
#include "storage_format.hpp"
#include <chrono>
#include <thread>
#include <memory>
#include <cstdio>
#include <csignal>
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#ifdef PS5
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
static AgentLaunchResult launchTitle(const std::string& title){AgentLaunchContext context{};context.size=sizeof(context);AgentLaunchResult result{sceUserServiceInitialize(nullptr),-1,-1};result.user=sceUserServiceGetForegroundUser(&context.user);if(!result.user){char* arguments[]={nullptr};result.launch=sceSystemServiceLaunchApp(title.c_str(),arguments,&context);}return result;}
#endif
static volatile std::sig_atomic_t running=1;
static bool enabled(const std::filesystem::path& marker){try{return std::filesystem::is_regular_file(marker)&&ps5library::readJson(marker).boolean();}catch(...){return false;}}
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
    auto agent=std::make_unique<ps5library::Agent>(config);
#ifdef PS5
    bool networkAuthorized=false;
#else
    bool networkAuthorized=!settings["serverUrl"].string().empty();
#endif
#ifndef PS5
    ps5library::LocalAgentServer localApi;
#endif
    std::unique_ptr<ps5library::LocalAgentServer> appApi;std::filesystem::path activePath;auto appApiRetry=std::chrono::steady_clock::time_point{};std::string appControl,appApiError,pendingLaunch,pendingUpdateBase;auto launchDeadline=std::chrono::steady_clock::time_point{};bool appNotified=false,pendingClose=false,closeRequested=false;
    Json cached;auto scanned=std::chrono::steady_clock::time_point{};std::unordered_map<std::string,std::pair<std::filesystem::file_time_type,std::string>> mediaHashes;
    auto reload=[&](Json next){settings=std::move(next);agent=std::make_unique<ps5library::Agent>(config);cached=Json();scanned={};};
    auto cache=[&](Json local){auto state=agent->status();ps5library::addLocalMedia(local,mediaHashes,[&]{return !running;});auto device=Json::object({{"deviceId",state["deviceId"]},{"consoleId",state["consoleId"]},{"pairingCode",state["pairing"]["code"]}});cached=Json::object({{"snapshot",local},{"device",device}});scanned=std::chrono::steady_clock::now();return cached;};
    auto refresh=[&]{auto previous=cached["snapshot"]["storageFormat"]["formatState"].string();const bool wasActive=previous=="STARTING"||previous=="FORMATTING";auto format=ps5library::storageFormatCoordinator().state();if(!cached.null()){auto local=cached["snapshot"];local.set("storageFormat",format);cached.set("snapshot",local);}if(ps5library::storageFormatCoordinator().active()){if(cached.null())throw std::runtime_error("STORAGE_FORMAT_BUSY");return cached;}auto age=std::chrono::steady_clock::now()-scanned;if(cached.null()||wasActive||age>=std::chrono::seconds(60))return cache(agent->localSnapshot());return cached;};
    auto snapshot=[&]{if(cached.null())throw std::runtime_error("Local snapshot not ready");return cached;};
    auto handle=[&](const ps5library::LocalAgentRequest& request){
      if(request.action==ps5library::LocalAgentAction::Connect||request.action==ps5library::LocalAgentAction::Offline){auto server=ps5library::normalizeServerUrl(request.serverUrl,request.allowInsecureLan);auto control=std::string(request.action==ps5library::LocalAgentAction::Connect?"online:":"offline:")+(request.allowInsecureLan?"1:":"0:")+server;if(control!=appControl){bool changed=settings["serverUrl"].string()!=server||settings["allowInsecureLan"].boolean()!=request.allowInsecureLan;if(changed)reload(ps5library::connectAgentConfig(config,server,request.allowInsecureLan));networkAuthorized=request.action==ps5library::LocalAgentAction::Connect;ps5library::atomicJson(offline,Json(!networkAuthorized));appControl=control;}return refresh();}if(request.action==ps5library::LocalAgentAction::Disconnect){if(appControl!="disconnected"){networkAuthorized=false;ps5library::atomicJson(offline,Json(true));reload(ps5library::disconnectAgentConfig(config));appControl="disconnected";}return refresh();}if(request.action==ps5library::LocalAgentAction::Online){return Json::object({{"online",networkAuthorized}});}if(ps5library::storageFormatCoordinator().active()&&(request.action==ps5library::LocalAgentAction::Delete||request.action==ps5library::LocalAgentAction::Move||request.action==ps5library::LocalAgentAction::FormatPrepare))throw std::runtime_error("STORAGE_FORMAT_BUSY");if(request.action==ps5library::LocalAgentAction::Delete){auto result=agent->localDelete(request.titleId,request.storageId);cached=Json();return result;}if(request.action==ps5library::LocalAgentAction::Move){auto result=agent->localMove(request.titleId,request.sourceStorageId,request.storageId);cached=Json();return result;}if(request.action==ps5library::LocalAgentAction::Close){if(pendingClose)throw std::runtime_error("APP_TRANSITION_BUSY");pendingLaunch.clear();pendingUpdateBase.clear();pendingClose=true;closeRequested=false;launchDeadline=std::chrono::steady_clock::now()+std::chrono::seconds(15);return Json::object({{"queued",true}});}if(request.action==ps5library::LocalAgentAction::Launch){if(pendingClose)throw std::runtime_error("APP_TRANSITION_BUSY");if(!ps5library::localLaunchable(refresh()["snapshot"],request.titleId))throw std::runtime_error("TITLE_NOT_AVAILABLE");pendingLaunch=request.titleId;pendingUpdateBase.clear();pendingClose=true;closeRequested=false;launchDeadline=std::chrono::steady_clock::now()+std::chrono::seconds(15);return Json::object({{"queued",true}});}if(request.action==ps5library::LocalAgentAction::AppUpdate){if(pendingClose||!networkAuthorized||!ps5library::nativeDownloadsAvailable())throw std::runtime_error("APP_UPDATE_UNAVAILABLE");pendingLaunch.clear();pendingUpdateBase=request.version;pendingClose=true;closeRequested=false;launchDeadline=std::chrono::steady_clock::now()+std::chrono::seconds(15);return Json::object({{"queued",true}});}if(request.action==ps5library::LocalAgentAction::FormatPrepare)return ps5library::storageFormatCoordinator().prepare(request.storageId);if(request.action==ps5library::LocalAgentAction::FormatConfirm)return ps5library::storageFormatCoordinator().confirm(request.storageId,request.challenge);return snapshot();};
    auto file=[&](const ps5library::LocalAgentRequest& request){return cached.null()||ps5library::storageFormatCoordinator().active()?std::filesystem::path():ps5library::localMediaPath(cached["snapshot"],request.titleId,request.kind);};auto serve=[&]{
#ifndef PS5
      localApi.poll(handle,file);
#endif
#ifdef PS5
      auto now=std::chrono::steady_clock::now();if(now>=appApiRetry){appApiRetry=now+std::chrono::seconds(2);auto desired=ps5library::localAgentSharedPath();if(activePath!=desired){appApi.reset();activePath=desired;appControl.clear();appApiError.clear();appNotified=false;networkAuthorized=false;ps5library::atomicJson(offline,Json(true));cached=Json();scanned={};}if(appApi&&!appApi->available()){appApi.reset();appControl.clear();appNotified=false;networkAuthorized=false;ps5library::atomicJson(offline,Json(true));}if(!appApi&&!desired.empty())try{appApi=std::make_unique<ps5library::LocalAgentServer>();appApiError.clear();std::fprintf(stderr,"Agent IPC ready: %s\n",ps5library::localAgentUrl().c_str());}catch(const std::exception& e){if(appApiError!=e.what()){appApiError=e.what();std::fprintf(stderr,"Agent IPC unavailable: %s\n",e.what());}} }
#endif
      if(appApi)try{appApi->poll(handle,file,[&]{ps5library::notifyLocalAgentConnection(appNotified,[]{return ps5library::notify("PS5Library Agent connected");});});}catch(const std::exception& e){std::fprintf(stderr,"Agent IPC reset: %s\n",e.what());appApi.reset();appNotified=false;}};
    auto launchReceipt=[&](const std::string& title,const std::string& state,int initialize=0,int user=0,int launch=0){try{ps5library::atomicJson(config.parent_path()/"launch-last.json",Json::object({{"titleId",title},{"state",state},{"initialize",initialize},{"user",user},{"launch",launch}}));}catch(const std::exception& e){std::fprintf(stderr,"Launch receipt: %s\n",e.what());}};
    auto launchPending=[&]{
#ifdef PS5
      if(!pendingClose&&pendingLaunch.empty()&&pendingUpdateBase.empty())return;if(std::chrono::steady_clock::now()>=launchDeadline){auto title=std::move(pendingLaunch);pendingLaunch.clear();pendingUpdateBase.clear();pendingClose=false;closeRequested=false;launchReceipt(title,"APP_DID_NOT_CLOSE");ps5library::notify(title.empty()?"PS5Library could not close":"PS5Library could not open the selected game");return;}const int app=sceSystemServiceGetAppIdOfRunningBigApp();if(app>0){if(closeRequested)return;char title[16]{};if(sceLncUtilGetAppTitleId(static_cast<std::uint32_t>(app),title)||std::string(title)!=ps5library::nativeTitleId){auto target=std::move(pendingLaunch);pendingLaunch.clear();pendingUpdateBase.clear();pendingClose=false;launchReceipt(target,"OTHER_BIG_APP_RUNNING");ps5library::notify(target.empty()?"PS5Library could not close":"Another app is currently running");return;}std::unique_lock<std::mutex> lock(ps5library::nativeApiMutex(),std::try_to_lock);if(!lock.owns_lock())return;const int result=sceSystemServiceKillApp(app,-1,0,0);usleep(200000);launchReceipt(pendingLaunch,result?"CLOSE_REJECTED":"CLOSE_REQUESTED",0,0,result);if(result){pendingLaunch.clear();pendingUpdateBase.clear();pendingClose=false;ps5library::notify("PS5Library could not close");}else closeRequested=true;return;}if(!closeRequested)return;if(!pendingUpdateBase.empty()){auto base=std::move(pendingUpdateBase);pendingUpdateBase.clear();pendingClose=false;closeRequested=false;try{agent->nativeAppUpdate(base);}catch(const std::exception& e){launchReceipt("",e.what());ps5library::notify("PS5Library update failed: "+std::string(e.what()));}return;}if(pendingLaunch.empty()){pendingClose=false;closeRequested=false;return;}std::unique_lock<std::mutex> lock(ps5library::nativeApiMutex(),std::try_to_lock);if(!lock.owns_lock())return;auto title=std::move(pendingLaunch);pendingLaunch.clear();pendingClose=false;closeRequested=false;launchReceipt(title,"STARTING");auto result=launchTitle(title);usleep(200000);launchReceipt(title,result.user||result.launch<0?"REJECTED":"ACCEPTED",result.initialize,result.user,result.launch);if(result.user||result.launch<0)ps5library::notify("PS5Library could not open "+title);
#endif
    };
    std::signal(SIGINT,[](int){running=0;}); std::signal(SIGTERM,[](int){running=0;});
    std::signal(SIGPIPE,SIG_IGN);
    while(running) {serve();launchPending();bool local=!networkAuthorized||enabled(offline)||settings["serverUrl"].string().empty();
      agent->client.cancelled=[&]{return !running;};try {
        if(!pendingClose){if(local||ps5library::storageFormatCoordinator().active())refresh();else{auto latest=agent->tick();if(!latest.null())cache(std::move(latest));}}
      } catch(const std::exception& e) { std::fprintf(stderr,"Agent: %s\n",e.what()); }
      if(argc>2 && std::string(argv[2])=="--once") break;
      for(int i=0;i<50 && running;i++){serve();launchPending();std::this_thread::sleep_for(std::chrono::milliseconds(100));}
    } close(lock); return 0;
  } catch(const std::exception& e) { std::fprintf(stderr,"%s\n",e.what()); return 1; }
}
