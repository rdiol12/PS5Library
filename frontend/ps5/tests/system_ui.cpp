// Read-only, one-minute console diagnostic. No hooks, input injection or title changes.
#include "../common/client.hpp"
#include <ps5/kernel.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cerrno>
#include <thread>
#include <unistd.h>
extern "C" {
int sceUserServiceInitialize(const void*);
int sceUserServiceGetInitialUser(int*);
int sceUserServiceGetForegroundUser(unsigned*);
int sceSystemServiceGetAppIdOfRunningBigApp();
int sceKernelGetAppState(int,int*,int*);
}
int main(){using namespace ps5library;try{
  alarm(75);
  const fs::path output="/data/ps5library/system-ui-probe.json";
  Json report=Json::object({{"schema",1},{"readOnly",true},{"firmwareSdk",static_cast<int64_t>(kernel_get_fw_version())}});
  auto checkpoint=[&](const char* stage){report.set("stage",stage);atomicJson(output,report);};checkpoint("user-initialize");
  report.set("userInitialize",sceUserServiceInitialize(nullptr));int initial=-1;unsigned foreground=~0u;
  checkpoint("initial-user");
  report.set("initialResult",sceUserServiceGetInitialUser(&initial));report.set("initialValid",initial>=0&&initial!=255);
  checkpoint("foreground-user");
  report.set("foregroundResult",sceUserServiceGetForegroundUser(&foreground));report.set("foregroundValid",foreground<0x80000000u&&foreground!=255);
  // Record short local code prefixes to verify unknown ABI layouts before calling them.
  uint32_t handle=0;uintptr_t getStatusAddress=0;auto exports=Json::array();
  checkpoint("system-service-module");
  static const char* const candidates[]={
    "sceSystemServiceGetStatus","sceSystemServiceReceiveEvent","sceSystemServicePowerTick",
    "sceSystemServiceNavigateToGoHome","sceSystemServiceNavigateToGoBack",
    "sceSystemServiceGetAppIdOfRunningBigApp","sceSystemServiceGetAppTitleId",
    "sceSystemServiceGetAppId","sceSystemServiceGetAppStatus","sceSystemServiceLaunchApp",
    "sceSystemServiceKillApp","sceSystemServiceIsShellUiFgAndGameBgCpuMode",
    "sceSystemServiceSuspendBackgroundApp","sceSystemServiceParamGetInt",
    "sceLncUtilGetAppStatus","sceLncUtilGetAppFocusedAppStatus","sceLncUtilGetAppId",
    "sceLncUtilGetAppIdOfRunningBigApp","sceLncUtilGetAppTitleId",
    "sceLncUtilIsAppLaunched","sceLncUtilIsAppSuspended","sceLncUtilLaunchApp",
    "sceLncUtilKillApp","sceLncUtilResumeApp","sceLncUtilSuspendApp",
    "sceLncUtilSetAppFocus","sceLncUtilSetControllerFocus"
  };
  if(!kernel_dynlib_handle(-1,"libSceSystemService.sprx",&handle))for(const char* name:candidates){
    checkpoint(name);
    const auto address=kernel_dynlib_dlsym(-1,handle,name);auto symbol=Json::object({{"name",name},{"found",address>0}});
    if(std::strcmp(name,"sceSystemServiceGetStatus")==0)getStatusAddress=address;
    // Code mappings may be execute-only. Let the kernel reject unreadable memory
    // instead of dereferencing it and terminating the entire diagnostic.
    if(address>0){
      unsigned char bytes[256]{};int descriptors[2];std::string hex;constexpr char digits[]="0123456789abcdef";
      if(pipe(descriptors)==0){
        const size_t count=std::min<size_t>(sizeof(bytes),4096-(static_cast<uintptr_t>(address)&4095));
        const auto written=write(descriptors[1],reinterpret_cast<const void*>(address),count);symbol.set("readError",written<0?errno:0);
        const auto copied=written>0?read(descriptors[0],bytes,static_cast<size_t>(written)):0;
        close(descriptors[0]);close(descriptors[1]);
        for(ssize_t i=0;i<copied;i++){hex+=digits[bytes[i]>>4];hex+=digits[bytes[i]&15];}
      }else symbol.set("readError",errno);
      symbol.set("codePrefix",hex);
    }
    exports.add(symbol);
  }
  report.set("exports",exports);checkpoint("sampling");auto samples=Json::array();const auto start=std::chrono::steady_clock::now();
  for(int i=0;i<120;i++){
    int app=sceSystemServiceGetAppIdOfRunningBigApp(),state=-1,detail=-1,result=-1;if(app>0)result=sceKernelGetAppState(app,&state,&detail);
    auto sample=Json::object({{"elapsedMs",static_cast<int64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-start).count())},{"bigApp",app},{"result",result},{"rawState",state},{"rawDetail",detail}});
    if(getStatusAddress){
      struct {std::array<unsigned char,136> value;std::array<unsigned char,16384-136> guard;} raw{};raw.guard.fill(0xa5);
      const int statusResult=reinterpret_cast<int(*)(void*)>(getStatusAddress)(raw.value.data());
      const bool intact=std::all_of(raw.guard.begin(),raw.guard.end(),[](unsigned char byte){return byte==0xa5;});
      std::string hex;constexpr char digits[]="0123456789abcdef";for(const auto byte:raw.value){hex+=digits[byte>>4];hex+=digits[byte&15];}
      sample.set("statusResult",statusResult);sample.set("statusGuardIntact",intact);sample.set("statusBytes",hex);
    }
    samples.add(sample);
    report.set("samples",samples);atomicJson(output,report);std::this_thread::sleep_for(std::chrono::milliseconds(500));
  }
  report.set("completed",true);atomicJson(output,report);return 0;
}catch(const std::exception& e){std::fprintf(stderr,"System UI diagnostic: %s\n",e.what());return 1;}}
