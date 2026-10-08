#pragma once
#include "../common/client.hpp"
#include <algorithm>
#include <charconv>
#include <cstdint>
#include <optional>
#include <set>
#include <string>
#include <string_view>

namespace ps5library {
inline constexpr std::uint64_t mdbgExceptionStopFlag=0x00080000ULL;
inline constexpr bool mdbgExceptionStopped(std::uint64_t flags){return (flags&mdbgExceptionStopFlag)!=0;}
inline std::string_view launchLogDelta(std::string_view previous,std::string_view current){
  if(current.empty())return current;
  if(previous.empty())return current;
  if(current.size()>=previous.size()&&current.substr(0,previous.size())==previous)return current.substr(previous.size());
  return current;
}
struct FatalThread {
  int pid=-1;std::uint64_t threadId=0,rax=0,rbx=0,rcx=0,rdx=0,rsi=0,rdi=0,rbp=0,rsp=0,r8=0,r9=0,r10=0,r11=0,r12=0,r13=0,r14=0,r15=0,rip=0,eflags=0;
};
inline std::optional<std::uint64_t> launchLogNumber(std::string_view block,std::string_view label,int base){
  auto at=block.find(label);if(at==std::string_view::npos)return std::nullopt;at+=label.size();while(at<block.size()&&(block[at]==' '||block[at]=='\t'))at++;std::uint64_t value=0;const auto parsed=std::from_chars(block.data()+at,block.data()+block.size(),value,base);if(parsed.ec!=std::errc()||parsed.ptr==block.data()+at)return std::nullopt;return value;
}
inline std::optional<FatalThread> parseFatalThread(std::string_view log,int pid){
  std::optional<FatalThread> latest;std::size_t start=0;
  while((start=log.find("# exception:",start))!=std::string_view::npos){
    const auto next=log.find("# exception:",start+1),end=next==std::string_view::npos?log.size():next;const auto block=log.substr(start,end-start);FatalThread value;
    auto proc=launchLogNumber(block,"# proc ID:",10),thread=launchLogNumber(block,"# thread ID:",10);
    auto rax=launchLogNumber(block,"# rax:",16),rbx=launchLogNumber(block,"rbx:",16),rcx=launchLogNumber(block,"# rcx:",16),rdx=launchLogNumber(block,"rdx:",16),rsi=launchLogNumber(block,"# rsi:",16),rdi=launchLogNumber(block,"rdi:",16),rbp=launchLogNumber(block,"# rbp:",16),rsp=launchLogNumber(block,"rsp:",16),r8=launchLogNumber(block,"# r8 :",16),r9=launchLogNumber(block,"r9 :",16),r10=launchLogNumber(block,"# r10:",16),r11=launchLogNumber(block,"r11:",16),r12=launchLogNumber(block,"# r12:",16),r13=launchLogNumber(block,"r13:",16),r14=launchLogNumber(block,"# r14:",16),r15=launchLogNumber(block,"r15:",16),rip=launchLogNumber(block,"# rip:",16),eflags=launchLogNumber(block,"eflags:",16);
    if(proc&&thread&&*proc==static_cast<std::uint64_t>(pid)&&rax&&rbx&&rcx&&rdx&&rsi&&rdi&&rbp&&rsp&&r8&&r9&&r10&&r11&&r12&&r13&&r14&&r15&&rip&&eflags){
      value={pid,*thread,*rax,*rbx,*rcx,*rdx,*rsi,*rdi,*rbp,*rsp,*r8,*r9,*r10,*r11,*r12,*r13,*r14,*r15,*rip,*eflags};latest=value;
    }
    if(next==std::string_view::npos)break;start=next;
  }
  return latest;
}
inline std::string launchHex(std::uint64_t value){
  static constexpr char digits[]="0123456789abcdef";char buffer[18]={'0','x'};for(int index=17;index>=2;index--){buffer[index]=digits[value&15];value>>=4;}return std::string(buffer,sizeof(buffer));
}
inline Json fatalThreadJson(const FatalThread& value){
  return Json::object({{"pid",value.pid},{"threadId",static_cast<int64_t>(value.threadId)},{"rax",launchHex(value.rax)},{"rbx",launchHex(value.rbx)},{"rcx",launchHex(value.rcx)},{"rdx",launchHex(value.rdx)},{"rsi",launchHex(value.rsi)},{"rdi",launchHex(value.rdi)},{"rbp",launchHex(value.rbp)},{"rsp",launchHex(value.rsp)},{"r8",launchHex(value.r8)},{"r9",launchHex(value.r9)},{"r10",launchHex(value.r10)},{"r11",launchHex(value.r11)},{"r12",launchHex(value.r12)},{"r13",launchHex(value.r13)},{"r14",launchHex(value.r14)},{"r15",launchHex(value.r15)},{"rip",launchHex(value.rip)},{"eflags",launchHex(value.eflags)}});
}
class LaunchProcessWatch {
  bool armed_=false;unsigned missing_=0;
public:
  void reset(){armed_=false;missing_=0;}
  bool observe(std::optional<int> pid){
    if(!pid){missing_=0;return false;}
    if(*pid>0){armed_=true;missing_=0;return false;}
    if(!armed_){missing_=0;return false;}
    if(++missing_<2)return false;reset();return true;
  }
};
class LaunchTrace {
  static constexpr size_t klogLimit=256*1024,manualKlogLookback=64*1024,errorFileLimit=256*1024,errorTotalLimit=1024*1024,errorFileCount=32;
  fs::path receipt_,history_;
  Json record_;
  std::set<std::string> historyBefore_;
  std::string klog_,klogError_;
  uint64_t klogBase_=0,klogEnd_=0,klogMark_=0;
  bool active_=false,appeared_=false,klogAvailable_=false,historyAvailable_=false,persistenceAvailable_=true;

  std::pair<bool,std::set<std::string>> historyNames() const {
    std::set<std::string> names;std::error_code error;
    fs::directory_iterator current(history_,error),end;if(error)return {false,{}};
    for(;current!=end;current.increment(error)){
      if(error)return {false,{}};
      auto status=current->symlink_status(error);if(error)return {false,{}};
      if(fs::is_regular_file(status)&&current->path().extension()==".json")names.insert(current->path().filename().string());
    }
    return {true,std::move(names)};
  }
  void initialize(const std::string& title,const char* source,int64_t at){
    const bool agent=source==std::string_view("AGENT");active_=true;appeared_=false;klogMark_=agent?klogEnd_:std::max(klogBase_,klogEnd_-std::min<uint64_t>(klogEnd_-klogBase_,manualKlogLookback));
    auto snapshot=historyNames();historyAvailable_=snapshot.first;historyBefore_=std::move(snapshot.second);
    record_=Json::object({{"schemaVersion",1},{"titleId",title},{"source",source},{"state",agent?"QUEUED":"BIG_APP_OBSERVED"},{"traceStartedAtUnixMs",at},{"processObserved",false},{"mdbgPolled",false},{"mdbgAvailable",false},{"mdbgExceptionStop",false},{"klogAvailable",klogAvailable_},{"klogLookbackBytes",agent?int64_t(0):static_cast<int64_t>(klogEnd_-klogMark_)},{"errorHistoryAccessible",historyAvailable_}});
    if(!klogError_.empty())record_.set("klogError",klogError_);
  }
  Json newHistory(bool& truncated){
    auto result=Json::array();if(!historyAvailable_){record_.set("errorHistoryAccessible",false);return result;}auto current=historyNames();record_.set("errorHistoryAccessible",current.first);if(!current.first)return result;
    size_t count=0,total=0;
    for(const auto& name:current.second){
      if(historyBefore_.count(name))continue;
      std::error_code error;const auto path=history_/name;auto size=fs::file_size(path,error);
      if(error||size>errorFileLimit||count>=errorFileCount||total+size>errorTotalLimit){truncated=true;continue;}
      try{auto content=readJsonIfPresent(path);if(content){result.add(Json::object({{"name",name},{"content",*content}}));total+=static_cast<size_t>(size);count++;}}
      catch(...){result.add(Json::object({{"name",name},{"readError",true}}));count++;}
    }
    return result;
  }
  void disable() noexcept {active_=false;appeared_=false;}
  void fail() noexcept {persistenceAvailable_=false;disable();}
  bool save() noexcept {if(!active_)return false;try{atomicJson(receipt_,record_);return true;}catch(...){fail();return false;}}
public:
  explicit LaunchTrace(fs::path receipt,fs::path history="/system_data/priv/error/history"):receipt_(std::move(receipt)),history_(std::move(history)){}
  bool active() const{return active_;}
  bool appeared() const{return appeared_;}
  bool processObserved() const{return active_&&record_["processObserved"].boolean();}
  int processId() const{return processObserved()?static_cast<int>(record_["pid"].number(-1)):-1;}
  bool matches(std::string_view title) const{return active_&&record_["titleId"].string()==title;}
  void klogStatus(bool available,std::string error={}) noexcept {
    try{klogAvailable_=available;klogError_=std::move(error);if(active_){record_.set("klogAvailable",available);record_.set("klogError",klogError_);save();}}catch(...){fail();}
  }
  void appendKlog(std::string_view bytes) noexcept {
    try{if(!persistenceAvailable_)return;std::string clean(bytes);std::replace(clean.begin(),clean.end(),'\0',' ');klogEnd_+=clean.size();klog_+=clean;if(klog_.size()>klogLimit){const auto removed=klog_.size()-klogLimit;klog_.erase(0,removed);klogBase_+=removed;}}catch(...){fail();}
  }
  void beginAgent(const std::string& title,int64_t at) noexcept {try{if(!persistenceAvailable_)return;initialize(title,"AGENT",at);record_.set("launchRequestedAtUnixMs",at);save();}catch(...){fail();}}
  void appeared(const std::string& title,int64_t at) noexcept {
    try{if(!persistenceAvailable_)return;if(!matches(title))initialize(title,"MANUAL",at);appeared_=true;record_.set("state","BIG_APP_OBSERVED");record_.set("bigAppObservedAtUnixMs",at);save();}catch(...){fail();}
  }
  void state(const std::string& state,int64_t at) noexcept {try{if(!active_)return;record_.set("state",state);record_.set("stateChangedAtUnixMs",at);save();}catch(...){fail();}}
  void launchResult(int initialize,int user,int launch,int64_t at) noexcept {
    try{if(!active_)return;record_.set("launchResult",Json::object({{"initialize",initialize},{"user",user},{"launch",launch}}));record_.set("launchCompletedAtUnixMs",at);record_.set("state",user||launch<0?"REJECTED":"ACCEPTED");save();}catch(...){fail();}
  }
  void process(int pid,int64_t at) noexcept {try{if(!active_||pid<=0)return;record_.set("processObserved",true);record_.set("pid",pid);record_.set("processObservedAtUnixMs",at);save();}catch(...){fail();}}
  bool mdbg(int callResult,int64_t status,std::uint64_t flags,int64_t at) noexcept {
    try{if(!active_)return false;const bool first=!record_["mdbgPolled"].boolean(),available=!callResult&&!status,exception=available&&mdbgExceptionStopped(flags),firstException=exception&&!record_["mdbgExceptionStop"].boolean();const auto stored=record_["mdbgFlags"].number(-1);const bool changed=first||record_["mdbgCallResult"].number()!=callResult||record_["mdbgStatus"].number()!=status||(available&&(!record_["mdbgAvailable"].boolean()||stored!=static_cast<int64_t>(flags)));record_.set("mdbgPolled",true);record_.set("mdbgCallResult",callResult);record_.set("mdbgStatus",status);if(available){record_.set("mdbgAvailable",true);record_.set("mdbgFlags",static_cast<int64_t>(flags));record_.set("mdbgObservedAtUnixMs",at);if(firstException){record_.set("mdbgExceptionStop",true);record_.set("mdbgExceptionFlags",static_cast<int64_t>(flags));record_.set("mdbgExceptionObservedAtUnixMs",at);}}if(changed)save();return firstException;}catch(...){fail();return false;}
  }
  void exceptionSnapshot(Json snapshot) noexcept {try{if(active_){record_.set("exceptionSnapshot",snapshot);save();}}catch(...){fail();}}
  void exited(int64_t at) noexcept {try{if(!active_)return;record_.set("state","PROCESS_EXITED");record_.set("processExitAtUnixMs",at);save();}catch(...){fail();}}
  void finish(int64_t at,const std::string& state="PROCESS_EXITED") noexcept {
    try{if(!active_)return;bool truncated=false;record_.set("state",state);record_.set("traceCompletedAtUnixMs",at);record_.set("errorHistory",newHistory(truncated));record_.set("errorHistoryTruncated",truncated);const auto begin=std::max(klogMark_,klogBase_);record_.set("klog",klog_.substr(static_cast<size_t>(begin-klogBase_)));record_.set("klogTruncated",klogMark_<klogBase_);save();disable();}catch(...){fail();}
  }
};
}
