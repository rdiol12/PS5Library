#include <SDL.h>
#include <cassert>
#include <cstring>
#include <deque>
#include <string>
#include <stdexcept>
#include "../frontend/async.hpp"
#include "../frontend/lifecycle.hpp"

static int homeRequests=0,dialogInitializations=0,moduleLoads=0,statusResult=0,statusCalls=0;
static unsigned char background=0;
static bool corruptStatus=false;
struct NativeLaunchContext;
extern "C" int ps5library_native_launch(const char*);
extern "C" int ps5library_native_exit();
static int foregroundResult=0,launchResult=0x4017,launchCalls=0,runningApp=41,titleResult=0,killResult=0,killCalls=0;
static std::string runningTitle="PPSA99051";
static std::string launchedTitle;
static std::deque<SDL_Event> events;
#define main applicationEntry
#include "../native/main.cpp"
#undef main

extern "C" long _write(int fd,const void* data,unsigned long size){return write(fd,data,size);}
extern "C" int __real_fcntl(int,int,...){return 0;}
extern "C" int sceNetInit(){return 0;}
extern "C" int sceNetPoolCreate(const char*,int,int){return 9;}
extern "C" int sceNetPoolDestroy(int pool){assert(pool==9);return 0;}
extern "C" int __real_sceUserServiceInitialize(const void*){return 0;}
extern "C" int sceCommonDialogInitialize(){++dialogInitializations;return static_cast<int>(0x80b80002u);}
extern "C" int sceSysmoduleLoadModule(std::uint16_t id){assert(id==0x96);++moduleLoads;return 0;}
extern "C" int __real_sceImeDialogInit(const void*,void*){assert(moduleLoads==1);return 0;}
extern "C" int __real_sceImeDialogGetStatus(){return 0;}
extern "C" int sceImeDialogAbort(){return 0;}
extern "C" int sceUserServiceGetForegroundUser(std::uint32_t* user){if(!foregroundResult)*user=42;return foregroundResult;}
extern "C" int sceSystemServiceLaunchApp(const char* title,char** arguments,NativeLaunchContext* context){
  ++launchCalls;launchedTitle=title;assert(arguments&&arguments[0]==nullptr&&context&&context->user==42);return launchResult;
}
extern "C" int sceSystemServiceGetAppIdOfRunningBigApp(){return runningApp;}
extern "C" int sceLncUtilGetAppTitleId(std::uint32_t app,char* title){assert(app==static_cast<std::uint32_t>(runningApp));if(!titleResult)std::strcpy(title,runningTitle.c_str());return titleResult;}
extern "C" int sceSystemServiceKillApp(int app,int how,int reason,int coreDump){++killCalls;assert(app==runningApp&&how==-1&&reason==0&&coreDump==0);return killResult;}
extern "C" int sceSystemServiceNavigateToGoHome(){++homeRequests;return 0;}
extern "C" int sceSystemServiceGetStatus(void* target){++statusCalls;auto* bytes=static_cast<unsigned char*>(target);bytes[5]=background;if(corruptStatus)bytes[136]=0;return statusResult;}
extern "C" void __real_SDL_RenderPresent(SDL_Renderer*){}
extern "C" int __real_SDL_PollEvent(SDL_Event* event){if(events.empty())return 0;*event=events.front();events.pop_front();return 1;}
int storefront_main(int argc,char** argv){assert(argc==1);assert(std::strcmp(argv[0],"ps5library")==0);return 7;}

int main(){
  storefront::AsyncWorker worker;std::thread::id first,second,mainThread=std::this_thread::get_id();
  assert(worker.submit([&]{first=std::this_thread::get_id();return std::string("first");}).get()=="first");
  assert(worker.submit([&]{second=std::this_thread::get_id();return std::string("second");}).get()=="second");
  assert(first==second&&first!=mainThread);
  assert(applicationEntry()==7); // Normal return must reach the native CRT's exit.
  assert(ps5library_native_launch("BAD")==-EINVAL&&launchCalls==0);
  foregroundResult=-55;assert(ps5library_native_launch("PPSA12345")==-55&&launchCalls==0);
  foregroundResult=0;assert(ps5library_native_launch("PPSA12345")==launchResult&&launchCalls==1&&launchedTitle=="PPSA12345");
  assert(ps5library_native_launch("CUSA54321")==launchResult&&launchCalls==2&&launchedTitle=="CUSA54321");
  assert(ps5library_native_exit()==0&&killCalls==1);
  runningTitle="CUSA54321";assert(ps5library_native_exit()==-EPERM&&killCalls==1);
  runningTitle="PPSA99051";runningApp=-1;assert(ps5library_native_exit()==-ESRCH&&killCalls==1);
  assert(__wrap_sceKeyboardInit()==-1&&errno==ENOSYS);
  assert(__wrap_sceKeyboardOpen(0,0,0,nullptr)==-1);
  assert(__wrap_sceImeDialogInit(nullptr,nullptr)==0);
  assert(__wrap_sceImeDialogInit(nullptr,nullptr)==0);
  assert(dialogInitializations==1&&moduleLoads==1);
  SDL_Event event{};
  assert(__wrap_SDL_PollEvent(&event)==0);assert(statusCalls==0);
  assert(__wrap_SDL_PollEvent(&event)==0);assert(homeRequests==0&&statusCalls==0);
  background=2;corruptStatus=true;
  assert(__wrap_SDL_PollEvent(&event)==0);assert(statusCalls==0); // Release builds never call the unverified ABI.
}
