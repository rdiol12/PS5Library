#pragma once
#include "json.hpp"
#include <curl/curl.h>
#include <filesystem>
#include <functional>
#include <string>
#include <string_view>
#include <unordered_map>

namespace ps5library {
namespace fs = std::filesystem;
class RequestError:public std::runtime_error {public:long status;RequestError(long code,const std::string& message):std::runtime_error(message),status(code){}};
class PairingResetRequired:public std::runtime_error {public:PairingResetRequired():std::runtime_error("Pair this console again to use these connection settings") {}};
Json readJson(const fs::path& filename);
Json readConfig(const fs::path& filename);
std::string normalizeServerUrl(const std::string& value,bool allowHttp=false);
Json saveServerSettings(const fs::path& configPath,const std::string& url,bool allowHttp,bool resetPairing=false);
Json loadDeviceState(const fs::path& configPath,const Json& config);
void atomicBytes(const fs::path& filename,std::string_view value);
void atomicJson(const fs::path& filename,const Json& value);
std::string randomHex(size_t bytes);
std::string fileHash(const fs::path& filename,const std::function<bool()>& cancelled={});
std::string deviceId();
std::string firmwareVersion(uint32_t raw);
fs::path beneath(const fs::path& root,const std::string& relative);
void notify(const std::string& message);
class Client {
  std::string base_, ca_;
  bool insecure_;
public:
  struct ImageResponse { std::string data,etag; bool unchanged=false; };
  std::string credential;
  std::function<bool()> cancelled;
  explicit Client(const Json& config);
  CURL* handle(const std::string& relative) const;
  std::string bytes(const std::string& relative) const;
  ImageResponse artwork(const std::string& relative,const std::string& etag,const std::function<bool()>& cancelled) const;
  Json request(const std::string& method,const std::string& relative,const Json& body=Json()) const;
  void download(const std::string& relative,const fs::path& part,int64_t expectedSize,const std::string& expectedHash,const std::function<void(int64_t,int64_t)>& progress) const;
};
class Agent {
  Json config_, state_;
  fs::path statePath_;
  std::unordered_map<std::string,std::pair<fs::file_time_type,std::string>> verified_;
public:
  Client client;
  explicit Agent(const fs::path& configPath);
  Json pair();
  bool paired() const { return !client.credential.empty(); }
  Json storage() const;
  Json inventory();
  void heartbeat();
  void tick();
  Json status() const { return state_; }
};
}
