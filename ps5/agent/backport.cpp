#include "../common/client.hpp"
#include <regex>
#include <set>
namespace ps5library {
Json shadowMountScanRoots(const Json& settings,const Json& version){
  auto roots=settings["scan_paths"];if(roots.size())return roots;
  if(version["shadowmount_version"].string().rfind("1.7",0)!=0)return Json::array();
  // Verified 1.7 sm_paths.h defaults; other versions must advertise explicit scan paths.
  roots=Json::array();for(const auto* storage:{"/data","/mnt/ext0","/mnt/ext1","/mnt/usb0","/mnt/usb1","/mnt/usb2","/mnt/usb3","/mnt/usb4","/mnt/usb5","/mnt/usb6","/mnt/usb7"})for(const auto* suffix:{"/homebrew","/etaHEN/games"})roots.add(std::string(storage)+suffix);
  for(const auto* storage:{"/mnt/usb0","/mnt/usb1","/mnt/usb2","/mnt/usb3","/mnt/usb4","/mnt/usb5","/mnt/usb6","/mnt/usb7","/mnt/ext0","/mnt/ext1"})roots.add(storage);
  return roots;
}
bool verifyBackport(const fs::path& folder,const Json& backport){
  try{
    const auto files=backport["files"];std::set<std::string> expected;
    if(files.size()>100)return false;
    for(size_t i=0;i<files.size();i++){
      const auto f=files[i];auto name=f["path"].string();if(!std::regex_match(name,std::regex("fakelib2?/[A-Za-z0-9._/-]+"))||!expected.insert(name).second)return false;
      auto file=beneath(folder,name);if(!fs::is_regular_file(file)||static_cast<int64_t>(fs::file_size(file))!=f["size"].number()||fileHash(file)!=f["sha256"].string())return false;
    }
    for(const auto& entry:fs::recursive_directory_iterator(folder))if(entry.is_symlink()||(entry.is_regular_file()&&!expected.count(fs::relative(entry.path(),folder).generic_string())))return false;
    return true;
  }catch(...){return false;}
}
Json prepareBackport(Client& client,const fs::path& root,const Json& roots,const Json& task,const std::function<void(int64_t,int64_t)>& progress){
  const auto bp=task["backport"];if(bp.null()||bp["placement"].string()!="SCAN_PATH"||!bp["files"].size())return Json();
  const auto title=task["titleId"].string();if(!std::regex_match(title,std::regex("PPSA[0-9]{5}")))throw std::runtime_error("METADATA_MISMATCH");
  fs::path selected;auto canonical=fs::canonical(root);
  for(size_t i=0;i<roots.size();i++){
    fs::path scan=roots[i].string();if(!scan.is_absolute()||scan.lexically_normal()!=scan)throw std::runtime_error("UNSAFE_PATH");
    if(fs::exists(scan)){auto old=beneath(scan,"backports/"+title);if(fs::exists(old)&&!verifyBackport(old,bp))throw std::runtime_error("BACKPORT_DESTINATION_CONFLICT");}
    auto relative=scan.lexically_relative(canonical).generic_string();
    if(selected.empty()&&(relative=="."||(!relative.empty()&&relative.rfind("..",0)!=0))){selected=relative=="."?canonical:beneath(canonical,relative);}
  }
  if(selected.empty())throw std::runtime_error("BACKPORT_SCAN_PATH_MISSING");
  fs::create_directories(selected);auto destination=beneath(selected,"backports/"+title);
  if(!fs::exists(destination)){
    auto staging=beneath(canonical,".ps5library/staging/"+task["id"].string()+"/backport");fs::create_directories(staging);
    int64_t complete=0;auto files=bp["files"];
    for(size_t i=0;i<files.size();i++){
      const auto file=files[i];const auto size=file["size"].number();auto target=beneath(staging,file["path"].string());
      client.download("/api/v1/device/tasks/"+task["id"].string()+"/backport/"+std::to_string(i),target,size,file["sha256"].string(),[&](int64_t bytes,int64_t speed){progress(complete+bytes,speed);});complete+=size;
    }
    if(!verifyBackport(staging,bp))throw std::runtime_error("BACKPORT_FILES_MISMATCH");
    fs::create_directories(destination.parent_path());fs::rename(staging,destination);
  }
  if(!verifyBackport(destination,bp))throw std::runtime_error("BACKPORT_FILES_MISMATCH");
  return Json::object({{"root",selected.string()},{"relativePath","backports/"+title},{"files",bp["files"]}});
}
}
