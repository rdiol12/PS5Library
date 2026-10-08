#include "../common/client.hpp"
#include <cassert>
#include <thread>
#include <set>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
int main(){
  for(bool redirect:{false,true}){
    int listener=socket(AF_INET,SOCK_STREAM,0);assert(listener>=0);sockaddr_in address{};address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);
    assert(bind(listener,reinterpret_cast<sockaddr*>(&address),sizeof(address))==0);socklen_t length=sizeof(address);assert(getsockname(listener,reinterpret_cast<sockaddr*>(&address),&length)==0);assert(listen(listener,1)==0);
    std::thread server([&]{int peer=accept(listener,nullptr,nullptr);assert(peer>=0);timeval timeout{2,0};setsockopt(peer,SOL_SOCKET,SO_RCVTIMEO,&timeout,sizeof(timeout));std::string request;char bytes[1024];
      while(request.find("\r\n\r\n{}")==std::string::npos){int count=recv(peer,bytes,sizeof(bytes),0);assert(count>0);request.append(bytes,count);assert(request.size()<8192);}
      assert(request.rfind("POST /api/v1/version HTTP/1.1",0)==0);assert(request.find("Authorization:")==std::string::npos);
      std::string body=R"({"status":0,"api_version":1,"shadowmount_version":"1.7","capabilities":["add_manual_source","rescan"]})";
      auto response=std::string(redirect?"HTTP/1.1 302 Found\r\nLocation: http://127.0.0.1:1/escape\r\n":"HTTP/1.1 200 OK\r\n")+"Connection: close\r\nContent-Length: "+std::to_string(body.size())+"\r\n\r\n"+body;
      assert(send(peer,response.data(),response.size(),0)==static_cast<ssize_t>(response.size()));close(peer);
    });
    bool rejected=false;try{auto version=ps5library::shadowMountRequest(ntohs(address.sin_port),"/api/v1/version");assert(ps5library::shadowMountSupported(version));}catch(...){rejected=true;}
    server.join();close(listener);assert(rejected==redirect);
  }
  namespace fs=std::filesystem;
  const auto root=fs::temp_directory_path()/ps5library::randomHex(8),staging=root/"staging",destination=root/"backports/PPSA99999",backup=root/"previous";
  fs::create_directories(staging/"sce_module");fs::create_directories(destination);
  ps5library::atomicBytes(staging/"eboot.bin","new eboot");ps5library::atomicBytes(staging/"sce_module/libc.prx","new libc");ps5library::atomicBytes(destination/"old.prx","old overlay");const auto oldHash=ps5library::fileHash(destination/"old.prx");
  auto files=Json::array();for(const auto& name:{"eboot.bin","sce_module/libc.prx"}){auto file=staging/name;files.add(Json::object({{"path",name},{"size",static_cast<int64_t>(fs::file_size(file))},{"sha256",ps5library::fileHash(file)}}));}auto profile=Json::object({{"files",files}});
  auto verify=[&](const fs::path& folder){return ps5library::verifyBackport(folder,profile);};bool rejected=false;try{ps5library::publishBackport(staging,destination,backup,false,verify);}catch(const std::exception& error){rejected=std::string(error.what())=="BACKPORT_DESTINATION_CONFLICT";}assert(rejected&&fs::is_regular_file(destination/"old.prx"));
  ps5library::publishBackport(staging,destination,backup,true,verify);assert(verify(destination)&&!fs::exists(destination/"old.prx")&&!fs::exists(backup));std::set<std::string> names;for(const auto& entry:fs::recursive_directory_iterator(destination))if(entry.is_regular_file())names.insert(fs::relative(entry.path(),destination).generic_string());assert(names==std::set<std::string>({"eboot.bin","sce_module/libc.prx"}));
  fs::create_directories(staging);ps5library::atomicBytes(staging/"eboot.bin","new eboot");fs::create_directories(staging/"sce_module");ps5library::atomicBytes(staging/"sce_module/libc.prx","new libc");fs::remove_all(destination);fs::create_directories(destination);ps5library::atomicBytes(destination/"old.prx","old overlay");
  rejected=false;try{ps5library::publishBackport(staging,destination,backup,true,[&](const fs::path& folder){return folder!=destination&&verify(folder);});}catch(const std::exception& error){rejected=std::string(error.what())=="BACKPORT_FILES_MISMATCH";}assert(rejected&&fs::is_regular_file(destination/"old.prx")&&ps5library::fileHash(destination/"old.prx")==oldHash&&!fs::exists(backup));
  fs::remove_all(root);
}
