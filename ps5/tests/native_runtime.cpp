#include <SDL.h>
#include <atomic>
#include <cassert>
#include <cstring>
#include <deque>
#include <fstream>
#include <string>
#include <stdexcept>
#include <vector>
#include "../frontend/async.hpp"
#include "../frontend/lifecycle.hpp"

static int homeRequests=0,dialogInitializations=0,moduleLoads=0,statusResult=0,statusCalls=0;
static unsigned char background=0;
static bool corruptStatus=false;
struct NativeLaunchContext;
extern "C" int ps5library_native_launch(const char*);
static int foregroundResult=0,launchResult=0x4017,launchCalls=0;
static std::string launchedTitle;
static std::deque<SDL_Event> events;
#define PS5LIBRARY_NATIVE_DIAGNOSTIC
#define PS5LIBRARY_NATIVE_DIAGNOSTIC_ROOT "/tmp/ps5library-native-runtime-checks"
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
  ++launchCalls;launchedTitle=title;assert(arguments&&arguments[0]==nullptr&&context&&context->size==sizeof(*context)&&context->user==42);return launchResult;
}
extern "C" int sceSystemServiceNavigateToGoHome(){++homeRequests;return 0;}
extern "C" int sceSystemServiceGetStatus(void* target){++statusCalls;auto* bytes=static_cast<unsigned char*>(target);bytes[5]=background;if(corruptStatus)bytes[136]=0;return statusResult;}
extern "C" void __real_SDL_RenderPresent(SDL_Renderer*){}
extern "C" int __real_SDL_PollEvent(SDL_Event* event){if(events.empty())return 0;*event=events.front();events.pop_front();return 1;}
int storefront_main(int argc,char** argv){assert(argc==1);assert(std::strcmp(argv[0],"ps5library")==0);return 7;}

int main(){
  constexpr char traceRoot[]="/tmp/ps5library-native-runtime-checks";
  constexpr char tracePath[]="/tmp/ps5library-native-runtime-checks/ps5library-native-stage.bin";
  unlink(tracePath);rmdir(traceRoot);assert(mkdir(traceRoot,0755)==0);
  storefront::AsyncWorker worker;std::thread::id first,second,mainThread=std::this_thread::get_id();
  std::atomic<bool> release{false};auto blocked=worker.submit([&]{while(!release.load(std::memory_order_acquire))std::this_thread::yield();return Json("released");});
  auto queued=worker.submit([]{return Json("queued");});while(queued.wait_for(std::chrono::seconds(0))!=storefront::AsyncWorker::Status::ready)std::this_thread::yield();assert(storefront::AsyncWorker::take(queued).string()=="queued");release.store(true,std::memory_order_release);
  blocked.wait();assert(storefront::AsyncWorker::take(blocked).string()=="released");
  auto failed=worker.submit([]()->Json{throw std::runtime_error("async failure");});auto failure=storefront::AsyncWorker::take(failed);assert(failure["error"].string()=="async failure"&&!failed.valid());
  std::atomic<bool> replaceRelease{false};auto replaced=worker.submit([&]{while(!replaceRelease.load(std::memory_order_acquire))std::this_thread::yield();return Json("old");});std::thread releaser([&]{replaceRelease.store(true,std::memory_order_release);});replaced=worker.submit([]{return Json("new");});releaser.join();assert(storefront::AsyncWorker::take(replaced).string()=="new");
  auto firstResult=worker.submit([&]{first=std::this_thread::get_id();return Json("first");});assert(storefront::AsyncWorker::take(firstResult).string()=="first");
  auto secondResult=worker.submit([&]{second=std::this_thread::get_id();return Json("second");});assert(storefront::AsyncWorker::take(secondResult).string()=="second");
  auto nestedResult=worker.submit([]{auto value=Json::object();for(int index=0;index<20;++index)value=Json::object({{"child",value}});return value;});auto nested=storefront::AsyncWorker::take(nestedResult);
  for(int index=0;index<20;++index)nested=nested["child"];
  assert(nested.isObject());
  assert(first!=mainThread&&second!=mainThread);
  assert(applicationEntry()==7);
  assert(ps5library_native_launch("BAD")==-EINVAL&&launchCalls==0);
  foregroundResult=-55;assert(ps5library_native_launch("PPSA12345")==-55&&launchCalls==0);
  foregroundResult=0;assert(ps5library_native_launch("PPSA12345")==launchResult&&launchCalls==1&&launchedTitle=="PPSA12345");
  assert(ps5library_native_launch("CUSA54321")==launchResult&&launchCalls==2&&launchedTitle=="CUSA54321");
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
  nativeTraceClose();unlink(tracePath);nativeTraceSequence=0;
  for(int stage=0;stage<static_cast<int>(nativeTraceCapacity)+7;stage++)native_stage(1000+stage);
  nativeTraceClose();native_stage(424242);nativeTraceClose();
  struct TraceRecord {std::uint32_t magic;std::int32_t stage;std::uint64_t sequence,checksum;};
  static_assert(sizeof(TraceRecord)==24);
  std::ifstream trace(tracePath,std::ios::binary);assert(trace);
  std::vector<TraceRecord> records(8);trace.read(reinterpret_cast<char*>(records.data()),records.size()*sizeof(TraceRecord));
  assert(trace.gcount()==static_cast<std::streamsize>(records.size()*sizeof(TraceRecord))&&trace.peek()==EOF);
  std::uint64_t latest=0;int latestStage=0,previousStage=0;size_t valid=0;
  for(const auto& record:records)if(record.magic==nativeTraceMagic&&record.checksum==nativeTraceChecksum(record.stage,record.sequence)){
    ++valid;if(record.sequence>latest){previousStage=latestStage;latest=record.sequence;latestStage=record.stage;}
  }
  assert(valid==8&&previousStage==1000+static_cast<int>(nativeTraceCapacity)+6&&latestStage==424242);
  unlink(tracePath);rmdir(traceRoot);
}
