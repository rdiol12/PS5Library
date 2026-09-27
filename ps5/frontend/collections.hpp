#pragma once
#include "../common/json.hpp"
#include <algorithm>
#include <cstdint>
#include <regex>
#include <set>
#include <vector>
namespace storefront {
inline std::string releaseLabel(const Json& release){return release["kind"].string()=="DLC"?"DLC: "+release["title"].string("Additional content")+" / "+release["version"].string():(release["kind"].string()=="UPDATE"?"Update / ":"Base game / ")+release["version"].string();}
inline bool serverReady(const Json& game){auto releases=game["releases"];for(size_t i=0;i<releases.size();i++)if(releases[i]["kind"].string()!="DLC"&&releases[i]["artifacts"].size())return true;return false;}
inline std::vector<Json> recentlyAdded(std::vector<Json> games,size_t limit=4){
  games.erase(std::remove_if(games.begin(),games.end(),[](const Json& g){auto releases=g["releases"];for(size_t i=0;i<releases.size();i++)if(releases[i]["sources"].size())return false;return true;}),games.end());
  std::stable_sort(games.begin(),games.end(),[](const Json& a,const Json& b){return a["addedAt"].string()>b["addedAt"].string();});if(games.size()>limit)games.resize(limit);return games;
}
inline bool releaseReady(const Json& release,const Json& library){for(size_t i=0;i<library.size();i++)if(release["kind"].string()!="DLC"&&library[i]["releaseId"].string()==release["id"].string()&&library[i]["state"].string()=="READY_ON_PS5")return true;return false;}
inline std::string launchableRelease(const Json& game,const Json& release,const Json& library){
  static const std::regex titleId("(PPSA|CUSA)[0-9]{5}");const auto id=game["titleId"].string();if(!std::regex_match(id,titleId)||!releaseReady(release,library))return {};
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
inline bool offlinePageEnabled(const std::string& page){return page!="Discover"&&page!="New Releases"&&page!="Categories";}
inline bool landingPage(const std::string& page,bool offline){return page==(offline?"My Library":"Discover");}
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
    return from>=0&&from<=2&&to>=0&&to<=2&&from!=to;
  }
  auto methods=destination["installMethodsSupported"];for(size_t i=0;i<methods.size();i++)if(methods[i].string()=="SHADOWMOUNT")return true;return false;
}
inline Json consoleById(const Json& consoles,const std::string& id){for(size_t i=0;i<consoles.size();i++)if(consoles[i]["id"].string()==id)return consoles[i];return consoles.size()==1?consoles[size_t(0)]:Json();}
inline Json withLocalConsoleState(Json console,const Json& snapshot,bool active,const std::string& localId){if(!active||console["id"].string()!=localId)return console;for(const auto* key:{"firmware","runtime","runtimeStatus","storage","storageFormat","capabilities"})console.set(key,snapshot[key]);return console;}
inline Json localEnvelope(Json value){if(!value["snapshot"].null())return value;if(!value["inventory"].null())return Json::object({{"snapshot",value},{"device",Json::object()}});throw std::runtime_error("Invalid local agent snapshot");}
inline Json localIdentity(Json identity,const std::string& currentConsoleId){if(identity.null())identity=Json::object();if(identity["consoleId"].string().empty())identity.set("consoleId",currentConsoleId.empty()?"local-console":currentConsoleId);return identity;}
inline Json localModel(const Json& cached,const Json& snapshot,const Json& device,const std::string& consoleName){
  auto result=cached.null()?Json::object():Json::parse(cached.dump());auto catalog=result["catalog"].null()?Json::array():Json::parse(result["catalog"].dump());auto library=Json::array(),consoleGames=Json::array();std::set<std::string> gameIds;
  auto inventory=snapshot["inventory"];for(size_t i=0;i<inventory.size();i++){
    auto item=inventory[i];if(!item["available"].boolean())continue;const auto titleId=item["titleId"].string(),version=item["version"].string("01.00");if(!std::regex_match(titleId,std::regex("(PPSA|CUSA)[0-9]{5}")))continue;
    Json game;for(size_t n=0;n<catalog.size();n++)if(catalog[n]["titleId"].string()==titleId){game=catalog[n];break;}
    auto releaseId=item["releaseId"].string();if(!game.null()){
      auto releases=game["releases"];bool found=false;for(size_t n=0;n<releases.size();n++)if((!releaseId.empty()&&releases[n]["id"].string()==releaseId)||(releaseId.empty()&&releases[n]["kind"].string()!="DLC"&&releases[n]["version"].string()==version)){releaseId=releases[n]["id"].string();found=true;break;}
      if(!found){releaseId="local-"+titleId+"-"+std::to_string(i);releases.add(Json::object({{"id",releaseId},{"kind","BASE"},{"version",version},{"size",item["size"]},{"sources",Json::array()},{"artifacts",Json::array()}}));game.set("releases",releases);}
    }else{
      releaseId="local-"+titleId+"-"+std::to_string(i);auto releases=Json::array();releases.add(Json::object({{"id",releaseId},{"kind","BASE"},{"version",version},{"size",item["size"]},{"sources",Json::array()},{"artifacts",Json::array()}}));game=Json::object({{"id","local-"+titleId},{"title",item["title"].string(titleId)},{"titleId",titleId},{"platform",titleId.rfind("PPSA",0)==0?"PS5":"PS4"},{"description","Discovered on this PS5."},{"genres",Json::array()},{"releases",releases}});catalog.add(game);
    }
    auto media=item["localMedia"];if(!media["cover"]["url"].string().empty()){game.set("coverUrl",media["cover"]["url"]);game.set("coverCrop",Json());}if(!media["hero"]["url"].string().empty()){game.set("heroUrl",media["hero"]["url"]);game.set("heroCrop",Json());}if(!media["music"]["url"].string().empty())game.set("music",media["music"]);
    auto entry=Json::parse(item.dump());entry.set("releaseId",releaseId);entry.set("state","READY_ON_PS5");library.add(entry);if(gameIds.insert(game["id"].string()).second)consoleGames.add(Json::object({{"gameId",game["id"]},{"available",true}}));
  }
  auto status=result["status"].null()?Json::object():Json::parse(result["status"].dump());const auto consoleId=device["consoleId"].string("local-console");status.set("id",consoleId);status.set("name",consoleName);for(const auto* key:{"firmware","runtime","runtimeStatus","storage","storageFormat","capabilities"})status.set(key,snapshot[key]);status.set("library",library);
  auto localConsole=Json::object({{"id",consoleId},{"name",consoleName},{"presence","LOCAL"},{"firmware",snapshot["firmware"]},{"runtime",snapshot["runtime"]},{"runtimeStatus",snapshot["runtimeStatus"]},{"storage",snapshot["storage"]},{"storageFormat",snapshot["storageFormat"]},{"capabilities",snapshot["capabilities"]},{"games",static_cast<int64_t>(gameIds.size())},{"isDefault",true}});auto consoles=Json::array();consoles.add(localConsole);
  auto profile=result["profile"].null()?Json::object({{"username","Local profile"}}):Json::parse(result["profile"].dump());auto profileConsole=Json::parse(localConsole.dump());profileConsole.set("games",consoleGames);profileConsole.set("saveData",snapshot["saveData"]["items"]);profileConsole.set("trophySummary",snapshot["trophySummary"]);auto profileConsoles=Json::array();profileConsoles.add(profileConsole);profile.set("consoles",profileConsoles);
  result.set("catalog",catalog);result.set("library",library);result.set("status",status);result.set("consoles",consoles);result.set("profile",profile);result.set("device",device);if(result["jobs"].null())result.set("jobs",Json::array());
  auto featured=result["featured"];const auto featuredId=featured["gameId"].string();bool present=false;for(size_t i=0;i<catalog.size();i++)present|=catalog[i]["id"].string()==featuredId;if(!present&&catalog.size())result.set("featured",Json::object({{"gameId",catalog[size_t(0)]["id"]}}));return result;
}
}
