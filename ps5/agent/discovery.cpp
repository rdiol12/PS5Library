#include "../common/client.hpp"
#include <fstream>
#include <regex>
#include <set>
#include <vector>
#include <cstring>
#include <sstream>
#include <openssl/evp.h>
#ifdef PS5
#include <sys/types.h>
#include <sys/sysctl.h>
#include <sys/user.h>
#endif
namespace ps5library {
unsigned shadowMountPort(const std::string& config){
  if(config.size()>65536)return 0;
  unsigned port=10101;bool enabled=true;std::istringstream input(config);std::string line;
  while(std::getline(input,line)){
    line=line.substr(0,line.find_first_of("#;"));auto equal=line.find('=');if(equal==std::string::npos)continue;
    auto trim=[](std::string value){auto start=value.find_first_not_of(" \t\r");if(start==std::string::npos)return std::string();return value.substr(start,value.find_last_not_of(" \t\r")-start+1);};
    auto key=trim(line.substr(0,equal)),value=trim(line.substr(equal+1));
    if(key=="api_port"){if(value.empty()||value.size()>5||value.find_first_not_of("0123456789")!=std::string::npos)return 0;port=std::stoul(value);if(!port||port>65535)return 0;}
    if(key=="api_enabled"){for(auto& c:value)c=static_cast<char>(std::tolower(static_cast<unsigned char>(c)));enabled=value=="1"||value=="true"||value=="on"||value=="yes";}
  }
  return enabled?port:0;
}
bool shadowMountSupported(const Json& version){
  auto name=version["shadowmount_version"].string();if(version["status"].number(-1)!=0||version["api_version"].number()!=1||name.empty()||name.size()>80)return false;
  bool add=false,scan=false;auto caps=version["capabilities"];for(size_t i=0;i<caps.size();i++){add|=caps[i].string()=="add_manual_source";scan|=caps[i].string()=="rescan";}return add&&scan;
}
Json shadowMountRequest(unsigned port,const std::string& route,const Json& body,const std::function<bool()>& cancelled){
  static const std::set<std::string> routes={"/api/v1/version","/api/v1/settings","/api/v1/manual/add","/api/v1/scan","/api/v1/games","/api/v1/games/uninstall","/api/v1/games/delete","/api/v1/games/storage/status"};
  if(!port||port>65535||!routes.count(route))throw std::runtime_error("Unsupported local ShadowMount request");
  Client local(Json::object({{"serverUrl","http://127.0.0.1:"+std::to_string(port)},{"allowInsecureLan",true}}));local.cancelled=cancelled;
  auto payload=body.dump();if(payload.size()>4096)throw std::runtime_error("ShadowMount request too large");
  auto* curl=local.handle(route);auto* headers=curl_slist_append(nullptr,"Content-Type: application/json");std::string output;
  curl_easy_setopt(curl,CURLOPT_PROXY,"");curl_easy_setopt(curl,CURLOPT_TIMEOUT_MS,1500L);curl_easy_setopt(curl,CURLOPT_CONNECTTIMEOUT_MS,500L);
  curl_easy_setopt(curl,CURLOPT_HTTPHEADER,headers);curl_easy_setopt(curl,CURLOPT_POSTFIELDS,payload.c_str());curl_easy_setopt(curl,CURLOPT_POSTFIELDSIZE,static_cast<long>(payload.size()));
  curl_easy_setopt(curl,CURLOPT_WRITEDATA,&output);curl_easy_setopt(curl,CURLOPT_WRITEFUNCTION,(+[](char* data,size_t a,size_t b,void* target)->size_t{auto& out=*static_cast<std::string*>(target);if(a*b>2*1024*1024-out.size())return 0;out.append(data,a*b);return a*b;}));
  auto result=curl_easy_perform(curl);long status=0;curl_easy_getinfo(curl,CURLINFO_RESPONSE_CODE,&status);curl_slist_free_all(headers);curl_easy_cleanup(curl);
  if(result!=CURLE_OK||status!=200)throw std::runtime_error("ShadowMount API unavailable");auto response=Json::parse(output);
  if(response["status"].number(-1)!=0)throw std::runtime_error("ShadowMount rejected the request");return response;
}
bool shadowMountDeletionSupported(const Json& version){
  if(!shadowMountSupported(version))return false;
  std::set<std::string> caps;auto list=version["capabilities"];for(size_t i=0;i<list.size();i++)caps.insert(list[i].string());
  return caps.count("uninstall_game")&&caps.count("delete_game_source")&&caps.count("list_games")&&caps.count("storage_job_status");
}
Json Agent::discoverDumps(const Json& volumes) {
  Json result=Json::array();std::set<std::string> seen;size_t inspected=0;
  for(size_t v=0;v<volumes.size();v++) {
    const auto volume=volumes[v];const auto root=fs::path(volume["path"].string());
    if(volume["storageId"].string()=="internal-installed")continue;
    // ponytail: bounded directory scan; add a persisted index if collections exceed 4096 folders.
    std::vector<std::pair<fs::path,int>> pending={{root,0}};
    while(!pending.empty()) {
      auto [folder,depth]=pending.back();pending.pop_back();
      if((client.cancelled&&client.cancelled())||++inspected>4096){inventoryComplete_=false;return result;}
      try {
        if(fs::is_symlink(folder)||!fs::is_directory(folder)||!seen.insert(folder.string()).second)continue;
        auto parameters=folder/"sce_sys/param.json",executable=folder/"eboot.bin";
        if(fs::is_regular_file(parameters)&&fs::is_regular_file(executable)) {
          auto relative=fs::relative(folder,root).generic_string();if(relative=="."||relative.empty())continue;
          parameters=beneath(root,relative+"/sce_sys/param.json");(void)beneath(root,relative+"/eboot.bin");
          if(fs::file_size(parameters)>128*1024)continue;
          auto metadata=readJson(parameters);const auto titleId=metadata["titleId"].string(),contentId=metadata["contentId"].string(),version=metadata["contentVersion"].string();
          if(!std::regex_match(titleId,std::regex("PPSA[0-9]{5}"))||contentId.size()>80||contentId.substr(7,9)!=titleId||version.empty()||version.size()>30)continue;
          const auto localized=metadata["localizedParameters"];const auto language=localized["defaultLanguage"].string("en-US");
          auto title=localized[language.c_str()]["titleName"].string(localized["en-US"]["titleName"].string());if(title.empty()||title.size()>200)continue;
          bool libraries=false;for(const auto* name:{"fakelib","fakelib2"})if(fs::is_directory(folder/name)&&!fs::is_symlink(folder/name))libraries=true;
          result.add(Json::object({{"titleId",titleId},{"contentId",contentId},{"version",version},{"title",title},{"storageId",volume["storageId"]},{"relativePath",relative},
            {"source","EXISTING_DUMP"},{"sha256",Json()},{"size",Json()},{"available",true},{"registered",false},{"backportFiles",libraries},{"_artworkRoot",(folder/"sce_sys").string()}}));
          continue;
        }
        if(depth==3)continue;
        for(const auto& entry:fs::directory_iterator(folder)) {
          if(++inspected>4096){inventoryComplete_=false;return result;}
          const auto name=entry.path().filename().string();
          if(name.empty()||name[0]=='.'||name=="backports"||name=="fakelib"||name=="fakelib2"||name=="user"||name=="system_data"||name=="System Volume Information")continue;
          if(!entry.is_symlink()&&entry.is_directory())pending.push_back({entry.path(),depth+1});
        }
      }catch(const fs::filesystem_error&){inventoryComplete_=false;}catch(const std::exception&){/* Invalid title metadata is not an available game. */}
    }
  }
  return result;
}
Json Agent::runtimeStatus() {
  detectedRuntime_.clear();
  auto result=Json::object({{"shadowMount","UNKNOWN"},{"kstuff","UNKNOWN"},{"backPork","UNKNOWN"},{"fakelibEnabled",Json()}});
#ifdef PS5
  int mib[4]={CTL_KERN,KERN_PROC,KERN_PROC_PROC,0};size_t size=0;
  if(sysctl(mib,4,nullptr,&size,nullptr,0)||!size||size>4*1024*1024)return result;
  std::vector<unsigned char> data(size);
  if(sysctl(mib,4,data.data(),&size,nullptr,0))return result;
  std::set<std::string> names;
  for(size_t offset=0;offset<size;) {
    if(size-offset<sizeof(int))return result;int length=0;std::memcpy(&length,data.data()+offset,sizeof(length));
    constexpr size_t end=offsetof(kinfo_proc,ki_comm)+sizeof(kinfo_proc::ki_comm);
    if(length<static_cast<int>(end)||static_cast<size_t>(length)>size-offset)return result;
    const char* name=reinterpret_cast<const char*>(data.data()+offset+offsetof(kinfo_proc,ki_comm));names.insert(std::string(name,strnlen(name,sizeof(kinfo_proc::ki_comm))));offset+=length;
  }
  bool shadow=names.count("shadowmountplus.elf")>0,backpork=names.count("backpork.elf")||names.count("BackPork.elf");
  if(names.count("kstuff-lite.elf"))detectedRuntime_="kstuff-lite";else if(names.count("kstuff.elf"))detectedRuntime_="kstuff";
  result.set("shadowMount",shadow?"RUNNING":"NOT_RUNNING");result.set("backPork",backpork?"RUNNING":"NOT_RUNNING");result.set("kstuff",names.count("kstuff.elf")||names.count("kstuff-lite.elf")?"RUNNING":"NOT_RUNNING");
  if(shadow) {
    bool enabled=true;std::ifstream input("/data/shadowmount/config.ini");std::string line;
    while(std::getline(input,line)){line=line.substr(0,line.find('#'));std::smatch match;if(std::regex_match(line,match,std::regex("[ \\t]*backport_fakelib[ \\t]*=[ \\t]*(0|1|true|false|yes|no|on|off)[ \\t\\r]*",std::regex::icase))){auto value=match[1].str();for(auto& c:value)c=static_cast<char>(std::tolower(static_cast<unsigned char>(c)));enabled=value=="1"||value=="true"||value=="yes"||value=="on";}}
    result.set("fakelibEnabled",enabled);result.set("backportConflict",enabled&&backpork);
  }
#endif
  return result;
}
void Agent::syncArtwork(const Json& items) {
  auto uploaded=state_["artworkUploaded"];if(uploaded.null())uploaded=Json::object();
  for(size_t i=0;i<items.size();i++) {
    auto item=items[i];if(item["source"].string()!="EXISTING_DUMP"&&item["source"].string()!="INSTALLED_TITLE")continue;
    for(const auto* kind:{"cover","hero"})try {
      if(client.cancelled&&client.cancelled())return;
      if(item["_artworkRoot"].string().empty())continue;
      const auto file=beneath(item["_artworkRoot"].string(),std::string(kind)=="hero"?(item["platform"].string()=="PS4"?"pic1.png":"pic0.png"):"icon0.png");
      if(!fs::is_regular_file(file)||fs::file_size(file)>16*1024*1024)continue;
      auto stamp=fs::last_write_time(file);auto found=verified_.find(file.string());if(found==verified_.end()||found->second.first!=stamp)verified_[file.string()]={stamp,fileHash(file,client.cancelled)};
      const auto digest=verified_[file.string()].second,key=item["titleId"].string()+":"+item["version"].string()+":"+kind;
      if(uploaded[key.c_str()].string()==digest)continue;
      std::ifstream input(file,std::ios::binary);std::string bytes(16*1024*1024+1,'\0');input.read(bytes.data(),bytes.size());bytes.resize(input.gcount());
      if(!input.eof()||bytes.empty()||bytes.size()>16*1024*1024)continue;
      std::string encoded(4*((bytes.size()+2)/3)+1,'\0');int length=EVP_EncodeBlock(reinterpret_cast<unsigned char*>(encoded.data()),reinterpret_cast<const unsigned char*>(bytes.data()),static_cast<int>(bytes.size()));encoded.resize(length);
      client.request("POST","/api/v1/device/library/artwork",Json::object({{"titleId",item["titleId"]},{"contentId",item["contentId"]},{"version",item["version"]},{"kind",kind},{"sha256",digest},{"data",encoded}}));
      uploaded.set(key,digest);state_.set("artworkUploaded",uploaded);atomicJson(statePath_,state_);
    }catch(const std::exception& e){std::fprintf(stderr,"Inventory artwork: %s\n",e.what());}
  }
}
}
