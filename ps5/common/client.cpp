#include "client.hpp"
#include "version.hpp"
#include <cstdlib>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <fstream>
#include <vector>
#include <chrono>
#include <cstdio>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <sys/time.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <algorithm>
#include <cerrno>
#include <charconv>
#include <memory>
#include <mutex>
#include <regex>
#include <cctype>
#include <cstddef>
#include <csignal>
#include <cstring>
#include <ctime>
#ifdef PS5
#include <ps5/kernel.h>
extern "C" int sceNotificationSend(int, bool, const char*);
union SceNetCtlInfo { char ip_address[16]; unsigned char storage[256]; };
static_assert(sizeof(SceNetCtlInfo)==256);
extern "C" int sceNetCtlInit();
extern "C" int sceNetCtlGetInfo(int32_t,SceNetCtlInfo*);
#endif
namespace ps5library {
static CURLcode perform(CURL* curl){static std::mutex mutex;std::lock_guard lock(mutex);return curl_easy_perform(curl);}
static bool privateHttpHost(std::string host){
  if(host.size()>2&&host.front()=='['&&host.back()==']')host=host.substr(1,host.size()-2);
  std::transform(host.begin(),host.end(),host.begin(),[](unsigned char c){return static_cast<char>(std::tolower(c));});
  if(host=="localhost"||(host.size()>6&&host.compare(host.size()-6,6,".local")==0))return true;
#ifndef PS5
  if(host=="host.docker.internal")return true;
#endif
  in_addr ipv4{};if(inet_pton(AF_INET,host.c_str(),&ipv4)==1){const auto* b=reinterpret_cast<const unsigned char*>(&ipv4);return b[0]==10||b[0]==127||(b[0]==172&&b[1]>=16&&b[1]<=31)||(b[0]==192&&b[1]==168)||(b[0]==169&&b[1]==254)||(b[0]==100&&b[1]>=64&&b[1]<=127);}
#ifndef PS5
  in6_addr ipv6{};if(inet_pton(AF_INET6,host.c_str(),&ipv6)==1){const auto* b=ipv6.s6_addr;bool loopback=true;for(int i=0;i<15;i++)loopback=loopback&&b[i]==0;return (loopback&&b[15]==1)||(b[0]&0xfe)==0xfc||(b[0]==0xfe&&(b[1]&0xc0)==0x80);}
#endif
  return false;
}
Json readJson(const fs::path& filename) { std::ifstream file(filename); if(!file || fs::file_size(filename)>8*1024*1024) throw std::runtime_error("Cannot read configuration/state"); return Json::parse(std::string(std::istreambuf_iterator<char>(file),{})); }
std::string normalizeServerUrl(const std::string& input,bool allowHttp) {
  auto first=input.find_first_not_of(" \t\r\n"),last=input.find_last_not_of(" \t\r\n");
  if(first==std::string::npos||input.size()>2048)throw std::runtime_error("Enter your server's full HTTPS address");
  auto value=input.substr(first,last-first+1);
  std::unique_ptr<CURLU,decltype(&curl_url_cleanup)> url(curl_url(),curl_url_cleanup);
  if(!url||curl_url_set(url.get(),CURLUPART_URL,value.c_str(),0)!=CURLUE_OK)throw std::runtime_error("Invalid server address");
  auto part=[&](CURLUPart name,unsigned flags=0){char* text=nullptr;curl_url_get(url.get(),name,&text,flags);std::string result=text?text:"";curl_free(text);return result;};
  auto scheme=part(CURLUPART_SCHEME),host=part(CURLUPART_HOST);
  if(scheme!="https"&&!(allowHttp&&scheme=="http"&&privateHttpHost(host)))throw std::runtime_error("Use HTTPS, or HTTP only for a private LAN address");
  if(host.empty()||part(CURLUPART_PATH)!="/"||value.find('@')!=std::string::npos||value.find('?')!=std::string::npos||value.find('#')!=std::string::npos)throw std::runtime_error("Use the server address without a path, password, query or fragment");
  std::transform(host.begin(),host.end(),host.begin(),[](unsigned char c){return static_cast<char>(std::tolower(c));});curl_url_set(url.get(),CURLUPART_HOST,host.c_str(),0);
  value=part(CURLUPART_URL,CURLU_NO_DEFAULT_PORT);if(!value.empty()&&value.back()=='/')value.pop_back();return value;
}
Json readConfig(const fs::path& filename){
  if(fs::exists(filename)){auto config=readJson(filename);if(const auto* launcher=std::getenv("PS5LIBRARY_LAUNCHER_URL"))config.set("launcherUrl",normalizeServerUrl(launcher,true));return config;}
  auto value=Json::object({{"serverUrl",""},{"name","My PS5"},{"runtime","unknown"},{"allowInsecureLan",false}});
#ifdef PS5
  value.set("font",(filename.parent_path()/"DejaVuSans.ttf").string());value.set("caBundle",(filename.parent_path()/"ca-bundle.crt").string());
  auto stores=Json::array();stores.add(Json::object({{"storageId","internal"},{"displayName","Internal Storage"},{"path","/data"}}));stores.add(Json::object({{"storageId","usb0"},{"displayName","USB SSD"},{"path","/mnt/usb0"}}));value.set("storage",stores);
#endif
  return value;
}
Json loadDeviceState(const fs::path& configPath,const Json& config){auto server=normalizeServerUrl(config["serverUrl"].string(),config["allowInsecureLan"].boolean());auto path=configPath.parent_path()/"device-state.json";auto state=fs::exists(path)?readJson(path):Json::object({{"deviceId",deviceId()},{"libraryRevision",int64_t(0)}});if(state["serverUrl"].null()&&!state["credential"].string().empty())throw std::runtime_error("Device credential has no server binding; reset and pair again");if(!state["serverUrl"].null()&&normalizeServerUrl(state["serverUrl"].string(),true)!=server)throw std::runtime_error("Server address changed; reset the local device identity before pairing to the new server");state.set("serverUrl",server);return state;}
void atomicBytes(const fs::path& filename,std::string_view data) {
#ifdef PS5
  // This is the last writer proven on real PS5 title sandboxes. The stronger
  // directory-fd variant introduced after 0.2.34 crashes firmware 4.51.
  fs::create_directories(fs::absolute(filename).parent_path());auto temp=filename.string()+".tmp";
  int fd=open(temp.c_str(),O_CREAT|O_TRUNC|O_WRONLY|O_NOFOLLOW,0600);if(fd<0)throw std::runtime_error("Cannot write state");
  size_t written=0;while(written<data.size()){auto n=write(fd,data.data()+written,data.size()-written);if(n<0&&errno==EINTR)continue;if(n<=0){close(fd);throw std::runtime_error("State write failed");}written+=static_cast<size_t>(n);}
  if(fsync(fd)!=0){close(fd);throw std::runtime_error("State sync failed");}close(fd);fs::rename(temp,filename);return;
#else
  constexpr mode_t mode=0600;
  auto path=fs::absolute(filename),parent=path.parent_path();fs::create_directories(parent);auto leaf=path.filename().string();if(leaf.empty()||leaf=="."||leaf=="..")throw std::runtime_error("Cannot write state");
  struct stat parentStatus{};if(lstat(parent.c_str(),&parentStatus)!=0||!S_ISDIR(parentStatus.st_mode)||S_ISLNK(parentStatus.st_mode))throw std::runtime_error("Cannot write state");
  int directory=open(parent.c_str(),O_RDONLY|O_DIRECTORY|O_NOFOLLOW);if(directory<0)throw std::runtime_error("Cannot write state");struct Directory {int fd;~Directory(){close(fd);}} directoryGuard{directory};struct stat openedParent{};if(fstat(directory,&openedParent)!=0||openedParent.st_dev!=parentStatus.st_dev||openedParent.st_ino!=parentStatus.st_ino)throw std::runtime_error("Cannot write state");
  int fd=-1;fs::path temp;for(int attempt=0;attempt<8;attempt++){temp=parent/("."+leaf+".tmp-"+randomHex(12));fd=open(temp.c_str(),O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW,mode);if(fd>=0)break;if(errno!=EEXIST)throw std::runtime_error("Cannot write state");}if(fd<0)throw std::runtime_error("Cannot write state");
  struct Temporary {int fd;fs::path name;bool renamed=false;~Temporary(){if(fd>=0)close(fd);if(!renamed)unlink(name.c_str());}} temporary{fd,temp};struct stat created{};if(fstat(fd,&created)!=0||!S_ISREG(created.st_mode)||created.st_nlink!=1)throw std::runtime_error("Cannot write state");
  size_t written=0;
  while(written<data.size()) { auto n=write(fd,data.data()+written,data.size()-written);if(n<0&&errno==EINTR)continue;if(n<=0)throw std::runtime_error("State write failed");written+=static_cast<size_t>(n); }
  if(fchmod(fd,mode)!=0||fsync(fd)!=0)throw std::runtime_error("State sync failed");close(fd);temporary.fd=-1;
  struct stat currentParent{};if(lstat(parent.c_str(),&currentParent)!=0||currentParent.st_dev!=openedParent.st_dev||currentParent.st_ino!=openedParent.st_ino)throw std::runtime_error("Cannot publish state");fs::rename(temp,path);temporary.renamed=true;if(fsync(directory)!=0)throw std::runtime_error("State sync failed");
#endif
}
void atomicJson(const fs::path& filename,const Json& value){atomicBytes(filename,value.dump());}
Json pairFrontend(const fs::path& configPath,const Json& config,const std::function<bool()>& cancelled){
  auto state=loadDeviceState(configPath,config);auto path=configPath.parent_path()/"device-state.json";
  if(!state["credential"].string().empty())return state;
  // Persist the app identity before making a request, including failed requests.
  atomicJson(path,state);Client client(config);client.cancelled=cancelled;
  if(!state["pairing"].null()){
    Json result;
    try{result=client.request("POST","/api/v1/pairings/"+state["pairing"]["id"].string()+"/poll",Json::object({{"pollSecret",state["pairing"]["pollSecret"]}}));}
    catch(const RequestError& e){if(e.status!=410)throw;state.set("pairing",Json());atomicJson(path,state);}
    if(result["status"].string()=="PAIRED"){
      auto credential=result["credential"].string();
      if(credential.size()!=64||credential.find_first_not_of("0123456789abcdef")!=std::string::npos||result["consoleId"].string().empty())throw std::runtime_error("Invalid pairing response");
      state.set("credential",credential);state.set("consoleId",result["consoleId"]);state.set("pairing",Json());atomicJson(path,state);return state;
    }
  }
  if(state["pairing"].null()){
    state.set("pairing",client.request("POST","/api/v1/frontend/pairings",Json::object({{"deviceId",state["deviceId"]}})));
    atomicJson(path,state);
  }
  return state;
}
std::string localAgentAddress(){
#ifdef PS5
  static const int initialized=sceNetCtlInit();(void)initialized;SceNetCtlInfo info{};if(sceNetCtlGetInfo(14,&info)<0)throw std::runtime_error("Console network unavailable");auto length=strnlen(info.ip_address,sizeof(info.ip_address));if(!length||length==sizeof(info.ip_address))throw std::runtime_error("Console network unavailable");std::string address(info.ip_address,length);if(!privateHttpHost(address))throw std::runtime_error("Console private address unavailable");return address;
#else
  return "127.0.0.1";
#endif
}
std::string localAgentUrl(){return "http://"+localAgentAddress()+":"+std::to_string(localAgentPort);}
Json localAgentRequest(const std::string& method,const std::string& path,uint16_t port,const fs::path& requestedSocket){
  const auto socketPath=requestedSocket;
  if((method!="GET"&&method!="POST")||(!port&&socketPath.empty())||path.rfind("/api/v1/agent/",0)!=0||path.find("..")!=std::string::npos||path.find_first_of("?#\\\r\n ")!=std::string::npos)throw std::runtime_error("Invalid local agent request");
  int socketFd=socket(socketPath.empty()?AF_INET:AF_UNIX,SOCK_STREAM,0);if(socketFd<0)throw std::runtime_error("Local agent unavailable");struct Socket {int fd;~Socket(){close(fd);}} socketGuard{socketFd};timeval timeout{10,0};setsockopt(socketFd,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout));setsockopt(socketFd,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof(timeout));
  std::signal(SIGPIPE,SIG_IGN);
  std::string host="127.0.0.1";
  if(socketPath.empty()){host=localAgentAddress();sockaddr_in address{};address.sin_family=AF_INET;address.sin_port=htons(port);if(inet_pton(AF_INET,host.c_str(),&address.sin_addr)!=1)throw std::runtime_error("Invalid local agent address");
#ifdef PS5
    address.sin_len=sizeof(address);
#endif
    if(connect(socketFd,reinterpret_cast<sockaddr*>(&address),sizeof(address))!=0)throw std::runtime_error("Local agent unavailable (connect "+std::to_string(errno)+")");}
  else {auto value=socketPath.string();sockaddr_un address{};if(value.empty()||value.size()>=sizeof(address.sun_path))throw std::runtime_error("Invalid local agent socket");address.sun_family=AF_UNIX;std::memcpy(address.sun_path,value.c_str(),value.size()+1);auto size=static_cast<socklen_t>(offsetof(sockaddr_un,sun_path)+value.size()+1);
#ifdef PS5
    address.sun_len=static_cast<unsigned char>(size);
#endif
    if(connect(socketFd,reinterpret_cast<sockaddr*>(&address),size)!=0)throw std::runtime_error("Local agent unavailable (connect "+std::to_string(errno)+")");}
  auto request=method+" "+path+" HTTP/1.1\r\nHost: "+host+"\r\nAuthorization: Bearer "+localAgentCredential+"\r\nConnection: close\r\nContent-Length: 0\r\n\r\n";size_t sent=0;while(sent<request.size()){
#ifdef MSG_NOSIGNAL
    auto count=send(socketFd,request.data()+sent,request.size()-sent,MSG_NOSIGNAL);
#else
    auto count=send(socketFd,request.data()+sent,request.size()-sent,0);
#endif
    if(count<0&&errno==EINTR)continue;if(count<=0)throw std::runtime_error("Local agent request failed");sent+=static_cast<size_t>(count);
  }
  constexpr size_t limit=12*1024*1024,headerLimit=16*1024;std::string response;char bytes[16*1024];for(;;){auto count=recv(socketFd,bytes,sizeof(bytes),0);if(count<0&&errno==EINTR)continue;if(count<0)throw std::runtime_error("Local agent response failed");if(!count)break;if(response.size()+static_cast<size_t>(count)>limit+headerLimit)throw std::runtime_error("Local agent response too large");response.append(bytes,static_cast<size_t>(count));}
  auto headersEnd=response.find("\r\n\r\n"),lineEnd=response.find("\r\n");if(headersEnd==std::string::npos||headersEnd>headerLimit||lineEnd==std::string::npos||response.rfind("HTTP/1.1 ",0)!=0)throw std::runtime_error("Invalid local agent response");long status=0;auto statusText=std::string_view(response).substr(9,3);auto statusParse=std::from_chars(statusText.data(),statusText.data()+statusText.size(),status);if(statusParse.ec!=std::errc()||statusParse.ptr!=statusText.data()+statusText.size())throw std::runtime_error("Invalid local agent response");
  const std::string lengthHeader="\r\nContent-Length: ";auto lengthAt=response.find(lengthHeader);if(lengthAt==std::string::npos||lengthAt>headersEnd)throw std::runtime_error("Invalid local agent response");lengthAt+=lengthHeader.size();auto lengthEnd=response.find("\r\n",lengthAt);if(lengthEnd==std::string::npos||lengthEnd>headersEnd)throw std::runtime_error("Invalid local agent response");uint64_t length=0;auto lengthParse=std::from_chars(response.data()+lengthAt,response.data()+lengthEnd,length);if(lengthParse.ec!=std::errc()||lengthParse.ptr!=response.data()+lengthEnd||length>limit||response.size()-headersEnd-4!=length)throw std::runtime_error("Incomplete local agent response");auto result=Json::parse(response.substr(headersEnd+4));if(status<200||status>=300)throw RequestError(status,result["error"].string("Local agent error"));return result;
}
Json saveServerSettings(const fs::path& configPath,const std::string& input,bool allowHttp,bool resetPairing){
  auto path=fs::absolute(configPath);
  auto server=normalizeServerUrl(input,allowHttp);fs::create_directories(path.parent_path());
  int lock=open((path.parent_path()/"agent.lock").c_str(),O_CREAT|O_RDWR|O_NOFOLLOW,0600);
  if(lock<0)throw std::runtime_error("Cannot access console settings");
  if(flock(lock,LOCK_EX|LOCK_NB)!=0){close(lock);throw std::runtime_error("Stop the separate PS5Library agent before changing servers");}
  try{auto config=readConfig(path);auto statePath=path.parent_path()/"device-state.json";bool hadState=fs::exists(statePath);auto state=hadState?readJson(statePath):Json();
    bool changed=true;try{changed=normalizeServerUrl(state["serverUrl"].string(),true)!=server;}catch(const std::exception&){ }
    if(changed&&!state["credential"].string().empty()&&!resetPairing)throw PairingResetRequired();
    if(changed){
      auto previous=Json::object({{"serverUrl",state["serverUrl"]},{"deviceId",state["deviceId"]},{"consoleId",state["consoleId"]},{"libraryRevision",state["libraryRevision"]}});
      atomicJson(path.parent_path()/"previous-server.json",Json::object({{"config",config},{"device",previous}}));
      atomicJson(statePath,Json::object({{"serverUrl",server},{"deviceId",deviceId()},{"libraryRevision",int64_t(0)}}));
    }
    auto next=Json::parse(config.dump());next.set("serverUrl",server);next.set("allowInsecureLan",allowHttp);
    try{atomicJson(path,next);}catch(...){if(changed){if(hadState)atomicJson(statePath,state);else fs::remove(statePath);}throw;}
    close(lock);return next;
  }catch(...){close(lock);throw;}
}
std::string randomHex(size_t bytes) { std::vector<unsigned char> data(bytes); if(RAND_bytes(data.data(),static_cast<int>(bytes))!=1) throw std::runtime_error("Secure random unavailable"); std::string out; for(auto b:data) { out+="0123456789abcdef"[b>>4]; out+="0123456789abcdef"[b&15]; } return out; }
std::string deviceId() { auto id=randomHex(16); id[12]='4'; id[16]='8'; return id.substr(0,8)+"-"+id.substr(8,4)+"-"+id.substr(12,4)+"-"+id.substr(16,4)+"-"+id.substr(20); }
std::string fileHash(const fs::path& filename,const std::function<bool()>& cancelled) {
  std::ifstream file(filename,std::ios::binary); if(!file) throw std::runtime_error("File missing");
  auto* ctx=EVP_MD_CTX_new(); EVP_DigestInit_ex(ctx,EVP_sha256(),nullptr); std::vector<char> buffer(1024*1024);
  while(file) {if(cancelled&&cancelled()){EVP_MD_CTX_free(ctx);throw std::runtime_error("Verification aborted");}file.read(buffer.data(),buffer.size()); EVP_DigestUpdate(ctx,buffer.data(),static_cast<size_t>(file.gcount())); }
  if(!file.eof()) { EVP_MD_CTX_free(ctx); throw std::runtime_error("File read failed"); }
  unsigned char digest[32]; unsigned length=0; EVP_DigestFinal_ex(ctx,digest,&length); EVP_MD_CTX_free(ctx);
  std::string out; for(unsigned i=0;i<length;i++) { out+="0123456789abcdef"[digest[i]>>4]; out+="0123456789abcdef"[digest[i]&15]; } return out;
}
fs::path beneath(const fs::path& root,const std::string& relative) {
  if(relative.empty() || relative.front()=='/' || relative.find('\\')!=std::string::npos || relative.find(':')!=std::string::npos || relative.find('\n')!=std::string::npos || relative.find('\r')!=std::string::npos) throw std::runtime_error("Unsafe path");
  fs::path value=fs::canonical(root); for(const auto& component:fs::path(relative)) {
    if(component==".." || component=="." || component.empty()) throw std::runtime_error("Unsafe path");
    value/=component;
    if(fs::is_symlink(fs::symlink_status(value))) throw std::runtime_error("Symlinks are not allowed");
  } return value;
}
std::string notificationPayload(const std::string& message,const std::string& createdAt,const std::string& id,const std::string& icon,const std::string& title){
  auto view=Json::object({{"icon",Json::object({{"type","Url"},{"parameters",Json::object({{"url",icon}})}})},{"message",Json::object({{"body",message}})},{"subMessage",Json::object({{"body",title.empty()?"PS5Library":title}})}});
  auto raw=Json::object({{"viewTemplateType","ToastTemplateB"},{"channelType","Downloads"},{"bundleName","PS5Library"},{"useCaseId","IDC"},{"toastOverwriteType","No"},{"isImmediate",true},{"priority",100},{"viewData",view}});
  // Omit soundEffect so ShellUI selects its native informative notification sound.
  return Json::object({{"rawData",raw},{"createdDateTime",createdAt},{"localNotificationId",id}}).dump();
}
bool notify(const std::string& message,const std::string& title) {
#ifdef PS5
  const char* icon="/user/appmeta/PPSA99051/icon0.png";char timestamp[32]{};std::time_t now=std::time(nullptr);std::tm utc{};
  if(gmtime_r(&now,&utc)&&std::strftime(timestamp,sizeof(timestamp),"%Y-%m-%dT%H:%M:%S.000Z",&utc))try{auto payload=notificationPayload(message,timestamp,randomHex(8),icon,title);const int result=sceNotificationSend(0xFE,true,payload.c_str());if(result==0)return true;std::fprintf(stderr,"Native notification unavailable: %#x\n",result);}catch(const std::exception& error){std::fprintf(stderr,"Native notification invalid: %s\n",error.what());}
  return false;
#else
  std::fprintf(stderr,"%s: %s\n",title.c_str(),message.c_str());
  return true;
#endif
}
Client::Client(const Json& config,const fs::path& unixSocket):base_(normalizeServerUrl(config["serverUrl"].string(),config["allowInsecureLan"].boolean())),ca_(config["caBundle"].string()),unixSocket_(unixSocket.string()),insecure_(config["allowInsecureLan"].boolean()) {
  static std::once_flag once;static CURLcode initialized=CURLE_FAILED_INIT;
  std::call_once(once,[]{initialized=curl_global_init(CURL_GLOBAL_DEFAULT);});
  if(initialized!=CURLE_OK) throw std::runtime_error("Network initialization failed");
}
CURL* Client::handle(const std::string& relative) const {
  if(cancelled&&cancelled())throw std::runtime_error("Request aborted");
  if(relative.rfind("/api/v1/",0)!=0 || relative.find("..")!=std::string::npos) throw std::runtime_error("Invalid server API path");
  CURL* curl=curl_easy_init(); if(!curl) throw std::runtime_error("Network allocation failed");
  auto url=base_+relative; curl_easy_setopt(curl,CURLOPT_URL,url.c_str());
  if(!unixSocket_.empty()&&(curl_easy_setopt(curl,CURLOPT_UNIX_SOCKET_PATH,unixSocket_.c_str())!=CURLE_OK||curl_easy_setopt(curl,CURLOPT_PROXY,"")!=CURLE_OK)){curl_easy_cleanup(curl);throw std::runtime_error("Local agent socket setup failed");}
  curl_easy_setopt(curl,CURLOPT_PROTOCOLS_STR,insecure_?"http,https":"https"); curl_easy_setopt(curl,CURLOPT_FOLLOWLOCATION,0L);
  curl_easy_setopt(curl,CURLOPT_CONNECTTIMEOUT,10L); curl_easy_setopt(curl,CURLOPT_TIMEOUT,30L);
  curl_easy_setopt(curl,CURLOPT_SSL_VERIFYPEER,1L); curl_easy_setopt(curl,CURLOPT_SSL_VERIFYHOST,2L);
  curl_easy_setopt(curl,CURLOPT_NOSIGNAL,1L); curl_easy_setopt(curl,CURLOPT_USERAGENT,("PS5Library/"+std::string(appVersion)).c_str());
  curl_easy_setopt(curl,CURLOPT_NOPROGRESS,0L);curl_easy_setopt(curl,CURLOPT_XFERINFODATA,this);
  curl_easy_setopt(curl,CURLOPT_XFERINFOFUNCTION,+[](void* data,curl_off_t,curl_off_t,curl_off_t,curl_off_t)->int{auto* client=static_cast<const Client*>(data);return client->cancelled&&client->cancelled()?1:0;});
  if(!ca_.empty()) curl_easy_setopt(curl,CURLOPT_CAINFO,ca_.c_str());
  return curl;
}
std::string Client::nativeDownloadUrl(const std::string& relative) const {
  static const std::regex path(R"(^/api/v1/native-downloads/[0-9a-f-]{36}/[0-9a-f]{64}/(game\.pkg|icon\.png)$)");
  if(!std::regex_match(relative,path))throw std::runtime_error("Invalid native download path");
  return base_+relative;
}
std::string Client::nativeUpdateUrl(const std::string& relative) const {
  static const std::regex path(R"(^/api/v1/native-updates/((PPSA99051|PPSA99783)/([1-9][0-9]*/packages/[0-9a-f]{64}\.pkg|icon\.png)|grants/[0-9a-f]{64}/(PPSA99051|PPSA99783)/(packages/[0-9a-f]{64}\.pkg|icon\.png))$)");
  if(!std::regex_match(relative,path))throw std::runtime_error("Invalid native update path");
  return base_+relative;
}
static size_t collect(char* ptr,size_t size,size_t count,void* userdata) {
  auto& out=*static_cast<std::string*>(userdata); if(size*count>12*1024*1024-out.size()) return 0; out.append(ptr,size*count); return size*count;
}
static size_t collectArtwork(char* ptr,size_t size,size_t count,void* userdata){auto& out=*static_cast<std::string*>(userdata);if(size*count>32*1024*1024-out.size())return 0;out.append(ptr,size*count);return size*count;}
static curl_slist* headers(const std::string& credential) { auto* list=curl_slist_append(nullptr,"Content-Type: application/json");list=curl_slist_append(list,"Connection: close");list=curl_slist_append(list,"X-PS5Library-Client: ps5");if(!credential.empty()) list=curl_slist_append(list,("Authorization: Bearer "+credential).c_str()); return list; }
Client::ImageResponse Client::artwork(const std::string& relative,const std::string& etag,const std::function<bool()>& cancelled) const {
  CURL* curl=handle(relative);auto* list=headers(credential);if(!etag.empty())list=curl_slist_append(list,("If-None-Match: "+etag).c_str());ImageResponse result;char details[CURL_ERROR_SIZE]{};curl_easy_setopt(curl,CURLOPT_ERRORBUFFER,details);
  curl_easy_setopt(curl,CURLOPT_HTTPHEADER,list);curl_easy_setopt(curl,CURLOPT_WRITEFUNCTION,collectArtwork);curl_easy_setopt(curl,CURLOPT_WRITEDATA,&result.data);
  curl_easy_setopt(curl,CURLOPT_NOPROGRESS,0L);curl_easy_setopt(curl,CURLOPT_XFERINFODATA,&cancelled);
  curl_easy_setopt(curl,CURLOPT_XFERINFOFUNCTION,+[](void* callback,curl_off_t,curl_off_t,curl_off_t,curl_off_t)->int{return (*static_cast<const std::function<bool()>*>(callback))()?1:0;});
  curl_easy_setopt(curl,CURLOPT_HEADERDATA,&result.etag);
  curl_easy_setopt(curl,CURLOPT_HEADERFUNCTION,(+[](char* data,size_t a,size_t b,void* output)->size_t{std::string line(data,a*b);if(line.size()>5&&(line.substr(0,5)=="ETag:"||line.substr(0,5)=="etag:")){auto start=line.find_first_not_of(" \t",5);auto end=line.find_last_not_of("\r\n ");if(start!=std::string::npos)*static_cast<std::string*>(output)=line.substr(start,end-start+1);}return a*b;}));
  auto error=perform(curl);long status=0;curl_easy_getinfo(curl,CURLINFO_RESPONSE_CODE,&status);curl_slist_free_all(list);curl_easy_cleanup(curl);
  if(error!=CURLE_OK||!(status==200||status==304))throw std::runtime_error(std::string("Artwork unavailable: ")+(details[0]?details:curl_easy_strerror(error))+" (HTTP "+std::to_string(status)+")");
  result.unchanged=status==304;return result;
}
std::string Client::bytes(const std::string& relative) const {
  CURL* curl=handle(relative); auto* list=headers(credential); std::string output;
  curl_easy_setopt(curl,CURLOPT_HTTPHEADER,list); curl_easy_setopt(curl,CURLOPT_WRITEFUNCTION,collect); curl_easy_setopt(curl,CURLOPT_WRITEDATA,&output);
  auto error=perform(curl); long status=0; curl_easy_getinfo(curl,CURLINFO_RESPONSE_CODE,&status); curl_slist_free_all(list); curl_easy_cleanup(curl);
  if(error!=CURLE_OK || status<200 || status>=300) throw std::runtime_error("Server request failed ("+std::to_string(status)+")");
  return output;
}
Json Client::request(const std::string& method,const std::string& relative,const Json& body) const {
  CURL* curl=handle(relative); auto* list=headers(credential); auto data=body.dump(); std::string output; char details[CURL_ERROR_SIZE]{};
  curl_easy_setopt(curl,CURLOPT_ERRORBUFFER,details);
  curl_easy_setopt(curl,CURLOPT_HTTPHEADER,list); curl_easy_setopt(curl,CURLOPT_CUSTOMREQUEST,method.c_str());
  if(method!="GET") { curl_easy_setopt(curl,CURLOPT_POSTFIELDS,data.c_str()); curl_easy_setopt(curl,CURLOPT_POSTFIELDSIZE,static_cast<long>(data.size())); }
  curl_easy_setopt(curl,CURLOPT_WRITEFUNCTION,collect); curl_easy_setopt(curl,CURLOPT_WRITEDATA,&output);
  auto error=perform(curl); long status=0,osError=0; curl_easy_getinfo(curl,CURLINFO_RESPONSE_CODE,&status);curl_easy_getinfo(curl,CURLINFO_OS_ERRNO,&osError); curl_slist_free_all(list); curl_easy_cleanup(curl);
  if(error!=CURLE_OK) throw std::runtime_error(std::string(details[0]?details:curl_easy_strerror(error))+" (errno "+std::to_string(osError)+")");
  auto result=Json::parse(output);
  if(status<200 || status>=300) throw RequestError(status,result["error"].string("Server error"));
  return result;
}
struct Transfer { FILE* file; int64_t limit,written=0; };
static size_t writeChunk(char* ptr,size_t size,size_t count,void* userdata) {
  auto& t=*static_cast<Transfer*>(userdata); auto bytes=size*count;
  if(bytes>static_cast<size_t>(t.limit-t.written)) return 0;
  auto n=fwrite(ptr,1,bytes,t.file); t.written+=static_cast<int64_t>(n);
  return n;
}
void Client::download(const std::string& relative,const fs::path& part,int64_t size,const std::string& hash,const std::function<void(int64_t,int64_t)>& progress) const {
  if(size<0||hash.size()!=64||hash.find_first_not_of("0123456789abcdef")!=std::string::npos)throw std::runtime_error("CORRUPT_INPUT");
  if(!part.parent_path().empty())fs::create_directories(part.parent_path());
  auto status=fs::symlink_status(part);if(fs::exists(status)&&!fs::is_regular_file(status))throw std::runtime_error("CORRUPT_INPUT");
  auto offset=fs::exists(status)?static_cast<int64_t>(fs::file_size(part)):0;
  if(offset>size) throw std::runtime_error("CORRUPT_INPUT");
  if(offset==size) { if(fileHash(part,cancelled)!=hash) throw std::runtime_error("CORRUPT_INPUT");progress(size,0);return; }
  constexpr int64_t chunkSize=4*1024*1024;
  while(offset<size){
    const auto wanted=std::min(chunkSize,size-offset),end=offset+wanted-1;auto started=std::chrono::steady_clock::now();
    CURL* curl=handle(relative);int fd=open(part.c_str(),O_CREAT|O_WRONLY|O_NOFOLLOW|(offset?O_APPEND:O_TRUNC),0600);
    if(fd<0){curl_easy_cleanup(curl);throw std::runtime_error("Cannot open staging file");}
    FILE* file=fdopen(fd,offset?"ab":"wb");if(!file){close(fd);curl_easy_cleanup(curl);throw std::runtime_error("Cannot open staging file");}
    auto* list=headers(credential);list=curl_slist_append(list,("If-Range: \""+hash+"\"").c_str());
    const auto range=std::to_string(offset)+"-"+std::to_string(end);Transfer transfer{file,wanted};
    curl_easy_setopt(curl,CURLOPT_HTTPHEADER,list);curl_easy_setopt(curl,CURLOPT_RANGE,range.c_str());curl_easy_setopt(curl,CURLOPT_FAILONERROR,1L);
    curl_easy_setopt(curl,CURLOPT_TIMEOUT,0L);curl_easy_setopt(curl,CURLOPT_LOW_SPEED_LIMIT,1024L);curl_easy_setopt(curl,CURLOPT_LOW_SPEED_TIME,30L);
    curl_easy_setopt(curl,CURLOPT_WRITEFUNCTION,writeChunk);curl_easy_setopt(curl,CURLOPT_WRITEDATA,&transfer);
    auto error=perform(curl);long response=0;curl_easy_getinfo(curl,CURLINFO_RESPONSE_CODE,&response);curl_slist_free_all(list);curl_easy_cleanup(curl);
    int flushed=fflush(file),synced=flushed?0:fsync(fd),closed=fclose(file);
    if(error!=CURLE_OK||response!=206||transfer.written!=wanted||flushed||synced||closed||static_cast<int64_t>(fs::file_size(part))!=end+1)throw std::runtime_error("Transfer interrupted; partial file retained");
    offset=end+1;auto ms=std::max<int64_t>(1,std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-started).count());
    if(offset<size)progress(offset,wanted*1000/ms);
  }
  if(fileHash(part,cancelled)!=hash)throw std::runtime_error("CORRUPT_INPUT");
  progress(size,0);
}
}
