#include "../common/client.hpp"
#include <cassert>
#include <atomic>
#include <thread>
#include <chrono>
#include <cstring>
#include <poll.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
struct PackageInfo {char id[48];int type,platform;};
struct MetaInfo {const char *uri,*extra,*scenario,*id,*name,*icon;};
struct PlayGoInfo {char languages[30][8],scenarios[64][3],ids[64][48];unsigned char reserved[6480];};
struct InstallError {int32_t code,version;char description[512],type[9];};
struct InstallStatus {char status[16],source[8];uint32_t remaining;uint64_t downloaded,initial,total;uint32_t promote;InstallError error;int32_t copyPercent;bool copyOnly;};
static std::atomic<int> initialized{0};static int requests=0,result=0,statusResult=0,statusRequests=0,uninstallRequests=0,existsRequests=0,moveRequests=0,moveCancels=0,moveSource=0,moveDestination=0,moveState=0;static std::string uninstalled,movedTitle;static InstallStatus reported{};
static void sendAll(int fd,const char* data,size_t size){while(size){auto n=send(fd,data,size,0);assert(n>0);data+=n;size-=static_cast<size_t>(n);}}
static void serve(int listener,const std::string& payload,std::atomic<bool>& stop,std::atomic<int>& ranges,std::atomic<int>& reports){
  while(!stop){pollfd ready{listener,POLLIN,0};if(poll(&ready,1,100)<=0)continue;int client=accept(listener,nullptr,nullptr);if(client<0)continue;
    std::string request;char buffer[4096];while(request.find("\r\n\r\n")==std::string::npos&&request.size()<16384){auto n=recv(client,buffer,sizeof(buffer),0);if(n<=0)break;request.append(buffer,static_cast<size_t>(n));}
    if(request.rfind("GET /api/v1/file ",0)==0){
      auto at=request.find("Range: bytes=");assert(at!=std::string::npos);at+=13;auto dash=request.find('-',at),end=request.find("\r\n",dash);assert(dash!=std::string::npos&&end!=std::string::npos);
      auto first=std::stoull(request.substr(at,dash-at)),last=std::stoull(request.substr(dash+1,end-dash-1));assert(first<=last&&last<payload.size());ranges++;
      auto header="HTTP/1.1 206 Partial Content\r\nContent-Type: application/octet-stream\r\nContent-Length: "+std::to_string(last-first+1)+"\r\nConnection: close\r\n\r\n";
      sendAll(client,header.data(),header.size());sendAll(client,payload.data()+first,last-first+1);
    }else{assert(request.rfind("POST /api/v1/progress ",0)==0);reports++;constexpr char response[]="HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}";sendAll(client,response,sizeof(response)-1);}
    close(client);
  }
}
extern "C" int sceAppInstUtilInitialize(){initialized++;std::this_thread::sleep_for(std::chrono::milliseconds(40));return 0;}
extern "C" int sceAppInstUtilInstallByPackage(MetaInfo* meta,PackageInfo* info,PlayGoInfo* playgo){
  requests++;assert(std::string(meta->uri)=="https://configured.example/api/v1/native-downloads/job/token/game.pkg");assert(std::string(meta->name)=="Owned homebrew");assert(std::string(meta->icon)=="https://configured.example/api/v1/native-downloads/job/icon-token/icon.png");assert(playgo->reserved[6479]==0);
  std::strncpy(info->id,meta->id,47);return result;
}
extern "C" int sceAppInstUtilGetInstallStatus(const char* id,InstallStatus* status){
  statusRequests++;assert(std::string(id)=="IV0000-PPSA99991_00-PS5LIBRARYTEST01");*status=reported;return statusResult;
}
extern "C" int sceAppInstUtilAppUnInstall(const char* id){uninstallRequests++;uninstalled=id;return 0;}
extern "C" int testAppExists(const char* id,unsigned char* exists){existsRequests++;assert(std::string(id)=="PPSA99991"&&*exists==0);*exists=1;return 0;}
extern "C" int testGetStorage(const char* id,int* storage){assert(std::string(id)=="IV0000-PPSA99991_00-PS5LIBRARYTEST01");*storage=moveSource+1;return 0;}
extern "C" int testRequestMove(int source,int destination,const char* ids,size_t count,int option){moveRequests++;moveDestination=destination;movedTitle=ids;assert(source==moveSource&&count==1&&option==0);return 0;}
extern "C" int testGetMoveProgress(void* raw){std::memset(raw,0,0x150);std::memcpy(raw,&moveState,sizeof(moveState));return 0;}
extern "C" int testCancelMove(){moveCancels++;return 0;}
extern "C" void* __wrap_dlopen(const char*,int){return reinterpret_cast<void*>(1);}
extern "C" void* __wrap_dlsym(void*,const char* name){
  if(!std::strcmp(name,"sceAppInstUtilAppExists"))return reinterpret_cast<void*>(&testAppExists);
  if(!std::strcmp(name,"sceAppInstUtilAppGetStorageDestType"))return reinterpret_cast<void*>(&testGetStorage);
  if(!std::strcmp(name,"sceAppInstUtilAppRequestMoveApps"))return reinterpret_cast<void*>(&testRequestMove);
  if(!std::strcmp(name,"sceAppInstUtilGetAppMoveProgressInfo"))return reinterpret_cast<void*>(&testGetMoveProgress);
  if(!std::strcmp(name,"sceAppInstUtilAppCancelMoveApps"))return reinterpret_cast<void*>(&testCancelMove);
  return nullptr;
}
int main(){using namespace ps5library;
  assert(!nativeDownloadsAvailable());for(int i=0;i<100&&initialized.load()!=1;i++)std::this_thread::sleep_for(std::chrono::milliseconds(2));assert(initialized==1);assert(!nativeApiMutex().try_lock());for(int i=0;i<200&&!nativeDownloadsAvailable();i++)std::this_thread::sleep_for(std::chrono::milliseconds(2));assert(nativeDownloadsAvailable());assert(nativeMovesAvailable());
  const std::string url="https://configured.example/api/v1/native-downloads/job/token/game.pkg",icon="https://configured.example/api/v1/native-downloads/job/icon-token/icon.png",id="IV0000-PPSA99991_00-PS5LIBRARYTEST01";
  startNativeDownload(url,id,"Owned homebrew",icon);assert(requests==1);
  std::strncpy(reported.status,"downloading",sizeof(reported.status)-1);reported.remaining=12;reported.downloaded=345;reported.total=1000;reported.promote=4;reported.copyPercent=7;
  auto status=nativeDownloadStatus(id);assert(status["available"].boolean()&&status["status"].string()=="downloading"&&status["downloadedBytes"].number()==345&&status["totalBytes"].number()==1000&&status["remainingSeconds"].number()==12&&status["promoteProgress"].number()==4&&status["localCopyPercent"].number()==7&&statusRequests==1);
  reported.error.code=-77;status=nativeDownloadStatus(id);assert(status["errorCode"].number()==-77);reported.error.code=0;
  statusResult=-9;status=nativeDownloadStatus(id);assert(!status["available"].boolean()&&status["result"].number()==-9);statusResult=0;
  result=-7;bool rejected=false;try{startNativeDownload(url,id,"Owned homebrew",icon);}catch(const std::exception& e){rejected=std::string(e.what()).rfind("NATIVE_INSTALL_REJECTED_",0)==0;}assert(rejected);
  rejected=false;try{startNativeDownload(url,"IV0000-NPXS99991_00-PS5LIBRARYTEST01","Owned homebrew",icon);}catch(...){rejected=true;}assert(rejected&&requests==2);
  auto submissionRoot=fs::temp_directory_path()/randomHex(8),marker=submissionRoot/"native.json";const std::string submissionHash(64,'a');
  rejected=false;try{submitNativeDownload(marker,submissionHash,"https://configured.example","console-1",url,id,"Owned homebrew",icon);}catch(const NativeSubmissionRejected&){rejected=true;}assert(rejected&&!fs::exists(marker));
  result=0;submitNativeDownload(marker,submissionHash,"https://configured.example","console-1",url,id,"Owned homebrew",icon);assert(inspectNativeSubmission(marker,submissionHash,"https://configured.example","console-1",false)==NativeSubmissionDecision::Monitor);fs::remove_all(submissionRoot);
  uninstallNativeTitle("PPSA99991");assert(uninstallRequests==1&&uninstalled=="PPSA99991");
  rejected=false;try{uninstallNativeTitle("../PPSA99991");}catch(...){rejected=true;}assert(rejected&&uninstallRequests==1);
  assert(nativeMoveStorageType("/user","","")==0&&nativeMoveStorageType("/mnt/ext0","/dev/da1p1.crypt","ufs")==1&&nativeMoveStorageType("/mnt/ext1","/dev/ssd1.user","bfs")==2);
  assert(nativeMoveStorageType("/mnt/usb0","/dev/da1p1","exfatfs")==-1&&nativeMoveStorageType("/mnt/ext0","/dev/da1p1","bfs")==-1&&nativeMoveStorageType("/mnt/ext0","/dev/da1p1.crypt","exfatfs")==-1&&nativeMoveStorageType("/mnt/ext1","/dev/da1p1","bfs")==-1);
  auto moveVolumes=Json::array();moveVolumes.add(Json::object({{"storageId","internal-installed"},{"path","/user"},{"nativeMoveStorageType",int64_t(0)}}));moveVolumes.add(Json::object({{"storageId","ext0"},{"path","/mnt/ext0"},{"nativeMoveStorageType",int64_t(1)}}));moveVolumes.add(Json::object({{"storageId","ext1"},{"path","/mnt/ext1"},{"nativeMoveStorageType",int64_t(2)}}));moveVolumes.add(Json::object({{"storageId","usb0"},{"path","/mnt/usb0"},{"nativeMoveStorageType",int64_t(-1)}}));
  assert(nativeMoveTargetAvailable(moveVolumes,0)&&nativeMoveTargetAvailable(moveVolumes,1)&&nativeMoveTargetAvailable(moveVolumes,2));auto rawOnly=Json::array();rawOnly.add(moveVolumes[size_t(0)]);rawOnly.add(moveVolumes[size_t(3)]);assert(!nativeMoveTargetAvailable(rawOnly,0));
  moveSource=0;nativeMoveTitle("PPSA99991",id,0,1);assert(existsRequests==1&&moveRequests==1&&moveDestination==1&&movedTitle=="PPSA99991");
  moveState=2;rejected=false;try{nativeMoveTitle("PPSA99991",id,0,1);}catch(...){rejected=true;}assert(rejected&&moveRequests==1);
  moveState=0;moveSource=2;rejected=false;try{nativeMoveTitle("PPSA99991",id,0,1);}catch(...){rejected=true;}assert(rejected&&moveRequests==1);
  cancelNativeMove();assert(moveCancels==1);
  auto movedRoot=fs::temp_directory_path()/randomHex(8),movedPackage=movedRoot/"user/app/PPSA99991/app.pkg";fs::create_directories(movedPackage.parent_path());atomicBytes(movedPackage,"moved package");auto movedVolumes=Json::array();movedVolumes.add(Json::object({{"storageId","ext0"},{"path",movedRoot.string()},{"nativeMoveStorageType",int64_t(1)}}));auto moved=Json::object({{"titleId","PPSA99991"},{"storageId","ext0"},{"relativePath","app/PPSA99991"},{"nativeRegistered",true}});assert(observedNativePackage(moved,movedVolumes)==movedPackage);auto movedReceipt=Json::object({{"size",static_cast<int64_t>(fs::file_size(movedPackage))},{"sha256",fileHash(movedPackage)}});std::unordered_map<std::string,std::pair<fs::file_time_type,std::string>> movedCache;assert(verifiedReceiptFile(movedPackage,movedReceipt,movedCache,{}));movedReceipt.set("sha256",std::string(64,'0'));assert(!verifiedReceiptFile(movedPackage,movedReceipt,movedCache,{}));movedVolumes[size_t(0)].set("nativeMoveStorageType",int64_t(-1));assert(observedNativePackage(moved,movedVolumes).empty());fs::remove_all(movedRoot);
  Client client(Json::object({{"serverUrl","https://configured.example"}}));const std::string job="00000000-0000-4000-8000-000000000000",grant(64,'a'),packageHash(64,'b');assert(client.nativeDownloadUrl("/api/v1/native-downloads/"+job+"/"+grant+"/game.pkg")=="https://configured.example/api/v1/native-downloads/"+job+"/"+grant+"/game.pkg");assert(client.nativeUpdateUrl("/api/v1/native-updates/PPSA99051/47/packages/"+packageHash+".pkg")=="https://configured.example/api/v1/native-updates/PPSA99051/47/packages/"+packageHash+".pkg");assert(client.nativeUpdateUrl("/api/v1/native-updates/grants/"+grant+"/PPSA99051/icon.png")=="https://configured.example/api/v1/native-updates/grants/"+grant+"/PPSA99051/icon.png");
  rejected=false;try{client.nativeDownloadUrl("https://another.example/game.pkg");}catch(...){rejected=true;}assert(rejected);rejected=false;try{client.nativeDownloadUrl("/api/v1/native-updates/PPSA99051/47/packages/"+packageHash+".pkg");}catch(...){rejected=true;}assert(rejected);rejected=false;try{client.nativeUpdateUrl("/api/v1/native-updates/PPSA99999/47/packages/"+packageHash+".pkg");}catch(...){rejected=true;}assert(rejected);
  int listener=socket(AF_INET,SOCK_STREAM,0);assert(listener>=0);sockaddr_in address{};address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);assert(bind(listener,reinterpret_cast<sockaddr*>(&address),sizeof(address))==0&&listen(listener,4)==0);socklen_t addressSize=sizeof(address);assert(getsockname(listener,reinterpret_cast<sockaddr*>(&address),&addressSize)==0);
  std::string payload(4*1024*1024+17,'x');auto root=fs::temp_directory_path()/randomHex(8),source=root/"source",part=root/"part";fs::create_directories(root);atomicBytes(source,payload);auto hash=fileHash(source);
  std::atomic<bool> stop{false};std::atomic<int> ranges{0},reports{0};std::thread server(serve,listener,std::cref(payload),std::ref(stop),std::ref(ranges),std::ref(reports));
  Client ranged(Json::object({{"serverUrl","http://127.0.0.1:"+std::to_string(ntohs(address.sin_port))},{"allowInsecureLan",true}}));
  ranged.download("/api/v1/file",part,payload.size(),hash,[&](int64_t,int64_t){ranged.request("POST","/api/v1/progress",Json::object());});
  stop=true;shutdown(listener,SHUT_RDWR);close(listener);server.join();assert(fileHash(part)==hash&&ranges==2&&reports==2);fs::remove_all(root);
}
