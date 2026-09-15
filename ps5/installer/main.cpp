#include "files.hpp"
#include <ps5/kernel.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <cstdio>
extern "C" {
int sceAppInstUtilInitialize(void);
int sceAppInstUtilAppUnInstall(const char*);
#define ASSET(name) extern const unsigned char name[];extern const size_t name##_size;
ASSET(frontend) ASSET(icon) ASSET(param) ASSET(launch) ASSET(font) ASSET(font_license) ASSET(config) ASSET(certificates)
}
constexpr auto titleId="BREW05001";
int main(int argc,char** argv){try{
  const std::filesystem::path target="/user/app/BREW05001";
  if(sceAppInstUtilInitialize())throw std::runtime_error("App registration service is unavailable");
  if(argc>1&&std::string(argv[1])=="--uninstall"){
    if(!install::owned(target))throw std::runtime_error("PS5Library does not own this title folder");
    if(sceAppInstUtilAppUnInstall(titleId))throw std::runtime_error("Title uninstall failed; files retained");
    install::removeOwned(target);std::puts("PS5Library home entry removed. Configuration and paired identity retained.");return 0;
  }
  // Require the existing loader bootstrap so websrv need not create system files on first launch.
  if(!std::filesystem::exists("/system_ex/app/FAKE00000/eboot.bin")||!std::filesystem::exists("/system_ex/app/FAKE00000/sce_sys/param.json"))throw std::runtime_error("Set up a compatible Homebrew Launcher first");
  int socket=::socket(AF_INET,SOCK_STREAM,0);sockaddr_in address{};address.sin_len=sizeof(address);address.sin_family=AF_INET;address.sin_port=htons(8080);inet_pton(AF_INET,"127.0.0.1",&address.sin_addr);int connected=connect(socket,reinterpret_cast<sockaddr*>(&address),sizeof(address));if(socket>=0)close(socket);if(connected)throw std::runtime_error("Start the console's compatible websrv homebrew loader first");
  uint32_t handle=0;using Register=int(*)(const char*,const char*,void*);Register registration=nullptr;
  if(!kernel_dynlib_handle(-1,"libSceAppInstUtil.sprx",&handle))registration=reinterpret_cast<Register>(kernel_dynlib_resolve(-1,handle,"Wudg3Xe3heE"));
  if(!registration||(kernel_get_fw_version()>>24)>=0x12)throw std::runtime_error("Exact-title registration is not verified for this runtime");
  std::filesystem::create_directories("/data/ps5library");
  const std::vector<install::File> defaults={{"config.json",config,config_size},{"DejaVuSans.ttf",font,font_size},{"FONT-LICENSE.txt",font_license,font_license_size},{"ca-bundle.crt",certificates,certificates_size}};
  for(const auto& file:defaults){auto path=std::filesystem::path("/data/ps5library")/file.name;if(!std::filesystem::exists(path))install::write(path,file.data,file.size);}
  install::publish(target,{{"eboot.elf",frontend,frontend_size},{"sce_sys/icon0.png",icon,icon_size},{"sce_sys/param.json",param,param_size},{"launch.html",launch,launch_size}},[&]{int result=registration(titleId,"/user/app/",nullptr);if(result){std::fprintf(stderr,"Registration returned 0x%08x\n",result);throw std::runtime_error("Registration failed; previous files restored");}});
  std::puts("PS5Library home entry registered. Open it from the home menu. Keep websrv running.");return 0;
}catch(const std::exception& error){std::fprintf(stderr,"PS5Library installer: %s\n",error.what());return 1;}}
