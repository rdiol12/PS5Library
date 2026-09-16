#include "../common/client.hpp"
#include <atomic>
#include <thread>
#include <mutex>
#include <regex>
#include <cstring>
#include <cstdio>
#ifdef PS5
// Verified ABI: etaHEN pkg-writeup.md; cy33hc/ps5-ezremote-dpi cff181ca source/sceAppInstUtil.h.
struct PackageInfo {char contentId[48];int contentType,contentPlatform;};
struct MetaInfo {const char *uri,*extraUri,*scenario,*contentId,*name,*icon;};
struct PlayGoInfo {char languages[30][8],scenarios[64][3],contentIds[64][48];unsigned char reserved[6480];};
static_assert(sizeof(PackageInfo)==56&&sizeof(MetaInfo)==48&&sizeof(PlayGoInfo)==9984);
extern "C" int sceAppInstUtilInitialize();
extern "C" int sceAppInstUtilInstallByPackage(MetaInfo*,PackageInfo*,PlayGoInfo*);
#endif
namespace ps5library {
bool nativeDownloadsAvailable(){
#ifdef PS5
  static std::atomic<int> status{-1};static std::once_flag once;
  // Initialize off the render/heartbeat thread, once only. A hung initializer is never retried concurrently.
  std::call_once(once,[]{std::thread([]{status.store(sceAppInstUtilInitialize());}).detach();});return status.load()==0;
#else
  return false;
#endif
}
void startNativeDownload(const std::string& url,const std::string& contentId,const std::string& title){
  if(!nativeDownloadsAvailable())throw std::runtime_error("NATIVE_INSTALLER_UNAVAILABLE");
  if(url.size()>2048||(url.rfind("http://",0)!=0&&url.rfind("https://",0)!=0)||!std::regex_match(contentId,std::regex("[A-Z]{2}[0-9]{4}-PPSA[0-9]{5}_[0-9]{2}-[A-Z0-9]{16}"))||title.size()>200)throw std::runtime_error("UNSUPPORTED_INPUT");
#ifdef PS5
  PackageInfo info{};PlayGoInfo playgo{};MetaInfo meta{url.c_str(),"","",contentId.c_str(),title.c_str(),""};
  const int result=sceAppInstUtilInstallByPackage(&meta,&info,&playgo);
  if(result){char code[64];std::snprintf(code,sizeof(code),"NATIVE_INSTALL_REJECTED_%08X",static_cast<unsigned>(result));throw std::runtime_error(code);}
  if(std::string(info.contentId,strnlen(info.contentId,sizeof(info.contentId)))!=contentId)throw std::runtime_error("METADATA_MISMATCH");
  // Acceptance is not completion. Never call GetInstallStatus: upstream reports process crashes.
#endif
}
fs::path installedNativePackage(const std::string& titleId){
  if(!std::regex_match(titleId,std::regex("PPSA[0-9]{5}")))throw std::runtime_error("METADATA_MISMATCH");
  return beneath("/user","app/"+titleId+"/app.pkg");
}
bool nativePackageRegistered(const Json& task){
  try{
    auto metadata=readJson(beneath("/user","appmeta/"+task["titleId"].string()+"/param.json"));
    return metadata["titleId"].string()==task["titleId"].string()&&metadata["contentId"].string()==task["contentId"].string()&&metadata["contentVersion"].string()==task["version"].string();
  }catch(...){return false;}
}
}
