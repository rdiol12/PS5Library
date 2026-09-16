#include "../common/client.hpp"
#include "../frontend/collections.hpp"
#include <cassert>
#include <fstream>
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
int main() {
  assert(ps5library::shadowMountPort("# api_port=9\n")==10101);
  assert(ps5library::shadowMountPort("api_port=12345\n")==12345);
  assert(ps5library::shadowMountPort("api_enabled = false\n")==0);
  assert(ps5library::shadowMountPort("api_port=65536\n")==0);
  assert(ps5library::shadowMountSupported(Json::parse(R"({"status":0,"api_version":1,"shadowmount_version":"1.7","capabilities":["add_manual_source","rescan"]})")));
  assert(!ps5library::shadowMountSupported(Json::parse(R"({"api_version":1,"shadowmount_version":"1.7","capabilities":["add_manual_source","rescan"]})")));
  assert(!ps5library::shadowMountSupported(Json::parse(R"({"status":0,"api_version":2,"shadowmount_version":"1.7","capabilities":["add_manual_source","rescan"]})")));
  assert(!ps5library::shadowMountSupported(Json::parse(R"({"status":0,"api_version":1,"shadowmount_version":"1.7","capabilities":["list_games"]})")));
  auto entry=Json::parse(R"({"titleId":"CUSA12345","addedAt":"2026-09-10","releases":[{"id":"release","sources":[{}],"artifacts":[{}]}]})");
  auto library=Json::parse(R"([{"releaseId":"release","state":"READY_ON_PS5","source":"INSTALLED_TITLE","registered":false}])");
  assert(storefront::serverReady(entry));assert(storefront::launchableTitle(entry,library)=="CUSA12345");
  assert(storefront::releaseLabel(Json::parse(R"({"kind":"DLC","title":"First expansion","version":"01.00"})"))=="DLC: First expansion / 01.00");
  auto addon=Json::parse(R"({"titleId":"CUSA12345","releases":[{"id":"release","kind":"DLC","artifacts":[{}]}]})");assert(!storefront::serverReady(addon));assert(storefront::launchableTitle(addon,library).empty());
  assert(storefront::launchableTitle(entry,Json::parse(R"([{"releaseId":"release","state":"MISSING","source":"INSTALLED_TITLE"}])")).empty());
  assert(storefront::launchableTitle(entry,Json::parse(R"([{"releaseId":"release","state":"READY_ON_PS5","source":"EXISTING_DUMP","registered":false}])")).empty());
  auto older=Json::parse(entry.dump());older.set("addedAt","2026-09-01");std::vector<Json> added={older,entry,older,older,older};
  auto recent=storefront::recentlyAdded(added);assert(recent.size()==4&&recent.front()["addedAt"].string()=="2026-09-10");
  assert(storefront::recentlyAdded({Json::parse(R"({"releases":[{"sources":[],"artifacts":[]}]})")}).empty());
  using namespace ps5library; auto root=fs::temp_directory_path()/("ps5library-"+randomHex(8)); fs::create_directory(root);
  const auto source=Json::object({{"name","Homebrew"},{"bytes",int64_t(50000000000)}}); atomicJson(root/"state.json",source);
  assert(readJson(root/"state.json")["bytes"].number()==50000000000);
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
  assert(registrationFirmware(0x12600000,0x12600000)=="12.60");
  assert(registrationFirmware(0x99990000,0x04500000).empty());
  assert(registrationFirmware(0,0x04500000).empty());
  auto libraries=root/"backport";fs::create_directories(libraries/"fakelib");atomicBytes(libraries/"fakelib/example.sprx","abc");
  auto backport=Json::parse(R"({"files":[{"path":"fakelib/example.sprx","size":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}]})");
  assert(verifyBackport(libraries,backport));atomicBytes(libraries/"fakelib/extra.sprx","abc");assert(!verifyBackport(libraries,backport));fs::remove(libraries/"fakelib/extra.sprx");
  assert(!verifyBackport(libraries,Json::parse(R"({"files":[{"path":"../data","size":3,"sha256":"ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"}]})")));
  assert(shadowMountScanRoots(Json::parse(R"({"scan_paths":[]})"),Json::parse(R"({"shadowmount_version":"1.7alpha13"})")).size()>20);
  assert(shadowMountScanRoots(Json::parse(R"({"scan_paths":[]})"),Json::parse(R"({"shadowmount_version":"2.0"})")).size()==0);
  rejected=false;try{Client invalid(Json::object({{"serverUrl","https://example.net/not-a-server-root"}}));}catch(...){rejected=true;}assert(rejected);
  auto config=Json::object({{"serverUrl","https://one.example"},{"name","Keep my name"}});atomicJson(root/"config.json",config);Agent initial(root/"config.json");auto state=readJson(root/"device-state.json");assert(state["serverUrl"].string()=="https://one.example");config.set("serverUrl","https://two.example");atomicJson(root/"config.json",config);rejected=false;try{Agent wrong(root/"config.json");}catch(...){rejected=true;}assert(rejected);
  assert(normalizeServerUrl(" HTTPS://ONE.EXAMPLE:443/ ")=="https://one.example");
  for(const auto* bad:{"", "http://one.example", "https://name:password@one.example", "https://one.example/path", "https://one.example?token=x", "https://one.example#fragment", "https://one.example:99999"}){rejected=false;try{normalizeServerUrl(bad);}catch(...){rejected=true;}assert(rejected);}
  assert(normalizeServerUrl("http://127.0.0.1:3150/",true)=="http://127.0.0.1:3150");
  config.set("serverUrl","https://one.example");atomicJson(root/"config.json",config);state.set("credential","old-secret");atomicJson(root/"device-state.json",state);
  saveServerSettings(root/"config.json","https://ONE.example:443/",false);assert(readJson(root/"device-state.json")["credential"].string()=="old-secret");
  rejected=false;try{saveServerSettings(root/"config.json","https://two.example",false);}catch(...){rejected=true;}assert(rejected);assert(readJson(root/"config.json")["serverUrl"].string()=="https://one.example");
  int lock=open((root/"agent.lock").c_str(),O_CREAT|O_RDWR,0600);assert(lock>=0&&flock(lock,LOCK_EX|LOCK_NB)==0);rejected=false;try{saveServerSettings(root/"config.json","https://two.example",false,true);}catch(...){rejected=true;}assert(rejected);close(lock);
  auto saved=saveServerSettings(root/"config.json","https://two.example",false,true),fresh=readJson(root/"device-state.json");assert(saved["name"].string()=="Keep my name");assert(fresh["credential"].null());assert(fresh["deviceId"].string()!=state["deviceId"].string());assert(fresh["serverUrl"].string()=="https://two.example");assert(readJson(root/"previous-server.json")["device"]["credential"].string()=="old-secret");
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
  fs::remove_all(root);return 0;
}
