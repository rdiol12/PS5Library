#pragma once
#include "../common/json.hpp"
#include <algorithm>
#include <cstdint>
#include <set>
#include <vector>
namespace storefront {
inline bool validTitleId(const std::string& value){return value.size()==9&&(value.compare(0,4,"PPSA")==0||value.compare(0,4,"CUSA")==0)&&std::all_of(value.begin()+4,value.end(),[](char c){return c>='0'&&c<='9';});}
inline std::string releaseLabel(const Json& release){return release["kind"].string()=="DLC"?"DLC: "+release["title"].string("Additional content")+" / "+release["version"].string():(release["kind"].string()=="UPDATE"?"Update / ":"Base game / ")+release["version"].string();}
inline bool serverAvailable(const Json& game){auto releases=game["releases"];for(size_t i=0;i<releases.size();i++)if(releases[i]["kind"].string()!="DLC"&&(releases[i]["sources"].size()||releases[i]["artifacts"].size()))return true;return false;}
inline bool serverReady(const Json& game){auto releases=game["releases"];for(size_t i=0;i<releases.size();i++)if(releases[i]["kind"].string()!="DLC"&&releases[i]["artifacts"].size())return true;return false;}
inline bool cachedArtifactOnly(const Json& release){return !release["sources"].size()&&release["artifacts"].size();}
inline std::vector<Json> recentlyAdded(std::vector<Json> games,size_t limit=4){
  games.erase(std::remove_if(games.begin(),games.end(),[](const Json& g){auto releases=g["releases"];for(size_t i=0;i<releases.size();i++)if(releases[i]["sources"].size())return false;return true;}),games.end());
  std::stable_sort(games.begin(),games.end(),[](const Json& a,const Json& b){return a["addedAt"].string()>b["addedAt"].string();});if(games.size()>limit)games.resize(limit);return games;
}
inline bool releaseReady(const Json& release,const Json& library){for(size_t i=0;i<library.size();i++)if(release["kind"].string()!="DLC"&&library[i]["releaseId"].string()==release["id"].string()&&library[i]["state"].string()=="READY_ON_PS5")return true;return false;}
inline std::string launchableRelease(const Json& game,const Json& release,const Json& library){
  const auto id=game["titleId"].string();if(!validTitleId(id)||!releaseReady(release,library))return {};
  for(size_t i=0;i<library.size();i++)if(library[i]["releaseId"].string()==release["id"].string()&&(library[i]["registered"].boolean()||library[i]["source"].string()=="INSTALLED_TITLE"))return id;return {};
}
inline std::string launchableTitle(const Json& game,const Json& library){auto releases=game["releases"];for(size_t i=0;i<releases.size();i++){auto id=launchableRelease(game,releases[i],library);if(!id.empty())return id;}return {};}
struct GameActionState {std::string label;bool enabled;};
inline GameActionState gameActionState(bool playable,bool active,bool ready,bool offline,bool downloadable,bool preparable){
  if(playable)return {"Play Now",true};
  if(active)return {"Installing",false};
  if(ready)return {"On this PS5",false};
  if(offline)return {"Offline",false};
  if(downloadable)return {"Download",true};
  if(preparable)return {"Prepare",true};
  return {"Source unavailable",false};
}
inline bool deliveryActive(const Json& release,const Json& installations,const Json& jobs,const std::string& consoleId){
  const auto terminal=[](const std::string& state){return state=="READY_ON_PS5"||state=="COMPLETED"||state=="ERROR"||state=="CANCELLED";};
  auto sources=release["sources"];
  for(size_t i=0;i<installations.size();i++)if(installations[i]["consoleId"].string()==consoleId&&!terminal(installations[i]["state"].string()))for(size_t s=0;s<sources.size();s++)if(installations[i]["sourceReleaseId"].string()==sources[s]["id"].string())return true;
  for(size_t i=0;i<jobs.size();i++)if(jobs[i]["consoleId"].string()==consoleId&&jobs[i]["kind"].string()=="TRANSFER"&&jobs[i]["releaseId"].string()==release["id"].string()&&!terminal(jobs[i]["state"].string()))return true;
  return false;
}
inline bool offlinePageEnabled(const std::string& page){return page=="My Library"||page=="Downloads"||page=="My PS5"||page=="Profile";}
inline bool landingPage(const std::string& page,bool){return page=="My Library";}
inline Json buildByteProgress(const Json& job){
  if(job["kind"].string()!="BUILD")return Json();const auto state=job["state"].string();
  if(state=="DOWNLOADING"&&job["totalBytes"].number()>0)return Json::object({{"completedBytes",job["downloadedBytes"]},{"totalBytes",job["totalBytes"]}});
  if(state!="EXTRACTING"&&state!="BUILDING"&&state!="PUBLISHING")return Json();
  auto progress=job["progress"];
  for(const auto* key:{"operation","extraction","staging"}){auto bytes=progress[key];if(bytes["totalBytes"].number()>0)return bytes;}
  return Json();
}
inline bool mergeJobEvent(Json& jobs,const Json& event){
  const auto id=event["jobId"].string(),state=event["state"].string();auto progress=event["progress"];if(id.empty()||state.empty()||!progress.isObject())return false;
  for(size_t i=0;i<jobs.size();i++)if(jobs[i]["id"].string()==id){auto job=jobs[i];job.set("state",event["state"]);for(const auto* key:{"downloadedBytes","totalBytes","speedBytesPerSecond","etaSeconds"})job.set(key,progress[key]);job.set("progress",progress["conversion"]);return true;}return false;
}
inline bool formatStorageId(const std::string& id){return id.size()>3&&id.rfind("usb",0)==0&&std::all_of(id.begin()+3,id.end(),[](char c){return c>='0'&&c<='9';});}
inline bool formatChallenge(const std::string& value){return value.size()==64&&std::all_of(value.begin(),value.end(),[](char c){return (c>='0'&&c<='9')||(c>='a'&&c<='f');});}
inline bool formatEligibleStorage(const Json& storage){return storage["formatEligible"].boolean()&&!storage["displayName"].string().empty()&&storage["totalBytes"].number()>0&&formatStorageId(storage["storageId"].string());}
inline Json storageCards(const Json& storage){
  auto result=Json::array();bool hasInternal=false;for(size_t i=0;i<storage.size();i++)hasInternal|=storage[i]["storageId"].string()=="internal";
  for(size_t i=0;i<storage.size();i++){auto item=storage[i];if(hasInternal&&item["storageId"].string()=="internal-installed")continue;if(item["storageId"].string()=="internal-installed")item.set("displayName","Internal Storage");result.add(item);}return result;
}
inline std::string formatStoragePath(const Json& storage,const std::string& action,const std::string& challenge={}){
  if(!formatEligibleStorage(storage))return {};const auto base="/api/v1/agent/storage/"+storage["storageId"].string()+"/format/";
  if(action=="prepare"&&challenge.empty())return base+action;
  if(action=="confirm"&&formatChallenge(challenge))return base+action+"/"+challenge;
  return {};
}
inline bool moveDestinationEligible(const Json& item,const Json& source,const Json& destination){
  if(!destination["writable"].boolean()||destination["storageId"].string().empty()||destination["storageId"].string()==source["storageId"].string())return false;
  const bool native=item["nativeRegistered"].boolean()&&(item["source"].string()=="INSTALLED_TITLE"||item["method"].string()=="FPKG");
  if(native){
    if(source["nativeMoveStorageType"].null()||destination["nativeMoveStorageType"].null())return false;
    const auto from=source["nativeMoveStorageType"].number(-1),to=destination["nativeMoveStorageType"].number(-1);
    bool fpkg=false;auto methods=destination["installMethodsSupported"];for(size_t i=0;i<methods.size();i++)fpkg|=methods[i].string()=="FPKG";
    return fpkg&&from>=0&&from<=2&&to>=0&&to<=2&&from!=to;
  }
  auto methods=destination["installMethodsSupported"];for(size_t i=0;i<methods.size();i++)if(methods[i].string()=="SHADOWMOUNT")return true;return false;
}
inline Json consoleById(const Json& consoles,const std::string& id){for(size_t i=0;i<consoles.size();i++)if(consoles[i]["id"].string()==id)return consoles[i];return consoles.size()==1?consoles[size_t(0)]:Json();}
inline std::string consoleSelectionAfterServerRefresh(const Json& consoles,const std::string& selectedId,const std::string& pairedId){
  for(size_t i=0;i<consoles.size();i++)if(consoles[i]["id"].string()==selectedId)return selectedId;
  for(size_t i=0;i<consoles.size();i++)if(consoles[i]["id"].string()==pairedId)return pairedId;
  return consoles.size()?consoles[size_t(0)]["id"].string():std::string();
}
inline bool selectedConsoleIsLocal(bool agentSeen,const Json& device,const Json& console){const auto id=device["consoleId"].string();return agentSeen&&!id.empty()&&console["id"].string()==id;}
inline Json withLocalConsoleState(Json console,const Json& snapshot,bool active,const std::string& localId){if(!active||console["id"].string()!=localId)return console;for(const auto* key:{"firmware","runtime","runtimeStatus","storage","storageFormat","capabilities"})console.set(key,snapshot[key]);return console;}
inline std::string consoleSelectionAfterLocalSnapshot(const Json& consoles,const std::string& selectedId,const std::string& previousLocalId,const std::string& observedLocalId){
  if(observedLocalId.empty())return selectedId;bool selectedExists=false;for(size_t i=0;i<consoles.size();i++)selectedExists|=consoles[i]["id"].string()==selectedId;
  return selectedId.empty()||selectedId==previousLocalId||!selectedExists?observedLocalId:selectedId;
}
inline Json withObservedLocalConsole(Json consoles,const Json& snapshot,const std::string& previousLocalId,const std::string& observedLocalId,const std::string& consoleName){
  if(observedLocalId.empty())return consoles;if(!consoles.isArray())consoles=Json::array();size_t index=consoles.size();
  for(size_t i=0;i<consoles.size();i++)if(consoles[i]["id"].string()==observedLocalId){index=i;break;}
  if(index==consoles.size()&&!previousLocalId.empty())for(size_t i=0;i<consoles.size();i++)if(consoles[i]["id"].string()==previousLocalId){index=i;break;}
  Json console;if(index<consoles.size())console=consoles[index];else{console=Json::object();consoles.add(console);}console.set("id",observedLocalId);if(console["name"].string().empty())console.set("name",consoleName);console.set("presence","LOCAL");
  for(const auto* key:{"firmware","runtime","runtimeStatus","storage","storageFormat","capabilities"})console.set(key,snapshot[key]);int64_t games=0;for(size_t i=0;i<snapshot["inventory"].size();i++)games+=snapshot["inventory"][i]["available"].boolean();console.set("games",games);return consoles;
}
inline Json withLocalInventory(Json library,const Json& inventory){
  for(size_t i=0;i<library.size();i++){
    Json local;for(size_t n=0;n<inventory.size();n++){
      const auto release=library[i]["releaseId"].string(),candidate=inventory[n]["releaseId"].string();
      const bool sameRelease=!release.empty()&&release==candidate;
      const bool sameTitle=library[i]["titleId"].string()==inventory[n]["titleId"].string()&&library[i]["version"].string()==inventory[n]["version"].string();
      if((sameRelease||sameTitle)&&(local.null()||inventory[n]["available"].boolean()))local=inventory[n];
    }
    if(local.null())continue;
    for(const auto* key:{"storageId","relativePath","source","method","contentId","registered","nativeRegistered","registrationBlocked","canDelete","canMove"})if(!local[key].null())library[i].set(key,local[key]);
    library[i].set("state",local["available"].boolean()?"READY_ON_PS5":"MISSING");
  }
  return library;
}
inline Json localEnvelope(Json value){if(!value["snapshot"].null())return value;if(!value["inventory"].null())return Json::object({{"snapshot",value},{"device",Json::object()}});throw std::runtime_error("Invalid local agent snapshot");}
inline Json localIdentity(Json identity,const std::string& currentConsoleId){if(identity.null())identity=Json::object();if(identity["consoleId"].string().empty())identity.set("consoleId",currentConsoleId.empty()?"local-console":currentConsoleId);return identity;}
inline Json localModel(const Json& cached,const Json& snapshot,const Json& device,const std::string& consoleName){
  auto result=cached.null()?Json::object():cached.deepCopy();auto catalog=result["catalog"].null()?Json::array():result["catalog"].deepCopy();auto library=Json::array(),consoleGames=Json::array();std::set<std::string> gameIds;
  auto inventory=snapshot["inventory"];for(size_t i=0;i<inventory.size();i++){
    auto item=inventory[i];if(!item["available"].boolean())continue;const auto titleId=item["titleId"].string(),version=item["version"].string("01.00");if(!validTitleId(titleId))continue;
    Json game;for(size_t n=0;n<catalog.size();n++)if(catalog[n]["titleId"].string()==titleId){game=catalog[n];break;}
    auto releaseId=item["releaseId"].string();if(!game.null()){
      auto releases=game["releases"];bool found=false;for(size_t n=0;n<releases.size();n++)if((!releaseId.empty()&&releases[n]["id"].string()==releaseId)||(releaseId.empty()&&releases[n]["kind"].string()!="DLC"&&releases[n]["version"].string()==version)){releaseId=releases[n]["id"].string();found=true;break;}
      if(!found){releaseId="local-"+titleId+"-"+std::to_string(i);releases.add(Json::object({{"id",releaseId},{"kind","BASE"},{"version",version},{"size",item["size"]},{"sources",Json::array()},{"artifacts",Json::array()}}));game.set("releases",releases);}
    }else{
      releaseId="local-"+titleId+"-"+std::to_string(i);auto releases=Json::array();releases.add(Json::object({{"id",releaseId},{"kind","BASE"},{"version",version},{"size",item["size"]},{"sources",Json::array()},{"artifacts",Json::array()}}));game=Json::object({{"id","local-"+titleId},{"title",item["title"].string(titleId)},{"titleId",titleId},{"platform",titleId.rfind("PPSA",0)==0?"PS5":"PS4"},{"description","Discovered on this PS5."},{"genres",Json::array()},{"releases",releases}});catalog.add(game);
    }
    auto media=item["localMedia"];if(!media["cover"]["url"].string().empty()){game.set("coverUrl",media["cover"]["url"]);game.set("coverCrop",Json());}if(!media["hero"]["url"].string().empty()){game.set("heroUrl",media["hero"]["url"]);game.set("heroCrop",Json());}if(!media["music"]["url"].string().empty())game.set("music",media["music"]);
    auto entry=item.deepCopy();entry.set("releaseId",releaseId);entry.set("state","READY_ON_PS5");library.add(entry);if(gameIds.insert(game["id"].string()).second)consoleGames.add(Json::object({{"gameId",game["id"]},{"available",true}}));
  }
  auto status=result["status"].null()?Json::object():result["status"].deepCopy();const auto consoleId=device["consoleId"].string("local-console");status.set("id",consoleId);status.set("name",consoleName);for(const auto* key:{"firmware","runtime","runtimeStatus","storage","storageFormat","capabilities"})status.set(key,snapshot[key]);status.set("library",library);
  auto localConsole=Json::object({{"id",consoleId},{"name",consoleName},{"presence","LOCAL"},{"firmware",snapshot["firmware"]},{"runtime",snapshot["runtime"]},{"runtimeStatus",snapshot["runtimeStatus"]},{"storage",snapshot["storage"]},{"storageFormat",snapshot["storageFormat"]},{"capabilities",snapshot["capabilities"]},{"games",static_cast<int64_t>(gameIds.size())},{"isDefault",true}});auto consoles=Json::array();consoles.add(localConsole);
  auto profile=result["profile"].null()?Json::object({{"username","Local profile"}}):result["profile"].deepCopy();auto profileConsole=localConsole.deepCopy();profileConsole.set("games",consoleGames);profileConsole.set("saveData",snapshot["saveData"]["items"]);profileConsole.set("trophySummary",snapshot["trophySummary"]);auto profileConsoles=Json::array();profileConsoles.add(profileConsole);profile.set("consoles",profileConsoles);
  result.set("catalog",catalog);result.set("library",library);result.set("status",status);result.set("consoles",consoles);result.set("profile",profile);result.set("device",device);if(result["jobs"].null())result.set("jobs",Json::array());return result;
}
inline Json withObservedLocalInventory(Json model,const Json& snapshot,const Json& device,const std::string& consoleName){
  auto observed=localModel(model,snapshot,device,consoleName),library=model["library"].null()?Json::array():model["library"].deepCopy();library=withLocalInventory(library,snapshot["inventory"]);
  auto local=observed["library"];for(size_t i=0;i<local.size();i++){bool found=false;for(size_t n=0;n<library.size();n++){const auto release=local[i]["releaseId"].string();found|=(!release.empty()&&release==library[n]["releaseId"].string())||(local[i]["titleId"].string()==library[n]["titleId"].string()&&local[i]["version"].string()==library[n]["version"].string());}if(!found)library.add(local[i]);}
  model.set("catalog",observed["catalog"]);model.set("library",library);return model;
}
}
