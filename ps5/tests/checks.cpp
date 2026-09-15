#include "../common/client.hpp"
#include <cassert>
#include <fstream>
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
int main() {
  using namespace ps5library; auto root=fs::temp_directory_path()/("ps5library-"+randomHex(8)); fs::create_directory(root);
  const auto source=Json::object({{"name","Homebrew"},{"bytes",int64_t(50000000000)}}); atomicJson(root/"state.json",source);
  assert(readJson(root/"state.json")["bytes"].number()==50000000000);
  assert(Json::parse(source.dump())["name"].string()=="Homebrew");
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
  Client stopped(Json::object({{"serverUrl","http://127.0.0.1:9"},{"allowInsecureLan",true}}));stopped.cancelled=[]{return true;};rejected=false;try{stopped.request("GET","/api/v1/device/status");}catch(const std::exception& e){rejected=std::string(e.what()).find("abort")!=std::string::npos;}assert(rejected);
  rejected=false;try{fileHash(root/"data",[]{return true;});}catch(...){rejected=true;}assert(rejected);
  fs::remove_all(root);return 0;
}
