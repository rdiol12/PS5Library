#pragma once
#include "json.hpp"
#include <curl/curl.h>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <functional>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <string_view>
#include <utility>
#include <unordered_map>

namespace ps5library {
inline constexpr uint16_t localAgentPort=37951;
inline constexpr uint16_t nativeUpdateBridgePort=37952;
inline constexpr uint16_t localCheatShellPort=37953;
inline constexpr uint16_t nativeDownloadRelayPort=37954;
inline constexpr const char* localAgentCredential="ps5library-local-v1";
inline constexpr const char* localAgentFrontendSocket="/download0/ps5library/agent.sock";
constexpr uint32_t localAgentRefreshDelay(bool connected){return connected?5000:250;}
inline std::string localHex(std::string_view value){static constexpr char digits[]="0123456789abcdef";std::string result;result.reserve(value.size()*2);for(unsigned char c:value){result+=digits[c>>4];result+=digits[c&15];}return result;}
inline std::string localAgentModePath(bool offline,bool allowHttp,std::string_view server,std::string_view fallback={}){auto path="/api/v1/agent/"+std::string(offline?"offline/":"connect/")+(allowHttp?"1/":"0/")+localHex(server);if(!fallback.empty())path+="/"+localHex(fallback);return path;}
namespace fs = std::filesystem;
class RequestError:public std::runtime_error {public:long status;RequestError(long code,const std::string& message):std::runtime_error(message),status(code){}};
class PairingResetRequired:public std::runtime_error {public:PairingResetRequired():std::runtime_error("Pair this console again to use these connection settings") {}};
Json readJson(const fs::path& filename,size_t limit=8*1024*1024);
std::optional<Json> readJsonIfPresent(const fs::path& filename,size_t limit=8*1024*1024);
Json readConfig(const fs::path& filename);
std::string normalizeServerUrl(const std::string& value,bool allowHttp=false);
std::string normalizeProxyUrl(const std::string& value);
long clientConnectTimeout(bool fallbackConfigured,bool fallbackAttempt);
Json saveServerSettings(const fs::path& configPath,const std::string& url,bool allowHttp,bool resetPairing=false,const std::string& fallbackUrl={});
Json loadDeviceState(const fs::path& configPath,const Json& config);
Json pairFrontend(const fs::path& configPath,const Json& config,const std::function<bool()>& cancelled={});
bool resetRejectedFrontendCredential(const fs::path& configPath,const std::string& rejectedCredential);
std::string localAgentAddress();
std::string localAgentUrl();
Json localAgentRequest(const std::string& method,const std::string& path,uint16_t port=localAgentPort,const fs::path& socketPath={},const std::string& sensitiveToken={},const std::string& approvalProfileId={},const std::string& bearer=localAgentCredential);
void atomicBytes(const fs::path& filename,std::string_view value);
void atomicJson(const fs::path& filename,const Json& value);
std::string randomHex(size_t bytes);
std::string fileHash(const fs::path& filename,const std::function<bool()>& cancelled={});
std::string deviceId();
std::string hardwareProofFromMaterial(const std::string& server,std::string_view material);
std::string consoleHardwareProof(const std::string& server);
std::string firmwareVersion(uint32_t raw);
std::string registrationFirmware(uint32_t systemVersion,uint32_t libraryVersion);
std::string inventoryFingerprint(const Json& items,bool complete);
constexpr int clampedHeartbeatInterval(int64_t seconds){return seconds<5?5:seconds>30?30:static_cast<int>(seconds);}
constexpr bool inventoryRefreshDue(bool cached,bool forced,int64_t ageSeconds){return forced||!cached||ageSeconds>=60;}
constexpr bool heartbeatIncludesInventory(bool scan,bool routineReady,bool revisionChanged){return !routineReady||(scan&&revisionChanged);}
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
void publishBackport(const fs::path& staging,const fs::path& destination,const fs::path& backup,bool managed,const std::function<bool(const fs::path&)>& verify);
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
void restoreNativeInstallTarget(const fs::path& marker);
void submitNativeDownload(const fs::path& marker,const std::string& sha256,const std::string& serverUrl,const std::string& consoleId,const std::string& url,const std::string& contentId,const std::string& title,const std::string& iconUrl,int storageType=-1);
void startNativeDownload(const std::string& url,const std::string& contentId,const std::string& title,const std::string& iconUrl);
Json nativeDownloadStatus(const std::string& contentId);
fs::path installedNativePackage(const std::string& titleId,const fs::path& storageRoot="/user");
bool sameStorageDevice(const fs::path& path,const fs::path& storageRoot);
bool nativePackageRegistered(const Json& task);
bool validateNativeUpdateBase(const Json& task,const Json& installed,int installedStorageType,int targetStorageType);
void uninstallNativeTitle(const std::string& titleId);
int nativeMoveStorageType(const std::string& path,const std::string& device,const std::string& filesystem);
int nativeTitleStorageType(const std::string& titleId,const std::string& contentId);
int nativeMoveState();
bool nativeMoveTargetAvailable(const Json& volumes,int sourceStorageType);
fs::path observedNativePackage(const Json& installed,const Json& volumes);
struct ReceiptFileState { bool present=false,checksumVerified=false; };
ReceiptFileState receiptFileState(const fs::path& file,const Json& receipt,const std::unordered_map<std::string,std::pair<fs::file_time_type,std::string>>& cache);
Json nativeMoveTitle(const std::string& titleId,const std::string& contentId,int sourceStorageType,int destinationStorageType,const fs::path& playGoBackupRoot="/data/ps5library/native-move-playgo",const fs::path& playGoRoot="/user/playgo/app");
void reconcileNativeMovePlayGo(const fs::path& playGoBackupRoot="/data/ps5library/native-move-playgo",const fs::path& playGoRoot="/user/playgo/app");
void startNativeMoveRecovery(const fs::path& playGoBackupRoot="/data/ps5library/native-move-playgo",const fs::path& playGoRoot="/user/playgo/app");
void cancelNativeMove();
fs::path beneath(const fs::path& root,const std::string& relative);
bool notify(const std::string& message,const std::string& title="PS5Library");
std::string notificationPayload(const std::string& message,const std::string& createdAt,const std::string& id,const std::string& icon,const std::string& title="PS5Library");
Json readTrophySummary(const fs::path& userRoot,const std::string& localUserId);
Json readSaveData(const fs::path& ps4Database,const fs::path& ps5Database,const std::string& localUserId);
Json buildSaveBackup(const fs::path& userHome,const Json& task,const fs::path& output);
Json buildPortableSaveArchive(const fs::path& plaintextRoot,const Json& task,const fs::path& output,const fs::path& bindingMetadata={});
void applyPortableSaveArchive(const fs::path& archive,const fs::path& plaintextRoot,const fs::path& bindingMetadata={});
bool saveTaskMatchesUser(const Json& task,const std::string& localUserId);
bool portableSaveAvailable();
Json inspectPs4Package(const fs::path& file);
Json inspectPs5Installed(const fs::path& database,const fs::path& appmetaRoot,const fs::path& appRoot);
bool sameInventoryRelease(const Json& receipt,const Json& installed);
bool availableFpkgReceipt(const Json& receipt);
std::string remotePlayAccountId(uint64_t value);
std::string remotePlayPin(uint32_t value);
bool remotePlayAvailable();
Json beginRemotePlayPairing(unsigned userId);
Json pollRemotePlayPairing();
void cancelRemotePlayPairing();
class NativeDownloadRelay;
class Client {
  std::string base_,fallback_,proxy_,fallbackProxy_,ca_,unixSocket_;
  bool insecure_;
  mutable std::atomic<bool> fallbackActive_{false};
  friend class NativeDownloadRelay;
public:
  struct ImageResponse { std::string data,etag; bool unchanged=false; };
  std::string credential;
  std::function<bool()> cancelled;
  explicit Client(const Json& config,const fs::path& unixSocket={});
  CURL* handle(const std::string& relative,bool fallback=false,bool ignoreCancelled=false) const;
  bool nativeDownloadRelayRequired() const;
  std::string nativeDownloadUrl(const std::string& relative) const;
  std::string nativeUpdateUrl(const std::string& relative) const;
  std::string bytes(const std::string& relative) const;
  ImageResponse artwork(const std::string& relative,const std::string& etag,const std::function<bool()>& cancelled) const;
  Json request(const std::string& method,const std::string& relative,const Json& body=Json()) const;
  Json uploadLaunchTrace(const fs::path& filename) const;
  void download(const std::string& relative,const fs::path& part,int64_t expectedSize,const std::string& expectedHash,const std::function<void(int64_t,int64_t)>& progress) const;
};
class NativeDownloadRelay {
  struct Impl;std::unique_ptr<Impl> impl_;
public:
  explicit NativeDownloadRelay(Client& client,uint16_t port=nativeDownloadRelayPort);
  ~NativeDownloadRelay();
  NativeDownloadRelay(const NativeDownloadRelay&)=delete;
  NativeDownloadRelay& operator=(const NativeDownloadRelay&)=delete;
  std::pair<std::string,std::string> pin(const std::string& packagePath,const std::string& iconPath={});
};
class CheatService;
class Agent {
  Json config_, state_;
  fs::path statePath_;
  std::unique_ptr<CheatService> cheats_;
  std::unordered_map<std::string,std::pair<fs::file_time_type,std::string>> verified_;
  bool inventoryComplete_=true;
  bool externalFpkg_=false;
  Json shadowMount_;
  Json shadowMountRoots_;
  Json shadowMountGames_;
  Json heartbeatBody_;
  Json heartbeatSnapshot_;
  std::chrono::steady_clock::time_point inventoryScannedAt_{};
  int heartbeatIntervalSeconds_=10;
  int64_t shadowMountCheckedMs_=0;
  unsigned shadowMountPort_=0;
  std::string detectedRuntime_;
  std::string hardwareProof_;
  bool hardwareEnrollmentChecked_=false;
  std::unique_ptr<NativeDownloadRelay> nativeRelay_;
  std::string nativeRelayTask_;
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
  void syncCheats();
  void nativeDownload(const Json& task,const fs::path& receiptRoot,const fs::path& storageRoot);
  Json inventory(const Json& volumes);
public:
  Client client;
  explicit Agent(const fs::path& configPath,bool externalFpkg=false);
  ~Agent();
  Json pair();
  const std::string& hardwareProof() const {return hardwareProof_;}
  bool paired() const { return !client.credential.empty(); }
  Json storage() const;
  Json inventory();
  Json discoverDumps(const Json& volumes);
  Json discoverInstalled(const Json& volumes);
  Json localSnapshot();
  Json localDelete(const std::string& titleId,const std::string& storageId);
  Json localMove(const std::string& titleId,const std::string& sourceStorageId,const std::string& storageId);
  Json localCheats();
  Json localCheatEnable(const std::string& profileId,const std::string& entryId,bool explicitApproval=false);
  Json localCheatDisable(const std::string& profileId,const std::string& entryId);
  Json localMemoryScanTarget();
  Json localMemoryScanStart(const std::string& titleId,const std::string& version,const std::string& type,const std::string& mode,const std::string& value={});
  Json localMemoryScanRefine(const std::string& scanId,const std::string& mode,const std::string& value={});
  Json localMemoryScanWatch(const std::string& scanId);
  Json localMemoryScanWrite(const std::string& scanId,const std::string& resultId,const std::string& value,bool freeze=false);
  Json localMemoryScanRestore(const std::string& scanId,const std::string& resultId);
  std::size_t localMemoryScanRestoreAll();
  void localMemoryScanClear();
  void localCheatReconcile();
  Json nativeAppUpdate(const std::string& titleId,const std::string& baseContentVersion);
  Json heartbeat(bool forceInventory=false);
  Json tick();
  int heartbeatIntervalSeconds() const {return heartbeatIntervalSeconds_;}
  void invalidateSnapshot() {inventoryScannedAt_={};}
  Json status() const { return state_; }
};
}
