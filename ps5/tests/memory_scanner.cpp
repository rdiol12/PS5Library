#include "../agent/memory_scanner.hpp"
#include <cassert>
#include <cstring>
#include <functional>
#include <map>

using namespace ps5library;
namespace {
class Memory final:public CheatRuntime {
public:
  CheatTarget target;std::map<std::uint64_t,unsigned char> bytes;bool runningNow=true;std::size_t writeCalls=0;std::uint64_t failWriteAt=UINT64_MAX;
  std::optional<CheatTarget> running(std::string_view process={})override{if(!runningNow||(!process.empty()&&process!=target.process))return std::nullopt;return target;}
  bool canRead()const override{return true;}bool canWrite()const override{return true;}
  std::vector<unsigned char> read(const CheatTarget& observed,std::uint64_t offset,std::size_t size)override{if(!runningNow||observed.token!=target.token)throw std::runtime_error("CHEAT_TARGET_CHANGED");std::vector<unsigned char> result(size);for(std::size_t i=0;i<size;i++)result[i]=bytes[offset+i];return result;}
  void write(const CheatTarget& observed,std::uint64_t offset,const std::vector<unsigned char>& value)override{if(!runningNow||observed.token!=target.token)throw std::runtime_error("CHEAT_TARGET_CHANGED");writeCalls++;if(offset==failWriteAt)throw std::runtime_error("MEMORY_WRITE_FAILED");for(std::size_t i=0;i<value.size();i++)bytes[offset+i]=value[i];}
  void put(std::uint64_t offset,std::uint32_t value){for(unsigned i=0;i<4;i++)bytes[offset+i]=static_cast<unsigned char>(value>>(i*8));}
  void putFloat(std::uint64_t offset,float value){unsigned char raw[4];std::memcpy(raw,&value,4);for(unsigned i=0;i<4;i++)bytes[offset+i]=raw[i];}
  std::uint32_t get(std::uint64_t offset)const{std::uint32_t value=0;for(unsigned i=0;i<4;i++)value|=static_cast<std::uint32_t>(bytes.at(offset+i))<<(i*8);return value;}
};
bool throws(const std::function<void()>& action,const char* expected){try{action();}catch(const std::exception& error){return std::strcmp(error.what(),expected)==0;}return false;}
}

int main(){
  assert(memoryRuntimeSupported(0x4510000));
  assert(memoryRuntimeSupported(0x4500000));
  assert(memoryDiscoverySupported(0x4500000));
  assert(memoryDiscoverySupported(0x4510000));
  assert(!memoryDiscoverySupported(0x5000000));
  Memory memory;memory.target.token=7;memory.target.pid=42;memory.target.moduleBase=0x1000;memory.target.moduleSize=0x100;memory.target.titleId="PPSA01628";memory.target.version="1.026.000";memory.target.process="eboot.bin";memory.target.ranges={{0,0x80,true,true},{0x80,0x80,true,false}};memory.put(0x10,100);memory.put(0x20,100);memory.put(0x84,100);
  MemoryScanner scanner(memory,true);auto target=scanner.target();assert(target["available"].boolean()&&target["titleId"].string()=="PPSA01628"&&target["process"].string()=="eboot.bin"&&target["scope"].string()=="MODULE_WRITABLE"&&!target["pid"].isInteger());auto started=scanner.start("PPSA01628","1.026.000","U32","EXACT","100");assert(started["candidateCount"].number()==2&&started["valueType"].string()=="U32"&&started["materialized"].boolean()&&started.dump().find("offset")==std::string::npos);auto scanId=started["scanId"].string();
  memory.put(0x10,101);auto changed=scanner.refine(scanId,"CHANGED");assert(changed["candidateCount"].number()==1);auto watched=scanner.watch(scanId);assert(watched["results"].size()==1&&watched["results"][size_t(0)]["value"].string()=="101"&&watched["results"][size_t(0)]["writable"].boolean());auto resultId=watched["results"][size_t(0)]["resultId"].string();assert(scanner.write(scanId,resultId,"500",true)["value"].string()=="500"&&memory.get(0x10)==500);memory.put(0x10,501);scanner.reconcile();assert(memory.get(0x10)==500);assert(throws([&]{scanner.clear();},"MEMORY_RESTORE_REQUIRED"));assert(scanner.restore(scanId,resultId)["value"].string()=="101"&&memory.get(0x10)==101);scanner.clear();
  started=scanner.start("PPSA01628","1.026.000","U32","EXACT","100");scanId=started["scanId"].string();watched=scanner.watch(scanId);assert(watched["results"].size()==1&&watched["results"][size_t(0)]["writable"].boolean());assert(throws([&]{scanner.start("PPSA99999","1.026.000","U32","EXACT","100");},"MEMORY_TARGET_MISMATCH"));scanner.clear();
  started=scanner.start("PPSA01628","1.026.000","U8","UNKNOWN");scanId=started["scanId"].string();memory.bytes[0]=1;auto increased=scanner.refine(scanId,"INCREASED");assert(increased["candidateCount"].number()==1&&increased["results"][size_t(0)]["value"].string()=="1");scanner.clear();memory.putFloat(0x40,12.5f);assert(scanner.start("PPSA01628","1.026.000","F32","EXACT","12.5")["candidateCount"].number()==1);scanner.clear();
  memory.target.moduleSize=0x20000;memory.target.ranges={{0,0x20000,true,true}};started=scanner.start("PPSA01628","1.026.000","U8","UNKNOWN");scanId=started["scanId"].string();assert(started["candidateCount"].number()==0x20000&&!started["materialized"].boolean()&&started["results"].size()==0);memory.bytes[0x1ffff]=1;changed=scanner.refine(scanId,"CHANGED");assert(changed["candidateCount"].number()==1&&changed["materialized"].boolean()&&changed["results"][size_t(0)]["value"].string()=="1");scanner.clear();memory.target.moduleSize=0x100;memory.target.ranges={{0,0x80,true,true},{0x80,0x80,true,false}};
  memory.put(0x10,100);started=scanner.start("PPSA01628","1.026.000","U32","EXACT","100");scanId=started["scanId"].string();resultId=scanner.watch(scanId)["results"][size_t(0)]["resultId"].string();scanner.write(scanId,resultId,"777",false);const auto writesBeforeRestart=memory.writeCalls;memory.target.token++;scanner.reconcile();assert(memory.writeCalls==writesBeforeRestart&&memory.get(0x10)==777);scanner.clear();started=scanner.start("PPSA01628","1.026.000","U32","EXACT","777");assert(started["candidateCount"].number()==1);scanner.clear();
  memory.target.token++;memory.put(0x10,100);memory.put(0x20,100);started=scanner.start("PPSA01628","1.026.000","U32","EXACT","100");scanId=started["scanId"].string();watched=scanner.watch(scanId);const auto first=watched["results"][size_t(0)]["resultId"].string(),second=watched["results"][size_t(1)]["resultId"].string();scanner.write(scanId,first,"701");scanner.write(scanId,second,"702",true);memory.failWriteAt=0x10;assert(throws([&]{scanner.restoreAll();},"MEMORY_RESTORE_ALL_FAILED")&&memory.get(0x10)==701&&memory.get(0x20)==100);memory.failWriteAt=UINT64_MAX;assert(scanner.restoreAll()==1&&memory.get(0x10)==100);
  MemoryScanner readOnly(memory);started=readOnly.start("PPSA01628","1.026.000","U32","EXACT","100");scanId=started["scanId"].string();resultId=readOnly.watch(scanId)["results"][size_t(0)]["resultId"].string();assert(throws([&]{readOnly.write(scanId,resultId,"1");},"MEMORY_WRITE_DISABLED"));return 0;
}
