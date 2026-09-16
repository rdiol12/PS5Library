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
std::string registrationFirmware(uint32_t systemVersion,uint32_t libraryVersion);
unsigned shadowMountPort(const std::string& config);
bool shadowMountSupported(const Json& version);
bool shadowMountDeletionSupported(const Json& version);
Json shadowMountRequest(unsigned port,const std::string& route,const Json& body=Json::object(),const std::function<bool()>& cancelled={});
Json shadowMountScanRoots(const Json& settings,const Json& version);
bool verifyBackport(const fs::path& folder,const Json& backport);
Json prepareBackport(class Client& client,const fs::path& root,const Json& scanRoots,const Json& task,const std::function<void(int64_t,int64_t)>& progress);
bool nativeDownloadsAvailable();
void startNativeDownload(const std::string& url,const std::string& contentId,const std::string& title);
fs::path installedNativePackage(const std::string& titleId);
bool nativePackageRegistered(const Json& task);
fs::path beneath(const fs::path& root,const std::string& relative);
void notify(const std::string& message);
Json readTrophySummary(const fs::path& userRoot,const std::string& localUserId);
Json inspectPs4Package(const fs::path& file);
class Client {
  std::string base_, ca_;
  bool insecure_;
public:
  struct ImageResponse { std::string data,etag; bool unchanged=false; };
  std::string credential;
  std::function<bool()> cancelled;
  explicit Client(const Json& config);
  CURL* handle(const std::string& relative) const;
  std::string nativeDownloadUrl(const std::string& relative) const;
  std::string bytes(const std::string& relative) const;
  ImageResponse artwork(const std::string& relative,const std::string& etag,const std::function<bool()>& cancelled) const;
  Json request(const std::string& method,const std::string& relative,const Json& body=Json()) const;
  void download(const std::string& relative,const fs::path& part,int64_t expectedSize,const std::string& expectedHash,const std::function<void(int64_t,int64_t)>& progress) const;
};
class Agent {
  Json config_, state_;
  fs::path statePath_;
  std::unordered_map<std::string,std::pair<fs::file_time_type,std::string>> verified_;
  bool inventoryComplete_=true;
  Json shadowMount_;
  Json shadowMountRoots_;
  Json heartbeatBody_;
  unsigned shadowMountPort_=0;
  std::string detectedRuntime_;
  Json runtimeStatus();
  void syncArtwork(const Json& items);
  Json trophies();
  void removals();
  void nativeDownload(const Json& task,const fs::path& receiptRoot);
public:
  Client client;
  explicit Agent(const fs::path& configPath);
  Json pair();
  bool paired() const { return !client.credential.empty(); }
  Json storage() const;
  Json inventory();
  Json discoverDumps(const Json& volumes);
  Json discoverInstalled(const Json& volumes);
  void heartbeat();
  void tick();
  Json status() const { return state_; }
};
}
