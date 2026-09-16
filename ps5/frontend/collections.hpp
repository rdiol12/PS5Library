#pragma once
#include "../common/json.hpp"
#include <algorithm>
#include <regex>
#include <vector>
namespace storefront {
inline std::string releaseLabel(const Json& release){return release["kind"].string()=="DLC"?"DLC: "+release["title"].string("Additional content")+" / "+release["version"].string():(release["kind"].string()=="UPDATE"?"Update / ":"Base game / ")+release["version"].string();}
inline bool serverReady(const Json& game){auto releases=game["releases"];for(size_t i=0;i<releases.size();i++)if(releases[i]["kind"].string()!="DLC"&&releases[i]["artifacts"].size())return true;return false;}
inline std::vector<Json> recentlyAdded(std::vector<Json> games,size_t limit=4){
  games.erase(std::remove_if(games.begin(),games.end(),[](const Json& g){auto releases=g["releases"];for(size_t i=0;i<releases.size();i++)if(releases[i]["sources"].size())return false;return true;}),games.end());
  std::stable_sort(games.begin(),games.end(),[](const Json& a,const Json& b){return a["addedAt"].string()>b["addedAt"].string();});if(games.size()>limit)games.resize(limit);return games;
}
inline std::string launchableTitle(const Json& game,const Json& library){
  static const std::regex titleId("(PPSA|CUSA)[0-9]{5}");auto releases=game["releases"];const auto id=game["titleId"].string();if(!std::regex_match(id,titleId))return {};
  for(size_t r=0;r<releases.size();r++)for(size_t i=0;i<library.size();i++)if(releases[r]["kind"].string()!="DLC"&&library[i]["releaseId"].string()==releases[r]["id"].string()&&library[i]["state"].string()=="READY_ON_PS5"&&(library[i]["registered"].boolean()||library[i]["source"].string()=="INSTALLED_TITLE"))return id;
  return {};
}
}
