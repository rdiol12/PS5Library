#include "../common/client.hpp"
#include <regex>
#include <sys/stat.h>
#ifdef PS5
extern "C" {int sceUserServiceInitialize2(void);int sceUserServiceGetForegroundUser(int*);}
#endif
namespace ps5library {
Json readTrophySummary(const fs::path& userRoot,const std::string& localUserId){
  try{
    if(!std::regex_match(localUserId,std::regex("[a-f0-9]{8}")))return Json();
    auto file=beneath(userRoot,localUserId+"/trophy/data/sce_trop/trpsummary.dat");struct stat info{};
    if(stat(file.c_str(),&info)||!S_ISREG(info.st_mode)||info.st_size<=0||info.st_size>4096)return Json();
    auto value=readJson(file);if(value["format"].number()!=1)return Json();auto counts=Json::object();
    for(const auto* grade:{"platinum","gold","silver","bronze"}){auto n=value["earnedTrophies"][grade].number(-1);if(n<0||n>1000000)return Json();counts.set(grade,n);}
    auto hash=fileHash(file);struct stat after{};if(stat(file.c_str(),&after)||info.st_size!=after.st_size||info.st_mtime!=after.st_mtime)return Json();
    return Json::object({{"source","LOCAL_SUMMARY"},{"localUserId",localUserId},{"earnedTrophies",counts},{"modifiedAt",static_cast<int64_t>(info.st_mtime)},{"sourceSha256",hash}});
  }catch(...){return Json();}
}
Json Agent::trophies(){
  // Bind once to the foreground profile; switching PS5 users never silently changes the server owner's trophy source.
  auto user=state_["trophyUserId"].string();
  if(user.empty()){
    user=config_["trophyUserId"].string();
#ifdef PS5
    if(user.empty()){sceUserServiceInitialize2();int id=-1;if(sceUserServiceGetForegroundUser(&id)==0&&id>0){char value[9];std::snprintf(value,sizeof(value),"%08x",static_cast<unsigned>(id));user=value;}}
#endif
    if(!std::regex_match(user,std::regex("[a-f0-9]{8}")))return Json();
    state_.set("trophyUserId",user);atomicJson(statePath_,state_);
  }
#ifdef PS5
  return readTrophySummary("/user/home",user);
#else
  return Json();
#endif
}
}
