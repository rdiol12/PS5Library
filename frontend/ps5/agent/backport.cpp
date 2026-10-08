#include "../common/client.hpp"
#include <exception>
#include <regex>
#include <set>
namespace ps5library {
static bool safeOverlayPath(const std::string& name){
  if(name.empty()||name[0]=='/'||name.find('\\')!=std::string::npos||!std::regex_match(name,std::regex("[A-Za-z0-9._/-]+")))return false;
  fs::path path(name);if(path.is_absolute()||path.lexically_normal().generic_string()!=name)return false;
  for(const auto& part:path)if(part=="."||part==".."||part.empty())return false;
  return true;
}
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
    if(files.size()>201)return false;
    for(size_t i=0;i<files.size();i++){
      const auto f=files[i];auto name=f["path"].string();if(!safeOverlayPath(name)||!expected.insert(name).second)return false;
      auto file=beneath(folder,name);if(!fs::is_regular_file(file)||static_cast<int64_t>(fs::file_size(file))!=f["size"].number()||fileHash(file)!=f["sha256"].string())return false;
    }
    for(const auto& entry:fs::recursive_directory_iterator(folder)){auto status=entry.symlink_status();if(fs::is_symlink(status)||(!fs::is_directory(status)&&!fs::is_regular_file(status))||(fs::is_regular_file(status)&&!expected.count(fs::relative(entry.path(),folder).generic_string())))return false;}
    return true;
  }catch(...){return false;}
}
void publishBackport(const fs::path& staging,const fs::path& destination,const fs::path& backup,bool managed,const std::function<bool(const fs::path&)>& verify){
  auto stageStatus=fs::symlink_status(staging),destinationStatus=fs::symlink_status(destination),backupStatus=fs::symlink_status(backup);
  if(!fs::is_directory(stageStatus)||fs::is_symlink(stageStatus)||fs::exists(backupStatus))throw std::runtime_error("BACKPORT_REPLACEMENT_UNSAFE");
  if(!verify(staging))throw std::runtime_error("BACKPORT_FILES_MISMATCH");
  const bool exists=fs::exists(destinationStatus);if(exists&&(fs::is_symlink(destinationStatus)||!fs::is_directory(destinationStatus)))throw std::runtime_error("BACKPORT_DESTINATION_CONFLICT");
  if(exists&&verify(destination)){fs::remove_all(staging);return;}if(exists&&!managed)throw std::runtime_error("BACKPORT_DESTINATION_CONFLICT");
  bool backedUp=false;try{fs::create_directories(destination.parent_path());if(exists){fs::rename(destination,backup);backedUp=true;}fs::rename(staging,destination);if(!verify(destination))throw std::runtime_error("BACKPORT_FILES_MISMATCH");}
  catch(...){auto failure=std::current_exception();std::error_code error;const bool published=fs::exists(destination,error);if(error)throw std::runtime_error("BACKPORT_ROLLBACK_FAILED");if(published){fs::remove_all(destination,error);if(error)throw std::runtime_error("BACKPORT_ROLLBACK_FAILED");}if(backedUp){fs::rename(backup,destination,error);if(error)throw std::runtime_error("BACKPORT_ROLLBACK_FAILED");}std::rethrow_exception(failure);}
  if(backedUp){std::error_code error;fs::remove_all(backup,error);if(error)throw std::runtime_error("BACKPORT_BACKUP_CLEANUP_FAILED");}
}
static bool ownsBackport(const fs::path& root,const fs::path& selected,const std::string& relative,const fs::path& marker){
  auto matches=[&](const Json& value){auto backport=value["backport"].null()?value:value["backport"];return fs::path(backport["root"].string()).lexically_normal()==selected&&backport["relativePath"].string()==relative&&backport["files"].size();};
  try{auto saved=readJsonIfPresent(marker,1024*1024);if(saved&&(*saved)["schemaVersion"].number()==1&&(*saved)["managedBy"].string()=="PS5Library"&&matches(*saved))return true;}catch(...){ }
  try{auto receipts=beneath(root,".ps5library/receipts");std::error_code error;auto status=fs::symlink_status(receipts,error);if(error||fs::is_symlink(status)||!fs::is_directory(status))return false;for(fs::directory_iterator it(receipts,fs::directory_options::skip_permission_denied,error),end;it!=end&&!error;it.increment(error)){auto entryStatus=it->symlink_status(error);if(error||fs::is_symlink(entryStatus)||!fs::is_regular_file(entryStatus)){error.clear();continue;}try{if(matches(readJson(it->path(),1024*1024)))return true;}catch(...){}}}catch(...){ }
  return false;
}
Json prepareBackport(Client& client,const fs::path& root,const Json& roots,const Json& task,const std::function<void(int64_t,int64_t)>& progress){
  const auto bp=task["backport"];if(bp.null()||bp["placement"].string()!="SCAN_PATH"||!bp["files"].size())return Json();
  const auto title=task["titleId"].string();if(!std::regex_match(title,std::regex("PPSA[0-9]{5}")))throw std::runtime_error("METADATA_MISMATCH");
  fs::path selected;auto canonical=fs::canonical(root);
  for(size_t i=0;i<roots.size();i++){
    fs::path scan=roots[i].string();if(!scan.is_absolute()||scan.lexically_normal()!=scan)throw std::runtime_error("UNSAFE_PATH");
    auto relative=scan.lexically_relative(canonical).generic_string();
    if(selected.empty()&&(relative=="."||(!relative.empty()&&relative.rfind("..",0)!=0))){selected=relative=="."?canonical:beneath(canonical,relative);}
  }
  if(selected.empty())throw std::runtime_error("BACKPORT_SCAN_PATH_MISSING");
  fs::create_directories(selected);const auto relative="backports/"+title;auto destination=beneath(selected,relative),job=beneath(canonical,".ps5library/staging/"+task["id"].string()),staging=beneath(job,"backport"),backup=beneath(job,"backport.previous"),marker=beneath(canonical,".ps5library/backports/"+title+".json");for(size_t i=0;i<roots.size();i++){fs::path scan=roots[i].string();if(fs::exists(scan)){auto old=beneath(scan,relative);if(old.lexically_normal()!=destination.lexically_normal()&&fs::exists(old)&&!verifyBackport(old,bp))throw std::runtime_error("BACKPORT_DESTINATION_CONFLICT");}}const auto owner=Json::object({{"schemaVersion",1},{"managedBy","PS5Library"},{"root",selected.string()},{"relativePath",relative},{"files",bp["files"]}});bool managed=ownsBackport(canonical,selected,relative,marker);
  if(fs::exists(destination)&&verifyBackport(destination,bp)){if(managed&&!fs::exists(marker))atomicJson(marker,owner);if(managed&&fs::exists(backup))fs::remove_all(backup);return Json::object({{"root",selected.string()},{"relativePath",relative},{"files",bp["files"]}});}
  if(fs::exists(destination)&&!managed)throw std::runtime_error("BACKPORT_DESTINATION_CONFLICT");
  if(fs::exists(backup)){if(!managed||fs::exists(destination))throw std::runtime_error("BACKPORT_REPLACEMENT_UNSAFE");fs::rename(backup,destination);}
  if(managed&&!fs::exists(marker))atomicJson(marker,owner);
  fs::create_directories(staging);int64_t complete=0;auto files=bp["files"];
  for(size_t i=0;i<files.size();i++){const auto file=files[i];const auto size=file["size"].number();auto target=beneath(staging,file["path"].string());client.download("/api/v1/device/tasks/"+task["id"].string()+"/backport/"+std::to_string(i),target,size,file["sha256"].string(),[&](int64_t bytes,int64_t speed){progress(complete+bytes,speed);});complete+=size;}
  publishBackport(staging,destination,backup,managed,[&](const fs::path& folder){return verifyBackport(folder,bp);});
  if(!managed)try{atomicJson(marker,owner);}catch(...){auto failure=std::current_exception();std::error_code error;fs::rename(destination,staging,error);if(error)throw std::runtime_error("BACKPORT_ROLLBACK_FAILED");std::rethrow_exception(failure);}
  if(!verifyBackport(destination,bp))throw std::runtime_error("BACKPORT_FILES_MISMATCH");
  return Json::object({{"root",selected.string()},{"relativePath",relative},{"files",bp["files"]}});
}
}
