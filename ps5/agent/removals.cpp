#include "../common/client.hpp"
#include <chrono>
#include <regex>
namespace ps5library {
void Agent::removals(){
  Json tasks;try{tasks=client.request("GET","/api/v1/device/removals");}catch(const RequestError& e){if(e.status==404)return;throw;}
  const auto volumes=storage();
  for(size_t i=0;i<tasks.size();i++){
    if(client.cancelled&&client.cancelled())return;
    const auto task=tasks[i];const auto id=task["id"].string();
    if(!std::regex_match(id,std::regex("[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}")))continue;
    auto progress=[&](const std::string& state,const std::string& error=""){client.request("POST","/api/v1/device/removals/"+id+"/progress",Json::object({{"state",state},{"error",error}}));};
    try{
      fs::path root;for(size_t v=0;v<volumes.size();v++)if(volumes[v]["storageId"].string()==task["storageId"].string())root=volumes[v]["path"].string();
      if(root.empty())throw std::runtime_error("Selected storage is unavailable");
      const auto file=beneath(root,task["relativePath"].string());
      const auto record=beneath(statePath_.parent_path(),"removals/"+id+".json");
      auto local=fs::exists(record)?readJson(record):Json();const auto now=std::chrono::duration_cast<std::chrono::seconds>(std::chrono::system_clock::now().time_since_epoch()).count();
      if(task["state"].string()=="QUEUED")progress("DELETING");
      if(local.null()&&fs::exists(file)){
        auto items=inventory();Json current;
        for(size_t n=0;n<items.size();n++)if(items[n]["storageId"].string()==task["storageId"].string()&&items[n]["relativePath"].string()==task["relativePath"].string())current=items[n];
        if(current.null()||!current["available"].boolean()||current["contentId"].string()!=task["contentId"].string()||current["version"].string()!=task["version"].string()||current["source"].string("MANAGED")!=task["source"].string()||current["sha256"].dump()!=task["sha256"].dump()||current["size"].dump()!=task["size"].dump())throw std::runtime_error("GAME_CHANGED_SINCE_CONFIRMATION");
        const bool ownedFile=task["source"].string()=="MANAGED"&&!task["registered"].boolean();
        if(ownedFile){
          if(task["relativePath"].string().rfind("PS5Library/",0)!=0||!fs::is_regular_file(file))throw std::runtime_error("REMOVAL_UNAVAILABLE");
          local=Json::object({{"startedAt",static_cast<int64_t>(now)}});atomicJson(record,local);fs::remove(file);
        }else{
          if(!shadowMountDeletionSupported(shadowMount_)||!std::regex_match(task["titleId"].string(),std::regex("(PPSA|CUSA)[0-9]{5}")))throw std::runtime_error("REMOVAL_UNAVAILABLE");
          const bool installed=task["source"].string()=="INSTALLED_TITLE";
          if(!installed){
            const auto games=shadowMountRequest(shadowMountPort_,"/api/v1/games",Json::object({{"include_size",false}}),client.cancelled)["games"];bool matched=false;
            for(size_t g=0;g<games.size();g++)if(games[g]["title_id"].string()==task["titleId"].string()&&games[g]["path"].string()==file.string()&&games[g]["source_available"].boolean())matched=true;
            if(!matched)throw std::runtime_error("SHADOWMOUNT_SOURCE_MISMATCH");
          }
          local=Json::object({{"startedAt",static_cast<int64_t>(now)}});atomicJson(record,local);
          // Persist before submission. An ambiguous timeout must never silently repeat a destructive request.
          try{auto response=shadowMountRequest(shadowMountPort_,installed?"/api/v1/games/uninstall":"/api/v1/games/delete",Json::object({{"title_id",task["titleId"]},{"confirm",true}}),client.cancelled);local.set("storageJob",response["job_id"]);}
          catch(const std::exception& e){local.set("requestError",e.what());}
          atomicJson(record,local);
        }
      }
      progress("VERIFYING");
      if(!fs::exists(file)){heartbeat();progress("COMPLETED");continue;}
      if(local["storageJob"].number()>0){const auto report=shadowMountRequest(shadowMountPort_,"/api/v1/games/storage/status",Json::object({{"job_id",local["storageJob"]}}),client.cancelled);const auto state=report["state"].string();if(state=="failed"||state=="cancelled")throw std::runtime_error("CONSOLE_REMOVAL_FAILED");}
      if(now-local["startedAt"].number(now)>120)throw std::runtime_error(local["requestError"].string("REMOVAL_NOT_CONFIRMED"));
    }catch(const std::exception& e){try{progress("ERROR",e.what());}catch(const std::exception&){}}
  }
}
}
