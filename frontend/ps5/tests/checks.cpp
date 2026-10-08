#include "../common/client.hpp"
#include "../common/version.hpp"
#include "../agent/config.hpp"
#include "../agent/cheats.hpp"
#include "../agent/local.hpp"
#include "../agent/launch_trace.hpp"
#include "../frontend/collections.hpp"
#include <cassert>
#include <atomic>
#include <cstring>
#include <thread>
#include <fstream>
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
#ifndef PS5
static std::atomic<int> curlInitializations{0};
static std::atomic<int> activeTransfers{0},maximumTransfers{0};
static std::atomic<bool> passthroughCurl{false};
extern "C" CURLcode __real_curl_global_init(long);
extern "C" CURLcode __wrap_curl_global_init(long flags){curlInitializations++;return __real_curl_global_init(flags);}
extern "C" CURLcode __real_curl_easy_perform(CURL*);
extern "C" CURLcode __wrap_curl_easy_perform(CURL* curl){if(passthroughCurl)return __real_curl_easy_perform(curl);auto active=++activeTransfers;auto maximum=maximumTransfers.load();while(active>maximum&&!maximumTransfers.compare_exchange_weak(maximum,active)){}std::this_thread::sleep_for(std::chrono::milliseconds(30));--activeTransfers;return CURLE_COULDNT_CONNECT;}
#endif
int main() {
  std::string hardwareBytes;for(int i=0;i<16;i++)hardwareBytes.push_back(static_cast<char>(i));
  assert(ps5library::hardwareProofFromMaterial("https://ONE.example:443/",hardwareBytes)=="19b191b03c95437d79a9b5a2edd70a7afe25829044ff456e9e8d4c862717a7f3");
  assert(ps5library::hardwareProofFromMaterial("https://two.example",hardwareBytes)!=ps5library::hardwareProofFromMaterial("https://one.example",hardwareBytes));
  // Complete top-level values need an end-of-input marker for json-c.
  assert(Json::parse("null").null());
  assert(Json::parse("true").boolean());
  assert(Json::parse("42").number()==42);
  auto notification=Json::parse(ps5library::notificationPayload("OpenStory download started.", "2026-09-23T10:00:00.000Z", "test-id", "/user/appmeta/PPSA99051/icon0.png", "OpenStory"));
  assert(notification["rawData"]["viewData"]["message"]["body"].string()=="OpenStory download started.");
  assert(notification["rawData"]["viewData"]["subMessage"]["body"].string()=="OpenStory");
  assert(notification["rawData"]["bundleName"].string()=="PS5Library");
  assert(notification["rawData"]["viewData"]["icon"]["parameters"]["url"].string()=="/user/appmeta/PPSA99051/icon0.png");
  assert(notification["rawData"]["viewTemplateType"].string()=="ToastTemplateB"&&notification["rawData"]["channelType"].string()=="Downloads");
  assert(notification.dump().find("\"soundEffect\"")==std::string::npos);
  for(const auto& input:std::vector<std::string>{"", "nul", "{\"v\":", "null false", std::string("null\0false",10)}){
    bool invalid=false;try{(void)Json::parse(input);}catch(const std::exception&){invalid=true;}assert(invalid);
  }
  assert(ps5library::shadowMountPort("# api_port=9\n")==10101);
  assert(ps5library::shadowMountPort("api_port=12345\n")==12345);
  assert(ps5library::shadowMountPort("api_enabled = false\n")==0);
  assert(ps5library::shadowMountPort("api_port=65536\n")==0);
  assert(ps5library::shadowMountSupported(Json::parse(R"({"status":0,"api_version":1,"shadowmount_version":"1.7","capabilities":["add_manual_source","rescan"]})")));
  assert(!ps5library::shadowMountSupported(Json::parse(R"({"api_version":1,"shadowmount_version":"1.7","capabilities":["add_manual_source","rescan"]})")));
  assert(!ps5library::shadowMountSupported(Json::parse(R"({"status":0,"api_version":2,"shadowmount_version":"1.7","capabilities":["add_manual_source","rescan"]})")));
  assert(!ps5library::shadowMountSupported(Json::parse(R"({"status":0,"api_version":1,"shadowmount_version":"1.7","capabilities":["list_games"]})")));
  assert(!ps5library::shadowMountPkgBackportSupported(Json::parse(R"({"status":0,"api_version":1,"shadowmount_version":"1.7beta1","capabilities":["add_manual_source","rescan"]})")));
  assert(ps5library::shadowMountPkgBackportSupported(Json::parse(R"({"status":0,"api_version":1,"shadowmount_version":"1.7beta2","capabilities":["add_manual_source","rescan"]})")));
  assert(ps5library::shadowMountPkgBackportSupported(Json::parse(R"({"status":0,"api_version":1,"shadowmount_version":"1.7beta2-2-g123456","capabilities":["add_manual_source","rescan"]})")));
  assert(!ps5library::shadowMountPkgBackportSupported(Json::parse(R"({"status":0,"api_version":1,"shadowmount_version":"1.7beta3","capabilities":["add_manual_source","rescan"]})")));
  assert(ps5library::shadowMountPkgBackportSupported(Json::parse(R"({"status":0,"api_version":1,"shadowmount_version":"1.7beta4","capabilities":["add_manual_source","rescan","installed_pkg_games","game_fakelib_settings"]})")));
  assert(ps5library::shadowMountPkgBackportSupported(Json::parse(R"({"status":0,"api_version":1,"shadowmount_version":"1.7beta4-2-g123456","capabilities":["add_manual_source","rescan","installed_pkg_games","game_fakelib_settings"]})")));
  assert(!ps5library::shadowMountPkgBackportSupported(Json::parse(R"({"status":0,"api_version":1,"shadowmount_version":"1.7beta4","capabilities":["add_manual_source","rescan","game_fakelib_settings"]})")));
  assert(!ps5library::shadowMountPkgBackportSupported(Json::parse(R"({"status":0,"api_version":1,"shadowmount_version":"1.7beta4","capabilities":["add_manual_source","rescan","installed_pkg_games"]})")));
  assert(!ps5library::shadowMountPkgBackportSupported(Json::parse(R"({"status":0,"api_version":1,"shadowmount_version":"1.7beta4","capabilities":"installed_pkg_games,game_fakelib_settings"})")));
  assert(ps5library::shadowMountMoveSupported(Json::parse(R"({"status":0,"api_version":1,"shadowmount_version":"1.7beta2","capabilities":["add_manual_source","rescan","move_game_source","list_games","storage_space","storage_job_status"]})")));
  assert(ps5library::shadowMountRefreshDue(0,1000,false));
  assert(!ps5library::shadowMountRefreshDue(1000,30999,false));
  assert(ps5library::shadowMountRefreshDue(1000,31000,false));
  assert(!ps5library::shadowMountRefreshDue(1000,300999,true));
  assert(!ps5library::shadowMountRefreshDue(1000,301000,true));
  assert(!ps5library::shadowMountRefreshDue(1000,999,true));
  auto entry=Json::parse(R"({"titleId":"CUSA12345","addedAt":"2026-09-10","releases":[{"id":"release","sources":[{}],"artifacts":[{}]}]})");
  assert(storefront::validTitleId("PPSA12345")&&storefront::validTitleId("CUSA12345")&&!storefront::validTitleId("PPSA1234")&&!storefront::validTitleId("ppsa12345")&&!storefront::validTitleId("PPSA1234x"));
  auto library=Json::parse(R"([{"releaseId":"release","state":"READY_ON_PS5","source":"INSTALLED_TITLE","registered":false}])");
  assert(storefront::serverAvailable(entry)&&storefront::serverReady(entry));assert(storefront::launchableTitle(entry,library)=="CUSA12345");
  assert(!storefront::cachedArtifactOnly(entry["releases"][size_t(0)]));
  auto sourceOnly=Json::parse(R"({"releases":[{"kind":"BASE","sources":[{}],"artifacts":[]}]})");
  assert(storefront::serverAvailable(sourceOnly)&&!storefront::serverReady(sourceOnly));
  assert(!storefront::cachedArtifactOnly(sourceOnly["releases"][size_t(0)]));
  assert(storefront::cachedArtifactOnly(Json::parse(R"({"sources":[],"artifacts":[{}]})")));
  auto newer=Json::parse(R"({"id":"new-release","kind":"BASE","version":"01.000.001","sources":[{}],"artifacts":[{}]})");
  assert(!storefront::releaseReady(newer,library));assert(storefront::launchableRelease(entry,newer,library).empty());
  auto newerAction=storefront::gameActionState(!storefront::launchableRelease(entry,newer,library).empty(),false,storefront::releaseReady(newer,library),false,true,true);assert(newerAction.label=="Download"&&newerAction.enabled);
  assert(storefront::releaseReady(entry["releases"][size_t(0)],library));assert(storefront::launchableRelease(entry,entry["releases"][size_t(0)],library)=="CUSA12345");
  assert(storefront::releaseLabel(Json::parse(R"({"kind":"DLC","title":"First expansion","version":"01.00"})"))=="DLC: First expansion / 01.00");
  auto addon=Json::parse(R"({"titleId":"CUSA12345","releases":[{"id":"release","kind":"DLC","sources":[{}],"artifacts":[{}]}]})");assert(!storefront::serverAvailable(addon)&&!storefront::serverReady(addon));assert(storefront::launchableTitle(addon,library).empty());
  assert(storefront::launchableTitle(entry,Json::parse(R"([{"releaseId":"release","state":"MISSING","source":"INSTALLED_TITLE"}])")).empty());
  assert(storefront::launchableTitle(entry,Json::parse(R"([{"releaseId":"release","state":"READY_ON_PS5","source":"EXISTING_DUMP","registered":false}])")).empty());
  auto action=storefront::gameActionState(true,true,true,false,true,true);assert(action.label=="Play Now"&&action.enabled);
  action=storefront::gameActionState(false,true,true,false,true,true);assert(action.label=="Installing"&&!action.enabled);
  action=storefront::gameActionState(false,false,true,false,true,true);assert(action.label=="On this PS5"&&!action.enabled);
  action=storefront::gameActionState(false,false,false,false,true,true);assert(action.label=="Download"&&action.enabled);
  action=storefront::gameActionState(false,false,false,false,false,true);assert(action.label=="Prepare"&&action.enabled);
  auto selected=Json::parse(R"({"id":"release","sources":[{"id":"source"}]})");
  assert(storefront::deliveryActive(selected,Json::parse(R"([{"sourceReleaseId":"source","consoleId":"console","state":"REGISTERING"}])"),Json::array(),"console"));
  assert(!storefront::deliveryActive(selected,Json::parse(R"([{"sourceReleaseId":"source","consoleId":"console","state":"READY_ON_PS5"}])"),Json::array(),"console"));
  assert(storefront::deliveryActive(selected,Json::array(),Json::parse(R"([{"releaseId":"release","consoleId":"console","kind":"TRANSFER","state":"VERIFYING"}])"),"console"));
  auto older=Json::parse(entry.dump());older.set("addedAt","2026-09-01");std::vector<Json> added={older,entry,older,older,older};
  auto recent=storefront::recentlyAdded(added);assert(recent.size()==4&&recent.front()["addedAt"].string()=="2026-09-10");
  assert(storefront::recentlyAdded({Json::parse(R"({"releases":[{"sources":[],"artifacts":[]}]})")}).empty());
  assert(!storefront::offlinePageEnabled("Discover"));assert(storefront::offlinePageEnabled("My Library"));assert(storefront::offlinePageEnabled("Downloads"));assert(storefront::offlinePageEnabled("My PS5"));
  auto extracting=Json::parse(R"({"kind":"BUILD","state":"EXTRACTING","downloadedBytes":0,"totalBytes":400,"progress":{"stage":"Extracting archive","completedStages":0,"totalStages":7,"extraction":{"completedBytes":100,"totalBytes":400}}})");
  auto measured=storefront::buildByteProgress(extracting);assert(measured["completedBytes"].number()==100&&measured["totalBytes"].number()==400);
  auto staging=Json::parse(R"({"kind":"BUILD","state":"BUILDING","progress":{"stage":"Copying to staging","completedStages":2,"totalStages":7,"staging":{"completedBytes":300,"totalBytes":600}}})");
  measured=storefront::buildByteProgress(staging);assert(measured["completedBytes"].number()==300&&measured["totalBytes"].number()==600);
  auto converting=Json::parse(R"({"kind":"BUILD","state":"BUILDING","progress":{"stage":"Building package","operation":{"completedBytes":450,"totalBytes":900},"staging":{"completedBytes":600,"totalBytes":600}}})");
  measured=storefront::buildByteProgress(converting);assert(measured["completedBytes"].number()==450&&measured["totalBytes"].number()==900);
  auto publishing=Json::parse(R"({"kind":"BUILD","state":"PUBLISHING","progress":{"stage":"Verifying package for publish","operation":{"completedBytes":50,"totalBytes":200}}})");
  measured=storefront::buildByteProgress(publishing);assert(measured["completedBytes"].number()==50&&measured["totalBytes"].number()==200);
  auto downloading=Json::parse(R"({"kind":"BUILD","state":"DOWNLOADING","downloadedBytes":250,"totalBytes":1000,"progress":{"stage":"DOWNLOADING","completedStages":0,"totalStages":7}})");
  measured=storefront::buildByteProgress(downloading);assert(measured["completedBytes"].number()==250&&measured["totalBytes"].number()==1000);
  auto failedExtraction=Json::parse(extracting.dump());failedExtraction.set("state","ERROR");assert(storefront::buildByteProgress(failedExtraction).null());
  auto package=Json::parse(R"({"kind":"BUILD","state":"BUILDING","progress":{"stage":"Building package","completedStages":3,"totalStages":7}})");assert(storefront::buildByteProgress(package).null());
  auto liveJobs=Json::parse(R"([{"id":"job-a","kind":"BUILD","state":"QUEUED","downloadedBytes":0,"totalBytes":1000,"progress":null}])");
  auto liveEvent=Json::parse(R"({"jobId":"job-a","state":"BUILDING","progress":{"downloadedBytes":1000,"totalBytes":1000,"speedBytesPerSecond":0,"etaSeconds":null,"conversion":{"stage":"Building package","completedStages":3,"totalStages":7,"operation":{"completedBytes":450,"totalBytes":900}}}})");
  assert(storefront::mergeJobEvent(liveJobs,liveEvent));measured=storefront::buildByteProgress(liveJobs[size_t(0)]);assert(liveJobs[size_t(0)]["state"].string()=="BUILDING"&&liveJobs[size_t(0)]["downloadedBytes"].number()==1000&&liveJobs[size_t(0)]["progress"]["stage"].string()=="Building package"&&measured["completedBytes"].number()==450&&measured["totalBytes"].number()==900);assert(!storefront::mergeJobEvent(liveJobs,Json::parse(R"({"jobId":"missing","state":"BUILDING","progress":{}})")));
  assert(storefront::landingPage("My Library",true));assert(storefront::landingPage("My Library",false));assert(!storefront::landingPage("Discover",false));
  auto rawUsb=Json::parse(R"({"storageId":"usb0","displayName":"USB Storage","path":"/mnt/usb0","totalBytes":1000000000000,"formatEligible":true})");
  assert(storefront::formatEligibleStorage(rawUsb));
  auto inferredUsb=Json::parse(R"({"storageId":"usb0","displayName":"USB Storage","path":"/mnt/usb0","totalBytes":1000000000000})");assert(!storefront::formatEligibleStorage(inferredUsb));
  auto unsafeUsb=Json::parse(rawUsb.dump());unsafeUsb.set("storageId","../usb0");assert(!storefront::formatEligibleStorage(unsafeUsb));
  auto missingSize=Json::parse(rawUsb.dump());missingSize.set("totalBytes",int64_t(0));assert(!storefront::formatEligibleStorage(missingSize));
  assert(storefront::formatStoragePath(rawUsb,"prepare")=="/api/v1/agent/storage/usb0/format/prepare");
  const std::string formatChallenge(64,'a');
  assert(storefront::formatStoragePath(rawUsb,"confirm",formatChallenge)=="/api/v1/agent/storage/usb0/format/confirm/"+formatChallenge);
  assert(storefront::formatStoragePath(rawUsb,"confirm","challenge_123").empty());
  auto wrongStorage=Json::parse(rawUsb.dump());wrongStorage.set("storageId","internal");assert(!storefront::formatEligibleStorage(wrongStorage));
  auto cards=storefront::storageCards(Json::parse(R"([{"storageId":"internal","displayName":"Internal Storage"},{"storageId":"internal-installed","displayName":"PS5-managed install storage"},{"storageId":"ext1","displayName":"M.2 SSD"}])"));assert(cards.size()==2&&cards[size_t(0)]["storageId"].string()=="internal"&&cards[size_t(1)]["storageId"].string()=="ext1");
  auto installedOnly=storefront::storageCards(Json::parse(R"([{"storageId":"internal-installed","displayName":"PS5-managed install storage"}])"));assert(installedOnly.size()==1&&installedOnly[size_t(0)]["displayName"].string()=="Internal Storage");
  auto cached=Json::parse(R"({"catalog":[{"id":"known","title":"Known","titleId":"PPSA10001","releases":[{"id":"known-release","kind":"BASE","version":"01.00","sources":[],"artifacts":[]}]}],"profile":{"username":"Owner","consoles":[]},"jobs":[]})");
  auto local=Json::parse(R"({"firmware":"4.50","runtime":"kstuff-lite","runtimeStatus":{"shadowMount":"RUNNING","kstuff":"RUNNING"},"storage":[{"storageId":"internal","displayName":"Internal","path":"/data","freeBytes":99}],"storageFormat":{"storageId":"usb0","formatState":"FORMATTING","formatProgress":42},"capabilities":{"shadowMount":true},"inventory":[{"titleId":"PPSA10001","title":"Known","version":"01.00","storageId":"internal","relativePath":"known","source":"EXISTING_DUMP","registered":false,"available":true,"canDelete":true,"canMove":true,"localMedia":{"cover":{"url":"/api/v1/agent/media/PPSA10001/cover?v=1"},"music":{"url":"/api/v1/agent/media/PPSA10001/music?v=1","size":3,"sha256":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}}},{"titleId":"CUSA12345","title":"Local only","version":"01.02","storageId":"internal","relativePath":"app/CUSA12345/app.pkg","source":"INSTALLED_TITLE","registered":true,"available":true}],"trophySummary":{"earnedTrophies":{"bronze":4}},"saveData":{"items":[]}})");
  auto reordered=Json::array();reordered.add(local["inventory"][size_t(1)]);reordered.add(local["inventory"][size_t(0)]);
  assert(ps5library::inventoryFingerprint(local["inventory"],true)==ps5library::inventoryFingerprint(reordered,true));
  assert(ps5library::inventoryFingerprint(local["inventory"],true)!=ps5library::inventoryFingerprint(local["inventory"],false));
  assert(ps5library::clampedHeartbeatInterval(10)==10);
  assert(ps5library::clampedHeartbeatInterval(0)==5);
  assert(ps5library::clampedHeartbeatInterval(300)==30);
  assert(ps5library::inventoryRefreshDue(false,false,0));
  assert(ps5library::inventoryRefreshDue(true,true,0));
  assert(!ps5library::inventoryRefreshDue(true,false,59));
  assert(ps5library::inventoryRefreshDue(true,false,60));
  assert(ps5library::heartbeatIncludesInventory(true,false,true));
  assert(ps5library::heartbeatIncludesInventory(true,true,true));
  assert(!ps5library::heartbeatIncludesInventory(true,true,false));
  assert(ps5library::heartbeatIncludesInventory(false,false,false));
  assert(!ps5library::heartbeatIncludesInventory(false,true,false));
  auto serverConsole=Json::parse(R"({"id":"local-console","storage":[{"storageId":"ext1"},{"storageId":"usb0"}],"storageFormat":null})"),localStorage=Json::parse(local.dump());localStorage.set("storage",Json::parse(R"([{"storageId":"usb0","formatEligible":true},{"storageId":"ext1"}])"));
  auto overlaid=storefront::withLocalConsoleState(serverConsole,localStorage,true,"local-console");assert(overlaid["storage"][size_t(0)]["storageId"].string()=="usb0"&&overlaid["storageFormat"]["formatProgress"].number()==42);
  auto serverLibrary=Json::parse(R"([{"releaseId":"release-1","titleId":"PPSA10001","version":"01.00","storageId":"internal-installed","state":"READY_ON_PS5","registered":true,"source":"INSTALLED_TITLE"}])");
  auto localInventory=Json::parse(R"([{"releaseId":"release-1","titleId":"PPSA10001","version":"01.00","storageId":"ext0","relativePath":"app/PPSA10001","available":true,"registered":true,"nativeRegistered":true,"canMove":true,"canDelete":true,"source":"INSTALLED_TITLE"}])");
  auto connectedLibrary=storefront::withLocalInventory(serverLibrary,localInventory);assert(connectedLibrary.size()==1&&connectedLibrary[size_t(0)]["storageId"].string()=="ext0"&&connectedLibrary[size_t(0)]["nativeRegistered"].boolean()&&connectedLibrary[size_t(0)]["canMove"].boolean());
  assert(storefront::localIdentity(Json::object({{"consoleId",Json()}}),"previous-console")["consoleId"].string()=="previous-console");
  assert(storefront::localIdentity(Json::object(),"")["consoleId"].string()=="local-console");
  assert(storefront::localIdentity(Json::object({{"consoleId","agent-console"}}),"previous-console")["consoleId"].string()=="agent-console");
  assert(storefront::localEnvelope(local)["snapshot"]["inventory"].size()==2);
  auto nestedLocal=Json::object({{"snapshot",local},{"device",Json::object()}});assert(storefront::localEnvelope(nestedLocal)["snapshot"]["libraryRevision"].number()==local["libraryRevision"].number());
  auto soleConsole=Json::array();soleConsole.add(Json::object({{"id","local-console"},{"games",int64_t(21)}}));assert(storefront::consoleById(soleConsole,"stale-server-console")["games"].number()==21);
  auto observedConsoles=Json::parse(R"([{"id":"old-local","name":"Living Room","presence":"OFFLINE","firmware":"unknown","games":0},{"id":"remote-console","name":"Bedroom","presence":"ONLINE","games":4}])");
  assert(storefront::consoleSelectionAfterServerRefresh(observedConsoles,"deleted-console","old-local")=="old-local");
  assert(storefront::consoleSelectionAfterServerRefresh(observedConsoles,"remote-console","old-local")=="remote-console");
  assert(storefront::consoleSelectionAfterLocalSnapshot(observedConsoles,"old-local","old-local","new-local")=="new-local");
  assert(storefront::consoleSelectionAfterLocalSnapshot(observedConsoles,"remote-console","old-local","new-local")=="remote-console");
  auto reconciledConsoles=storefront::withObservedLocalConsole(observedConsoles,local,"old-local","new-local","My PS5");
  assert(reconciledConsoles.size()==2&&reconciledConsoles[size_t(0)]["id"].string()=="new-local"&&reconciledConsoles[size_t(0)]["presence"].string()=="LOCAL"&&reconciledConsoles[size_t(0)]["firmware"].string()=="4.50"&&reconciledConsoles[size_t(0)]["games"].number()==2&&reconciledConsoles[size_t(1)]["id"].string()=="remote-console");
  auto offline=storefront::localModel(cached,local,Json::object({{"consoleId","console"}}),"Living Room PS5");
  assert(offline["catalog"].size()==2&&offline["library"].size()==2);assert(offline["status"]["runtime"].string()=="kstuff-lite");assert(offline["status"]["runtimeStatus"]["shadowMount"].string()=="RUNNING");assert(offline["consoles"][size_t(0)]["presence"].string()=="LOCAL");assert(offline["consoles"][size_t(0)]["storageFormat"]["formatProgress"].number()==42);assert(offline["profile"]["consoles"][size_t(0)]["games"].size()==2);assert(storefront::launchableTitle(offline["catalog"][size_t(1)],offline["library"])=="CUSA12345");assert(offline["catalog"][size_t(0)]["coverUrl"].string().rfind("/api/v1/agent/media/",0)==0&&offline["catalog"][size_t(0)]["music"]["size"].number()==3);assert(offline["library"][size_t(0)]["canDelete"].boolean()&&offline["library"][size_t(0)]["canMove"].boolean());
  auto emptyConnected=Json::object({{"catalog",Json::array()},{"library",Json::array()},{"jobs",Json::array()}});
  auto recovered=storefront::withObservedLocalInventory(emptyConnected,local,Json::object({{"consoleId","console"}}),"Living Room PS5");
  assert(recovered["catalog"].size()==2&&recovered["library"].size()==2);
  const auto nativeItem=Json::object({{"nativeRegistered",true},{"source","INSTALLED_TITLE"},{"storageId","internal-installed"}}),fpkgItem=Json::object({{"nativeRegistered",true},{"method","FPKG"},{"storageId","internal-installed"}}),shadowItem=Json::object({{"storageId","usb0"}});
  const auto internalStore=Json::object({{"storageId","internal-installed"},{"writable",true},{"nativeMoveStorageType",int64_t(0)},{"installMethodsSupported",Json::parse(R"(["FPKG"])" )}}),managedUsbStore=Json::object({{"storageId","ext0"},{"writable",true},{"nativeMoveStorageType",int64_t(1)},{"installMethodsSupported",Json::parse(R"(["FPKG"])" )}}),blockedUsbStore=Json::object({{"storageId","ext0"},{"writable",true},{"nativeMoveStorageType",int64_t(1)},{"installMethodsSupported",Json::array()}}),m2Store=Json::object({{"storageId","ext1"},{"writable",true},{"nativeMoveStorageType",int64_t(2)},{"installMethodsSupported",Json::parse(R"(["FPKG"])" )}}),rawUsbStore=Json::parse(R"({"storageId":"usb0","writable":true,"nativeMoveStorageType":null,"installMethodsSupported":["SHADOWMOUNT"]})");
  assert(storefront::moveDestinationEligible(nativeItem,internalStore,managedUsbStore));assert(storefront::moveDestinationEligible(fpkgItem,internalStore,m2Store));assert(!storefront::moveDestinationEligible(nativeItem,internalStore,blockedUsbStore));assert(!storefront::moveDestinationEligible(nativeItem,internalStore,internalStore));assert(!storefront::moveDestinationEligible(nativeItem,internalStore,Json::object({{"storageId","other-internal"},{"writable",true},{"nativeMoveStorageType",int64_t(0)},{"installMethodsSupported",Json::parse(R"(["FPKG"])" )}})));assert(!storefront::moveDestinationEligible(nativeItem,internalStore,rawUsbStore));
  assert(storefront::moveDestinationEligible(shadowItem,rawUsbStore,Json::parse(R"({"storageId":"usb1","writable":true,"installMethodsSupported":["SHADOWMOUNT"]})")));assert(!storefront::moveDestinationEligible(shadowItem,rawUsbStore,managedUsbStore));
  assert(storefront::selectedConsoleIsLocal(true,Json::object({{"consoleId","console-a"}}),Json::object({{"id","console-a"}})));assert(!storefront::selectedConsoleIsLocal(true,Json::object({{"consoleId","console-a"}}),Json::object({{"id","console-b"}})));assert(!storefront::selectedConsoleIsLocal(false,Json::object({{"consoleId","console-a"}}),Json::object({{"id","console-a"}})));
  using namespace ps5library; auto root=fs::temp_directory_path()/("ps5library-"+randomHex(8)); fs::create_directory(root);
  {
    assert(!mdbgExceptionStopped(0)&&!mdbgExceptionStopped(0x40000)&&mdbgExceptionStopped(0x80000)&&mdbgExceptionStopped(0x80001));assert(launchLogDelta("old\n","old\nnew\n")=="new\n");assert(launchLogDelta("same","same").empty());assert(launchLogDelta("rotated","fresh") == "fresh");assert(launchLogDelta("old","").empty());assert(titleMainExecutable("eboot")&&titleMainExecutable("eboot.bin")&&!titleMainExecutable("BigHelmet-Worker")&&!titleMainExecutable("SceSysCore")&&titleProcessAlive(2)&&!titleProcessAlive(5));LaunchProcessWatch processWatch;assert(!processWatch.observe(-1));assert(!processWatch.observe(581));assert(!processWatch.observe(-1));assert(!processWatch.observe(std::nullopt));assert(!processWatch.observe(-1));assert(processWatch.observe(-1));assert(!processWatch.observe(-1));LaunchProcessWatch bigAppWatch;assert(!bigAppWatch.observe(0x4017));assert(!bigAppWatch.observe(-1));assert(!bigAppWatch.observe(0x4017));assert(!bigAppWatch.observe(-1));assert(bigAppWatch.observe(-1));
    const auto fatal=parseFatalThread(R"LOG(# exception: 0xa0020101 (PRX_NOT_RESOLVED_FUNCTION)
# thread ID: 7
# proc ID: 999
# registers:
# rax: 0000000000000000  rbx: 0000000000000000
# exception: 0xa0020101 (PRX_NOT_RESOLVED_FUNCTION)
# thread ID: 101759
# thread name: eboot.bin
# proc ID: 203
# proc name: eboot.bin
# registers:
# rax: 0000000000000000  rbx: 00000000056ac010
# rcx: 2dc5f08537fa37cd  rdx: 0000000000000000
interleaved kernel log line
# rsi: 0000000000000000  rdi: 0000000080198750
# rbp: 00000007eeffbd60  rsp: 00000007eeffbd18
# r8 : ff00fffffffffff8  r9 : 0000000000000040
# r10: ff00fffffffffff8  r11: 0000000000000040
# r12: 0000000006815cf8  r13: 0000000001655670
# r14: 0000000006815eb0  r15: 00000000016ae300
# rip: 0000000800032782  eflags: 00000202
)LOG",203);
    assert(fatal&&fatal->pid==203&&fatal->threadId==101759&&fatal->rsp==0x7eeffbd18ULL&&fatal->rbp==0x7eeffbd60ULL&&fatal->rip==0x800032782ULL&&fatal->rcx==0x2dc5f08537fa37cdULL);
    const auto history=root/"error-history";const auto receipt=root/"launch-last.json";fs::create_directory(history);
    atomicJson(history/"old.json",Json::object({{"code","OLD"}}));
    LaunchTrace trace(receipt,history);trace.klogStatus(true);trace.appendKlog("before launch\n");trace.beginAgent("PPSA19943",1000);
    trace.appendKlog("loader failed\n");atomicJson(history/"new.json",Json::object({{"code","CE-108255-1"}}));
    trace.appeared("PPSA19943",2000);trace.appendKlog("target crashed\n");trace.launchResult(0,0,0,2100);trace.process(321,2200);assert(trace.mdbg(0,0,0x80001,2250));assert(!trace.mdbg(0,0,0x80001,2275));assert(!trace.mdbg(0,0,0,2300));trace.exited(3000);trace.finish(5000);
    const auto saved=readJson(receipt);assert(saved["titleId"].string()=="PPSA19943");assert(saved["source"].string()=="AGENT");assert(saved["processObserved"].boolean());assert(saved["pid"].number()==321);assert(saved["mdbgAvailable"].boolean());assert(saved["mdbgExceptionStop"].boolean());assert(saved["mdbgExceptionFlags"].number()==0x80001);assert(saved["mdbgExceptionObservedAtUnixMs"].number()==2250);assert(saved["mdbgFlags"].number()==0);assert(saved["mdbgObservedAtUnixMs"].number()==2300);assert(saved["processExitAtUnixMs"].number()==3000);assert(saved["klog"].string()=="loader failed\ntarget crashed\n");assert(saved["errorHistory"].size()==1);assert(saved["errorHistory"][size_t(0)]["name"].string()=="new.json");assert(saved["errorHistory"][size_t(0)]["content"]["code"].string()=="CE-108255-1");
    LaunchTrace manual(root/"manual-launch.json",history);manual.klogStatus(true);manual.appendKlog("manual prelude\n");manual.appeared("PPSA19943",6000);manual.appendKlog("manual crash\n");manual.exited(7000);manual.finish(8000);const auto manualSaved=readJson(root/"manual-launch.json");assert(manualSaved["source"].string()=="MANUAL");assert(manualSaved["klog"].string()=="manual prelude\nmanual crash\n");
    LaunchTrace bounded(root/"bounded-launch.json",history);bounded.klogStatus(true);bounded.beginAgent("PPSA19943",9000);bounded.appendKlog(std::string(300*1024,'x'));bounded.finish(10000,"REJECTED");const auto boundedSaved=readJson(root/"bounded-launch.json");assert(boundedSaved["klog"].string().size()==256*1024);assert(boundedSaved["klogTruncated"].boolean());
  }
  assert(!readJsonIfPresent(root/"missing-state.json"));atomicJson(root/"state.json",Json::object({{"ok",true}}));assert(readJsonIfPresent(root/"state.json")->operator[]("ok").boolean());atomicBytes(root/"bom-state.json",std::string("\xef\xbb\xbf")+"{\"ok\":true}");assert(readJson(root/"bom-state.json")["ok"].boolean());
  fs::create_symlink(root/"state.json",root/"state-link.json");bool unsafeState=false;try{readJsonIfPresent(root/"state-link.json");}catch(...){unsafeState=true;}assert(unsafeState);{std::ofstream oversized(root/"oversized-state.json",std::ios::binary);oversized.seekp(8*1024*1024);oversized.put('x');}unsafeState=false;try{readJsonIfPresent(root/"oversized-state.json");}catch(...){unsafeState=true;}assert(unsafeState);
  auto deviceMarker=root/"device";atomicBytes(deviceMarker,"storage");assert(sameStorageDevice(deviceMarker,root));assert(!sameStorageDevice(root/"missing",root));
  assert(discoveredStorageName("/mnt/ext1","/dev/ssd1.user","bfs")=="M.2 SSD");assert(discoveredStorageName("/mnt/ext0","/dev/da1p2.crypt","ufs")=="USB Extended Storage");assert(discoveredStorageName("/mnt/usb0","/dev/da1p1","exfatfs")=="USB Storage");assert(ps5ManagedUsbStorage("/mnt/ext0","/dev/da1p2.crypt","ufs"));assert(!ps5ManagedUsbStorage("/mnt/ext0","/dev/da1p2","bfs"));assert(!ps5ManagedUsbStorage("/mnt/usb0","/dev/da1p1","exfatfs"));
  assert(exactStorageMount("/mnt/ext0","/mnt/ext0"));assert(exactStorageMount("/mnt/usb0","/mnt/usb0"));assert(!exactStorageMount("/mnt/ext0","/mnt"));assert(!exactStorageMount("/mnt/ext0","/mnt/ext0/"));
  auto nativeVolume=root/"native-volume",nativePackage=nativeVolume/"user/app/PPSA99999/app.pkg";fs::create_directories(nativePackage.parent_path());atomicBytes(nativePackage,"package");assert(installedNativePackage("PPSA99999",nativeVolume)==nativePackage);fs::remove_all(nativeVolume/"user");nativePackage=nativeVolume/"ps5/user/app/PPSA99999/app.pkg";fs::create_directories(nativePackage.parent_path());atomicBytes(nativePackage,"package");assert(installedNativePackage("PPSA99999",nativeVolume)==nativePackage);
  const auto source=Json::object({{"name","Homebrew"},{"bytes",int64_t(50000000000)}}); atomicJson(root/"state.json",source);
  auto nested=Json::parse(R"({"object":{"value":"original"},"array":[{"value":"original"}]})"),cloned=nested.deepCopy();cloned["object"].set("value","changed");cloned["array"][size_t(0)].set("value","changed");assert(nested["object"]["value"].string()=="original"&&nested["array"][size_t(0)]["value"].string()=="original"&&Json().deepCopy().null());
  assert(readJson(root/"state.json")["bytes"].number()==50000000000);
  auto outside=root/"outside",linked=root/"linked-parent";fs::create_directory(outside);atomicBytes(outside/"state","safe");auto outsideHash=fileHash(outside/"state");fs::create_directory_symlink(outside,linked);bool linkedWriteRejected=false;try{atomicBytes(linked/"state","unsafe");}catch(...){linkedWriteRejected=true;}assert(linkedWriteRejected&&readJson(root/"state.json")["bytes"].number()==50000000000&&fileHash(outside/"state")==outsideHash);fs::remove(linked);
  assert(Json::parse(source.dump())["name"].string()=="Homebrew");
  auto trophyRoot=root/"profiles";fs::create_directories(trophyRoot/"12345678/trophy/data/sce_trop");auto summaryFile=trophyRoot/"12345678/trophy/data/sce_trop/trpsummary.dat";
  const auto summary=Json::object({{"format",1},{"earnedTrophies",Json::object({{"platinum",0},{"gold",0},{"silver",0},{"bronze",4}})}});atomicJson(summaryFile,summary);
  assert(readTrophySummary(trophyRoot,"12345678")["earnedTrophies"]["bronze"].number()==4);
  assert(readTrophySummary(trophyRoot,"87654321").null());assert(readTrophySummary(trophyRoot,"../12345678").null());
  auto badSummary=Json::parse(summary.dump());badSummary["earnedTrophies"].set("bronze",-1);atomicJson(summaryFile,badSummary);assert(readTrophySummary(trophyRoot,"12345678").null());atomicJson(summaryFile,summary);
  bool rejected=false; try { (void)beneath(root,"../outside"); } catch(...) { rejected=true; } assert(rejected);
  rejected=false; try { (void)Json::parse("{}trailing"); } catch(...) { rejected=true; } assert(rejected);
  std::ofstream(root/"data")<<"abc";
  assert(fileHash(root/"data")=="ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  assert(deviceId().size()==36);
  assert(firmwareVersion(0x10500000)=="10.50");
  assert(firmwareVersion(0x07610000)=="7.61");
  assert(firmwareVersion(0x04510000)=="4.51");
  assert(firmwareVersion(0x12000000)=="12.00");
  assert(firmwareVersion(0).empty());
  assert(registrationFirmware(0x04510000,0x04500000)=="4.51");
  assert(registrationFirmware(0x04510000,0x04510001).empty());
  assert(registrationFirmware(0x12600000,0x12600000)=="12.60");
  assert(registrationFirmware(0x99990000,0x04500000).empty());
  assert(registrationFirmware(0,0x04500000).empty());
  auto libraries=root/"backport";fs::create_directories(libraries/"fakelib");atomicBytes(libraries/"fakelib/example.sprx","abc");
  auto backport=Json::parse(R"({"files":[{"path":"fakelib/example.sprx","size":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}]})");
  assert(verifyBackport(libraries,backport));atomicBytes(libraries/"fakelib/extra.sprx","abc");assert(!verifyBackport(libraries,backport));fs::remove(libraries/"fakelib/extra.sprx");
  atomicBytes(libraries/"eboot.bin","abc");atomicBytes(libraries/"sce_sys/param.json","abc");
  auto fullBackport=Json::parse(R"({"files":[{"path":"eboot.bin","size":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},{"path":"fakelib/example.sprx","size":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"},{"path":"sce_sys/param.json","size":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}]})");
  assert(verifyBackport(libraries,fullBackport));
  assert(!verifyBackport(libraries,Json::parse(R"({"files":[{"path":"../data","size":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}]})")));
  assert(shadowMountScanRoots(Json::parse(R"({"scan_paths":[]})"),Json::parse(R"({"shadowmount_version":"1.7alpha13"})")).size()>20);
  assert(shadowMountScanRoots(Json::parse(R"({"scan_paths":[]})"),Json::parse(R"({"shadowmount_version":"2.0"})")).size()==0);
  rejected=false;try{Client invalid(Json::object({{"serverUrl","https://example.net/not-a-server-root"}}));}catch(...){rejected=true;}assert(rejected);
  auto config=Json::object({{"serverUrl","https://one.example"},{"name","Keep my name"}});atomicJson(root/"config.json",config);Agent initial(root/"config.json");auto state=readJson(root/"device-state.json");assert(state["serverUrl"].string()=="https://one.example");config.set("serverUrl","https://two.example");atomicJson(root/"config.json",config);rejected=false;try{Agent wrong(root/"config.json");}catch(...){rejected=true;}assert(rejected);
  auto unpaired=root/"unpaired/config.json";fs::create_directories(unpaired.parent_path());atomicJson(unpaired,Json::object({{"serverUrl","https://one.example"},{"allowInsecureLan",false}}));atomicJson(unpaired.parent_path()/"device-state.json",Json::object({{"deviceId",deviceId()},{"serverUrl",""},{"libraryRevision",int64_t(0)}}));Agent unpairedAgent(unpaired);assert(readJson(unpaired.parent_path()/"device-state.json")["serverUrl"].string()=="https://one.example");
  auto frontendRoot=root/"frontend";fs::create_directories(frontendRoot);auto rejectedCredential=std::string(64,'a'),replacementCredential=std::string(64,'b'),frontendId=deviceId();
  atomicJson(frontendRoot/"device-state.json",Json::object({{"serverUrl","https://one.example"},{"deviceId",frontendId},{"consoleId","old-console"},{"credential",rejectedCredential},{"pairing",Json::object({{"id",deviceId()}})},{"libraryRevision",int64_t(7)},{"firmware","4.50"}}));
  assert(!resetRejectedFrontendCredential(frontendRoot/"config.json",replacementCredential));
  assert(resetRejectedFrontendCredential(frontendRoot/"config.json",rejectedCredential));auto recoveredFrontend=readJson(frontendRoot/"device-state.json");
  assert(recoveredFrontend["serverUrl"].string()=="https://one.example"&&recoveredFrontend["deviceId"].string()==frontendId&&recoveredFrontend["libraryRevision"].number()==7&&recoveredFrontend["firmware"].string()=="4.50");
  assert(recoveredFrontend["credential"].null()&&recoveredFrontend["consoleId"].null()&&recoveredFrontend["pairing"].null());
  assert(normalizeServerUrl(" HTTPS://ONE.EXAMPLE:443/ ")=="https://one.example");
  assert(normalizeProxyUrl(" http://localhost:8118/ ")=="http://localhost:8118");assert(normalizeProxyUrl("").empty());
  for(const auto* bad:{"https://localhost:8118","http://server.example:8118","http://localhost:8118/path"}){rejected=false;try{normalizeProxyUrl(bad);}catch(...){rejected=true;}assert(rejected);}
  assert(clientConnectTimeout(false,false)==10&&clientConnectTimeout(true,false)==3&&clientConnectTimeout(true,true)==10);
  for(const auto* bad:{"", "http://one.example", "https://name:password@one.example", "https://one.example/path", "https://one.example?token=x", "https://one.example#fragment", "https://one.example:99999"}){rejected=false;try{normalizeServerUrl(bad);}catch(...){rejected=true;}assert(rejected);}
  assert(normalizeServerUrl("http://192.168.1.20:3150",true)=="http://192.168.1.20:3150");
  rejected=false;try{normalizeServerUrl("http://public.example",true);}catch(...){rejected=true;}assert(rejected);
  assert(normalizeServerUrl("http://127.0.0.1:3150/",true)=="http://127.0.0.1:3150");
  auto nativeConfig=root/"native/config.json",agentConfig=root/"agent/config.json";fs::create_directories(nativeConfig.parent_path());
  auto freshAgent=root/"fresh-agent/config.json";auto freshDefaults=bootstrapAgentConfig(freshAgent,{});assert(fs::is_regular_file(freshAgent)&&freshDefaults["serverUrl"].string().empty());Agent freshLocal(freshAgent);
  atomicJson(nativeConfig,Json::object({{"serverUrl","https://one.example"},{"fallbackServerUrl","https://one-tail.example"},{"fallbackProxyUrl","http://localhost:8118"},{"allowInsecureLan",false}}));
  auto bootstrapped=bootstrapAgentConfig(agentConfig,nativeConfig);assert(bootstrapped["serverUrl"].string()=="https://one.example"&&bootstrapped["fallbackServerUrl"].string()=="https://one-tail.example"&&bootstrapped["fallbackProxyUrl"].string()=="http://localhost:8118");
  assert(bootstrapped["caBundle"].string()==(agentConfig.parent_path()/"ca-bundle.crt").string());assert(fs::is_regular_file(agentConfig));
  atomicJson(nativeConfig,Json::object({{"serverUrl","https://two.example"},{"allowInsecureLan",false}}));
  auto directBootstrap=bootstrapAgentConfig(agentConfig,nativeConfig);assert(directBootstrap["serverUrl"].string()=="https://two.example"&&directBootstrap["fallbackProxyUrl"].string().empty());
  auto agentState=readJson(agentConfig.parent_path()/"device-state.json");
  assert(agentState["credential"].null()&&agentState["consoleId"].null());
  atomicJson(nativeConfig,Json::object({{"serverUrl",""},{"allowInsecureLan",false}}));
  atomicJson(agentConfig.parent_path()/"device-state.json",Json::object({{"deviceId",deviceId()},{"serverUrl","https://two.example"},{"consoleId","old-console"},{"credential","old-secret"},{"libraryRevision",int64_t(9)}}));
  auto disconnectedBootstrap=bootstrapAgentConfig(agentConfig,nativeConfig);assert(disconnectedBootstrap["serverUrl"].string().empty()&&disconnectedBootstrap["fallbackProxyUrl"].string().empty());
  agentState=readJson(agentConfig.parent_path()/"device-state.json");
  assert(agentState["credential"].null()&&agentState["consoleId"].null()&&agentState["serverUrl"].string().empty());
  Agent localOnly(agentConfig);assert(localOnly.localSnapshot()["inventory"].size()==0);
  assert(parseLocalAgentRequest("GET /api/v1/agent/snapshot HTTP/1.1\r\n\r\n").action==LocalAgentAction::Invalid);
  const auto authorized="Authorization: Bearer "+std::string(localAgentCredential)+"\r\n\r\n";assert(parseLocalAgentRequest("POST /api/v1/agent/titles/PPSA10001/delete/internal HTTP/1.1\r\n"+authorized).action==LocalAgentAction::Delete);auto moveRequest=parseLocalAgentRequest("POST /api/v1/agent/titles/PPSA10001/move/internal/usb0 HTTP/1.1\r\n"+authorized);assert(moveRequest.action==LocalAgentAction::Move&&moveRequest.sourceStorageId=="internal"&&moveRequest.storageId=="usb0");assert(parseLocalAgentRequest("POST /api/v1/agent/titles/PPSA10001/move/internal/../data HTTP/1.1\r\n"+authorized).action==LocalAgentAction::Invalid);
  auto offlineRequest=parseLocalAgentRequest("POST /api/v1/agent/offline/0/68747470733a2f2f6f6e652e6578616d706c65 HTTP/1.1\r\n"+authorized);assert(offlineRequest.action==LocalAgentAction::Offline&&offlineRequest.serverUrl=="https://one.example"&&!offlineRequest.allowInsecureLan);
  assert(localAgentModePath(true,false,"https://one.example")=="/api/v1/agent/offline/0/68747470733a2f2f6f6e652e6578616d706c65");
  assert(localAgentModePath(false,true,"http://192.168.1.20:3150","http://100.64.0.10:3150")=="/api/v1/agent/connect/1/687474703a2f2f3139322e3136382e312e32303a33313530/687474703a2f2f3130302e36342e302e31303a33313530");
  bool connectionNotified=false;int connectionNotices=0;notifyLocalAgentConnection(connectionNotified,[&]{connectionNotices++;return false;});assert(!connectionNotified);notifyLocalAgentConnection(connectionNotified,[&]{connectionNotices++;return true;});notifyLocalAgentConnection(connectionNotified,[&]{connectionNotices++;return true;});assert(connectionNotified&&connectionNotices==2);connectionNotified=false;notifyLocalAgentConnection(connectionNotified,[&]{connectionNotices++;return true;});assert(connectionNotices==3);
  assert(parseLocalAgentRequest("POST /api/v1/agent/disconnect HTTP/1.1\r\n"+authorized).action==LocalAgentAction::Disconnect);
  assert(parseLocalAgentRequest("POST /api/v1/agent/refresh HTTP/1.1\r\n"+authorized).action==LocalAgentAction::Refresh);
  assert(parseLocalAgentRequest("POST /api/v1/agent/close HTTP/1.1\r\n"+authorized).action==LocalAgentAction::Close);
  const auto* openStory=nativeUpdateIdentity("PPSA99783");assert(openStory&&std::string(openStory->contentId)=="UP9000-PPSA99783_00-OPENSTORYPS50000"&&std::string(openStory->name)=="OpenStory"&&!nativeUpdateIdentity("PPSA99999"));
  auto appUpdate=parseLocalAgentRequest("POST /api/v1/agent/app-update/PPSA99051/01.042.000 HTTP/1.1\r\n"+authorized);assert(appUpdate.action==LocalAgentAction::AppUpdate&&appUpdate.titleId==nativeTitleId&&appUpdate.version=="01.042.000");auto gameUpdate=parseLocalAgentRequest("POST /api/v1/agent/app-update/PPSA99783/01.000.021 HTTP/1.1\r\n"+authorized);assert(gameUpdate.action==LocalAgentAction::AppUpdate&&gameUpdate.titleId=="PPSA99783"&&gameUpdate.version=="01.000.021");assert(parseLocalAgentRequest("POST /api/v1/agent/app-update/01.042.000 HTTP/1.1\r\n"+authorized).action==LocalAgentAction::Invalid);assert(parseLocalAgentRequest("POST /api/v1/agent/app-update/PPSA99999/01.000.021 HTTP/1.1\r\n"+authorized).action==LocalAgentAction::Invalid);assert(parseLocalAgentRequest("POST /api/v1/agent/app-update/PPSA99783/01.04..000 HTTP/1.1\r\n"+authorized).action==LocalAgentAction::Invalid);assert(parseLocalAgentRequest("POST /api/v1/agent/app-update/PPSA99051/01.042.000?url=https://other HTTP/1.1\r\n"+authorized).action==LocalAgentAction::Invalid);
  auto launchRequest=parseLocalAgentRequest("POST /api/v1/agent/titles/CUSA12345/launch HTTP/1.1\r\n"+authorized);assert(launchRequest.action==LocalAgentAction::Launch&&launchRequest.titleId=="CUSA12345");assert(localLaunchable(Json::parse(R"({"inventory":[{"titleId":"CUSA12345","available":true,"source":"INSTALLED_TITLE"}]})"),"CUSA12345"));assert(!localLaunchable(Json::parse(R"({"inventory":[{"titleId":"CUSA12345","available":false,"source":"INSTALLED_TITLE"}]})"),"CUSA12345"));
  auto connectRequest=parseLocalAgentRequest("POST /api/v1/agent/connect/0/68747470733a2f2f6f6e652e6578616d706c65 HTTP/1.1\r\n"+authorized);assert(connectRequest.action==LocalAgentAction::Connect&&connectRequest.serverUrl=="https://one.example"&&!connectRequest.allowInsecureLan);
  auto fallbackRequest=parseLocalAgentRequest("POST /api/v1/agent/connect/1/687474703a2f2f3139322e3136382e312e32303a33313530/687474703a2f2f3130302e36342e302e31303a33313530 HTTP/1.1\r\n"+authorized);assert(fallbackRequest.action==LocalAgentAction::Connect&&fallbackRequest.serverUrl=="http://192.168.1.20:3150"&&fallbackRequest.fallbackServerUrl=="http://100.64.0.10:3150"&&fallbackRequest.allowInsecureLan);
  assert(parseLocalAgentRequest("POST /api/v1/agent/connect/1/zz HTTP/1.1\r\n"+authorized).action==LocalAgentAction::Invalid);
  assert(localAgentAddress()=="127.0.0.1");assert(localAgentUrl()=="http://127.0.0.1:"+std::to_string(localAgentPort));
  auto oversizedSnapshot=Json::object({{"snapshot",Json::object({{"firmware","4.50"},{"runtimeStatus",Json::object({{"shadowMount","RUNNING"},{"fakelibEnabled",true}})},{"inventory",Json::parse(R"([{"title":"Local game","titleId":"PPSA10001","version":"01.00","available":true,"registered":true,"localMedia":{"cover":{"url":"/api/v1/agent/media/PPSA10001/cover?v=1","size":1234}}}])")},{"saveData",Json::object({{"items",Json::parse("[\""+std::string(8192,'x')+"\"]")}})},{"cheats",Json::array()}})},{"device",Json::object({{"consoleId","local-console"}})}});
  auto boundedPayload=localAgentPayload(oversizedSnapshot,2048);assert(!boundedPayload.empty()&&boundedPayload.size()<=2048);auto boundedSnapshot=Json::parse(boundedPayload);assert(boundedSnapshot["snapshot"]["runtimeStatus"]["shadowMount"].string()=="RUNNING"&&boundedSnapshot["snapshot"]["runtimeStatus"]["fakelibEnabled"].boolean()&&boundedSnapshot["snapshot"]["inventory"].size()==1&&boundedSnapshot["snapshot"]["inventory"][size_t(0)]["titleId"].string()=="PPSA10001"&&boundedSnapshot["snapshot"]["inventory"][size_t(0)]["localMedia"]["cover"]["size"].number()==1234&&boundedSnapshot["snapshot"]["localPayloadTruncated"].boolean()&&boundedSnapshot["snapshot"]["saveData"]["items"].size()==0);
  LocalAgentServer localServer(0);std::thread localServerThread([&]{while(!localServer.poll([](const LocalAgentRequest& request){assert(request.action==LocalAgentAction::Snapshot);return Json::object({{"snapshot",Json::object({{"libraryRevision",int64_t(1)},{"padding",std::string(20000,'x')}})}});}))std::this_thread::yield();});
  auto localSnapshotResponse=localAgentRequest("GET","/api/v1/agent/snapshot",localServer.port());localServerThread.join();assert(localSnapshotResponse["snapshot"]["libraryRevision"].number()==1&&localSnapshotResponse["snapshot"]["padding"].string().size()==20000);
  LocalAgentServer localMoveServer(0);std::thread localMoveThread([&]{while(!localMoveServer.poll([](const LocalAgentRequest& request){assert(request.action==LocalAgentAction::Move&&request.titleId=="PPSA10001"&&request.sourceStorageId=="internal"&&request.storageId=="ext0");return Json::object({{"accepted",true},{"operation","native-move"}});}))std::this_thread::yield();});
  auto localMoveResponse=localAgentRequest("POST","/api/v1/agent/titles/PPSA10001/move/internal/ext0",localMoveServer.port());localMoveThread.join();assert(localMoveResponse["accepted"].boolean()&&localMoveResponse["operation"].string()=="native-move");
  LocalAgentServer localRefreshServer(0);std::thread localRefreshThread([&]{while(!localRefreshServer.poll([](const LocalAgentRequest& request){assert(request.action==LocalAgentAction::Refresh);return Json::object({{"snapshot",Json::object({{"libraryRevision",int64_t(3)}})}});}))std::this_thread::yield();});
  auto localRefreshResponse=localAgentRequest("POST","/api/v1/agent/refresh",localRefreshServer.port());localRefreshThread.join();assert(localRefreshResponse["snapshot"]["libraryRevision"].number()==3);
  int connectedNotices=0;LocalAgentServer unixServer(root/"agent.sock");std::thread unixServerThread([&]{while(!unixServer.poll([](const LocalAgentRequest& request){assert(request.action==LocalAgentAction::Snapshot);return Json::object({{"snapshot",Json::object({{"libraryRevision",int64_t(2)}})}});},{},[&]{connectedNotices++;}))std::this_thread::yield();});
  auto unixSnapshotResponse=localAgentRequest("GET","/api/v1/agent/snapshot",0,root/"agent.sock");unixServerThread.join();assert(unixSnapshotResponse["snapshot"]["libraryRevision"].number()==2&&unixServer.available()&&connectedNotices==1);fs::remove(root/"agent.sock");assert(!unixServer.available());
  const auto identitySession=std::string(64,'c'),localAuth="\r\nAuthorization: Bearer "+std::string(localAgentCredential)+"\r\n";
  assert(parseLocalAgentRequest("GET /api/v1/agent/hardware-proof HTTP/1.1"+localAuth+"\r\n",identitySession).action==LocalAgentAction::Invalid);
  assert(parseLocalAgentRequest("GET /api/v1/agent/hardware-proof HTTP/1.1"+localAuth+"X-PS5Library-Cheat-Session: "+identitySession+"\r\n\r\n",identitySession).action==LocalAgentAction::HardwareProof);
  const auto shellToken=std::string(64,'d'),shellAuth="\r\nAuthorization: Bearer "+shellToken+"\r\n\r\n";assert(parseLocalAgentRequest("GET /api/v1/agent/hardware-proof HTTP/1.1"+shellAuth,{},shellToken,true).action==LocalAgentAction::Invalid);
  int rejectedNotices=0;LocalAgentServer rejectedServer(root/"rejected.sock");std::thread rejectedThread([&]{while(!rejectedServer.poll([](const LocalAgentRequest&)->Json{throw std::runtime_error("rejected");},{},[&]{rejectedNotices++;}))std::this_thread::yield();});rejected=false;try{localAgentRequest("GET","/api/v1/agent/snapshot",0,root/"rejected.sock");}catch(const RequestError& error){rejected=error.status==409;}rejectedThread.join();assert(rejected&&rejectedNotices==0);
  auto sandboxes=root/"sandboxes",oldSandbox=sandboxes/"PPSA99051_000",activeSandbox=sandboxes/"PPSA99051_001";assert(localAgentBackingSocketPath(sandboxes).empty());fs::create_directories(oldSandbox/"download0/ps5library");fs::create_directories(activeSandbox/"download0/ps5library");assert(localAgentBackingSocketPath(sandboxes).empty());int activeLock=open((activeSandbox/"download0/ps5library/frontend.lock").c_str(),O_CREAT|O_RDWR,0644);assert(activeLock>=0&&flock(activeLock,LOCK_EX|LOCK_NB)==0);assert(localAgentSharedPath(sandboxes)==activeSandbox/"download0/ps5library"&&localAgentBackingSocketPath(sandboxes)==activeSandbox/"download0/ps5library/agent.sock");int oldLock=open((oldSandbox/"download0/ps5library/frontend.lock").c_str(),O_CREAT|O_RDWR,0644);assert(oldLock>=0&&flock(oldLock,LOCK_EX|LOCK_NB)==0&&localAgentSharedPath(sandboxes)==activeSandbox/"download0/ps5library");close(activeLock);assert(localAgentSharedPath(sandboxes)==oldSandbox/"download0/ps5library");close(oldLock);assert(localAgentBackingSocketPath(sandboxes).empty());
  atomicBytes(root/"cover.png","image-bytes");atomicBytes(root/"unix-media.at9","music-bytes");LocalAgentServer unixMediaServer(root/"media.sock");std::thread unixMediaThread([&]{for(int served=0;served<2;)if(unixMediaServer.poll([](const LocalAgentRequest&){return Json();},[&](const LocalAgentRequest& request){assert(request.action==LocalAgentAction::Media);return request.kind=="music"?root/"unix-media.at9":root/"cover.png";}))served++;else std::this_thread::yield();});Client unixMedia(Json::object({{"serverUrl","http://127.0.0.1"},{"allowInsecureLan",true}}),root/"media.sock");unixMedia.credential=localAgentCredential;passthroughCurl=true;auto unixMediaResponse=unixMedia.artwork("/api/v1/agent/media/PPSA10001/cover?v=1","",[] {return false;});unixMedia.download("/api/v1/agent/media/PPSA10001/music?v=1",root/"unix-media.part",11,fileHash(root/"unix-media.at9"),[](int64_t,int64_t){});passthroughCurl=false;unixMediaThread.join();assert(unixMediaResponse.data=="image-bytes"&&fileHash(root/"unix-media.part")==fileHash(root/"unix-media.at9"));
  int localClient=socket(AF_INET,SOCK_STREAM,0);assert(localClient>=0);
  sockaddr_in localAddress{};localAddress.sin_family=AF_INET;localAddress.sin_addr.s_addr=htonl(INADDR_LOOPBACK);localAddress.sin_port=htons(localServer.port());
  char localResponse[512]{};ssize_t localBytes=0;
  atomicBytes(root/"media.at9","abcdef");localClient=socket(AF_INET,SOCK_STREAM,0);assert(localClient>=0&&connect(localClient,reinterpret_cast<sockaddr*>(&localAddress),sizeof(localAddress))==0);const std::string mediaRequest="GET /api/v1/agent/media/PPSA10001/music?v=1 HTTP/1.1\r\nAuthorization: Bearer "+std::string(localAgentCredential)+"\r\nRange: bytes=1-3\r\n\r\n";assert(send(localClient,mediaRequest.data(),mediaRequest.size(),0)==static_cast<ssize_t>(mediaRequest.size()));assert(localServer.poll([](const LocalAgentRequest&){return Json();},[&](const LocalAgentRequest& request){assert(request.action==LocalAgentAction::Media&&request.rangeStart==1&&request.rangeEnd==3);return root/"media.at9";}));std::string mediaResponse;while((localBytes=recv(localClient,localResponse,sizeof(localResponse),0))>0)mediaResponse.append(localResponse,static_cast<size_t>(localBytes));close(localClient);assert(mediaResponse.find("206 Partial Content")!=std::string::npos&&mediaResponse.substr(mediaResponse.find("\r\n\r\n")+4)=="bcd");
  config.set("serverUrl","https://one.example");atomicJson(root/"config.json",config);state.set("credential","old-secret");atomicJson(root/"device-state.json",state);
  auto fallbackSaved=saveServerSettings(root/"config.json","https://ONE.example:443/",false,false,"https://one-tail.example/");assert(readJson(root/"device-state.json")["credential"].string()=="old-secret"&&fallbackSaved["fallbackServerUrl"].string()=="https://one-tail.example");
  rejected=false;try{saveServerSettings(root/"config.json","https://two.example",false);}catch(...){rejected=true;}assert(rejected);assert(readJson(root/"config.json")["serverUrl"].string()=="https://one.example");
  int lock=open((root/"agent.lock").c_str(),O_CREAT|O_RDWR,0600);assert(lock>=0&&flock(lock,LOCK_EX|LOCK_NB)==0);rejected=false;try{saveServerSettings(root/"config.json","https://two.example",false,true);}catch(...){rejected=true;}assert(rejected);close(lock);
  auto saved=saveServerSettings(root/"config.json","https://two.example",false,true),fresh=readJson(root/"device-state.json"),previous=readJson(root/"previous-server.json");assert(saved["name"].string()=="Keep my name");assert(fresh["credential"].null());assert(fresh["deviceId"].string()!=state["deviceId"].string());assert(fresh["serverUrl"].string()=="https://two.example");assert(previous["device"]["credential"].null());assert(previous["device"]["pairing"].null());assert(previous["device"]["deviceId"].string()==state["deviceId"].string());
  auto legacy=Json::object({{"deviceId",deviceId()},{"credential","unbound-secret"}});atomicJson(root/"device-state.json",legacy);
  rejected=false;try{saveServerSettings(root/"config.json","https://two.example",false);}catch(...){rejected=true;}assert(rejected);
  saveServerSettings(root/"config.json","https://two.example",false,true);assert(loadDeviceState(root/"config.json",saved)["credential"].null());
  auto stores=Json::array();stores.add(Json::object({{"storageId","test"},{"displayName","Test"},{"path",root.string()}}));saved.set("storage",stores);atomicJson(root/"config.json",saved);
  fresh=readJson(root/"device-state.json");fresh.set("consoleId","new-console");atomicJson(root/"device-state.json",fresh);Agent inventory(root/"config.json");
  auto receipt=Json::object({{"serverUrl","https://one.example"},{"consoleId","old-console"},{"relativePath","data"},{"size",int64_t(3)},{"sha256",fileHash(root/"data")}});
  atomicJson(root/".ps5library/receipts/check.json",receipt);assert(inventory.inventory().size()==0);
  receipt.set("serverUrl","https://two.example");atomicJson(root/".ps5library/receipts/check.json",receipt);assert(inventory.inventory().size()==0);
  receipt.set("consoleId","new-console");atomicJson(root/".ps5library/receipts/check.json",receipt);assert(inventory.inventory().size()==1);
  auto dump=root/"PPSA03208-app0";fs::create_directories(dump/"sce_sys");std::ofstream(dump/"eboot.bin")<<"fixture executable";
  auto parameters=Json::parse(R"({"titleId":"PPSA03208","contentId":"EP9000-PPSA03208_00-GHOSTSHIP0000000","contentVersion":"02.017.000","localizedParameters":{"defaultLanguage":"en-US","en-US":{"titleName":"Existing dump fixture"}}})");
  atomicJson(dump/"sce_sys/param.json",parameters);
  auto scan=inventory.inventory();assert(scan.size()==2);auto found=scan[size_t(1)];assert(found["title"].string()=="Existing dump fixture");assert(found["source"].string()=="EXISTING_DUMP");assert(found["sha256"].null()&&found["size"].null());assert(found["available"].boolean());assert(!found["registered"].boolean());
  assert(fs::is_regular_file(dump/"eboot.bin")&&readJson(dump/"sce_sys/param.json").dump()==parameters.dump());
  fs::create_directories(root/"backports/PPSA03208/sce_sys");atomicJson(root/"backports/PPSA03208/sce_sys/param.json",parameters);std::ofstream(root/"backports/PPSA03208/eboot.bin")<<"overlay";assert(inventory.inventory().size()==2);
  fs::create_directory_symlink(dump,root/"linked-dump");assert(inventory.inventory().size()==2);
  fs::remove(dump/"eboot.bin");assert(inventory.inventory().size()==1);
  Client stopped(Json::object({{"serverUrl","http://127.0.0.1:9"},{"allowInsecureLan",true}}));stopped.cancelled=[]{return true;};rejected=false;try{stopped.request("GET","/api/v1/device/status");}catch(const std::exception& e){rejected=std::string(e.what()).find("abort")!=std::string::npos;}assert(rejected);
  rejected=false;try{fileHash(root/"data",[]{return true;});}catch(...){rejected=true;}assert(rejected);
#ifndef PS5
  assert(curlInitializations==1);
  Client first(Json::object({{"serverUrl","http://127.0.0.1:9"},{"allowInsecureLan",true}})),second(Json::object({{"serverUrl","http://127.0.0.1:9"},{"allowInsecureLan",true}}));
  auto transfer=[](Client& client){try{client.bytes("/api/v1/test");}catch(...){}};std::thread a(transfer,std::ref(first)),b(transfer,std::ref(second));a.join();b.join();assert(maximumTransfers==1);
#endif
  fs::remove_all(root);return 0;
}
