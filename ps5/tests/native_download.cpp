#include "../common/client.hpp"
#include <cassert>
#include <atomic>
#include <thread>
#include <chrono>
#include <cstring>
struct PackageInfo {char id[48];int type,platform;};
struct MetaInfo {const char *uri,*extra,*scenario,*id,*name,*icon;};
struct PlayGoInfo {char languages[30][8],scenarios[64][3],ids[64][48];unsigned char reserved[6480];};
static std::atomic<int> initialized{0};static int requests=0,result=0;
extern "C" int sceAppInstUtilInitialize(){initialized++;std::this_thread::sleep_for(std::chrono::milliseconds(40));return 0;}
extern "C" int sceAppInstUtilInstallByPackage(MetaInfo* meta,PackageInfo* info,PlayGoInfo* playgo){
  requests++;assert(std::string(meta->uri)=="https://configured.example/api/v1/native-downloads/job/token/game.pkg");assert(std::string(meta->name)=="Owned homebrew");assert(playgo->reserved[6479]==0);
  std::strncpy(info->id,meta->id,47);return result;
}
int main(){using namespace ps5library;
  assert(!nativeDownloadsAvailable());for(int i=0;i<100&&!nativeDownloadsAvailable();i++)std::this_thread::sleep_for(std::chrono::milliseconds(2));assert(nativeDownloadsAvailable());assert(initialized==1);
  const std::string url="https://configured.example/api/v1/native-downloads/job/token/game.pkg",id="IV0000-PPSA99991_00-PS5LIBRARYTEST01";
  startNativeDownload(url,id,"Owned homebrew");assert(requests==1);
  result=-7;bool rejected=false;try{startNativeDownload(url,id,"Owned homebrew");}catch(const std::exception& e){rejected=std::string(e.what()).rfind("NATIVE_INSTALL_REJECTED_",0)==0;}assert(rejected);
  rejected=false;try{startNativeDownload(url,"IV0000-NPXS99991_00-PS5LIBRARYTEST01","Owned homebrew");}catch(...){rejected=true;}assert(rejected&&requests==2);
  Client client(Json::object({{"serverUrl","https://configured.example"}}));assert(client.nativeDownloadUrl("/api/v1/native-downloads/job/token/game.pkg")==url);
  rejected=false;try{client.nativeDownloadUrl("https://another.example/game.pkg");}catch(...){rejected=true;}assert(rejected);
}
