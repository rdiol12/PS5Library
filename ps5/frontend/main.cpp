#include "../common/client.hpp"
#include "../common/update.hpp"
#include "design.hpp"
#include "focus.hpp"
#include "render.hpp"
#include "input.hpp"
#include "lifecycle.hpp"
#include "artwork.hpp"
#include "audio.hpp"
#ifdef PS5
#include "ps5_audio.hpp"
#endif
#include "video.hpp"
#include "collections.hpp"
#include <SDL_image.h>
#include <atomic>
#include <chrono>
#include <ctime>
#include <future>
#include <functional>
#include <cstring>
#include <numeric>
#include <thread>
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
using namespace ps5library;
using namespace storefront;

static std::string amount(int64_t n){char s[80];std::snprintf(s,sizeof(s),n>=1000000000?"%.1f GB":"%.1f MB",n/(n>=1000000000?1000000000.0:1000000.0));return s;}
static std::string friendly(std::string text){std::replace(text.begin(),text.end(),'_',' ');for(auto& c:text)c=static_cast<char>(std::tolower(static_cast<unsigned char>(c)));if(!text.empty())text.front()=static_cast<char>(std::toupper(static_cast<unsigned char>(text.front())));return text;}
static std::string lower(std::string text){for(auto& c:text)c=static_cast<char>(std::tolower(static_cast<unsigned char>(c)));return text;}
static std::string list(const Json& array){std::string text;for(size_t i=0;i<array.size();i++){if(i)text+=" / ";text+=array[i].string();}return text;}
static SDL_Rect crop(const Json& value){return {static_cast<int>(value["x"].number()),static_cast<int>(value["y"].number()),static_cast<int>(value["w"].number()),static_cast<int>(value["h"].number())};}
struct Options {fs::path config="/data/ps5library/config.json";bool preview=false;int width=1920,height=1080,frames=0;std::string screen="Discover",capture,script;};
#ifdef PS5
extern "C" {extern const unsigned char ui_font[],ui_font_license[],ui_certificates[];extern const size_t ui_font_size,ui_font_license_size,ui_certificates_size;}
static void localAssets(const fs::path& root){for(const auto& item:std::vector<std::pair<std::string,std::string_view>>{{"DejaVuSans.ttf",{reinterpret_cast<const char*>(ui_font),ui_font_size}},{"FONT-LICENSE.txt",{reinterpret_cast<const char*>(ui_font_license),ui_font_license_size}},{"ca-bundle.crt",{reinterpret_cast<const char*>(ui_certificates),ui_certificates_size}}})if(!fs::exists(root/item.first))atomicBytes(root/item.first,item.second);}
#endif

class Storefront {
  Options options_;Json config_,model_=Json::object(),device_,plan_;std::string credential_,query_,category_,libraryFilter_="All";
  SDL_Window* window_=nullptr;SDL_Renderer* renderer_=nullptr;std::unique_ptr<Canvas> canvas_;std::unique_ptr<Artwork> art_;std::unique_ptr<Input> input_;
  std::unique_ptr<UiAudio> audio_;
  std::unique_ptr<VideoPreview> video_;PreviewDelay previewDelay_,musicDelay_;std::string previewKey_,musicKey_;bool windowActive_=true;Visibility visibility_;
  bool profileTrophies_=false,serverLibrary_=false;
  bool releaseAddons_=false;size_t releasePage_=0;
  Json removal_,removalConsole_;
  SDL_Texture* backdropCache_=nullptr;std::string backdropKey_,launchTitle_;
  Focus focus_;std::unordered_map<std::string,std::function<void()>> actions_;std::unordered_map<std::string,Rect> rects_;
  std::unordered_map<std::string,float> animation_,scroll_;std::unordered_map<std::string,std::string> screenFocus_;
  std::vector<std::string> desiredImages_,tabs_={"Discover","New Releases","Categories","My Library","Downloads","My PS5"};
  std::string page_="Discover",returnPage_,gameId_,consoleId_,storageId_,method_,modal_,message_,heroUrl_,oldHero_,taskError_,launchId_=randomHex(16);size_t featured_=0,release_=0;
  bool offline_=false,loading_=true,advanced_=false;float delta_=1.f/60.f,heroMix_=1;Uint32 toastUntil_=0,lastRefresh_=0;int modalStep_=0;
  std::atomic<bool> running_{true};std::thread agent_;std::future<std::string> request_;std::function<void(const Json&)> complete_;
  std::atomic<bool> networkPaused_{false};bool setupInFlight_=false,draftHttp_=false,replaceDraft_=false;std::string draftServer_;
  std::function<void()> pending_;uint64_t planRevision_=0;
  std::vector<double> frameTimes_,drawTimes_,presentTimes_,intervalTimes_;int backdropCompositions_=0;std::vector<std::string> script_;size_t scriptIndex_=0;int frameCount_=0;
  std::future<std::string> updateRequest_;Json updateEnvelope_,updateManifest_;std::string updateStatus_="Updates are checked automatically.";Uint32 lastUpdateCheck_=0;
  std::atomic<int64_t> updateBytes_{0},updateTotal_{0};bool updating_=false;int frontendLock_=-1;
  Canvas& draw(){return *canvas_;}
  Json catalog()const{return model_["catalog"];} Json consoles()const{return model_["consoles"];} Json jobs()const{return model_["jobs"];}
  Json game(const std::string& id)const{auto all=catalog();for(size_t i=0;i<all.size();i++)if(all[i]["id"].string()==id)return all[i];return Json();}
  Json selectedRelease()const{return game(gameId_)["releases"][release_];}
  Json selectedConsole()const{auto all=consoles();for(size_t i=0;i<all.size();i++)if(all[i]["id"].string()==consoleId_)return all[i];return Json();}
  Json featuredGame()const{auto all=catalog();if(options_.preview)return all.size()?all[featured_%all.size()]:Json();auto selected=model_["featured"];auto g=game(selected["gameId"].string());if(g.null())return Json();auto result=Json::parse(g.dump());result.set("heroUrl",selected["heroUrl"]);return result;}
  Json highlighted()const{if(!modal_.empty())return Json();if(page_=="Game")return game(gameId_);const auto id=focus_.id();if(id.rfind("rail",0)==0||id.rfind("grid:",0)==0)return game(id.substr(id.find(':')+1));return Json();}
  Json heroGame()const{const auto selected=highlighted();return !options_.preview&&page_=="Discover"&&!selected.null()?selected:page_=="Game"?game(gameId_):featuredGame();}
  void preview(){
    auto g=highlighted(),trailer=g["trailer"],music=g["music"];std::string key,musicKey;
    if(!options_.preview&&!offline_&&!networkPaused_&&windowActive_&&!credential_.empty()){
      if((config_["autoplayTrailers"].null()||config_["autoplayTrailers"].boolean())&&!trailer.null())key=page_+":"+g["id"].string()+":"+trailer["sha256"].string();
      if((config_["gameMusic"].null()||config_["gameMusic"].boolean())&&!music.null())musicKey=page_+":"+g["id"].string()+":"+music["sha256"].string();
    }
    if(key!=previewKey_||musicKey!=musicKey_){video_->stop();previewKey_=key;musicKey_=musicKey;}
    const auto now=SDL_GetTicks64();bool startMusic=musicDelay_.ready(musicKey,now,650),startTrailer=previewDelay_.ready(key,now);
    if(startTrailer)video_->start(key,config_,credential_,trailer,config_["trailerSound"].null()||config_["trailerSound"].boolean());
    else if(startMusic&&!video_->active())video_->start(musicKey,config_,credential_,music,true,true);
  }
  void togglePreference(const std::string& key){auto next=Json::parse(config_.dump());next.set(key.c_str(),!(next[key.c_str()].null()||next[key.c_str()].boolean()));try{if(!options_.preview)atomicJson(options_.config,next);config_=next;}catch(...){toast("Could not save the setting.");}}
  void avatar(Rect rect){auto data=model_["profile"];auto url=data["avatarUrl"].string();desiredImages_.push_back(url);auto* texture=art_->get(url);
    if(texture){auto source=crop(data["avatarCrop"]);draw().cover(texture,rect,source.w>0?&source:nullptr,255,rect.w/2);}
    else{draw().rounded(rect,{32,53,77,255},rect.w/2);auto name=data["username"].string("P");int size=rect.w>80?Tokens::title:Tokens::caption;draw().label(name.substr(0,1),rect.cx()-draw().measure(name.substr(0,1),size)/2,rect.cy()-size*.62f,size,Tokens::white);}
    draw().edge(rect,{66,161,231,235},rect.w/2,1.7f);
  }
  bool ready(const Json& g)const{auto releases=g["releases"],library=model_["library"];for(size_t i=0;i<releases.size();i++)for(size_t j=0;j<library.size();j++)if(releases[i]["kind"].string()!="DLC"&&library[j]["releaseId"].string()==releases[i]["id"].string()&&library[j]["state"].string()=="READY_ON_PS5")return true;return false;}
  std::string playable(const Json& g)const{return offline_||consoleId_!=device_["consoleId"].string()||config_["launcherUrl"].string().empty()?"":launchableTitle(g,model_["library"]);}
  void toast(std::string text){message_=std::move(text);toastUntil_=SDL_GetTicks()+6500;}
  void navigate(std::string page){screenFocus_[page_]=focus_.id();page_=std::move(page);focus_.select(screenFocus_.count(page_)?screenFocus_[page_]:"first-card");category_.clear();modal_.clear();SDL_StopTextInput();}
  void openGame(const std::string& id){screenFocus_[page_]=focus_.id();returnPage_=page_;gameId_=id;release_=0;page_="Game";focus_.select("download");plan_=Json();}
  void closeModal(){modal_.clear();focus_.select(screenFocus_["before-modal"]);SDL_StopTextInput();}
  void search(){screenFocus_["before-modal"]=focus_.id();modal_="Search";focus_.select("search-input");SDL_StartTextInput();}
  void profile(){
    const auto data=model_["profile"];auto profileConsoles=data["consoles"];Json selected;
    for(size_t i=0;i<profileConsoles.size();i++)if(profileConsoles[i]["id"].string()==consoleId_)selected=profileConsoles[i];
    avatar({Tokens::safe,165,136,136});
    draw().label(data["username"].string("Your profile"),Tokens::safe+172,165,Tokens::title,Tokens::white,1100);
    draw().label(selected["name"].string("Select your PS5"),Tokens::safe+175,241,Tokens::body,Tokens::muted);
    button("profile-picture","Change picture",{Tokens::width-Tokens::safe-290,185,290,62},1,[this]{screenFocus_["before-modal"]=focus_.id();modal_="Avatar";focus_.select("avatar-default");});
    float x=Tokens::safe;for(size_t i=0;i<profileConsoles.size();i++){auto c=profileConsoles[i];button("profile-console:"+c["id"].string(),c["name"].string(),{x,335,290,54},2,[this,c]{consoleId_=c["id"].string();lastRefresh_=0;},false,true,c["id"].string()==consoleId_);x+=310;if(x>Tokens::width-350)break;}
    button("profile-games","Available games",{Tokens::safe,415,270,54},3,[this]{profileTrophies_=false;},false,true,!profileTrophies_);
    button("profile-trophies","Trophies by game",{Tokens::safe+290,415,290,54},3,[this]{profileTrophies_=true;},false,true,profileTrophies_);
    auto reported=selected["games"];std::vector<Json> visible;
    for(size_t i=0;i<reported.size();i++)if(profileTrophies_||reported[i]["available"].boolean()){auto g=game(reported[i]["gameId"].string());if(!g.null())visible.push_back(g);}
    rail(profileTrophies_?"Your trophy collection":"Currently on this console",visible,510,4);
    if(profileTrophies_){draw().label("Per-game earned progress has not been collected yet.",Tokens::safe,815,Tokens::body,Tokens::muted);auto summary=selected["trophySummary"];
      if(!summary.null()){auto e=summary["earnedTrophies"];draw().label("Local console total: "+std::to_string(e["platinum"].number())+" platinum   /   "+std::to_string(e["gold"].number())+" gold   /   "+std::to_string(e["silver"].number())+" silver   /   "+std::to_string(e["bronze"].number())+" bronze",Tokens::safe,865,Tokens::body);draw().label("This older total does not identify which games earned each trophy.",Tokens::safe,910,Tokens::caption,Tokens::muted);}
    }else draw().label("Availability comes from the last inventory reported by your PS5.",Tokens::safe,815,Tokens::body,Tokens::muted);
  }
  void avatarModal(){
    const float x=Tokens::width*.13f,y=Tokens::height*.16f,w=Tokens::width*.74f;draw().fill({0,0,Tokens::width,Tokens::height},{2,6,12,225});draw().rounded({x,y,w,Tokens::height*.7f},{22,32,47,248},28);
    draw().label("Choose your account picture",x+35,y+30,Tokens::title);draw().label("Choose game artwork, or upload a picture from Profile on your server.",x+35,y+108,Tokens::body,Tokens::muted);
    button("avatar-default","Use default",{x+35,y+170,270,55},1,[this]{request("DELETE","/api/v1/device/profile/avatar",Json(),[this](const Json&){closeModal();lastRefresh_=0;});});
    auto all=catalog();for(size_t i=0;i<std::min(size_t(14),all.size());i++){auto g=all[i];Rect rect{x+35+(i%7)*190,y+265+(i/7)*185,162,162};gameImage(g,rect);button("avatar:"+g["id"].string(),"Select",{rect.x,rect.y+112,rect.w,44},2+static_cast<int>(i/7),[this,g]{request("PUT","/api/v1/device/profile/avatar",Json::object({{"gameId",g["id"]}}),[this](const Json&){closeModal();lastRefresh_=0;});},false,true);}
  }
  void exitPrompt(){screenFocus_["before-modal"]=focus_.id();modal_="Exit";focus_.select("exit-cancel");SDL_StopTextInput();}
  void networkSettings(){if(updateRequest_.valid()){toast("Finish the app update request before changing servers.");return;}screenFocus_["before-modal"]=focus_.id();draftServer_=config_["serverUrl"].string();draftHttp_=config_["allowInsecureLan"].boolean();replaceDraft_=true;modal_="Network";focus_.select("server-input");SDL_StartTextInput();}
  void appUpdate(bool install=false){
    if(options_.preview||credential_.empty()||networkPaused_||updateRequest_.valid())return;
    lastUpdateCheck_=SDL_GetTicks();updating_=install;updateStatus_=install?"Downloading verified app update…":"Checking for updates…";updateBytes_=0;updateTotal_=install?updateManifest_["size"].number():0;
    auto configuration=config_.dump(),token=credential_,envelope=updateEnvelope_.dump();auto root=options_.config.parent_path()/"updates";
    updateRequest_=std::async(std::launch::async,[this,configuration,token,envelope,root,install]{try{
      Client client(Json::parse(configuration));client.credential=token;client.cancelled=[this]{return !running_;};
      if(!install){auto release=client.request("GET","/api/v1/device/updates");if(release.null())return Json::object({{"status","No update published by your server."}}).dump();auto manifest=verifyUpdate(release,updatePublicKey(),0);if(manifest["build"].number()<=appBuild)return Json::object({{"status","PS5Library is up to date."}}).dump();return Json::object({{"envelope",release},{"manifest",manifest},{"status","Version "+manifest["version"].string()+" is available."}}).dump();}
      auto manifest=verifyUpdate(Json::parse(envelope),updatePublicKey(),appBuild);
      auto file=downloadUpdate(client,root,manifest,[this](int64_t bytes,int64_t){updateBytes_=bytes;});
#ifdef PS5
      if(root!=fs::path("/data/ps5library/updates"))throw std::runtime_error("Automatic installation requires the standard PS5Library location");
      // websrv passes args as the complete argv, including the program name.
      loaderRequest(Json::parse(configuration)["launcherUrl"].string(),"/elfldr?elf="+file.string()+"&cwd=/data/ps5library&args=ps5library-install%20--update&pipe=0");return Json::object({{"restart",true}}).dump();
#else
      return Json::object({{"status","Update verified. Installation requires a PS5."}}).dump();
#endif
    }catch(const std::exception& e){return Json::object({{"error",e.what()}}).dump();}});
  }
  void pumpUpdate(){
    if(updateRequest_.valid()&&updateRequest_.wait_for(std::chrono::seconds(0))==std::future_status::ready){auto result=Json::parse(updateRequest_.get());const bool checked=!updating_;updating_=false;if(result["restart"].boolean()){running_=false;return;}if(!result["error"].null())updateStatus_=result["error"].string();else{updateStatus_=result["status"].string();if(!result["manifest"].null()){updateManifest_=result["manifest"];updateEnvelope_=result["envelope"];toast(updateStatus_+" Open Settings to update.");}else if(checked){updateManifest_=Json();updateEnvelope_=Json();}}}
    if(!options_.preview&&!networkPaused_&&!credential_.empty()&&(!lastUpdateCheck_||SDL_GetTicks()-lastUpdateCheck_>6*60*60*1000))appUpdate();
  }
  void startAgent(){if(options_.preview||config_["serverUrl"].string().empty()||agent_.joinable())return;agent_=std::thread([this]{int lock=open((options_.config.parent_path()/"agent.lock").c_str(),O_CREAT|O_RDWR|O_NOFOLLOW,0600);if(lock<0||flock(lock,LOCK_EX|LOCK_NB)!=0){if(lock>=0)close(lock);return;}try{Agent agent(options_.config);agent.client.cancelled=[this]{return !running_||networkPaused_;};while(running_&&!networkPaused_){try{agent.tick();}catch(const std::exception&e){if(!networkPaused_&&running_)std::fprintf(stderr,"Agent: %s\n",e.what());}for(int i=0;i<50&&running_&&!networkPaused_;i++)std::this_thread::sleep_for(std::chrono::milliseconds(100));}}catch(const std::exception&e){std::fprintf(stderr,"Agent setup: %s\n",e.what());}close(lock);});}
  void resetArtwork(){art_=std::make_unique<Artwork>(config_,options_.config.parent_path()/"artwork-cache",options_.preview);art_->credentials(credential_);}
  void saveNetwork(bool reset=false){
    if(options_.preview){toast("Design preview — connection settings are not saved.");return;}
    std::string url;try{url=normalizeServerUrl(draftServer_,draftHttp_);}catch(const std::exception&e){toast(e.what());return;}
    networkPaused_=true;SDL_StopTextInput();complete_={};auto file=options_.config;bool http=draftHttp_;
    pending_=[this,file,url,http,reset]{setupInFlight_=true;complete_=[this](const Json& value){config_=value["config"];device_=value["device"];credential_=device_["credential"].string();consoleId_=device_["consoleId"].string();model_=Json::object();plan_=Json();gameId_.clear();heroUrl_.clear();oldHero_.clear();scroll_.clear();updateManifest_=Json();updateEnvelope_=Json();lastUpdateCheck_=0;resetArtwork();setupInFlight_=false;networkPaused_=false;loading_=true;offline_=false;closeModal();navigate("Discover");startAgent();lastRefresh_=0;};
      request_=std::async(std::launch::async,[this,file,url,http,reset]{if(agent_.joinable())agent_.join();art_->stop();try{auto config=saveServerSettings(file,url,http,reset);return Json::object({{"result",Json::object({{"config",config},{"device",loadDeviceState(file,config)}})}}).dump();}catch(const PairingResetRequired&e){return Json::object({{"error",e.what()},{"pairingResetRequired",true}}).dump();}catch(const std::exception&e){return Json::object({{"error",e.what()}}).dump();}});
    };
  }
  bool textEvent(const SDL_Event& event){
    bool network=modal_=="Network"&&focus_.id()=="server-input";if(networkPaused_||(!network&&modal_!="Search"))return false;
    if(event.type==SDL_KEYDOWN&&event.key.keysym.sym==SDLK_RETURN&&(network||focus_.id()=="search-input")){SDL_StopTextInput();if(network)focus_.select("allow-http");else focus_.move(Direction::Down);return true;}
    auto& value=network?draftServer_:query_;if(event.type==SDL_TEXTINPUT){if(network&&replaceDraft_){value.clear();replaceDraft_=false;}if(value.size()+std::strlen(event.text.text)<=(network?2048:200))value+=event.text.text;return true;}
    if(event.type==SDL_KEYDOWN&&event.key.keysym.sym==SDLK_BACKSPACE){replaceDraft_=false;eraseLastCharacter(value);return true;}return false;
  }
  void request(const std::string& method,const std::string& url,const Json& body,std::function<void(const Json&)> complete){
    if(networkPaused_)return;
    if(options_.preview){toast("Design preview — connect to your server to perform this action.");return;}
    if(request_.valid()){if(!pending_)pending_=[this,method,url,body,complete=std::move(complete)]()mutable{request(method,url,body,std::move(complete));};else toast("Finishing the current request…");return;}
    auto configuration=config_.dump(),payload=body.dump(),token=credential_;complete_=std::move(complete);
    request_=std::async(std::launch::async,[this,configuration,payload,token,method,url]{try{Client client(Json::parse(configuration));client.cancelled=[this]{return !running_||networkPaused_;};client.credential=token;return Json::object({{"result",client.request(method,url,Json::parse(payload))}}).dump();}catch(const RequestError& e){return Json::object({{"error",e.what()},{"serverReachable",true}}).dump();}catch(const std::exception& e){return Json::object({{"error",e.what()}}).dump();}});
  }
  void refresh(){if(options_.preview||request_.valid()||networkPaused_||config_["serverUrl"].string().empty())return;lastRefresh_=SDL_GetTicks();auto config=config_.dump();auto file=options_.config;auto console=consoleId_;
    complete_=[this](const Json& value){device_=value["device"];credential_=device_["credential"].string();art_->credentials(credential_);if(!value["catalog"].null()){model_=value;offline_=false;loading_=false;auto all=consoles();if(consoleId_.empty()&&all.size())consoleId_=device_["consoleId"].string(all[size_t(0)]["id"].string());try{auto cached=Json::parse(value.dump());cached.set("device",Json::object({{"consoleId",device_["consoleId"]}}));cached.set("serverUrl",config_["serverUrl"]);atomicJson(options_.config.parent_path()/"catalog-cache.json",cached);}catch(...){}}};
    request_=std::async(std::launch::async,[this,config,file,console]{try{auto configuration=Json::parse(config);auto device=loadDeviceState(file,configuration);auto value=Json::object({{"device",device}});auto token=device["credential"].string();if(!token.empty()){Client client(configuration);client.cancelled=[this]{return !running_||networkPaused_;};client.credential=token;auto own=client.request("GET","/api/v1/device/status");value.set("catalog",client.request("GET","/api/v1/device/catalog"));value.set("featured",client.request("GET","/api/v1/device/featured"));value.set("jobs",client.request("GET","/api/v1/device/jobs"));value.set("consoles",client.request("GET","/api/v1/device/consoles"));value.set("status",own);try{value.set("profile",client.request("GET","/api/v1/device/profile"));}catch(const RequestError& e){if(e.status!=404)throw;}value.set("library",console.empty()||console==own["id"].string()?own["library"]:client.request("GET","/api/v1/device/consoles/"+console+"/library"));}return Json::object({{"result",value}}).dump();}catch(const RequestError&e){return Json::object({{"error",e.what()},{"serverReachable",true}}).dump();}catch(const std::exception&e){return Json::object({{"error",e.what()}}).dump();}});
  }
  void pump(){if(request_.valid()&&request_.wait_for(std::chrono::seconds(0))==std::future_status::ready){auto result=Json::parse(request_.get());auto done=std::move(complete_);complete_={};if(!result["error"].null()){if(setupInFlight_){setupInFlight_=false;networkPaused_=false;resetArtwork();startAgent();if(result["pairingResetRequired"].boolean()){modal_="SwitchServer";focus_.select("keep-server");}else toast(result["error"].string());}else if(!networkPaused_){offline_=!result["serverReachable"].boolean();loading_=false;toast(friendly(result["error"].string()));}}else{offline_=false;if(done)done(result["result"]);}}if(pending_&&!request_.valid()){auto next=std::move(pending_);pending_={};next();}if(!options_.preview&&SDL_GetTicks()-lastRefresh_>5000)refresh();}
  void button(std::string id,std::string title,Rect rect,int row,std::function<void()> callback,bool primary=false,bool enabled=true,bool selected=false,bool plain=false){
    if(enabled){focus_.add(id,row,{rect.x,rect.y,rect.w,rect.h});actions_[id]=std::move(callback);rects_[id]=rect;}
    auto& a=animation_[id];a+=(focus_.id()==id?1.f-a:-a)*std::min(1.f,delta_/Tokens::focusSeconds);
    if(a>.02f||selected||primary)draw().outline(rect,std::max(a,primary?.5f:selected?.42f:0.f),rect.h/2);
    if(!plain||selected||a>.05f)draw().rounded(rect,primary?SDL_Color{224,233,244,255}:selected?SDL_Color{37,52,73,185}:Tokens::surface,rect.h/2);
    if(!plain||selected||a>.05f)draw().edge(rect,primary?SDL_Color{248,251,255,240}:selected?SDL_Color{123,182,241,210}:SDL_Color{126,148,174,65},rect.h/2);
    draw().label(title,rect.x+(rect.w-draw().measure(title))/2,rect.y+(rect.h-Tokens::body)/2-3,Tokens::body,!enabled?Tokens::muted:primary?Tokens::background:Tokens::white,static_cast<int>(rect.w-20));
  }
  void title(const std::string& text,const std::string& subtitle=""){draw().label(text,Tokens::safe,Tokens::header+Tokens::gap*2,Tokens::title);draw().label(subtitle,Tokens::safe,Tokens::header+Tokens::gap*2+Tokens::title+Tokens::gap,Tokens::body,Tokens::muted);}
  void badge(const std::string& text,Rect rect){draw().rounded(rect,{22,36,53,235},rect.h/2);draw().label(text,rect.x+Tokens::gap/2,rect.y+3,Tokens::caption,Tokens::accent,static_cast<int>(rect.w-12));}
  void gameImage(const Json& g,Rect rect,bool hero=false,Uint8 opacity=255){auto url=g[hero?"heroUrl":"coverUrl"].string();desiredImages_.push_back(url);auto c=crop(g[hero?"heroCrop":"coverCrop"]);draw().cover(art_->get(url),rect,c.w>0?&c:nullptr,opacity,hero?0:Tokens::radius);}
  void background(const Json& featured){auto url=featured["heroUrl"].string();desiredImages_.push_back(url);auto* image=art_->get(url);if(image&&heroUrl_!=url){oldHero_=heroUrl_;heroUrl_=url;heroMix_=0;}heroMix_=std::min(1.f,heroMix_+delta_/Tokens::fadeSeconds);
    Rect rect{Tokens::width*.25f,0,Tokens::width*.75f,std::ceil(Tokens::heroBottom+Tokens::cardHeight*.8f)};auto* video=video_->frame(renderer_);
    auto paint=[&]{draw().fill({0,0,Tokens::width,Tokens::height},Tokens::background);if(!oldHero_.empty()&&heroMix_<1){desiredImages_.push_back(oldHero_);draw().cover(art_->get(oldHero_),rect);}if(image){auto source=crop(featured["heroCrop"]);draw().cover(image,rect,source.w>0?&source:nullptr,static_cast<Uint8>(255*heroMix_));}if(video)draw().cover(video,rect);
      if(image||video||heroMix_<1){const float fadeTop=std::floor(Tokens::heroBottom*.35f);draw().fade({rect.x,0,rect.w*.56f,rect.h},true,true,255);draw().fade({0,fadeTop,Tokens::width,rect.h-fadeTop},false);draw().fade({0,0,Tokens::width,Tokens::header*1.2f},false,true,175);}};
    // Compose the static hero once. SDL's PS5 software renderer otherwise blends millions of unchanged pixels every frame.
    if(!video&&heroMix_>=1&&SDL_RenderTargetSupported(renderer_)){
      if(!backdropCache_)backdropCache_=SDL_CreateTexture(renderer_,SDL_PIXELFORMAT_ARGB8888,SDL_TEXTUREACCESS_TARGET,static_cast<int>(Tokens::width),static_cast<int>(Tokens::height));
      const auto key=url+featured["heroCrop"].dump()+(image?":loaded":":empty");
      if(backdropCache_){if(key!=backdropKey_){if(SDL_SetRenderTarget(renderer_,backdropCache_)!=0){paint();return;}paint();SDL_SetRenderTarget(renderer_,nullptr);backdropKey_=key;backdropCompositions_++;}
        SDL_SetTextureBlendMode(backdropCache_,SDL_BLENDMODE_NONE);SDL_RenderCopy(renderer_,backdropCache_,nullptr,nullptr);return;}
    }
    paint();
  }
  void navigation(){const float y=Tokens::safe*.65f;float x=Tokens::safe;
    draw().rounded({x,y+4,49,34},{217,232,255,255},12);draw().fill({x+9,y+18,13,4},Tokens::background);draw().fill({x+13,y+14,4,12},Tokens::background);draw().rounded({x+32,y+12,5,5},Tokens::accent,3);draw().rounded({x+38,y+19,5,5},Tokens::accent,3);
    x+=76;draw().label("PS5",x,y-7,Tokens::brand,{114,167,228,255});draw().label("Library",x+draw().measure("PS5",Tokens::brand),y-7,Tokens::brand);draw().label("Games without limits",x,y+34,Tokens::caption,Tokens::muted);
    x=Tokens::width*.215f;const float right=Tokens::width*.745f,tabGap=Tokens::gap;float total=0;for(const auto& tab:tabs_)total+=draw().measure(tab,Tokens::body)+Tokens::gap*2;float scale=std::min(1.f,(right-x-tabGap*5)/total);
    for(size_t i=0;i<tabs_.size();i++){float width=(draw().measure(tabs_[i])+Tokens::gap*2)*scale;button("nav:"+tabs_[i],tabs_[i],{x,y-3,width,58},0,[this,i]{navigate(tabs_[i]);},false,true,page_==tabs_[i],true);x+=width+tabGap;}
    x=Tokens::width*.798f;button("search","",{x,y,50,52},0,[this]{search();},false,true,false,true);draw().icon("search",x+25,y+25);button("settings","",{x+82,y,50,52},0,[this]{navigate("Settings");},false,true,false,true);draw().icon("settings",x+107,y+25);button("profile","",{x+164,y,50,52},0,[this]{navigate("Profile");},false,true,false,true);avatar({x+169,y+5,40,40});
    std::time_t now=std::time(nullptr);char clock[12];std::strftime(clock,sizeof(clock),"%H:%M",std::localtime(&now));draw().label(clock,Tokens::width-Tokens::safe-78,y+10,Tokens::body,Tokens::muted);
  }
  void card(const Json& g,Rect rect,int row,const std::string& id){focus_.add(id,row,{rect.x,rect.y,rect.w,rect.h});actions_[id]=[this,id=g["id"].string()]{openGame(id);};rects_[id]=rect;
    auto& a=animation_[id];a+=(focus_.id()==id?1.f-a:-a)*std::min(1.f,delta_/Tokens::focusSeconds);float grow=a*(Tokens::focusScale-1);rect={rect.x-rect.w*grow/2,rect.y-rect.h*grow/2,rect.w*(1+grow),rect.h*(1+grow)};
    if(a>.01f)draw().outline(rect,a);gameImage(g,{rect.x+2,rect.y+2,rect.w-4,rect.h-4});if(a>.05f){draw().edge(rect,{98,179,255,static_cast<Uint8>(255*a)},Tokens::radius,3);draw().edge({rect.x+1,rect.y+1,rect.w-2,rect.h-2},{232,248,255,static_cast<Uint8>(255*a)},Tokens::radius-1,1.2f);}
    if(page_=="My Library"&&(serverLibrary_?serverReady(g):ready(g)))badge(serverLibrary_?"SERVER":"ON PS5",{rect.x+9,rect.y+10,105,29});
    if(a>.8f&&!g["title"].string().empty()&&!options_.preview){draw().fade({rect.x,rect.y+rect.h*.65f,rect.w,rect.h*.35f},false);draw().label(g["title"].string(),rect.x+10,rect.y+rect.h-32,Tokens::caption,Tokens::white,static_cast<int>(rect.w-20));}
  }
  void rail(const std::string& name,const std::vector<Json>& games,float y,int row){const auto key=std::to_string(row);draw().label(name,Tokens::safe,y,Tokens::heading);
    if(!games.empty())button("all:"+key,"View All  >",{Tokens::width-Tokens::safe-165,y-6,165,44},row,[this,name]{navigate(name);},false,true,false,true);
    const float top=y+Tokens::railTitle+Tokens::gap;float target=0;for(size_t i=0;i<games.size();i++)if(focus_.id()=="rail"+key+":"+games[i]["id"].string()){float cardLeft=static_cast<float>(i)*(Tokens::cardWidth+Tokens::gap);target=std::max(0.f,cardLeft-(Tokens::width-Tokens::safe*2-Tokens::cardWidth)/2);}
    target=std::min(target,std::max(0.f,games.size()*(Tokens::cardWidth+Tokens::gap)-Tokens::gap-(Tokens::width-Tokens::safe*2)));
    if(focus_.id().rfind("rail"+key+":",0)==0)scroll_[key]+=(target-scroll_[key])*std::min(1.f,delta_*14);
    float x=Tokens::safe-scroll_[key];SDL_Rect clip{static_cast<int>(Tokens::safe-10),static_cast<int>(top-14),static_cast<int>(Tokens::width-Tokens::safe+10),static_cast<int>(Tokens::cardHeight+30)};SDL_RenderSetClipRect(renderer_,&clip);
    for(size_t i=0;i<games.size();i++){Rect rect{x+static_cast<float>(i)*(Tokens::cardWidth+Tokens::gap),top,Tokens::cardWidth,Tokens::cardHeight};auto id="rail"+key+":"+games[i]["id"].string();if(rect.x+rect.w>0&&rect.x<Tokens::width+Tokens::cardWidth)card(games[i],rect,row,id);else{focus_.add(id,row,{rect.x,rect.y,rect.w,rect.h});actions_[id]=[this,g=games[i]]{openGame(g["id"].string());};}}
    SDL_RenderSetClipRect(renderer_,nullptr);if(games.empty()){if(loading_)for(int i=0;i<8;i++)draw().cover(nullptr,{Tokens::safe+i*(Tokens::cardWidth+Tokens::gap),top,Tokens::cardWidth,Tokens::cardHeight});else draw().label("No games in this collection yet.",Tokens::safe,top+Tokens::gap,Tokens::body,Tokens::muted);}
  }
  std::vector<Json> games(const std::function<bool(const Json&)>& filter={})const{std::vector<Json> out;auto all=catalog();for(size_t i=0;i<all.size();i++)if(!filter||filter(all[i]))out.push_back(all[i]);return out;}
  void hero(const Json& g){const float x=Tokens::safe,y=Tokens::header+Tokens::gap*2;draw().label("F E A T U R E D",x,y,Tokens::caption,Tokens::accent);draw().label(g["title"].string("Your next adventure starts here"),x,y+Tokens::gap*2,Tokens::title,Tokens::white,900,2);
    draw().label(g["description"].string("Connect your collection and discover your games in one place."),x,y+Tokens::title+Tokens::gap*3,Tokens::body,Tokens::muted,770,2);
    float chipX=x,chipY=Tokens::heroBottom-171;auto genres=g["genres"];for(size_t i=0;i<std::min(size_t(3),genres.size());i++){auto label=genres[i].string();float w=draw().measure(label,Tokens::caption)+27;badge(label,{chipX,chipY,w,29});chipX+=w+Tokens::gap/2;}badge(g["platform"].string("PS5"),{chipX,chipY,61,29});
    button("view-game","View Game",{x,Tokens::heroBottom-114,290,66},1,[this,g]{openGame(g["id"].string());},true,!g.null());
    button("save-game",g["saved"].boolean()?"In Your Library":"+  Add to Library",{x+310,Tokens::heroBottom-114,270,66},1,[this,g]{request("POST","/api/v1/device/games/"+g["id"].string()+"/save",Json::object({{"saved",true}}),[this](const Json&){toast("Saved to your collection");lastRefresh_=0;});},false,!g.null());
    if(!options_.preview)return;auto all=catalog();float indicators=Tokens::width/2-static_cast<float>(std::min(size_t(5),all.size()))*15;for(size_t i=0;i<std::min(size_t(5),all.size());i++){Rect rect{indicators+static_cast<float>(i)*30,Tokens::heroBottom-24,20,4};draw().rounded(rect,i==featured_%5?Tokens::white:SDL_Color{143,161,184,110},2);}
    button("hero-previous","<",{Tokens::width-Tokens::safe-115,Tokens::heroBottom-84,48,48},1,[this,all]{if(all.size())featured_=(featured_+all.size()-1)%all.size();});button("hero-next",">",{Tokens::width-Tokens::safe-55,Tokens::heroBottom-84,48,48},1,[this,all]{if(all.size())featured_=(featured_+1)%all.size();});
  }
  void discover(){auto all=games();Json featured=heroGame();hero(featured);if(options_.preview&&!all.empty())desiredImages_.push_back(all[(featured_+1)%all.size()]["heroUrl"].string());
    auto first=all,updated=games([](const Json& g){return g["recentlyUpdated"].boolean();});
    if(options_.preview){first.clear();updated.clear();for(const auto& g:all){if(g["rail"].string()=="popular")first.push_back(g);if(g["rail"].string()=="updated")updated.push_back(g);}}
    // Only call a rail popular when the server supplies an actual popularity signal.
    bool popular=std::any_of(first.begin(),first.end(),[](const Json&g){return g["popularity"].number()>0;});if(popular)std::stable_sort(first.begin(),first.end(),[](const Json&a,const Json&b){return a["popularity"].number()>b["popularity"].number();});
    if(!popular&&!options_.preview)first=recentlyAdded(first);
    if(focus_.id()=="first-card"&&!first.empty())focus_.select("rail3:"+first.front()["id"].string());
    rail(popular||options_.preview?"Popular This Week":"Recently Added",first,Tokens::heroBottom,3);
    rail("Recently Updated",updated,Tokens::heroBottom+Tokens::railTitle+Tokens::gap+Tokens::cardHeight+Tokens::railGap,5);
  }
  void gridPage(){std::string subtitle;auto all=games();float y=Tokens::header+Tokens::title+Tokens::gap*6;
    if(page_=="Categories"&&category_.empty()){title("Categories","Find your next adventure.");std::set<std::string> categories;for(const auto& g:all){auto tags=g["genres"];for(size_t i=0;i<tags.size();i++)categories.insert(tags[i].string());}if(categories.empty())categories={"Action","Adventure","RPG","Racing","Sports","Horror","Indie","Homebrew"};size_t n=0;for(const auto& tag:categories){float w=(Tokens::width-Tokens::safe*2-Tokens::gap*3)/4;Rect rect{Tokens::safe+(n%4)*(w+Tokens::gap),y+(n/4)*235,w,200};auto candidates=games([&](const Json&g){return list(g["genres"]).find(tag)!=std::string::npos;});if(!candidates.empty())gameImage(candidates[0],rect);draw().fade(rect,false);button("category:"+tag,tag,{rect.x+20,rect.y+130,rect.w-40,52},2+static_cast<int>(n/4),[this,tag]{category_=tag;focus_.select("first-card");});n++;if(n==12)break;}return;}
    if(page_=="My Library"){
      subtitle=serverLibrary_?"Verified packages stored on your server":offline_?"Previously reported by your PS5 ? server offline":"Confirmed by your selected PS5";
      button("library-console","On This PS5",{Tokens::safe,y,280,50},1,[this]{serverLibrary_=false;},false,true,!serverLibrary_);
      button("library-server","Ready on Server",{Tokens::safe+300,y,320,50},1,[this]{serverLibrary_=true;},false,true,serverLibrary_);y+=72;
      if(serverLibrary_)all=games([](const Json&g){return serverReady(g);});
      else{all=games([this](const Json&g){if(!ready(g))return false;if(libraryFilter_=="All")return true;auto library=model_["library"],releases=g["releases"];for(size_t i=0;i<library.size();i++)for(size_t r=0;r<releases.size();r++)if(library[i]["releaseId"].string()==releases[r]["id"].string()&&library[i]["state"].string()=="READY_ON_PS5"){auto storage=lower(library[i]["storageId"].string());if(libraryFilter_=="USB"&&storage.find("usb")!=std::string::npos)return true;if(libraryFilter_=="Internal"&&storage.find("internal")!=std::string::npos)return true;if(libraryFilter_=="ShadowMount"&&library[i]["registered"].boolean())return true;if(libraryFilter_=="Updates"&&releases.size()>1)return true;}return false;});float x=Tokens::safe;for(const std::string filter:{"All","Internal","USB","ShadowMount","Updates"}){float w=draw().measure(filter)+40;button("filter:"+filter,filter,{x,y,w,50},2,[this,filter]{libraryFilter_=filter;},false,true,libraryFilter_==filter);x+=w+15;}y+=72;}
    }
    if(page_=="Recently Added")all=recentlyAdded(all,all.size());
    if(page_=="Recently Updated")all=games([](const Json&g){return g["recentlyUpdated"].boolean();});
    if(page_=="New Releases")std::stable_sort(all.begin(),all.end(),[](const Json&a,const Json&b){return a["releaseDate"].string()>b["releaseDate"].string();});
    if(!category_.empty())all=games([this](const Json&g){return list(g["genres"]).find(category_)!=std::string::npos;});
    title(category_.empty()?page_:category_,subtitle);if(all.empty()){draw().label("Your collection is ready for its first game.",Tokens::safe,y+60,Tokens::heading,Tokens::muted);return;}
    if(focus_.id()=="first-card")focus_.select("grid:"+all.front()["id"].string());
    const size_t columns=7;float width=(Tokens::width-Tokens::safe*2-Tokens::gap*(columns-1))/columns,height=width*1.18f;float target=0;for(size_t i=0;i<all.size();i++)if(focus_.id()=="grid:"+all[i]["id"].string())target=std::max(0.f,static_cast<float>(i/columns)*(height+62)-330);
    auto& offset=scroll_["grid:"+page_];offset+=(target-offset)*std::min(1.f,delta_*14);SDL_Rect clip{0,static_cast<int>(y-12),1920,static_cast<int>(Tokens::height-y-48)};SDL_RenderSetClipRect(renderer_,&clip);
    for(size_t i=0;i<all.size();i++){Rect rect{Tokens::safe+(i%columns)*(width+Tokens::gap),y+(i/columns)*(height+62)-offset,width,height};const auto id="grid:"+all[i]["id"].string();focus_.add(id,3+static_cast<int>(i/columns),{rect.x,rect.y,rect.w,rect.h});if(rect.y+rect.h<y||rect.y>Tokens::height)continue;card(all[i],rect,3+static_cast<int>(i/columns),id);draw().label(all[i]["title"].string(),rect.x,rect.y+rect.h+12,Tokens::caption,Tokens::white,static_cast<int>(width));}SDL_RenderSetClipRect(renderer_,nullptr);
  }
  void details(){auto g=game(gameId_),r=selectedRelease();const float y=Tokens::header+Tokens::gap*3,coverW=Tokens::width*.19f,x=Tokens::safe+coverW+Tokens::gap*3;gameImage(g,{Tokens::safe,y,coverW,coverW*1.3f});draw().label(g["title"].string(),x,y+10,Tokens::title,Tokens::white,1100,2);draw().label(list(g["genres"]),x,y+Tokens::title*2+Tokens::gap,Tokens::body,Tokens::accent);draw().label(g["description"].string("Description unavailable."),x,y+Tokens::title*2+Tokens::gap*4,Tokens::body,Tokens::muted,1080,3);
    draw().label(releaseLabel(r)+"    "+(r["size"].null()?"Size not scanned":amount(r["size"].number()))+"    "+friendly(r["kind"].string())+"    "+r["region"].string("Region unknown"),x,y+300,Tokens::body);draw().label(list(r["languages"])+"    "+g["publisher"].string(),x,y+343,Tokens::caption,Tokens::muted);
    const auto playableId=playable(g);
    button("download",!playableId.empty()?"Play":r["sources"].size()?(r["artifacts"].size()?"Download":"Prepare"):ready(g)?"On this PS5":"Source unavailable",{x,y+410,290,66},1,[this,playableId]{
      if(!playableId.empty()){launchTitle_=playableId;running_=false;return;}
      screenFocus_["before-modal"]=focus_.id();modal_="Download";modalStep_=0;releasePage_=0;releaseAddons_=false;focus_.select("release-games");plan_=Json();
    },true,!playableId.empty()||r["sources"].size()>0);
    if(!ready(g))draw().label(r["artifacts"].size()?"Verified copy ready on server":"Server preparation required",x+330,y+421,Tokens::body,Tokens::muted,700);
    if(ready(g)){draw().label("Available on your PS5",x+330,y+421,Tokens::body,Tokens::accent);draw().label(playableId.empty()?"Mount this dump with its supported launcher first.":"Play closes PS5Library and opens the game.",x,y+495,Tokens::caption,Tokens::muted);}
    auto library=model_["library"];for(size_t i=0;i<library.size();i++)if(library[i]["titleId"].string()==g["titleId"].string()&&library[i]["canDelete"].boolean()){auto entry=library[i];button("remove-game","Delete from PS5",{x+720,y+410,310,66},1,[this,entry]{removal_=entry;removalConsole_=selectedConsole();screenFocus_["before-modal"]=focus_.id();modal_="RemoveGame";focus_.select("remove-cancel");});break;}
    float lower=Tokens::height*.65f;draw().label("Available releases",Tokens::safe,lower,Tokens::heading);auto releases=g["releases"];for(size_t i=0;i<releases.size()&&i<5;i++){auto release=releases[i];float w=(Tokens::width-Tokens::safe*2-Tokens::gap*4)/5;button("release:"+std::to_string(i),releaseLabel(release),{Tokens::safe+i*(w+Tokens::gap),lower+48,w,58},3,[this,i]{release_=i;},false,true,i==release_);}
    draw().label("Screenshots",Tokens::safe,lower+146,Tokens::heading);auto shots=g["screenshotUrls"];for(size_t i=0;i<shots.size()&&i<5;i++){auto url=shots[i].string();desiredImages_.push_back(url);draw().cover(art_->get(url),{Tokens::safe+i*250,lower+190,230,125});}if(!shots.size())draw().label("No screenshots supplied for this release.",Tokens::safe,lower+195,Tokens::caption,Tokens::muted);
    if(advanced_)draw().label(g["titleId"].string()+"  "+r["contentId"].string(),x,y+550,Tokens::caption,Tokens::muted);
  }
  void downloadJobs(){title("Downloads","Your server and PS5 keep you in sync.");auto list=jobs();float y=Tokens::header+Tokens::title+Tokens::gap*7;size_t first=static_cast<size_t>(scroll_["jobs"]);if(focus_.id()=="first-card"&&list.size())focus_.select("job:"+list[size_t(0)]["id"].string());for(size_t i=0;i<list.size();i++)if(focus_.id()=="job:"+list[i]["id"].string()){if(i<first)first=i;if(i>=first+3)first=i-2;}scroll_["jobs"]=static_cast<float>(first);
    for(size_t i=0;i<list.size();i++){auto id="job:"+list[i]["id"].string();focus_.add(id,static_cast<int>(i)+1,{Tokens::safe,y+(static_cast<int>(i)-static_cast<int>(first))*240,Tokens::width-Tokens::safe*2,220});}
    for(size_t i=first;i<list.size()&&i<first+3;i++){auto j=list[i],g=Json();for(const auto& item:games()){auto releases=item["releases"];for(size_t n=0;n<releases.size();n++)if(releases[n]["id"].string()==j["releaseId"].string())g=item;}
      Rect panel{Tokens::safe,y,Tokens::width-Tokens::safe*2,220};auto id="job:"+j["id"].string();if(focus_.id()==id)draw().outline(panel,.55f,18);if(!g.null())actions_[id]=[this,g]{openGame(g["id"].string());};draw().rounded(panel,{22,31,44,205},18);gameImage(g,{panel.x+22,y+22,132,176});float x=panel.x+184,w=panel.w-215;draw().label(j["title"].string(g["title"].string("Selected release")),x,y+22,Tokens::heading);draw().label(friendly(j["state"].string()),x,y+68,Tokens::body,Tokens::accent);
      const auto state=j["state"].string();const bool building=j["kind"].string()=="BUILD",stopped=state=="ERROR"||state=="CANCELLED";auto p=j["progress"];
      if(j["kind"].string()=="DELETE"){
        if(!stopped&&state!="COMPLETED")draw().bar({x,y+116,w,7},0,0);draw().label(state=="COMPLETED"?"Removed from PS5; inventory confirmed":stopped?j["error"].string("Removal failed"):"Removing game from your PS5",x,y+139,Tokens::caption,Tokens::muted);
      }else if(building&&state=="EXTRACTING"&&model_["profile"]["role"].string()=="ADMIN"&&!p["extraction"].null()){
        auto done=p["extraction"]["completedBytes"].number(),total=p["extraction"]["totalBytes"].number();draw().bar({x,y+116,w,7},done,total);draw().label("Extracting archive  /  "+amount(done)+" / "+amount(total)+(total?"  /  "+std::to_string(done*100/total)+"%":""),x,y+139,Tokens::caption,Tokens::muted);
      }else if(building&&model_["profile"]["role"].string()=="ADMIN"&&!p.null()){
        const float half=(w-30)/2;
        for(int part=0;part<2;part++){auto component=p[part?"fakelib":"package"];const auto status=component["state"].string(part?"UNKNOWN":state=="COMPLETED"?"VERIFIED":"WAITING");const bool absent=status=="NOT_REQUIRED",complete=state=="COMPLETED"&&status=="VERIFIED";const float left=x+part*(half+30);
          draw().label(part?"Fakelib":component["method"].string("Package"),left,y+106,Tokens::caption,Tokens::white);
          if(!absent&&status!="UNKNOWN"&&!stopped)draw().bar({left,y+140,half,6},complete?1:0,complete?1:0);
          draw().label(absent?"No libraries supplied":stopped?friendly(state):status=="UNKNOWN"?"Not reported by this build":complete?"Files verified":friendly(status),left,y+157,Tokens::caption,Tokens::muted,static_cast<int>(half));
        }
      }else if(building)draw().label(state=="COMPLETED"?"Preparation complete":stopped?friendly(state):"Preparing on your server",x,y+139,Tokens::caption,Tokens::muted);
      else{auto total=j["totalBytes"].number(),done=j["downloadedBytes"].number();if(!stopped)draw().bar({x,y+116,w,7},done,total);std::string metrics=(total?std::to_string(std::clamp(done*100/total,int64_t(0),int64_t(100)))+"%    ":"")+amount(done)+(total?" / "+amount(total):" transferred")+"     "+amount(j["speedBytesPerSecond"].number())+"/s";if(!j["etaSeconds"].null())metrics+="     About "+std::to_string(j["etaSeconds"].number()/60)+"m "+std::to_string(j["etaSeconds"].number()%60)+"s";draw().label(metrics,x,y+139,Tokens::caption,Tokens::muted);}
      std::string target;auto all=consoles();for(size_t n=0;n<all.size();n++)if(all[n]["id"].string()==j["consoleId"].string()){target=all[n]["name"].string();auto stores=all[n]["storage"];for(size_t s=0;s<stores.size();s++)if(stores[s]["storageId"].string()==j["storageId"].string())target+="  /  "+stores[s]["displayName"].string();}draw().label(target.empty()?"SERVER  >  "+friendly(j["kind"].string()):"PS5  >  "+target,x,y+180,Tokens::caption,Tokens::muted);y+=240;}
    if(!list.size())draw().label("You're all caught up. Your next adventure is in Discover.",Tokens::safe,y+70,Tokens::heading,Tokens::muted);
  }
  void myPS5(){auto c=selectedConsole();title(c["name"].string("My PS5"),c["presence"].string("OFFLINE")+"    Firmware "+c["firmware"].string("unknown"));float y=Tokens::header+Tokens::title+Tokens::gap*7,x=Tokens::safe;
    auto all=consoles();for(size_t i=0;i<all.size()&&i<4;i++){button("console:"+all[i]["id"].string(),all[i]["name"].string(),{x,y,330,57},1,[this,id=all[i]["id"].string()]{consoleId_=id;lastRefresh_=0;},false,true,all[i]["id"].string()==consoleId_);x+=350;}y+=98;
    const auto observed=c["runtimeStatus"];bool online=c["presence"].string()=="ONLINE";
    const auto shadow=!online?"Last seen: "+friendly(observed["shadowMount"].string("UNKNOWN")):friendly(observed["shadowMount"].string("UNKNOWN"));
    const auto backport=observed["backportConflict"].boolean()?"Runtime conflict":observed["fakelibEnabled"].null()?"Unknown":observed["fakelibEnabled"].boolean()?"Runtime enabled":"Runtime disabled";
    const std::vector<std::pair<std::string,std::string>> facts={{"PS5Library Agent",online?"Connected":"Offline"},{"ShadowMountPlus",shadow},{"Backport runtime",backport},{"Games",std::to_string(c["games"].number())}};
    x=Tokens::safe;for(const auto& [name,value]:facts){draw().label(name,x,y,Tokens::caption,Tokens::muted);draw().label(value,x,y+37,Tokens::heading,Tokens::white,static_cast<int>(Tokens::width*.225f),2);x+=Tokens::width*.235f;}y+=130;
    draw().label(c["capabilities"]["persistentAgent"].boolean()?"Background downloads available":"Console transfers run while PS5Library is open.",Tokens::safe,y-33,Tokens::caption,Tokens::muted);
    auto storage=Json::array();for(size_t i=0;i<c["storage"].size();i++)if(c["storage"][i]["installMethodsSupported"].size())storage.add(c["storage"][i]);for(size_t i=0;i<storage.size()&&i<4;i++){auto s=storage[i];float w=(Tokens::width-Tokens::safe*2-Tokens::gap)/2;Rect rect{Tokens::safe+(i%2)*(w+Tokens::gap),y+(i/2)*210,w,180};draw().rounded(rect,Tokens::surface,20);draw().label(s["displayName"].string(),rect.x+30,rect.y+25,Tokens::heading);draw().bar({rect.x+30,rect.y+90,rect.w-60,9},s["totalBytes"].number()-s["freeBytes"].number(),s["totalBytes"].number());draw().label(amount(s["freeBytes"].number())+" available",rect.x+30,rect.y+120,Tokens::body,Tokens::muted);}
  }
  void settings(){title("Settings","PS5Library is your independent, self-hosted library.");float y=Tokens::header+Tokens::title+Tokens::gap*7;
    button("network","Server connection",{Tokens::safe,y,480,64},1,[this]{networkSettings();});button("retry","Retry connection",{Tokens::safe,y+95,380,64},2,[this]{lastRefresh_=0;refresh();});button("advanced",advanced_?"Advanced information: on":"Advanced information: off",{Tokens::safe,y+190,480,64},3,[this]{advanced_=!advanced_;});
    button("exit","Exit to PS5 home",{Tokens::safe+Tokens::width*.42f,y,400,64},1,[this]{exitPrompt();});
    float ux=Tokens::safe+Tokens::width*.42f;bool available=!updateManifest_.null();
    button("app-update",available?"Update & restart":"Check for app updates",{ux,y+95,550,64},2,[this,available]{appUpdate(available);},available,!updateRequest_.valid()&&!credential_.empty());
    draw().label("PS5Library "+std::string(appVersion),ux,y+190,Tokens::body);draw().label(updateStatus_,ux,y+228,Tokens::caption,Tokens::muted,700,2);
    if(updating_){draw().bar({ux,y+288,550,8},updateBytes_,updateTotal_);draw().label(amount(updateBytes_)+" / "+amount(updateTotal_),ux,y+310,Tokens::caption,Tokens::muted);}
    button("sounds",audio_->available()?(audio_->enabled()?"Interface sounds: on":"Interface sounds: off"):"Audio unavailable",{Tokens::safe,y+285,480,64},4,[this]{auto next=Json::parse(config_.dump());next.set("interfaceSounds",!audio_->enabled());try{if(!options_.preview)atomicJson(options_.config,next);config_=next;audio_->setEnabled(next["interfaceSounds"].boolean());}catch(const std::exception&){toast("Could not save the sound setting.");}},false,audio_->available());
    button("autoplay",config_["autoplayTrailers"].null()||config_["autoplayTrailers"].boolean()?"Trailer previews: on":"Trailer previews: off",{Tokens::safe,y+380,480,64},5,[this]{togglePreference("autoplayTrailers");});
    button("trailer-sound",config_["trailerSound"].null()||config_["trailerSound"].boolean()?"Trailer sound: on":"Trailer sound: off",{ux,y+380,550,64},5,[this]{togglePreference("trailerSound");});
    if(!updating_)button("game-music",config_["gameMusic"].null()||config_["gameMusic"].boolean()?"Game music: on":"Game music: off",{ux,y+285,550,64},4,[this]{togglePreference("gameMusic");});
    draw().label("Your server",Tokens::safe,y+480,Tokens::heading);draw().label(config_["serverUrl"].string().empty()?"Choose a server to connect your library.":config_["serverUrl"].string(),Tokens::safe,y+530,Tokens::body,Tokens::muted,1400);draw().label("Account pairing and invitations are managed in the companion.",Tokens::safe,y+605,Tokens::body,Tokens::muted);
  }
  void networkModal(){const float x=Tokens::width*.16f,y=Tokens::height*.16f,w=Tokens::width*.68f,h=Tokens::height*.72f;draw().fill({0,0,Tokens::width,Tokens::height},{2,6,12,220});draw().rounded({x,y,w,h},{22,32,47,248},28);
    bool switching=modal_=="SwitchServer";draw().label(switching?"Switch servers?":"Connect your library",x+42,y+36,Tokens::title);draw().label(switching?"Pair this console again on the new server.":"Enter the PS5Library server address from your PC.",x+42,y+116,Tokens::body,Tokens::muted,static_cast<int>(w-84));
    if(networkPaused_){draw().label("Saving your connection…",x+42,y+260,Tokens::heading);draw().bar({x+42,y+330,w-84,8},0,0);return;}
    if(switching){draw().label(draftServer_,x+42,y+215,Tokens::heading,Tokens::accent,static_cast<int>(w-84),2);draw().label("Your downloaded files stay on this PS5.",x+42,y+335,Tokens::body,Tokens::muted);button("switch-server","Switch & pair again",{x+42,y+h-190,w-84,66},1,[this]{saveNetwork(true);},true);button("keep-server","Keep current server",{x+42,y+h-100,360,56},2,[this]{modal_="Network";focus_.select("server-input");});return;}
    draw().label("Server address",x+42,y+190,Tokens::caption,Tokens::accent);button("server-input",draftServer_.empty()?"https://library.example.net":draftServer_,{x+42,y+230,w-84,76},1,[this]{replaceDraft_=true;SDL_StartTextInput();});
    button("allow-http",draftHttp_?"Unencrypted HTTP: On":"Unencrypted HTTP: Off",{x+42,y+348,w-84,62},2,[this]{draftHttp_=!draftHttp_;SDL_StopTextInput();});draw().label(draftHttp_?"HTTP sends credentials without encryption. Use only on a trusted local network.":"HTTPS verifies your server certificate and protects the connection.",x+42,y+430,Tokens::caption,Tokens::muted,static_cast<int>(w-84),2);
    button("save-server","Save & connect",{x+42,y+h-190,w-84,66},3,[this]{saveNetwork();},true,!draftServer_.empty());button("cancel-server","Cancel",{x+42,y+h-100,200,56},4,[this]{closeModal();});
  }
  void plan(const std::string& method=""){
    if(options_.preview){method_=method.empty()?"SHADOWMOUNT":method;auto stores=Json::array();auto source=selectedConsole()["storage"];for(size_t i=0;i<source.size();i++){auto s=Json::parse(source[i].dump());s.set("allowed",true);stores.add(s);}auto methods=Json::array();methods.add("SHADOWMOUNT");methods.add("FPKG");plan_=Json::object({{"method",method_},{"methods",methods},{"allowed",true},{"storage",stores},{"compatibility",Json::object({{"status","NATIVE_COMPATIBLE"}})}});return;}
    auto revision=++planRevision_;auto r=selectedRelease();if(!r["sources"].size()){toast("No source is available for this release.");return;}auto body=Json::object({{"sourceReleaseId",r["sources"][size_t(0)]["id"]},{"consoleId",consoleId_}});if(!method.empty())body.set("method",method);plan_=Json();request("POST","/api/v1/device/installations/plan",body,[this,revision](const Json& result){
      if(revision!=planRevision_)return;plan_=result;method_=result["method"].string();if(modal_!="Download")return;
      auto stores=result["storage"];bool available=false;std::string first="modal-back";
      for(size_t i=0;i<stores.size();i++)if(stores[i]["allowed"].boolean()){if(first=="modal-back")first="destination:"+std::to_string(i);if(stores[i]["storageId"].string()==storageId_)available=true;}
      if(modalStep_==4&&!available)modalStep_=2;
      if(modalStep_==2)focus_.select(first);
    });}
  void downloadModal(){const float w=Tokens::width*.68f,x=(Tokens::width-w)/2,y=Tokens::height*.15f,h=Tokens::height*.76f;draw().fill({0,0,Tokens::width,Tokens::height},{2,6,12,210});draw().rounded({x,y,w,h},{22,32,47,248},28);
    const std::vector<std::string> steps={"Select version","Select PS5","Select storage","Installation method","Ready to download"};draw().label(steps[static_cast<size_t>(modalStep_)],x+40,y+35,Tokens::title,Tokens::white,1000);draw().label("STEP "+std::to_string(modalStep_+1)+" OF 5",x+40,y+110,Tokens::caption,Tokens::accent);const float top=y+170;auto g=game(gameId_),r=selectedRelease();
    if(modalStep_==0){
      auto releases=g["releases"];std::vector<size_t> choices;size_t addons=0;for(size_t i=0;i<releases.size();i++){const bool dlc=releases[i]["kind"].string()=="DLC";if(dlc)addons++;if(dlc==releaseAddons_)choices.push_back(i);}
      button("release-games","Game & updates",{x+40,top,w*.42f,48},1,[this]{releaseAddons_=false;releasePage_=0;},false,true,!releaseAddons_);
      button("release-dlc","DLC ("+std::to_string(addons)+")",{x+w*.48f,top,w*.48f-40,48},1,[this]{releaseAddons_=true;releasePage_=0;},false,addons>0,releaseAddons_);
      const size_t pages=std::max(size_t(1),(choices.size()+3)/4);releasePage_=std::min(releasePage_,pages-1);
      for(size_t n=releasePage_*4;n<choices.size()&&n<(releasePage_+1)*4;n++){const auto i=choices[n];button("version:"+std::to_string(i),releaseLabel(releases[i])+"  /  "+amount(releases[i]["size"].number()),{x+40,top+70+(n%4)*80,w-80,64},2+static_cast<int>(n%4),[this,i]{release_=i;modalStep_=1;focus_.select("target:0");},false,true,i==release_);}
      if(choices.empty())draw().label("No base game or update has finished source inspection.",x+40,top+90,Tokens::body,Tokens::muted,static_cast<int>(w-80),2);
      if(pages>1){button("releases-prev","Previous",{x+40,y+h-160,190,48},6,[this]{releasePage_--;focus_.select("releases-next");},false,releasePage_>0);button("releases-next","Next",{x+w-230,y+h-160,190,48},6,[this]{releasePage_++;focus_.select("releases-prev");},false,releasePage_+1<pages);draw().label(std::to_string(releasePage_+1)+" / "+std::to_string(pages),x+w*.48f,y+h-145,Tokens::caption,Tokens::muted);}
    }
    if(modalStep_==1){auto all=consoles();for(size_t i=0;i<all.size()&&i<5;i++)button("target:"+std::to_string(i),all[i]["name"].string()+"   "+all[i]["presence"].string("OFFLINE"),{x+40,top+i*78,w-80,62},1+static_cast<int>(i),[this,id=all[i]["id"].string()]{consoleId_=id;modalStep_=2;focus_.select("destination:0");plan();},false,true,all[i]["id"].string()==consoleId_);}
    if(modalStep_==2){auto stores=plan_["storage"];draw().label(plan_.null()?"Checking compatibility and storage…":friendly(plan_["compatibility"]["status"].string()),x+40,top,Tokens::heading,Tokens::accent,static_cast<int>(w-80));for(size_t i=0;i<stores.size()&&i<4;i++){
      const auto store=stores[i];const float row=top+70+i*106;
      button("destination:"+std::to_string(i),store["displayName"].string()+"   "+amount(store["freeBytes"].number())+" available",{x+40,row,w-80,62},1+static_cast<int>(i),[this,id=store["storageId"].string()]{storageId_=id;modalStep_=3;focus_.select("method");},false,store["allowed"].boolean());
      const auto reason=store["reason"].string();const auto detail=reason=="NOT_WRITABLE"?"This storage is currently read-only.":reason=="UNSUPPORTED_METHOD"?"This installation method is unavailable here.":std::string(store["allowed"].boolean()?"Space required: ":"Not enough space. Required: ")+amount(store["requiredBytes"].number());
      draw().label(detail,x+62,row+66,Tokens::caption,Tokens::muted,static_cast<int>(w-124));
    }if(!plan_.null()&&!stores.size())draw().label(plan_["message"].string("No supported writable storage was reported."),x+40,top+85,Tokens::body,Tokens::muted,static_cast<int>(w-80),4);}
    if(modalStep_==3){draw().label("Recommended for this console",x+40,top,Tokens::body,Tokens::muted);auto methods=plan_["methods"];for(size_t i=0;i<methods.size();i++){auto value=methods[i].string();auto label=value=="SHADOWMOUNT"?"ShadowMountPlus":value=="FPKG"?"FPKG":"Homebrew";button(i==0?"method":"method:"+value,label,{x+40,top+70+i*85,w-80,70},1+static_cast<int>(i),[this,value]{modalStep_=4;focus_.select("confirm-download");if(method_!=value)plan(value);},i==0);}draw().label("Only methods reported by your console are available.",x+40,top+95+methods.size()*85,Tokens::caption,Tokens::muted);}
    if(modalStep_==4){gameImage(g,{x+40,top,220,280});float textX=x+300;draw().label(g["title"].string(),textX,top,Tokens::heading,Tokens::white,static_cast<int>(w-340),2);draw().label(releaseLabel(r)+"  ·  "+amount(r["size"].number()),textX,top+90,Tokens::body);draw().label(selectedConsole()["name"].string(),textX,top+140,Tokens::body);auto stores=plan_["storage"];for(size_t i=0;i<stores.size();i++)if(stores[i]["storageId"].string()==storageId_)draw().label(stores[i]["displayName"].string(),textX,top+185,Tokens::body,Tokens::muted);draw().label(friendly(plan_["compatibility"]["status"].string()),textX,top+245,Tokens::caption,Tokens::accent,700,2);
      button("confirm-download","Download & Prepare",{x+40,y+h-165,w-80,67},2,[this,r]{request("POST","/api/v1/device/installations",Json::object({{"sourceReleaseId",plan_["sourceReleaseId"]},{"consoleId",consoleId_},{"storageId",storageId_},{"method",method_}}),[this](const Json&){closeModal();navigate("Downloads");lastRefresh_=0;toast("Preparation and delivery queued for your PS5");});},true,plan_["allowed"].boolean());
      if(!plan_["allowed"].boolean())draw().label(friendly(plan_["reason"].string()),x+40,y+h-205,Tokens::caption,Tokens::muted);}
    button("modal-back",modalStep_?"Back":"Cancel",{x+40,y+h-80,180,50},9,[this]{if(modalStep_)modalStep_--;else closeModal();focus_.select("");});
  }
  void searchModal(){draw().fill({0,0,Tokens::width,Tokens::height},{4,10,18,247});draw().label("Search your library",Tokens::safe,Tokens::safe*1.5f,Tokens::title);button("search-input",query_.empty()?"Search games, publishers and genres…":query_,{Tokens::safe,Tokens::safe*3,Tokens::width-Tokens::safe*2,78},0,[]{SDL_StartTextInput();});auto results=games([this](const Json&g){return lower(g["title"].string()+" "+g["publisher"].string()+" "+list(g["genres"])+(advanced_?g["titleId"].string():"")).find(lower(query_))!=std::string::npos;});rail("Results",results,Tokens::safe*5.5f,2);button("search-back","Close search",{Tokens::safe,Tokens::height-Tokens::safe-70,260,58},4,[this]{closeModal();});}
  void removalModal(){const float w=Tokens::width*.6f,h=460,x=(Tokens::width-w)/2,y=(Tokens::height-h)/2;
    draw().fill({0,0,Tokens::width,Tokens::height},{2,6,12,215});draw().rounded({x,y,w,h},{22,32,47,250},28);
    draw().label("Delete from PS5?",x+40,y+35,Tokens::title);draw().label(removal_["title"].string(),x+40,y+120,Tokens::heading,Tokens::white,static_cast<int>(w-80),2);
    std::string destination=removalConsole_["name"].string();auto stores=removalConsole_["storage"];for(size_t i=0;i<stores.size();i++)if(stores[i]["storageId"].string()==removal_["storageId"].string())destination+=" / "+stores[i]["displayName"].string();
    draw().label(destination,x+40,y+205,Tokens::body,Tokens::accent,static_cast<int>(w-80));draw().label("Remove the game files from this console. Your server copy stays available.",x+40,y+260,Tokens::body,Tokens::muted,static_cast<int>(w-80),2);
    button("remove-confirm","Delete from PS5",{x+40,y+h-85,w*.53f,55},1,[this]{auto entry=removal_,console=removalConsole_;request("POST","/api/v1/device/consoles/"+console["id"].string()+"/library/remove",Json::object({{"releaseId",entry["releaseId"]},{"storageId",entry["storageId"]},{"confirm",true}}),[this](const Json&){closeModal();navigate("Downloads");lastRefresh_=0;toast("Removal queued for your PS5");});});
    button("remove-cancel","Keep game",{x+w*.61f,y+h-85,w*.39f-40,55},1,[this]{closeModal();});
  }
  void exitModal(){const float w=Tokens::width*.52f,h=330,x=(Tokens::width-w)/2,y=(Tokens::height-h)/2;
    draw().fill({0,0,Tokens::width,Tokens::height},{2,6,12,225});draw().rounded({x,y,w,h},{22,32,47,250},28);
    draw().label("Return to PS5 home?",x+40,y+35,Tokens::title,Tokens::white,static_cast<int>(w-80));
    draw().label("Server preparation continues. Console transfers resume next time.",x+40,y+118,Tokens::body,Tokens::muted,static_cast<int>(w-80),2);
    button("exit-confirm","Exit PS5Library",{x+40,y+h-95,330,60},1,[this]{running_=false;SDL_StopTextInput();},true);
    button("exit-cancel","Stay in PS5Library",{x+w-390,y+h-95,350,60},1,[this]{closeModal();});
  }
  void footer(){draw().fade({0,Tokens::height-68,Tokens::width,68},false);draw().label(options_.preview?"DESIGN PREVIEW":offline_?"SERVER OFFLINE  ·  Cached collection":loading_?"Connecting to your library…":"PS5Library",Tokens::safe,Tokens::height-39,Tokens::caption,Tokens::muted);draw().label("△  Utilities     L1 / R1  Switch Tab     ✕  Select     ○  Back",Tokens::width-730,Tokens::height-39,Tokens::caption,Tokens::white,700);}
  void action(Action a){if(a==Action::None)return;if(a==Action::Quit){running_=false;return;}if(networkPaused_||SDL_IsScreenKeyboardShown(window_))return;const auto before=focus_.id();if(a==Action::Up)focus_.move(Direction::Up);if(a==Action::Down)focus_.move(Direction::Down);if(a==Action::Left)focus_.move(Direction::Left);if(a==Action::Right)focus_.move(Direction::Right);if(before!=focus_.id())audio_->play(Cue::Move);if(a==Action::Select){auto i=actions_.find(focus_.id());if(i!=actions_.end()){auto callback=i->second;callback();audio_->play(Cue::Select);}}
    if(a==Action::Search)search();if(a==Action::Settings)navigate("Settings");if(a==Action::Context){if(page_=="Game")advanced_=!advanced_;else search();}
    if(a==Action::Back){audio_->play(Cue::Back);if(!modal_.empty()){if(modal_=="Download"&&modalStep_>0){modalStep_--;focus_.select("");}else if(modal_=="SwitchServer"){modal_="Network";focus_.select("server-input");}else closeModal();}else if(page_=="Game"){page_=returnPage_;focus_.select(screenFocus_[page_]);}else if(!category_.empty())category_.clear();else if(page_=="Discover")exitPrompt();else navigate("Discover");}
    if(modal_.empty()&&(a==Action::NextTab||a==Action::PreviousTab)){auto i=std::find(tabs_.begin(),tabs_.end(),page_);int index=i==tabs_.end()?0:static_cast<int>(i-tabs_.begin());index=(index+static_cast<int>(tabs_.size())+(a==Action::NextTab?1:-1))%static_cast<int>(tabs_.size());navigate(tabs_[static_cast<size_t>(index)]);focus_.select("nav:"+page_);audio_->play(Cue::Move);}}
public:
  explicit Storefront(Options options):options_(std::move(options)),config_(readConfig(options_.config)),page_(options_.screen){
    fs::create_directories(options_.config.parent_path());
#ifdef PS5
    localAssets(options_.config.parent_path());
    frontendLock_=open("/data/ps5library/frontend.lock",O_CREAT|O_RDWR|O_NOFOLLOW,0600);if(frontendLock_<0||flock(frontendLock_,LOCK_EX|LOCK_NB)!=0)throw std::runtime_error("PS5Library is already open or updating");
#endif
    if(!config_["serverUrl"].string().empty())try{config_.set("serverUrl",normalizeServerUrl(config_["serverUrl"].string(),config_["allowInsecureLan"].boolean()));}catch(const std::exception& e){toast(e.what());}
    if(SDL_Init(SDL_INIT_VIDEO|SDL_INIT_GAMECONTROLLER)!=0||TTF_Init()!=0)throw std::runtime_error(SDL_GetError());IMG_Init(IMG_INIT_PNG|IMG_INIT_JPG|IMG_INIT_WEBP);SDL_SetHint(SDL_HINT_RENDER_SCALE_QUALITY,"1");
    Uint32 flags=SDL_WINDOW_SHOWN|SDL_WINDOW_RESIZABLE;
#ifdef PS5
    flags|=SDL_WINDOW_FULLSCREEN_DESKTOP;
#endif
    window_=SDL_CreateWindow("PS5Library",SDL_WINDOWPOS_CENTERED,SDL_WINDOWPOS_CENTERED,options_.width,options_.height,flags);renderer_=SDL_CreateRenderer(window_,-1,SDL_RENDERER_ACCELERATED|SDL_RENDERER_PRESENTVSYNC);if(!renderer_)renderer_=SDL_CreateRenderer(window_,-1,SDL_RENDERER_SOFTWARE);if(!renderer_)throw std::runtime_error(SDL_GetError());SDL_RenderSetLogicalSize(renderer_,static_cast<int>(Tokens::width),static_cast<int>(Tokens::height));
    canvas_=std::make_unique<Canvas>(renderer_,config_["font"].string("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"));art_=std::make_unique<Artwork>(config_,options_.config.parent_path()/"artwork-cache",options_.preview);input_=std::make_unique<Input>();
    audio_=std::make_unique<UiAudio>(config_["interfaceSounds"].null()||config_["interfaceSounds"].boolean());video_=std::make_unique<VideoPreview>(options_.config.parent_path()/"trailer-cache",*audio_);
    if(options_.preview){model_=readJson(options_.config.parent_path()/"preview.json");device_=model_["device"];credential_="preview";consoleId_=consoles()[size_t(0)]["id"].string();loading_=false;auto all=catalog();if(all.size())gameId_=all[size_t(0)]["id"].string();}
    else if(!config_["serverUrl"].string().empty()){auto cache=options_.config.parent_path()/"catalog-cache.json";try{device_=loadDeviceState(options_.config,config_);credential_=device_["credential"].string();art_->credentials(credential_);consoleId_=device_["consoleId"].string();if(fs::exists(cache)){auto saved=readJson(cache);if(saved["serverUrl"].string()==config_["serverUrl"].string()&&saved["device"]["consoleId"].string()==consoleId_&&!consoleId_.empty()){model_=saved;offline_=true;}}}catch(const std::exception&e){toast(e.what());}startAgent();refresh();}
    if(!options_.script.empty()){std::string command;for(char c:options_.script){if(c==','){script_.push_back(command);command.clear();}else command+=c;}if(!command.empty())script_.push_back(command);}
    focus_.select(page_=="Game"?"download":"first-card");
    if(!options_.preview&&config_["serverUrl"].string().empty()){loading_=false;networkSettings();}
  }
  ~Storefront(){running_=false;if(updateRequest_.valid())updateRequest_.wait();if(request_.valid())request_.wait();if(agent_.joinable())agent_.join();video_.reset();audio_.reset();art_.reset();SDL_DestroyTexture(backdropCache_);canvas_.reset();input_.reset();SDL_DestroyRenderer(renderer_);SDL_DestroyWindow(window_);IMG_Quit();TTF_Quit();SDL_Quit();if(frontendLock_>=0)close(frontendLock_);}
  std::string launchTitle()const{return launchTitle_;}
  void run(){auto previous=std::chrono::steady_clock::now();while(running_){auto start=std::chrono::steady_clock::now();if(frameCount_){double interval=std::chrono::duration<double,std::milli>(start-previous).count();if(intervalTimes_.size()<6000)intervalTimes_.push_back(interval);else intervalTimes_[frameCount_%6000]=interval;}delta_=std::min(.05f,std::chrono::duration<float>(start-previous).count());previous=start;pump();pumpUpdate();art_->upload(renderer_);SDL_Event event;
      while(SDL_PollEvent(&event)){visibility_.event(event);if(windowActive_!=visibility_.active()){windowActive_=visibility_.active();video_->stop();audio_->suspend(!windowActive_);}if(!windowActive_&&event.type!=SDL_QUIT)continue;if(textEvent(event))continue;if(event.type==SDL_KEYDOWN&&event.key.keysym.sym==SDLK_SLASH&&(modal_=="Network"||modal_=="Search"))continue;if(event.type==SDL_MOUSEBUTTONDOWN){float x,y;SDL_RenderWindowToLogical(renderer_,event.button.x,event.button.y,&x,&y);for(const auto& [id,rect]:rects_)if(x>=rect.x&&x<rect.x+rect.w&&y>=rect.y&&y<rect.y+rect.h){focus_.select(id);action(Action::Select);break;}}else action(input_->read(event));}if(windowActive_)action(input_->analog());
      if(!windowActive_){preview();SDL_Delay(50);previous=std::chrono::steady_clock::now();continue;}
      if(frameCount_>0&&frameCount_%25==0&&scriptIndex_<script_.size()){auto command=script_[scriptIndex_++];const std::map<std::string,Action> commands={{"up",Action::Up},{"down",Action::Down},{"left",Action::Left},{"right",Action::Right},{"select",Action::Select},{"back",Action::Back},{"next",Action::NextTab},{"prev",Action::PreviousTab},{"search",Action::Search},{"settings",Action::Settings}};if(command=="enter"){SDL_Event typed{};typed.type=SDL_KEYDOWN;typed.key.keysym.sym=SDLK_RETURN;SDL_PushEvent(&typed);}else if(command.rfind("text:",0)==0){auto text=command.substr(5);for(size_t offset=0;offset<text.size();){SDL_Event typed{};typed.type=SDL_TEXTINPUT;auto count=std::min(text.size()-offset,sizeof(typed.text.text)-1);std::memcpy(typed.text.text,text.data()+offset,count);SDL_PushEvent(&typed);offset+=count;}}else if(commands.count(command))action(commands.at(command));}
      preview();desiredImages_.clear();actions_.clear();rects_.clear();focus_.clear();Json backdrop=page_=="Profile"?Json():heroGame();background(backdrop);navigation();
      if(!options_.preview&&credential_.empty()&&page_!="Settings"){bool configured=!config_["serverUrl"].string().empty();title("Make yourself at home.",configured?"Open the companion and pair this console with your account.":"Connect your server to start exploring your collection.");draw().label(configured?device_["pairing"]["code"].string("Contacting your server…"):"Your library. Your PS5.",Tokens::safe,Tokens::height*.38f,Tokens::title,Tokens::accent);draw().label("Pair once. Your games and consoles stay with your account.",Tokens::safe,Tokens::height*.52f,Tokens::body,Tokens::muted);button("pair-network",configured?"Server connection":"Connect server",{Tokens::safe,Tokens::height*.65f,350,60},1,[this]{networkSettings();},true);if(configured)button("pair-retry","Retry",{Tokens::safe+380,Tokens::height*.65f,220,60},1,[this]{lastRefresh_=0;});}
      else if(page_=="Discover")discover();else if(page_=="Game")details();else if(page_=="Downloads")downloadJobs();else if(page_=="My PS5")myPS5();else if(page_=="Settings")settings();else if(page_=="Profile")profile();else gridPage();
      footer();if(offline_&&modal_.empty()){badge("Server offline — cached view",{Tokens::width-Tokens::safe-355,Tokens::header+5,355,34});}
      if(!modal_.empty()){focus_.clear();actions_.clear();rects_.clear();if(modal_=="Download")downloadModal();else if(modal_=="Network"||modal_=="SwitchServer")networkModal();else if(modal_=="Exit")exitModal();else if(modal_=="Avatar")avatarModal();else if(modal_=="RemoveGame")removalModal();else searchModal();}
      if(!focus_.current()&&focus_.id()=="first-card"){if(page_=="Discover"){auto candidate=games([](const Json&g){return g["rail"].string()!="hero";});if(!candidate.empty())focus_.select("rail3:"+candidate[0]["id"].string());}else{auto candidate=games();if(!candidate.empty())focus_.select("grid:"+candidate[0]["id"].string());}}focus_.ensure();
      if(SDL_GetTicks()<toastUntil_){Rect rect{Tokens::width*.2f,Tokens::height-115,Tokens::width*.6f,58};draw().rounded(rect,{35,51,73,245},16);draw().label(message_,rect.x+22,rect.y+15,Tokens::caption,Tokens::white,static_cast<int>(rect.w-44));}
      art_->desire(desiredImages_);draw().end();SDL_RenderFlush(renderer_);auto composed=std::chrono::steady_clock::now();SDL_RenderPresent(renderer_);auto rendered=std::chrono::steady_clock::now();
      auto record=[this](std::vector<double>& samples,double duration){if(samples.size()<6000)samples.push_back(duration);else samples[frameCount_%6000]=duration;};
      record(frameTimes_,std::chrono::duration<double,std::milli>(rendered-start).count());record(drawTimes_,std::chrono::duration<double,std::milli>(composed-start).count());record(presentTimes_,std::chrono::duration<double,std::milli>(rendered-composed).count());frameCount_++;
      if(!options_.preview&&(frameCount_==60||frameCount_%300==0)){
        SDL_RendererInfo info{};SDL_GetRendererInfo(renderer_,&info);auto median=[](std::vector<double> samples){std::sort(samples.begin(),samples.end());return static_cast<int64_t>(samples[samples.size()/2]*1000);};
        auto metrics=Json::object({{"build",appBuild},{"version",appVersion},{"audioAvailable",audio_->available()},{"renderer",info.name?info.name:"unknown"},{"frames",frameCount_},{"renderMedianMicros",median(frameTimes_)},{"drawMedianMicros",median(drawTimes_)},{"presentMedianMicros",median(presentTimes_)},{"backdropCompositions",backdropCompositions_},{"screen",page_}});
        metrics.set("frameIntervalMedianMicros",median(intervalTimes_));metrics.set("audioDriver",SDL_GetCurrentAudioDriver()?SDL_GetCurrentAudioDriver():"unavailable");metrics.set("soundCuesPlayed",static_cast<int64_t>(audio_->played()));metrics.set("audioQueuedBytes",static_cast<int64_t>(audio_->queued()));metrics.set("interfaceSounds",audio_->enabled());
#ifdef PS5
        metrics.set("audioOutputCalls",static_cast<int64_t>(audioOutput.calls.load()));metrics.set("audioOutputErrors",static_cast<int64_t>(audioOutput.errors.load()));metrics.set("audioLastError",audioOutput.lastError.load());metrics.set("audioOpenResult",audioOutput.openResult.load());metrics.set("audioVolumeResult",audioOutput.volumeResult.load());metrics.set("audioRoute",audioOutput.user.load()==255?"SYSTEM":"LOCAL_USER");metrics.set("audioInitialUserResult",audioOutput.initialUserResult.load());metrics.set("audioForegroundUserResult",audioOutput.foregroundUserResult.load());metrics.set("audioLocalOpenResult",audioOutput.localOpenResult.load());metrics.set("audioPcmPeak",audioOutput.peak.load());metrics.set("audioNonzeroBlocks",static_cast<int64_t>(audioOutput.nonzeroBlocks.load()));
#endif
        if(frameCount_==60){metrics.set("launchId",launchId_);metrics.set("startupRenderMedianMicros",median(frameTimes_));atomicJson(options_.config.parent_path()/"update-boot.json",metrics);}atomicJson(options_.config.parent_path()/"performance-live.json",metrics);
      }
      if(options_.frames&&frameCount_>=options_.frames){if(!options_.capture.empty()){int w,h;SDL_GetRendererOutputSize(renderer_,&w,&h);auto* surface=SDL_CreateRGBSurfaceWithFormat(0,w,h,32,SDL_PIXELFORMAT_ARGB8888);SDL_RenderReadPixels(renderer_,nullptr,SDL_PIXELFORMAT_ARGB8888,surface->pixels,surface->pitch);SDL_SaveBMP(surface,options_.capture.c_str());SDL_FreeSurface(surface);}break;}
      if(options_.frames)SDL_Delay(10);
#ifndef PS5
      else SDL_Delay(1);
#endif
      // PS5 SDL already blocks on the display flip. An extra sleep can miss the next refresh.
    }std::sort(frameTimes_.begin(),frameTimes_.end());if(!frameTimes_.empty()){auto count=frameTimes_.size();Json metrics=Json::object({{"musicStarts",static_cast<int64_t>(video_->musicStarts())},{"musicAudioBytes",static_cast<int64_t>(video_->musicBytes())},{"backdropCompositions",backdropCompositions_},{"trailerStarts",static_cast<int64_t>(video_->starts())},{"trailerFrames",static_cast<int64_t>(video_->displayed())},{"trailerDecodedFrames",static_cast<int64_t>(video_->decoded())},{"trailerAudioBytes",static_cast<int64_t>(video_->audioBytes())},{"trailerActive",video_->active()},{"audioAvailable",audio_->available()},{"soundCuesPlayed",static_cast<int64_t>(audio_->played())},{"frames",static_cast<int64_t>(count)},{"renderMedianMicros",static_cast<int64_t>(frameTimes_[count/2]*1000)},{"renderP95Micros",static_cast<int64_t>(frameTimes_[count*95/100]*1000)},{"textureBytes",static_cast<int64_t>(art_->textureBytes())},{"screen",page_},{"focus",focus_.id()},{"preview",options_.preview}});atomicJson(options_.config.parent_path()/"performance.json",metrics);std::puts(metrics.dump().c_str());}}
};
int main(int argc,char** argv){try{Options options;for(int i=1;i<argc;i++){std::string value=argv[i];if(value=="--preview")options.preview=true;else if(value.rfind("--frames=",0)==0)options.frames=std::stoi(value.substr(9));else if(value.rfind("--capture=",0)==0)options.capture=value.substr(10);else if(value.rfind("--screen=",0)==0)options.screen=value.substr(9);else if(value.rfind("--script=",0)==0)options.script=value.substr(9);else if(value.rfind("--size=",0)==0){auto split=value.find('x');options.width=std::stoi(value.substr(7,split-7));options.height=std::stoi(value.substr(split+1));}else options.config=value;}options.config=fs::absolute(options.config);std::string launch;{Storefront app(options);app.run();launch=app.launchTitle();}if(!launch.empty())loaderRequest(readConfig(options.config)["launcherUrl"].string(),"/launch?titleId="+launch);return 0;}catch(const std::exception&e){std::fprintf(stderr,"Storefront: %s\n",e.what());return 1;}}
