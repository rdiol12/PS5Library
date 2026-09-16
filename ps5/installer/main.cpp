#include "files.hpp"
#include "../common/update.hpp"
#include <sys/file.h>
#include <chrono>
#include <thread>
#include <ps5/kernel.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <cstdio>
extern "C" {
int sceAppInstUtilInitialize(void);
int sceAppInstUtilAppUnInstall(const char*);
#define ASSET(name) extern const unsigned char name[];extern const size_t name##_size;
ASSET(frontend) ASSET(icon) ASSET(icon_dds) ASSET(home) ASSET(home_dds) ASSET(param) ASSET(launch) ASSET(font) ASSET(font_license) ASSET(config) ASSET(certificates)
}
constexpr auto titleId="BREW05001";
int main(int argc,char** argv){int lock=-1;bool updating=argc>1&&std::string(argv[1])=="--update";try{
  const std::filesystem::path target="/user/app/BREW05001";
  const auto launcherUrl=ps5library::readConfig("/data/ps5library/config.json")["launcherUrl"].string();
  if(updating){
    if(!install::owned(target))throw std::runtime_error("Install the PS5Library home entry before updating");
    lock=open("/data/ps5library/frontend.lock",O_CREAT|O_RDWR|O_NOFOLLOW,0600);if(lock<0)throw std::runtime_error("Cannot access the app update lock");
    bool acquired=false;for(int i=0;i<300;i++){if(flock(lock,LOCK_EX|LOCK_NB)==0){acquired=true;break;}std::this_thread::sleep_for(std::chrono::milliseconds(100));}if(!acquired)throw std::runtime_error("Close PS5Library before installing the update");
  }
  if(sceAppInstUtilInitialize())throw std::runtime_error("App registration service is unavailable");
  if(argc>1&&std::string(argv[1])=="--uninstall"){
    if(!install::owned(target))throw std::runtime_error("PS5Library does not own this title folder");
    if(sceAppInstUtilAppUnInstall(titleId))throw std::runtime_error("Title uninstall failed; files retained");
    install::removeOwned(target);std::puts("PS5Library home entry removed. Configuration and paired identity retained.");return 0;
  }
  // Require the existing loader bootstrap so websrv need not create system files on first launch.
  if(!std::filesystem::exists("/system_ex/app/FAKE00000/eboot.bin")||!std::filesystem::exists("/system_ex/app/FAKE00000/sce_sys/param.json"))throw std::runtime_error("Set up a compatible Homebrew Launcher first");
  if(updating)ps5library::normalizeServerUrl(launcherUrl,true);
  uint32_t handle=0;using Register=int(*)(const char*,const char*,void*);Register registration=nullptr;
  if(!kernel_dynlib_handle(-1,"libSceAppInstUtil.sprx",&handle))registration=reinterpret_cast<Register>(kernel_dynlib_resolve(-1,handle,"Wudg3Xe3heE"));
  if(!registration||(kernel_get_fw_version()>>24)>=0x12)throw std::runtime_error("Exact-title registration is not verified for this runtime");
  std::filesystem::create_directories("/data/ps5library");
  const std::vector<install::File> defaults={{"config.json",config,config_size},{"DejaVuSans.ttf",font,font_size},{"FONT-LICENSE.txt",font_license,font_license_size},{"ca-bundle.crt",certificates,certificates_size}};
  for(const auto& file:defaults){auto path=std::filesystem::path("/data/ps5library")/file.name;if(!std::filesystem::exists(path))install::write(path,file.data,file.size);}
  std::printf("Installing PS5Library %s; update mode %s\n",ps5library::appVersion,updating?"yes":"no");
  install::publish(target,{{"eboot.elf",frontend,frontend_size},{"sce_sys/icon0.png",icon,icon_size},{"sce_sys/icon0.dds",icon_dds,icon_dds_size},{"sce_sys/pic0.png",home,home_size},{"sce_sys/pic0.dds",home_dds,home_dds_size},{"sce_sys/pic1.png",home,home_size},{"sce_sys/pic1.dds",home_dds,home_dds_size},{"sce_sys/param.json",param,param_size},{"launch.html",launch,launch_size}},[&]{int result=registration(titleId,"/user/app/",nullptr);if(result){std::fprintf(stderr,"Registration returned 0x%08x\n",result);throw std::runtime_error("Registration failed; previous files restored");}},updating);
  if(updating){
    using namespace ps5library;const auto launchApp="/hbldr?path=/user/app/BREW05001/eboot.elf&cwd=/data/ps5library&args=ps5library%20/data/ps5library/config.json&daemon=0&pipe=0";
    atomicJson("/data/ps5library/update-boot.json",Json());close(lock);lock=-1;
    try{
      loaderRequest(launcherUrl,launchApp);bool healthy=false;
      for(int i=0;i<150;i++){try{if(readJson("/data/ps5library/update-boot.json")["build"].number()==appBuild){healthy=true;break;}}catch(...){ }std::this_thread::sleep_for(std::chrono::milliseconds(200));}
      if(!healthy)throw std::runtime_error("Updated app did not confirm startup");
      install::removeOwned(target.parent_path()/".ps5library-previous");
      atomicJson("/data/ps5library/update-result.json",Json::object({{"status","COMPLETED"},{"version",appVersion},{"build",appBuild}}));notify("Updated to "+std::string(appVersion));return 0;
    }catch(...){
      lock=open("/data/ps5library/frontend.lock",O_CREAT|O_RDWR|O_NOFOLLOW,0600);
      if(lock>=0&&flock(lock,LOCK_EX|LOCK_NB)==0){install::rollback(target);close(lock);lock=-1;try{loaderRequest(launcherUrl,launchApp);}catch(...){ }}
      throw;
    }
  }
  std::puts("PS5Library home entry registered. Open it from the home menu. Keep websrv running.");return 0;
}catch(const std::exception& error){if(lock>=0)close(lock);if(updating)try{ps5library::atomicJson("/data/ps5library/update-result.json",Json::object({{"status","ERROR"},{"message",error.what()}}));ps5library::notify("App update failed; previous app files retained");}catch(...){ }std::fprintf(stderr,"PS5Library installer: %s\n",error.what());return 1;}}
