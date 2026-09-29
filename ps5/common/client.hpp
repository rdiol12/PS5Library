#pragma once
#include "json.hpp"
#include <curl/curl.h>
#include <filesystem>
#include <functional>
#include <mutex>
#include <string>
#include <string_view>
#include <unordered_map>

namespace ps5library {
inline constexpr uint16_t localAgentPort=37951;
inline constexpr uint16_t nativeUpdateBridgePort=37952;
inline constexpr const char* localAgentCredential="ps5library-local-v1";
inline constexpr const char* localAgentFrontendSocket="/download0/ps5library/agent.sock";
inline std::string localHex(std::string_view value){static constexpr char digits[]="0123456789abcdef";std::string result;result.reserve(value.size()*2);for(unsigned char c:value){result+=digits[c>>4];result+=digits[c&15];}return result;}
namespace fs = std::filesystem;
class RequestError:public std::runtime_error {public:long status;RequestError(long code,const std::string& message):std::runtime_error(message),status(code){}};
class PairingResetRequired:public std::runtime_error {public:PairingResetRequired():std::runtime_error("Pair this console again to use these connection settings") {}};
Json readJson(const fs::path& filename);
Json readConfig(const fs::path& filename);
std::string normalizeServerUrl(const std::string& value,bool allowHttp=false);
Json saveServerSettings(const fs::path& configPath,const std::string& url,bool allowHttp,bool resetPairing=false);
Json loadDeviceState(const fs::path& configPath,const Json& config);
Json pairFrontend(const fs::path& configPath,const Json& config,const std::function<bool()>& cancelled={});
std::string localAgentAddress();
std::string localAgentUrl();
Json localAgentRequest(const std::string& method,const std::string& path,uint16_t port=localAgentPort,const fs::path& socketPath={});
void atomicBytes(const fs::path& filename,std::string_view value);
void atomicJson(const fs::path& filename,const Json& value);
std::string randomHex(size_t bytes);
std::string fileHash(const fs::path& filename,const std::function<bool()>& cancelled={});
std::string deviceId();
std::string firmwareVersion(uint32_t raw);
std::string registrationFirmware(uint32_t systemVersion,uint32_t libraryVersion);
unsigned shadowMountPort(const std::string& config);
bool shadowMountSupported(const Json& version);
bool shadowMountPkgBackportSupported(const Json& version);
bool shadowMountDeletionSupported(const Json& version);
bool shadowMountMoveSupported(const Json& version);
bool shadowMountRefreshDue(int64_t checkedMs,int64_t nowMs,bool supported);
std::string discoveredStorageName(const std::string& path,const std::string& device,const std::string& type);
bool ps5ManagedUsbStorage(const std::string& path,const std::string& device,const std::string& type);
bool exactStorageMount(const std::string& path,const std::string& mountedAt);
Json shadowMountRequest(unsigned port,const std::string& route,const Json& body=Json::object(),const std::function<bool()>& cancelled={});
Json shadowMountScanRoots(const Json& settings,const Json& version);
bool verifyBackport(const fs::path& folder,const Json& backport);
Json prepareBackport(class Client& client,const fs::path& root,const Json& scanRoots,const Json& task,const std::function<void(int64_t,int64_t)>& progress);
bool nativeDownloadsAvailable();
bool nativeUpdateBridgeAvailable();
void setNativeUpdateBridgeAvailable(bool available);
std::mutex& nativeApiMutex();
bool nativeMovesAvailable();
class NativeSubmissionRejected final:public std::runtime_error {public:using std::runtime_error::runtime_error;};
enum class NativeSubmissionDecision { Submit, Monitor, Uncertain };
NativeSubmissionDecision inspectNativeSubmission(const fs::path& marker,const std::string& sha256,const std::string& serverUrl,const std::string& consoleId,bool resetRequested);
void beginNativeSubmission(const fs::path& marker,const std::string& sha256,const std::string& serverUrl,const std::string& consoleId);
void acceptNativeSubmission(const fs::path& marker,const std::string& sha256,const std::string& serverUrl,const std::string& consoleId);
void resetNativeSubmission(const fs::path& marker);
void submitNativeDownload(const fs::path& marker,const std::string& sha256,const std::string& serverUrl,const std::string& consoleId,const std::string& url,const std::string& contentId,const std::string& title,const std::string& iconUrl);
void startNativeDownload(const std::string& url,const std::string& contentId,const std::string& title,const std::string& iconUrl);
Json nativeDownloadStatus(const std::string& contentId);
fs::path installedNativePackage(const std::string& titleId,const fs::path& storageRoot="/user");
bool sameStorageDevice(const fs::path& path,const fs::path& storageRoot);
bool nativePackageRegistered(const Json& task);
void uninstallNativeTitle(const std::string& titleId);
int nativeMoveStorageType(const std::string& path,const std::string& device,const std::string& filesystem);
int nativeTitleStorageType(const std::string& titleId,const std::string& contentId);
int nativeMoveState();
bool nativeMoveTargetAvailable(const Json& volumes,int sourceStorageType);
fs::path observedNativePackage(const Json& installed,const Json& volumes);
bool verifiedReceiptFile(const fs::path& file,const Json& receipt,std::unordered_map<std::string,std::pair<fs::file_time_type,std::string>>& cache,const std::function<bool()>& cancelled);
Json nativeMoveTitle(const std::string& titleId,const std::string& contentId,int sourceStorageType,int destinationStorageType);
void cancelNativeMove();
fs::path beneath(const fs::path& root,const std::string& relative);
bool notify(const std::string& message,const std::string& title="PS5Library");
std::string notificationPayload(const std::string& message,const std::string& createdAt,const std::string& id,const std::string& icon,const std::string& title="PS5Library");
Json readTrophySummary(const fs::path& userRoot,const std::string& localUserId);
Json readSaveData(const fs::path& ps4Database,const fs::path& ps5Database,const std::string& localUserId);
Json buildSaveBackup(const fs::path& userHome,const Json& task,const fs::path& output);
Json buildPortableSaveArchive(const fs::path& plaintextRoot,const Json& task,const fs::path& output,const fs::path& bindingMetadata={});
void applyPortableSaveArchive(const fs::path& archive,const fs::path& plaintextRoot,const fs::path& bindingMetadata={});
bool portableSaveAvailable();
Json inspectPs4Package(const fs::path& file);
Json inspectPs5Installed(const fs::path& database,const fs::path& appmetaRoot,const fs::path& appRoot);
bool sameInventoryRelease(const Json& receipt,const Json& installed);
std::string remotePlayAccountId(uint64_t value);
std::string remotePlayPin(uint32_t value);
bool remotePlayAvailable();
Json beginRemotePlayPairing(unsigned userId);
Json pollRemotePlayPairing();
void cancelRemotePlayPairing();
class Client {
  std::string base_, ca_,unixSocket_;
  bool insecure_;
public:
  struct ImageResponse { std::string data,etag; bool unchanged=false; };
  std::string credential;
  std::function<bool()> cancelled;
  explicit Client(const Json& config,const fs::path& unixSocket={});
  CURL* handle(const std::string& relative) const;
  std::string nativeDownloadUrl(const std::string& relative) const;
  std::string nativeUpdateUrl(const std::string& relative) const;
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
  bool externalFpkg_=false;
  Json shadowMount_;
  Json shadowMountRoots_;
  Json shadowMountGames_;
  Json heartbeatBody_;
  int64_t shadowMountCheckedMs_=0;
  unsigned shadowMountPort_=0;
  std::string detectedRuntime_;
  std::string remotePlayRequest_;
  Json remotePlayMaterial_;
  bool notifications() const {
#ifdef PS5
    return true;
#else
    return config_["nativeNotifications"].boolean();
#endif
  }
  Json runtimeStatus();
  std::string localUserId();
  Json trophies();
  Json saves();
  void saveBackups();
  void saveExports();
  void saveImports();
  void removals();
  void remotePlayPairing();
  void nativeDownload(const Json& task,const fs::path& receiptRoot,const fs::path& storageRoot);
  Json inventory(const Json& volumes);
public:
  Client client;
  explicit Agent(const fs::path& configPath);
  Json pair();
  bool paired() const { return !client.credential.empty(); }
  Json storage() const;
  Json inventory();
  Json discoverDumps(const Json& volumes);
  Json discoverInstalled(const Json& volumes);
  Json localSnapshot();
  Json localDelete(const std::string& titleId,const std::string& storageId);
  Json localMove(const std::string& titleId,const std::string& sourceStorageId,const std::string& storageId);
  Json nativeAppUpdate(const std::string& titleId,const std::string& baseContentVersion);
  Json heartbeat();
  Json tick();
  Json status() const { return state_; }
};
}
