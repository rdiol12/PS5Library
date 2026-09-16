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
#include <algorithm>
#include <memory>
#include <cctype>
#ifdef PS5
#include <ps5/kernel.h>
extern "C" int sceKernelSendNotificationRequest(int, void*, size_t, int);
#endif
namespace ps5library {
Json readJson(const fs::path& filename) { std::ifstream file(filename); if(!file || fs::file_size(filename)>8*1024*1024) throw std::runtime_error("Cannot read configuration/state"); return Json::parse(std::string(std::istreambuf_iterator<char>(file),{})); }
std::string normalizeServerUrl(const std::string& input,bool allowHttp) {
  auto first=input.find_first_not_of(" \t\r\n"),last=input.find_last_not_of(" \t\r\n");
  if(first==std::string::npos||input.size()>2048)throw std::runtime_error("Enter your server's full HTTPS address");
  auto value=input.substr(first,last-first+1);
  std::unique_ptr<CURLU,decltype(&curl_url_cleanup)> url(curl_url(),curl_url_cleanup);
  if(!url||curl_url_set(url.get(),CURLUPART_URL,value.c_str(),0)!=CURLUE_OK)throw std::runtime_error("Invalid server address");
  auto part=[&](CURLUPart name,unsigned flags=0){char* text=nullptr;curl_url_get(url.get(),name,&text,flags);std::string result=text?text:"";curl_free(text);return result;};
  auto scheme=part(CURLUPART_SCHEME),host=part(CURLUPART_HOST);
  if(scheme!="https"&&!(allowHttp&&scheme=="http"))throw std::runtime_error("Use HTTPS, or explicitly allow unencrypted HTTP");
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
  fs::create_directories(fs::absolute(filename).parent_path()); auto temp=filename.string()+".tmp";
  int fd=open(temp.c_str(),O_CREAT|O_TRUNC|O_WRONLY|O_NOFOLLOW,0600); if(fd<0) throw std::runtime_error("Cannot write state");
  size_t written=0;
  while(written<data.size()) { auto n=write(fd,data.data()+written,data.size()-written); if(n<=0) { close(fd); throw std::runtime_error("State write failed"); } written+=static_cast<size_t>(n); }
  if(fsync(fd)!=0) { close(fd); throw std::runtime_error("State sync failed"); } close(fd);
  fs::rename(temp,filename);
}
void atomicJson(const fs::path& filename,const Json& value){atomicBytes(filename,value.dump());}
Json saveServerSettings(const fs::path& configPath,const std::string& input,bool allowHttp,bool resetPairing){
  auto path=fs::absolute(configPath);
  auto server=normalizeServerUrl(input,allowHttp);fs::create_directories(path.parent_path());
  int lock=open((path.parent_path()/"agent.lock").c_str(),O_CREAT|O_RDWR|O_NOFOLLOW,0600);
  if(lock<0)throw std::runtime_error("Cannot access console settings");
  if(flock(lock,LOCK_EX|LOCK_NB)!=0){close(lock);throw std::runtime_error("Stop the separate PS5Library agent before changing servers");}
  try{auto config=readConfig(path);auto statePath=path.parent_path()/"device-state.json";bool hadState=fs::exists(statePath);auto state=hadState?readJson(statePath):Json();
    bool changed=true;try{changed=normalizeServerUrl(state["serverUrl"].string(),true)!=server;}catch(const std::exception&){ }
    if(changed&&!state["credential"].string().empty()&&!resetPairing)throw PairingResetRequired();
    if(changed){atomicJson(path.parent_path()/"previous-server.json",Json::object({{"config",config},{"device",state}}));atomicJson(statePath,Json::object({{"serverUrl",server},{"deviceId",deviceId()},{"libraryRevision",int64_t(0)}}));}
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
    if(component==".." || component=="." || component.empty()) throw std::runtime_error("Unsafe path"); value/=component;
    if(fs::is_symlink(fs::symlink_status(value))) throw std::runtime_error("Symlinks are not allowed");
  } return value;
}
void notify(const std::string& message) {
#ifdef PS5
  struct Request { char reserved[45]; char message[3075]; } request{};
  std::snprintf(request.message,sizeof(request.message),"PS5Library: %s",message.c_str());
  if(sceKernelSendNotificationRequest(0,&request,sizeof(request),0)!=0) std::fprintf(stderr,"Notification unavailable\n");
#else
  std::fprintf(stderr,"PS5Library: %s\n",message.c_str());
#endif
}
Client::Client(const Json& config):base_(normalizeServerUrl(config["serverUrl"].string(),config["allowInsecureLan"].boolean())),ca_(config["caBundle"].string()),insecure_(config["allowInsecureLan"].boolean()) {
  if(curl_global_init(CURL_GLOBAL_DEFAULT)!=CURLE_OK) throw std::runtime_error("Network initialization failed");
}
CURL* Client::handle(const std::string& relative) const {
  if(cancelled&&cancelled())throw std::runtime_error("Request aborted");
  if(relative.rfind("/api/v1/",0)!=0 || relative.find("..")!=std::string::npos) throw std::runtime_error("Invalid server API path");
  CURL* curl=curl_easy_init(); if(!curl) throw std::runtime_error("Network allocation failed");
  auto url=base_+relative; curl_easy_setopt(curl,CURLOPT_URL,url.c_str());
  curl_easy_setopt(curl,CURLOPT_PROTOCOLS_STR,insecure_?"http,https":"https"); curl_easy_setopt(curl,CURLOPT_FOLLOWLOCATION,0L);
  curl_easy_setopt(curl,CURLOPT_CONNECTTIMEOUT,10L); curl_easy_setopt(curl,CURLOPT_TIMEOUT,30L);
  curl_easy_setopt(curl,CURLOPT_SSL_VERIFYPEER,1L); curl_easy_setopt(curl,CURLOPT_SSL_VERIFYHOST,2L);
  curl_easy_setopt(curl,CURLOPT_NOSIGNAL,1L); curl_easy_setopt(curl,CURLOPT_USERAGENT,("PS5Library/"+std::string(appVersion)).c_str());
  curl_easy_setopt(curl,CURLOPT_NOPROGRESS,0L);curl_easy_setopt(curl,CURLOPT_XFERINFODATA,this);
  curl_easy_setopt(curl,CURLOPT_XFERINFOFUNCTION,+[](void* data,curl_off_t,curl_off_t,curl_off_t,curl_off_t)->int{auto* client=static_cast<const Client*>(data);return client->cancelled&&client->cancelled()?1:0;});
  if(!ca_.empty()) curl_easy_setopt(curl,CURLOPT_CAINFO,ca_.c_str()); return curl;
}
static size_t collect(char* ptr,size_t size,size_t count,void* userdata) {
  auto& out=*static_cast<std::string*>(userdata); if(size*count>12*1024*1024-out.size()) return 0; out.append(ptr,size*count); return size*count;
}
static curl_slist* headers(const std::string& credential) { auto* list=curl_slist_append(nullptr,"Content-Type: application/json"); if(!credential.empty()) list=curl_slist_append(list,("Authorization: Bearer "+credential).c_str()); return list; }
Client::ImageResponse Client::artwork(const std::string& relative,const std::string& etag,const std::function<bool()>& cancelled) const {
  CURL* curl=handle(relative);auto* list=headers(credential);if(!etag.empty())list=curl_slist_append(list,("If-None-Match: "+etag).c_str());ImageResponse result;
  curl_easy_setopt(curl,CURLOPT_HTTPHEADER,list);curl_easy_setopt(curl,CURLOPT_WRITEFUNCTION,collect);curl_easy_setopt(curl,CURLOPT_WRITEDATA,&result.data);
  curl_easy_setopt(curl,CURLOPT_NOPROGRESS,0L);curl_easy_setopt(curl,CURLOPT_XFERINFODATA,&cancelled);
  curl_easy_setopt(curl,CURLOPT_XFERINFOFUNCTION,+[](void* callback,curl_off_t,curl_off_t,curl_off_t,curl_off_t)->int{return (*static_cast<const std::function<bool()>*>(callback))()?1:0;});
  curl_easy_setopt(curl,CURLOPT_HEADERDATA,&result.etag);
  curl_easy_setopt(curl,CURLOPT_HEADERFUNCTION,(+[](char* data,size_t a,size_t b,void* output)->size_t{std::string line(data,a*b);if(line.size()>5&&(line.substr(0,5)=="ETag:"||line.substr(0,5)=="etag:")){auto start=line.find_first_not_of(" \t",5);auto end=line.find_last_not_of("\r\n ");if(start!=std::string::npos)*static_cast<std::string*>(output)=line.substr(start,end-start+1);}return a*b;}));
  auto error=curl_easy_perform(curl);long status=0;curl_easy_getinfo(curl,CURLINFO_RESPONSE_CODE,&status);curl_slist_free_all(list);curl_easy_cleanup(curl);
  if(error!=CURLE_OK||!(status==200||status==304))throw std::runtime_error("Artwork unavailable");result.unchanged=status==304;return result;
}
std::string Client::bytes(const std::string& relative) const {
  CURL* curl=handle(relative); auto* list=headers(credential); std::string output;
  curl_easy_setopt(curl,CURLOPT_HTTPHEADER,list); curl_easy_setopt(curl,CURLOPT_WRITEFUNCTION,collect); curl_easy_setopt(curl,CURLOPT_WRITEDATA,&output);
  auto error=curl_easy_perform(curl); long status=0; curl_easy_getinfo(curl,CURLINFO_RESPONSE_CODE,&status); curl_slist_free_all(list); curl_easy_cleanup(curl);
  if(error!=CURLE_OK || status<200 || status>=300) throw std::runtime_error("Server request failed ("+std::to_string(status)+")"); return output;
}
Json Client::request(const std::string& method,const std::string& relative,const Json& body) const {
  CURL* curl=handle(relative); auto* list=headers(credential); auto data=body.dump(); std::string output;
  curl_easy_setopt(curl,CURLOPT_HTTPHEADER,list); curl_easy_setopt(curl,CURLOPT_CUSTOMREQUEST,method.c_str());
  if(method!="GET") { curl_easy_setopt(curl,CURLOPT_POSTFIELDS,data.c_str()); curl_easy_setopt(curl,CURLOPT_POSTFIELDSIZE,static_cast<long>(data.size())); }
  curl_easy_setopt(curl,CURLOPT_WRITEFUNCTION,collect); curl_easy_setopt(curl,CURLOPT_WRITEDATA,&output);
  auto error=curl_easy_perform(curl); long status=0; curl_easy_getinfo(curl,CURLINFO_RESPONSE_CODE,&status); curl_slist_free_all(list); curl_easy_cleanup(curl);
  if(error!=CURLE_OK) throw std::runtime_error(curl_easy_strerror(error)); auto result=Json::parse(output);
  if(status<200 || status>=300) throw RequestError(status,result["error"].string("Server error")); return result;
}
struct Transfer { FILE* file; int64_t offset,total,written=0,lastBytes=0; std::chrono::steady_clock::time_point last=std::chrono::steady_clock::now(); const std::function<void(int64_t,int64_t)>* progress; std::string error; };
static size_t writeChunk(char* ptr,size_t size,size_t count,void* userdata) {
  auto& t=*static_cast<Transfer*>(userdata); auto bytes=size*count;
  if(t.offset+t.written+static_cast<int64_t>(bytes)>t.total) return 0;
  auto n=fwrite(ptr,1,bytes,t.file); t.written+=static_cast<int64_t>(n);
  auto now=std::chrono::steady_clock::now(); auto ms=std::chrono::duration_cast<std::chrono::milliseconds>(now-t.last).count();
  if(ms>=500) { try { (*t.progress)(t.offset+t.written,(t.written-t.lastBytes)*1000/ms); } catch(const std::exception& e) { t.error=e.what(); return 0; } t.last=now; t.lastBytes=t.written; }
  return n;
}
void Client::download(const std::string& relative,const fs::path& part,int64_t size,const std::string& hash,const std::function<void(int64_t,int64_t)>& progress) const {
  fs::create_directories(part.parent_path()); auto offset=fs::exists(part)?static_cast<int64_t>(fs::file_size(part)):0;
  if(offset>size) throw std::runtime_error("CORRUPT_INPUT");
  if(offset==size) { if(fileHash(part,cancelled)!=hash) throw std::runtime_error("CORRUPT_INPUT"); return; }
  CURL* curl=handle(relative);FILE* file=fopen(part.c_str(),offset?"ab":"wb");if(!file){curl_easy_cleanup(curl);throw std::runtime_error("Cannot open staging file");}
  auto* list=headers(credential); if(offset) list=curl_slist_append(list,("If-Range: \""+hash+"\"").c_str());
  Transfer transfer{file,offset,size,0,0,std::chrono::steady_clock::now(),&progress,{}};
  curl_easy_setopt(curl,CURLOPT_HTTPHEADER,list); curl_easy_setopt(curl,CURLOPT_RESUME_FROM_LARGE,static_cast<curl_off_t>(offset));
  curl_easy_setopt(curl,CURLOPT_FAILONERROR,1L);
  curl_easy_setopt(curl,CURLOPT_TIMEOUT,0L); curl_easy_setopt(curl,CURLOPT_LOW_SPEED_LIMIT,1024L); curl_easy_setopt(curl,CURLOPT_LOW_SPEED_TIME,30L);
  curl_easy_setopt(curl,CURLOPT_WRITEFUNCTION,writeChunk); curl_easy_setopt(curl,CURLOPT_WRITEDATA,&transfer);
  auto error=curl_easy_perform(curl); long status=0; curl_easy_getinfo(curl,CURLINFO_RESPONSE_CODE,&status); curl_slist_free_all(list); curl_easy_cleanup(curl);
  int flushed=fflush(file); int synced=fsync(fileno(file)); fclose(file);
  if(!transfer.error.empty()) throw std::runtime_error(transfer.error);
  if(error!=CURLE_OK || (status!=200 && status!=206) || flushed || synced) throw std::runtime_error("Transfer interrupted; partial file retained");
  if(static_cast<int64_t>(fs::file_size(part))!=size || fileHash(part,cancelled)!=hash) throw std::runtime_error("CORRUPT_INPUT"); progress(size,0);
}
}
