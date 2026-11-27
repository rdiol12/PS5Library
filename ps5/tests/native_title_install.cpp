// Separate native-startup experiment; never replaces the installed storefront.
#include "../installer/files.hpp"
#include "../common/client.hpp"
#include "native-title-bundle.hpp"
#include <ps5/kernel.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <cstdio>
extern "C" int sceAppInstUtilInitialize();
extern "C" int sceAppInstUtilAppUnInstall(const char*);
struct NativeLaunchContext {uint32_t size,user,options;uint64_t crashReport;uint32_t checkFlag;};
static_assert(sizeof(NativeLaunchContext)==32);
extern "C" int sceUserServiceGetForegroundUser(uint32_t*);
extern "C" int sceUserServiceInitialize(void*);
extern "C" int sceSystemServiceGetAppIdOfRunningBigApp();
extern "C" int sceSystemServiceLaunchApp(const char*,char**,NativeLaunchContext*);
extern "C" int sceSystemServiceKillApp(int,int,int,int);
extern "C" int sceLncUtilGetAppTitleId(uint32_t,char*);
int main(int argc,char** argv){
  using namespace ps5library;
  alarm(60);
  std::freopen("/data/ps5library/native-title-install.log","w",stdout);
  std::setvbuf(stdout,nullptr,_IONBF,0);
  const fs::path target="/user/app/PPSA99051";
  try {
    bool shadowInfo=false,shadowStage=false,shadowRemove=false,shadowLaunch=false,kernelLog=false,storefront=false;
    for(int i=1;i<argc;i++){const std::string arg=argv[i];shadowInfo|=arg=="--shadow-info";shadowStage|=arg=="--shadow-stage";shadowRemove|=arg=="--shadow-remove";shadowLaunch|=arg=="--shadow-launch";kernelLog|=arg=="--kernel-log";storefront|=arg=="--storefront";}
    if(shadowInfo||shadowStage||shadowRemove||shadowLaunch||kernelLog){
      std::ifstream input("/data/shadowmount/config.ini");if(!input)throw std::runtime_error("ShadowMount configuration unavailable");
      const unsigned port=shadowMountPort(std::string((std::istreambuf_iterator<char>(input)),{}));
      std::printf("ShadowMount configured API port: %u\n",port);
      Client diagnosticApi(Json::object({{"serverUrl","http://127.0.0.1:"+std::to_string(port)},{"allowInsecureLan",true}}));
      const auto version=diagnosticApi.request("POST","/api/v1/version",Json::object());std::puts(version.dump().c_str());
      if(!shadowMountSupported(version)||!shadowMountDeletionSupported(version))throw std::runtime_error("Required mount and recovery APIs unavailable");
      auto saveKernelLog=[&](const fs::path& destination="/data/ps5library/native-title-kernel-log.json"){
        Client local(Json::object({{"serverUrl","http://127.0.0.1:"+std::to_string(port)},{"allowInsecureLan",true}}));
        const auto report=local.request("POST","/api/v1/kernel-log",Json::object({{"max_bytes",262144}}));
        atomicJson(destination,report);std::puts("Saved bounded kernel log for private startup diagnosis");
      };
      if(kernelLog){saveKernelLog();return 0;}
      const auto settings=shadowMountRequest(port,"/api/v1/settings");
      const auto games=shadowMountRequest(port,"/api/v1/games",Json::object({{"include_size",false}}))["games"];
      Json game;for(size_t i=0;i<games.size();i++)if(games[i]["title_id"].string()=="PPSA99051")game=games[i];
      if(shadowInfo){std::puts(settings.dump().c_str());std::puts(game.null()?"No native test tracked":game.dump().c_str());return 0;}
      const int lock=open("/data/ps5library/frontend.lock",O_CREAT|O_RDWR|O_NOFOLLOW,0600);
      if(lock<0||flock(lock,LOCK_EX|LOCK_NB))throw std::runtime_error("Close the storefront before the native-title experiment");
      const fs::path source="/data/homebrew/PPSA99051",hidden="/data/homebrew/.ps5library-native-home-test";
      if(fs::is_symlink(source.parent_path())||fs::is_symlink(hidden)||fs::exists(hidden))throw std::runtime_error("Native test staging needs recovery");
      if(shadowLaunch){
        if(!install::owned(source)||readJson(source/"sce_sys/param.json")["titleId"].string()!="PPSA99051"||game.null()||game["path"].string()!=source.string())throw std::runtime_error("Native test source ownership mismatch");
        for(const auto& item:nativeTitleFiles())if(fileHash(source/item.file.name)!=item.sha256)throw std::runtime_error("Native test changed before launch");
        const int previous=sceSystemServiceGetAppIdOfRunningBigApp();std::printf("Previous BigApp: %#x\n",previous);
        if(previous>0)throw std::runtime_error("Another application is running; diagnostic launch refused");
        NativeLaunchContext context{};char* arguments[]={nullptr};
        const int initialized=sceUserServiceInitialize(nullptr);std::printf("UserService initialize: %#x\n",initialized);
        if(initialized)throw std::runtime_error("UserService initialization failed");
        const int foreground=sceUserServiceGetForegroundUser(&context.user);std::printf("Foreground user query: %#x\n",foreground);
        if(foreground)throw std::runtime_error("Foreground user unavailable");
        // Keep the same context as pinned websrv; only add return-code/log capture.
        unlink("/data/ps5library/native-title-home-status.bin");
        const int result=sceSystemServiceLaunchApp("PPSA99051",arguments,&context);std::printf("Native LaunchApp result: %#x\n",result);
        if(storefront){
          usleep(500000);saveKernelLog("/data/ps5library/native-title-early-kernel-log.json");
          sleep(1);saveKernelLog("/data/ps5library/native-title-startup-kernel-log.json");
          sleep(8);
        }else sleep(10);
        const int backgroundApp=sceSystemServiceGetAppIdOfRunningBigApp();char backgroundTitle[16]={};
        if(backgroundApp>0&&!sceLncUtilGetAppTitleId(static_cast<uint32_t>(backgroundApp),backgroundTitle)&&std::string(backgroundTitle)=="PPSA99051")
          std::printf("Native same-title resume request: %#x\n",sceSystemServiceLaunchApp("PPSA99051",arguments,&context));
        sleep(10);
        for(const auto& sandbox:fs::directory_iterator("/mnt/sandbox"))if(sandbox.path().filename().string().rfind("PPSA99051_",0)==0){
          if(storefront){
            for(const auto& name:{"ps5library-native-stage.bin","ps5library-native-error.txt","ps5library-native-lifecycle.bin","ps5library-storefront.bmp"}){
              const auto path=sandbox.path()/"download0"/name;const int fd=open(path.c_str(),O_RDONLY|O_NOFOLLOW);
              if(fd<0){std::printf("Native evidence %s: open errno=%d\n",name,errno);continue;}
              struct stat info{};if(fstat(fd,&info)||!S_ISREG(info.st_mode)||info.st_size<0||info.st_size>16*1024*1024){close(fd);throw std::runtime_error("Invalid native evidence file");}
              std::vector<unsigned char> bytes(static_cast<size_t>(info.st_size));size_t offset=0;
              while(offset<bytes.size()){const auto count=read(fd,bytes.data()+offset,bytes.size()-offset);if(count<0&&errno==EINTR)continue;if(count<=0){close(fd);throw std::runtime_error("Incomplete native evidence read");}offset+=static_cast<size_t>(count);}
              close(fd);atomicBytes(fs::path("/data/ps5library")/name,{reinterpret_cast<const char*>(bytes.data()),bytes.size()});
              std::printf("Native evidence %s: %zu bytes\n",name,bytes.size());
            }
            continue;
          }
          const auto receipt=sandbox.path()/"download0/ps5library-home-probe.txt";
          if(fs::is_regular_file(receipt)&&fs::file_size(receipt)<32768){
            std::printf("Native receipt size: %llu\n",static_cast<unsigned long long>(fs::file_size(receipt)));
            const int descriptor=open(receipt.c_str(),O_RDONLY|O_NOFOLLOW);
            std::printf("Native receipt open: %d errno=%d\n",descriptor,descriptor<0?errno:0);
            if(descriptor>=0){
              unsigned char bytes[32768];const auto count=read(descriptor,bytes,sizeof(bytes));const int error=count<0?errno:0;close(descriptor);
              std::printf("Native receipt read: %lld errno=%d\n",static_cast<long long>(count),error);
              if(count>=0)install::write("/data/ps5library/native-title-home-status.bin",bytes,static_cast<size_t>(count),0600);
            }
          }
        }
        try{saveKernelLog();}catch(const std::exception& error){std::printf("Kernel log: %s\n",error.what());}
        const int running=sceSystemServiceGetAppIdOfRunningBigApp();char title[16]={};
        if(running>0&&!sceLncUtilGetAppTitleId(static_cast<uint32_t>(running),title)&&std::string(title)=="PPSA99051")std::printf("Native test close result: %#x\n",sceSystemServiceKillApp(running,-1,0,0));
        std::puts("NATIVE LAUNCH DIAGNOSTIC FINISHED");return 0;
      }
      if(shadowRemove){
        if(!install::owned(source)||readJson(source/"sce_sys/param.json")["titleId"].string()!="PPSA99051"||game.null()||game["path"].string()!=source.string())throw std::runtime_error("Native test source ownership mismatch");
        // Hide only our source before unregistering, so the scanner cannot add it again.
        fs::rename(source,hidden);
        try{std::puts(shadowMountRequest(port,"/api/v1/games/uninstall",Json::object({{"title_id","PPSA99051"},{"confirm",true}})).dump().c_str());}
        catch(...){fs::rename(hidden,source);throw;}
        install::removeOwned(hidden);std::puts("REMOVED ShadowMount native test PPSA99051");return 0;
      }
      if(settings["scan_paths"].size()!=0)throw std::runtime_error("Custom scan roots require review before this fixed-path experiment");
      if(!game.null()||fs::exists(source)||fs::exists(target)||fs::exists("/user/appmeta/PPSA99051"))throw std::runtime_error("Native test identity already exists");
      fs::create_directories(source.parent_path());
      const auto bundle=nativeTitleFiles();std::vector<install::File> files;for(const auto& item:bundle)files.push_back(item.file);
      install::publish(source,files,[&]{for(const auto& item:bundle)if(fileHash(source/item.file.name)!=item.sha256)throw std::runtime_error("Native source readback hash mismatch");});
      std::puts("STAGED ShadowMount native test PPSA99051; waiting for mount and registration");
      std::puts(shadowMountRequest(port,"/api/v1/scan",Json::object({{"reset_attempts",false}})).dump().c_str());return 0;
    }
    const int lock=open("/data/ps5library/frontend.lock",O_CREAT|O_RDWR|O_NOFOLLOW,0600);
    if(lock<0||flock(lock,LOCK_EX|LOCK_NB))throw std::runtime_error("Close the storefront before the native-title experiment");
    bool remove=false;for(int i=1;i<argc;i++)if(std::string(argv[i])=="--remove")remove=true;
    if(fs::exists(target)&&(!install::owned(target)||readJson(target/"sce_sys/param.json")["titleId"].string()!="PPSA99051"))throw std::runtime_error("Native test title belongs to another application");
    if(!fs::exists(target)&&fs::exists("/user/appmeta/PPSA99051"))throw std::runtime_error("Existing native test title metadata needs review");
    const int initialized=sceAppInstUtilInitialize();std::printf("AppInstUtil initialize: %#x\n",initialized);
    if(initialized)throw std::runtime_error("Registration service unavailable");
    if(remove){
      if(!install::owned(target))throw std::runtime_error("Native test is not owned; removal refused");
      const int result=sceAppInstUtilAppUnInstall("PPSA99051");std::printf("Uninstall: %#x\n",result);
      if(result)throw std::runtime_error("Native test uninstall failed; files retained");
      install::removeOwned(target);std::puts("REMOVED PPSA99051");return 0;
    }
    uint32_t handle=0;using Register=int(*)(const char*,const char*,void*);Register registration=nullptr;
    if(!kernel_dynlib_handle(-1,"libSceAppInstUtil.sprx",&handle))registration=reinterpret_cast<Register>(kernel_dynlib_resolve(-1,handle,"Wudg3Xe3heE"));
    if(!registration||(kernel_get_fw_version()>>24)>=0x12)throw std::runtime_error("Registration boundary unavailable");
    const auto bundle=nativeTitleFiles();std::vector<install::File> files;for(const auto& item:bundle)files.push_back(item.file);
    install::publish(target,files,[&]{
      for(const auto& item:bundle){if(fileHash(target/item.file.name)!=item.sha256)throw std::runtime_error("Native test readback hash mismatch");std::printf("Verified %s\n",item.file.name.c_str());}
      const int result=registration("PPSA99051","/user/app/",nullptr);std::printf("Registration: %#x\n",result);
      if(result)throw std::runtime_error("Native test registration failed");
    });
    std::puts("REGISTERED PPSA99051; launch and Home behavior remain unverified");return 0;
  }catch(const std::exception& error){std::printf("FAILED: %s\n",error.what());return 1;}
}
