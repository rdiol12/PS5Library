#pragma once
#include "../common/client.hpp"
namespace ps5library {
inline Json bootstrapAgentConfig(const fs::path& agentConfig,const fs::path& frontendConfig){
  if(fs::is_symlink(agentConfig)||fs::is_symlink(frontendConfig))throw std::runtime_error("Configuration symlinks are not allowed");
  if(fs::exists(agentConfig))return readConfig(agentConfig);
  if(!fs::is_regular_file(frontendConfig))throw std::runtime_error("Open PS5Library and save its server address before starting the agent");
  auto source=readConfig(frontendConfig),config=readConfig(agentConfig);
  config.set("serverUrl",normalizeServerUrl(source["serverUrl"].string(),source["allowInsecureLan"].boolean()));
  config.set("allowInsecureLan",source["allowInsecureLan"].boolean());
  if(!source["name"].string().empty())config.set("name",source["name"]);
  config.set("caBundle",(frontendConfig.parent_path()/"ca-bundle.crt").string());
  atomicJson(agentConfig,config);return config;
}
}
