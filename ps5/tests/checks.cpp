#include "../common/client.hpp"
#include <cassert>
#include <fstream>
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
  auto config=Json::object({{"serverUrl","https://one.example"}});atomicJson(root/"config.json",config);Agent initial(root/"config.json");auto state=readJson(root/"device-state.json");assert(state["serverUrl"].string()=="https://one.example");config.set("serverUrl","https://two.example");atomicJson(root/"config.json",config);rejected=false;try{Agent wrong(root/"config.json");}catch(...){rejected=true;}assert(rejected);fs::remove_all(root);return 0;
}
