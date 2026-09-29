#pragma once
#include "../common/client.hpp"
#include "../common/version.hpp"
#include <algorithm>
#include <cerrno>
#include <charconv>
#include <cctype>
#include <cstddef>
#include <cstring>
#include <functional>
#include <string_view>
#include <unordered_map>
#include <vector>
#include <arpa/inet.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>

namespace ps5library {
enum class LocalAgentAction { Invalid, Snapshot, Online, Connect, Offline, Disconnect, Close, AppUpdate, Media, Delete, Move, Launch, FormatPrepare, FormatConfirm };
struct LocalAgentRequest {LocalAgentAction action=LocalAgentAction::Invalid;std::string titleId,kind,sourceStorageId,storageId,serverUrl,challenge,version;bool allowInsecureLan=false;int64_t rangeStart=-1,rangeEnd=-1;};

template<class Send> inline void notifyLocalAgentConnection(bool& notified,Send send){if(!notified)notified=send();}

inline bool localUnhex(std::string_view value,std::string& result){if(value.empty()||value.size()>4096||value.size()%2)return false;result.clear();result.reserve(value.size()/2);auto digit=[](char c)->int{if(c>='0'&&c<='9')return c-'0';if(c>='a'&&c<='f')return c-'a'+10;return -1;};for(size_t i=0;i<value.size();i+=2){auto high=digit(value[i]),low=digit(value[i+1]);if(high<0||low<0)return false;auto c=static_cast<char>((high<<4)|low);if(static_cast<unsigned char>(c)<0x20||c==0x7f)return false;result+=c;}return true;}

inline bool localTitleId(std::string_view value){return value.size()==9&&(value.substr(0,4)=="PPSA"||value.substr(0,4)=="CUSA")&&std::all_of(value.begin()+4,value.end(),[](char c){return c>='0'&&c<='9';});}
inline bool localContentVersion(std::string_view value){if(value.size()!=10)return false;for(size_t i=0;i<value.size();i++)if(i==2||i==6?value[i]!='.':value[i]<'0'||value[i]>'9')return false;return true;}
inline bool localFrontendActive(const fs::path& shared){
  int fd=open((shared/"frontend.lock").c_str(),O_RDONLY|O_NOFOLLOW|O_NONBLOCK);if(fd<0)return false;struct File {int fd;~File(){close(fd);}} file{fd};struct stat status{};if(fstat(fd,&status)!=0||!S_ISREG(status.st_mode))return false;
  if(flock(fd,LOCK_EX|LOCK_NB)==0){flock(fd,LOCK_UN);return false;}return errno==EWOULDBLOCK||errno==EAGAIN;
}
inline fs::path localAgentSharedPath(const fs::path& sandboxRoot="/mnt/sandbox"){
  fs::path selected;std::string selectedName;std::error_code error;
  for(fs::directory_iterator it(sandboxRoot,fs::directory_options::skip_permission_denied,error),end;it!=end;it.increment(error)){if(error){error.clear();continue;}auto name=it->path().filename().string();if(name.size()!=13||name.rfind("PPSA99051_",0)!=0||!std::all_of(name.begin()+10,name.end(),[](char c){return c>='0'&&c<='9';}))continue;auto download=it->path()/"download0",shared=download/"ps5library";auto rootStatus=it->symlink_status(error),downloadStatus=fs::symlink_status(download,error),sharedStatus=fs::symlink_status(shared,error);if(error||fs::is_symlink(rootStatus)||!fs::is_directory(rootStatus)||fs::is_symlink(downloadStatus)||!fs::is_directory(downloadStatus)||fs::is_symlink(sharedStatus)||!fs::is_directory(sharedStatus)||!localFrontendActive(shared)){error.clear();continue;}if(selected.empty()||name>selectedName){selected=shared;selectedName=name;}error.clear();}
  return selected;
}
inline fs::path localAgentBackingSocketPath(const fs::path& sandboxRoot="/mnt/sandbox"){auto shared=localAgentSharedPath(sandboxRoot);return shared.empty()?fs::path():shared/"agent.sock";}
inline LocalAgentRequest parseNativeUpdateBridgeRequest(std::string_view request){
  LocalAgentRequest result;const auto headersEnd=request.find("\r\n\r\n"),lineEnd=request.find("\r\n");if(headersEnd==std::string_view::npos||lineEnd==std::string_view::npos)return result;
  const auto line=request.substr(0,lineEnd),prefix=std::string_view("GET /api/v1/agent/home-update/");if(line.rfind(prefix,0)!=0||line.size()!=prefix.size()+9+1+10+9||line.substr(line.size()-9)!=" HTTP/1.1")return result;
  const auto title=line.substr(prefix.size(),9),version=line.substr(prefix.size()+10,10);if(line[prefix.size()+9]!='/'||!nativeUpdateIdentity(title)||!localContentVersion(version))return result;
  result.action=LocalAgentAction::AppUpdate;result.titleId=title;result.version=version;return result;
}
inline std::string nativeNoUpdateXml(std::string_view titleId){const auto* identity=nativeUpdateIdentity(titleId);if(!identity)return {};return "<?xml version=\"1.0\" encoding=\"UTF-8\"?><title_patch ac_set_rev=\"0\" nptitleid=\""+std::string(identity->titleId)+"_00\" schema_ver=\"1.0\"><app_tag content_id=\""+identity->contentId+"\" name=\""+identity->name+"\" revision=\"0\"></app_tag></title_patch>";}
inline LocalAgentRequest parseLocalAgentRequest(std::string_view request) {
  LocalAgentRequest result;const auto headersEnd=request.find("\r\n\r\n"),lineEnd=request.find("\r\n");
  if(headersEnd==std::string_view::npos||lineEnd==std::string_view::npos||request.find("\r\nAuthorization: Bearer "+std::string(localAgentCredential)+"\r\n")==std::string_view::npos)return result;
  const auto line=request.substr(0,lineEnd);const auto space=line.find(' '),last=line.rfind(' ');if(space==std::string_view::npos||last==space||line.substr(last)!=" HTTP/1.1")return result;
  const auto method=line.substr(0,space);auto path=line.substr(space+1,last-space-1);if(path=="/api/v1/agent/snapshot"&&method=="GET")result.action=LocalAgentAction::Snapshot;else if(path=="/api/v1/agent/online"&&method=="POST")result.action=LocalAgentAction::Online;else if(path=="/api/v1/agent/disconnect"&&method=="POST")result.action=LocalAgentAction::Disconnect;else if(path=="/api/v1/agent/close"&&method=="POST")result.action=LocalAgentAction::Close;
  else if(method=="POST"&&path.rfind("/api/v1/agent/app-update/",0)==0){auto value=path.substr(25);const auto slash=value.find('/');auto title=value.substr(0,slash);if(slash!=std::string_view::npos)value=value.substr(slash+1);if(slash==9&&nativeUpdateIdentity(title)&&localContentVersion(value)){result.action=LocalAgentAction::AppUpdate;result.titleId=title;result.version=value;}}
  else if(method=="POST"&&(path.rfind("/api/v1/agent/connect/",0)==0||path.rfind("/api/v1/agent/offline/",0)==0)){const bool offline=path.rfind("/api/v1/agent/offline/",0)==0;auto rest=path.substr(22);if(rest.size()>2&&rest[1]=='/'&&(rest[0]=='0'||rest[0]=='1')&&localUnhex(rest.substr(2),result.serverUrl)){result.action=offline?LocalAgentAction::Offline:LocalAgentAction::Connect;result.allowInsecureLan=rest[0]=='1';}}
  else {
    const std::string_view media="/api/v1/agent/media/",titles="/api/v1/agent/titles/",storage="/api/v1/agent/storage/";
    if(method=="GET"&&path.rfind(media,0)==0){auto query=path.find('?');path=path.substr(0,query);auto rest=path.substr(media.size());auto slash=rest.find('/');if(slash!=std::string_view::npos&&localTitleId(rest.substr(0,slash))&&(rest.substr(slash+1)=="cover"||rest.substr(slash+1)=="hero"||rest.substr(slash+1)=="music")){result.action=LocalAgentAction::Media;result.titleId=rest.substr(0,slash);result.kind=rest.substr(slash+1);}}
    else if(method=="POST"&&path.rfind(titles,0)==0){auto rest=path.substr(titles.size());auto slash=rest.find('/');if(slash!=std::string_view::npos&&localTitleId(rest.substr(0,slash))){result.titleId=rest.substr(0,slash);rest=rest.substr(slash+1);auto valid=[](std::string_view value){return !value.empty()&&value.size()<=64&&std::all_of(value.begin(),value.end(),[](char c){return std::isalnum(static_cast<unsigned char>(c))||c=='_'||c=='-';});};if(rest=="launch")result.action=LocalAgentAction::Launch;else if(rest.rfind("delete/",0)==0&&valid(rest.substr(7))){result.action=LocalAgentAction::Delete;result.storageId=rest.substr(7);}else if(rest.rfind("move/",0)==0){auto stores=rest.substr(5);auto split=stores.find('/');if(split!=std::string_view::npos&&valid(stores.substr(0,split))&&valid(stores.substr(split+1))){result.action=LocalAgentAction::Move;result.sourceStorageId=stores.substr(0,split);result.storageId=stores.substr(split+1);}}}}
    else if(method=="POST"&&path.rfind(storage,0)==0){auto rest=path.substr(storage.size());auto slash=rest.find('/');if(slash!=std::string_view::npos){auto id=rest.substr(0,slash);auto action=rest.substr(slash+1);const bool usb=id.size()>3&&id.rfind("usb",0)==0&&std::all_of(id.begin()+3,id.end(),[](char c){return c>='0'&&c<='9';});if(usb&&action=="format/prepare"){result.action=LocalAgentAction::FormatPrepare;result.storageId=id;}else if(usb&&action.rfind("format/confirm/",0)==0){auto token=action.substr(15);if(token.size()==64&&std::all_of(token.begin(),token.end(),[](char c){return (c>='0'&&c<='9')||(c>='a'&&c<='f');})){result.action=LocalAgentAction::FormatConfirm;result.storageId=id;result.challenge=token;}}}}
  }
  if(result.action==LocalAgentAction::Media)if(auto at=request.find("\r\nRange: bytes=");at!=std::string_view::npos){at+=15;auto dash=request.find('-',at),end=request.find("\r\n",at);if(dash==std::string_view::npos||end==std::string_view::npos||dash>=end){result.action=LocalAgentAction::Invalid;return result;}auto first=request.substr(at,dash-at),lastPart=request.substr(dash+1,end-dash-1);auto parsed=std::from_chars(first.data(),first.data()+first.size(),result.rangeStart);if(parsed.ec!=std::errc()||parsed.ptr!=first.data()+first.size()||result.rangeStart<0){result.action=LocalAgentAction::Invalid;return result;}if(!lastPart.empty()){parsed=std::from_chars(lastPart.data(),lastPart.data()+lastPart.size(),result.rangeEnd);if(parsed.ec!=std::errc()||parsed.ptr!=lastPart.data()+lastPart.size()||result.rangeEnd<result.rangeStart){result.action=LocalAgentAction::Invalid;return result;}}}
  return result;
}
inline LocalAgentAction localAgentAction(std::string_view request){return parseLocalAgentRequest(request).action;}
inline bool localLaunchable(const Json& snapshot,const std::string& title){auto items=snapshot["inventory"];for(size_t i=0;i<items.size();i++)if(items[i]["titleId"].string()==title&&items[i]["available"].boolean()&&(items[i]["registered"].boolean()||items[i]["source"].string()=="INSTALLED_TITLE"))return true;return false;}

inline fs::path localMediaPath(const Json& snapshot,const Json& item,const std::string& kind){
  const auto title=item["titleId"].string();if(!localTitleId(title)||!item["available"].boolean())return {};
  std::vector<std::string> names=kind=="cover"?std::vector<std::string>{"icon0.png","icon0.jpg","icon0.jpeg"}:kind=="hero"?std::vector<std::string>{"pic1.png","pic0.png","pic2.png","pic1.jpg","pic0.jpg","icon0.png"}:kind=="music"?std::vector<std::string>{"snd0.at9"}:std::vector<std::string>{};
  const uintmax_t limit=kind=="music"?8*1024*1024:32*1024*1024;auto find=[&](const fs::path& root,const std::string& prefix){for(const auto& name:names)try{auto file=beneath(root,prefix+name);auto status=fs::symlink_status(file);if(!fs::is_symlink(status)&&fs::is_regular_file(status)){auto size=fs::file_size(file);if(size&&size<=limit)return file;}}catch(...){ }return fs::path();};
  for(const auto& root:std::vector<std::pair<fs::path,std::string>>{{"/user/appmeta",title+"/"},{"/user/app",title+"/"},{"/user/app",title+"/sce_sys/"}})if(auto file=find(root.first,root.second);!file.empty())return file;
  auto storage=snapshot["storage"];for(size_t i=0;i<storage.size();i++)if(storage[i]["storageId"].string()==item["storageId"].string())if(auto file=find(storage[i]["path"].string(),item["relativePath"].string()+"/sce_sys/");!file.empty())return file;return {};
}
inline fs::path localMediaPath(const Json& snapshot,const std::string& title,const std::string& kind){auto items=snapshot["inventory"];for(size_t i=0;i<items.size();i++)if(items[i]["titleId"].string()==title)if(auto file=localMediaPath(snapshot,items[i],kind);!file.empty())return file;return {};}
inline void addLocalMedia(Json snapshot,std::unordered_map<std::string,std::pair<fs::file_time_type,std::string>>& hashes,const std::function<bool()>& cancelled={}){
  auto items=snapshot["inventory"];for(size_t i=0;i<items.size();i++){auto item=items[i],media=Json::object();for(const auto* kind:{"cover","hero","music"})try{auto file=localMediaPath(snapshot,item,kind);if(file.empty())continue;auto size=fs::file_size(file);auto stamp=fs::last_write_time(file);auto version=std::to_string(static_cast<long long>(stamp.time_since_epoch().count()))+"-"+std::to_string(static_cast<unsigned long long>(size));auto value=Json::object({{"url","/api/v1/agent/media/"+item["titleId"].string()+"/"+kind+"?v="+version},{"size",static_cast<int64_t>(size)}});if(std::string(kind)=="music"){auto found=hashes.find(file.string());if(found==hashes.end()||found->second.first!=stamp)hashes[file.string()]={stamp,fileHash(file,cancelled)};value.set("sha256",hashes[file.string()].second);}media.set(kind,value);}catch(...){ }item.set("localMedia",media);}
}

class LocalAgentServer {
  int listener_=-1;uint16_t port_=0;in_addr_t boundAddress_=0;bool fixedAddress_=false;fs::path socketPath_;dev_t socketDevice_=0;ino_t socketInode_=0;
  void ready(){if(listen(listener_,4)!=0){close(listener_);listener_=-1;throw std::runtime_error("Local agent listen failed");}auto flags=fcntl(listener_,F_GETFL,0);if(flags<0||fcntl(listener_,F_SETFL,flags|O_NONBLOCK)!=0){close(listener_);listener_=-1;throw std::runtime_error("Local agent socket setup failed");}}
  static bool sendAll(int peer,const char* value,size_t size){size_t offset=0;while(offset<size){
#ifdef MSG_NOSIGNAL
      const auto count=send(peer,value+offset,size-offset,MSG_NOSIGNAL);
#else
      const auto count=send(peer,value+offset,size-offset,0);
#endif
      if(count<0&&errno==EINTR)continue;if(count<=0)return false;offset+=static_cast<size_t>(count);}return true;}
  static bool sendAll(int peer,const std::string& value){return sendAll(peer,value.data(),value.size());}
  static void sendFile(int peer,const fs::path& path,const LocalAgentRequest& request){
    int fd=open(path.c_str(),O_RDONLY|O_NOFOLLOW);if(fd<0)throw std::runtime_error("Local media unavailable");struct File {int fd;~File(){close(fd);}} guard{fd};struct stat stat{};auto extension=path.extension().string();const auto limit=extension==".at9"?8*1024*1024:32*1024*1024;if(fstat(fd,&stat)!=0||!S_ISREG(stat.st_mode)||stat.st_size<=0||stat.st_size>limit)throw std::runtime_error("Local media unavailable");
    int64_t first=request.rangeStart<0?0:request.rangeStart,last=request.rangeEnd<0?stat.st_size-1:request.rangeEnd;if(first>=stat.st_size||last>=stat.st_size||last<first)throw std::runtime_error("Invalid media range");const auto count=last-first+1;const char* type=extension==".at9"?"audio/atrac9":(extension==".jpg"||extension==".jpeg")?"image/jpeg":"image/png";const bool partial=request.rangeStart>=0;
    std::string header="HTTP/1.1 "+std::string(partial?"206 Partial Content":"200 OK")+"\r\nContent-Type: "+type+"\r\nCache-Control: private, max-age=31536000, immutable\r\nAccept-Ranges: bytes\r\nConnection: close\r\nContent-Length: "+std::to_string(count)+"\r\n";if(partial)header+="Content-Range: bytes "+std::to_string(first)+"-"+std::to_string(last)+"/"+std::to_string(stat.st_size)+"\r\n";header+="\r\n";if(!sendAll(peer,header)||lseek(fd,first,SEEK_SET)<0)return;
    char buffer[64*1024];int64_t remaining=count;while(remaining>0){auto readBytes=read(fd,buffer,static_cast<size_t>(std::min<int64_t>(sizeof(buffer),remaining)));if(readBytes<=0)return;if(!sendAll(peer,buffer,static_cast<size_t>(readBytes)))return;remaining-=readBytes;}
  }
public:
  explicit LocalAgentServer(uint16_t port=localAgentPort,const char* fixedHost=nullptr){
    listener_=socket(AF_INET,SOCK_STREAM,0);if(listener_<0)throw std::runtime_error("Local agent socket unavailable");int reuse=1;setsockopt(listener_,SOL_SOCKET,SO_REUSEADDR,&reuse,sizeof(reuse));sockaddr_in address{};address.sin_family=AF_INET;address.sin_port=htons(port);fixedAddress_=fixedHost!=nullptr;auto host=fixedAddress_?std::string(fixedHost):localAgentAddress();if(inet_pton(AF_INET,host.c_str(),&address.sin_addr)!=1){close(listener_);listener_=-1;throw std::runtime_error("Local agent address unavailable");}
#ifdef PS5
    address.sin_len=sizeof(address);
#endif
    boundAddress_=address.sin_addr.s_addr;
    if(bind(listener_,reinterpret_cast<sockaddr*>(&address),sizeof(address))!=0){close(listener_);listener_=-1;throw std::runtime_error("Local agent port unavailable");}ready();socklen_t size=sizeof(address);if(getsockname(listener_,reinterpret_cast<sockaddr*>(&address),&size)!=0){close(listener_);listener_=-1;throw std::runtime_error("Local agent socket setup failed");}port_=ntohs(address.sin_port);
  }
  explicit LocalAgentServer(const fs::path& path):socketPath_(path){auto value=path.string();sockaddr_un address{};if(value.empty()||value.size()>=sizeof(address.sun_path))throw std::runtime_error("Invalid local agent socket path");struct stat parent{},existing{};if(lstat(path.parent_path().c_str(),&parent)!=0||!S_ISDIR(parent.st_mode)||S_ISLNK(parent.st_mode))throw std::runtime_error("Local agent socket directory unavailable");if(lstat(value.c_str(),&existing)==0){if(!S_ISSOCK(existing.st_mode)||unlink(value.c_str())!=0)throw std::runtime_error("Unsafe local agent socket path");}else if(errno!=ENOENT)throw std::runtime_error("Local agent socket path unavailable");listener_=socket(AF_UNIX,SOCK_STREAM,0);if(listener_<0)throw std::runtime_error("Local agent socket unavailable");address.sun_family=AF_UNIX;std::memcpy(address.sun_path,value.c_str(),value.size()+1);auto size=static_cast<socklen_t>(offsetof(sockaddr_un,sun_path)+value.size()+1);
#ifdef PS5
    address.sun_len=static_cast<unsigned char>(size);
#endif
    if(bind(listener_,reinterpret_cast<sockaddr*>(&address),size)!=0||chmod(value.c_str(),0666)!=0||lstat(value.c_str(),&existing)!=0){close(listener_);listener_=-1;unlink(value.c_str());throw std::runtime_error("Local agent socket unavailable");}socketDevice_=existing.st_dev;socketInode_=existing.st_ino;try{ready();}catch(...){unlink(value.c_str());throw;}}
  bool available()const{if(socketPath_.empty()){if(fixedAddress_)return listener_>=0;try{in_addr address{};return listener_>=0&&inet_pton(AF_INET,localAgentAddress().c_str(),&address)==1&&address.s_addr==boundAddress_;}catch(...){return false;}}struct stat status{};return listener_>=0&&lstat(socketPath_.c_str(),&status)==0&&S_ISSOCK(status.st_mode)&&status.st_dev==socketDevice_&&status.st_ino==socketInode_;}
  ~LocalAgentServer(){if(listener_>=0)close(listener_);if(available())unlink(socketPath_.c_str());}LocalAgentServer(const LocalAgentServer&)=delete;LocalAgentServer& operator=(const LocalAgentServer&)=delete;uint16_t port()const{return port_;}
  bool poll(const std::function<Json(const LocalAgentRequest&)>& handle,const std::function<fs::path(const LocalAgentRequest&)>& file={},const std::function<void()>& connected={},const std::function<void(const LocalAgentRequest&)>& nativeUpdate={}){
    sockaddr_in peerAddress{};socklen_t peerSize=sizeof(peerAddress);int peer=socketPath_.empty()?accept(listener_,reinterpret_cast<sockaddr*>(&peerAddress),&peerSize):accept(listener_,nullptr,nullptr);if(peer<0){if(errno==EAGAIN||errno==EWOULDBLOCK)return false;throw std::runtime_error("Local agent accept failed");}struct Peer {int fd;~Peer(){close(fd);}} guard{peer};if(socketPath_.empty()&&(peerAddress.sin_family!=AF_INET||peerAddress.sin_addr.s_addr!=boundAddress_))return true;auto flags=fcntl(peer,F_GETFL,0);if(flags<0||fcntl(peer,F_SETFL,flags&~O_NONBLOCK)!=0)return true;timeval timeout{10,0};setsockopt(peer,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout));setsockopt(peer,SOL_SOCKET,SO_SNDTIMEO,&timeout,sizeof(timeout));
    constexpr size_t requestLimit=8192;std::string request;char bytes[1024];while(request.size()<requestLimit&&request.find("\r\n\r\n")==std::string::npos){auto count=recv(peer,bytes,std::min(sizeof(bytes),requestLimit-request.size()),0);if(count<=0)break;request.append(bytes,static_cast<size_t>(count));}
    if(nativeUpdate){auto update=parseNativeUpdateBridgeRequest(request);if(update.action!=LocalAgentAction::AppUpdate){sendAll(peer,"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");return true;}auto payload=nativeNoUpdateXml(update.titleId);auto response="HTTP/1.1 200 OK\r\nContent-Type: application/xml; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: "+std::to_string(payload.size())+"\r\n\r\n"+payload;if(sendAll(peer,response))nativeUpdate(update);return true;}
    const auto parsed=parseLocalAgentRequest(request);
    if(parsed.action==LocalAgentAction::Media&&file)try{sendFile(peer,file(parsed),parsed);return true;}catch(...){sendAll(peer,"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");return true;}
    int status=parsed.action==LocalAgentAction::Invalid?404:200;Json body;try{body=status==200?handle(parsed):Json::object({{"error","Not found"}});}catch(const std::exception& e){status=409;body=Json::object({{"error",e.what()}});}catch(...){status=503;body=Json::object({{"error","Local action unavailable"}});}auto payload=body.dump();if(payload.size()>12*1024*1024){status=503;payload=Json::object({{"error","Local scan too large"}}).dump();}const char* reason=status==200?"OK":status==404?"Not Found":status==409?"Conflict":"Service Unavailable";if(sendAll(peer,"HTTP/1.1 "+std::to_string(status)+" "+reason+"\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nConnection: close\r\nContent-Length: "+std::to_string(payload.size())+"\r\n\r\n"+payload)&&status==200&&connected)connected();return true;
  }
};
}
