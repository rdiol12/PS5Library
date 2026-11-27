#include "../developer/files.hpp"
#include <cassert>
#include <fstream>
#include <unistd.h>
using namespace ps5library;
int main() {
  char temporary[] = "/tmp/ps5library-dev-XXXXXX";
  const fs::path root = mkdtemp(temporary);
  const std::string id(32, 'a'), another(32, 'b');
  auto content = [&](const fs::path& path) { std::ifstream in(path); return std::string(std::istreambuf_iterator<char>(in), {}); };
  auto denied = [&](auto action) { bool failed=false; try { action(); } catch(const std::exception&) { failed=true; } assert(failed); };
  atomicBytes(root/"settings.json", "original");
  const auto original = fileHash(root/"settings.json");
  developer::replace(root,"settings.json",id,"changed",original);
  assert(content(root/"settings.json")=="changed");
  developer::replace(root,"settings.json",id,"changed",original); // Retry after a lost reply.
  assert(content(root/(".ps5library-dev-"+id+".backup"))=="original");
  denied([&]{developer::replace(root,"settings.json",another,"stale write",original);});
  atomicBytes(root/"settings.json","external change");
  denied([&]{developer::replace(root,"settings.json",id,"changed",original,true);});
  assert(content(root/"settings.json")=="external change");
  atomicBytes(root/"settings.json","changed");
  developer::replace(root,"settings.json",id,"changed",original,true);
  assert(content(root/"settings.json")=="original");
  developer::replace(root,"new.txt",another,"new file","ABSENT");
  assert(content(root/"new.txt")=="new file");
  developer::replace(root,"new.txt",another,"new file","ABSENT",true);
  assert(!fs::exists(root/"new.txt"));
  fs::create_symlink(root/"settings.json",root/"link");
  denied([&]{developer::replace(root,"link",another,"bad",original);});
  denied([&]{developer::replace(root,"../escape",another,"bad","ABSENT");});
  denied([&]{developer::replace(root,"settings.json","../escape","bad",original);});
  // A damaged backup must not be used to recover an apparently matching file.
  atomicBytes(root/(".ps5library-dev-"+id+".backup"),"damaged");
  denied([&]{developer::replace(root,"settings.json",id,"changed",original);});
  assert(content(root/"settings.json")=="original");
  fs::remove_all(root);
}
