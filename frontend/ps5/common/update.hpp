#pragma once
#include "client.hpp"
#include "version.hpp"
namespace ps5library {
const char* updatePublicKey();
Json verifyUpdate(const Json& envelope,const std::string& trustedKey,int64_t minimumBuild);
fs::path downloadUpdate(Client& client,const fs::path& root,const Json& manifest,const std::function<void(int64_t,int64_t)>& progress);
void loaderRequest(const std::string& launcherUrl,const std::string& query);
}
