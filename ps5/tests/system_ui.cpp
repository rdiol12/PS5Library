// Read-only, one-minute console diagnostic. No hooks, input injection or title changes.
#include "../common/client.hpp"
#include <ps5/kernel.h>
#include <algorithm>
#include <chrono>
#include <thread>
extern "C" {
int sceUserServiceInitialize(const void*);
int sceUserServiceGetInitialUser(int*);
int sceUserServiceGetForegroundUser(unsigned*);
int sceSystemServiceGetAppIdOfRunningBigApp();
int sceKernelGetAppState(int,int*,int*);
}
int main(){using namespace ps5library;try{
  const fs::path output="/data/ps5library/system-ui-probe.json";
  Json report=Json::object({{"schema",1},{"readOnly",true},{"firmwareSdk",static_cast<int64_t>(kernel_get_fw_version())}});
  report.set("userInitialize",sceUserServiceInitialize(nullptr));int initial=-1;unsigned foreground=~0u;
  report.set("initialResult",sceUserServiceGetInitialUser(&initial));report.set("initialValid",initial>=0&&initial!=255);
  report.set("foregroundResult",sceUserServiceGetForegroundUser(&foreground));report.set("foregroundValid",foreground<0x80000000u&&foreground!=255);
  // Record short local code prefixes to verify unknown ABI layouts before calling them.
  uint32_t handle=0;auto exports=Json::array();
  if(!kernel_dynlib_handle(-1,"libSceSystemService.sprx",&handle))for(const char* name:{"sceSystemServiceGetStatus","sceSystemServiceReceiveEvent"}){
    const auto address=kernel_dynlib_dlsym(-1,handle,name);auto symbol=Json::object({{"name",name},{"found",address>0}});
    if(address>0){const auto* bytes=reinterpret_cast<const unsigned char*>(address);std::string hex;constexpr char digits[]="0123456789abcdef";const size_t count=std::min<size_t>(256,4096-(static_cast<uintptr_t>(address)&4095));for(size_t i=0;i<count;i++){hex+=digits[bytes[i]>>4];hex+=digits[bytes[i]&15];}symbol.set("codePrefix",hex);}
    exports.add(symbol);
  }
  report.set("exports",exports);auto samples=Json::array();const auto start=std::chrono::steady_clock::now();
  for(int i=0;i<120;i++){
    int app=sceSystemServiceGetAppIdOfRunningBigApp(),state=-1,detail=-1,result=-1;if(app>0)result=sceKernelGetAppState(app,&state,&detail);
    samples.add(Json::object({{"elapsedMs",static_cast<int64_t>(std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::steady_clock::now()-start).count())},{"bigApp",app},{"result",result},{"rawState",state},{"rawDetail",detail}}));
    report.set("samples",samples);atomicJson(output,report);std::this_thread::sleep_for(std::chrono::milliseconds(500));
  }
  report.set("completed",true);atomicJson(output,report);return 0;
}catch(const std::exception& e){std::fprintf(stderr,"System UI diagnostic: %s\n",e.what());return 1;}}
