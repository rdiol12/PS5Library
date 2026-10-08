#pragma once
#include "../common/client.hpp"
namespace ps5library {
inline Json resetAgentState(const fs::path& agentConfig,const std::string& server=""){
  const auto path=agentConfig.parent_path()/"device-state.json";if(fs::is_symlink(path))throw std::runtime_error("Configuration symlinks are not allowed");Json previous;
  try{if(fs::is_regular_file(path)&&!fs::is_symlink(path))previous=readJson(path);}catch(...){ }
  auto state=Json::object({{"deviceId",deviceId()},{"serverUrl",server},{"libraryRevision",int64_t(0)}});
  if(!previous["firmware"].null())state.set("firmware",previous["firmware"]);
  if(!previous["firmwareChecked"].null())state.set("firmwareChecked",previous["firmwareChecked"]);
  atomicJson(path,state);return state;
}
inline Json disconnectAgentConfig(const fs::path& agentConfig){
  if(fs::is_symlink(agentConfig))throw std::runtime_error("Configuration symlinks are not allowed");
  auto config=readConfig(agentConfig);const auto state=agentConfig.parent_path()/"device-state.json";
  bool connected=!config["serverUrl"].string().empty();
  try{if(fs::is_regular_file(state)){auto saved=readJson(state);connected=connected||!saved["serverUrl"].string().empty()||!saved["credential"].string().empty()||!saved["consoleId"].string().empty()||!saved["pairing"].null();}}catch(...){connected=true;}
  config.set("serverUrl","");config.set("fallbackServerUrl","");config.set("serverProxyUrl","");config.set("fallbackProxyUrl","");config.set("allowInsecureLan",false);atomicJson(agentConfig,config);if(connected||!fs::is_regular_file(state))resetAgentState(agentConfig);return config;
}
inline Json connectAgentConfig(const fs::path& agentConfig,const std::string& input,bool allowHttp,const std::string& fallbackInput={}){
  if(fs::is_symlink(agentConfig))throw std::runtime_error("Configuration symlinks are not allowed");
  const auto server=normalizeServerUrl(input,allowHttp);auto fallback=fallbackInput.empty()?std::string():normalizeServerUrl(fallbackInput,allowHttp);if(fallback==server)fallback.clear();auto config=readConfig(agentConfig);bool changed=true;
  try{changed=normalizeServerUrl(config["serverUrl"].string(),config["allowInsecureLan"].boolean())!=server;}catch(...){ }
  config.set("serverUrl",server);config.set("fallbackServerUrl",fallback);config.set("allowInsecureLan",allowHttp);config.set("caBundle",(agentConfig.parent_path()/"ca-bundle.crt").string());atomicJson(agentConfig,config);
  if(changed)resetAgentState(agentConfig,server);return config;
}
inline Json bootstrapAgentConfig(const fs::path& agentConfig,const fs::path& frontendConfig){
  if(fs::is_symlink(agentConfig)||fs::is_symlink(frontendConfig))throw std::runtime_error("Configuration symlinks are not allowed");
  if(!fs::is_regular_file(frontendConfig)){auto config=readConfig(agentConfig);if(!fs::is_regular_file(agentConfig))atomicJson(agentConfig,config);return config;}
  auto source=readConfig(frontendConfig);if(source["serverUrl"].string().empty())return disconnectAgentConfig(agentConfig);
  auto config=connectAgentConfig(agentConfig,source["serverUrl"].string(),source["allowInsecureLan"].boolean(),source["fallbackServerUrl"].string());config.set("serverProxyUrl",normalizeProxyUrl(source["serverProxyUrl"].string()));config.set("fallbackProxyUrl",normalizeProxyUrl(source["fallbackProxyUrl"].string()));if(!source["name"].string().empty())config.set("name",source["name"]);atomicJson(agentConfig,config);return config;
}
}
