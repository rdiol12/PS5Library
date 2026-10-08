#include "../common/client.hpp"
#include <array>
#include <cstdio>
#include <mutex>
#ifdef PS5
#include <dlfcn.h>
extern "C" int sceUserServiceInitialize(void*);
extern "C" int sceUserServiceGetNpAccountId(int,uint64_t*);
#endif
namespace ps5library {
std::string remotePlayAccountId(uint64_t value){
  static constexpr char alphabet[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  std::array<unsigned char,8> input{};for(size_t i=0;i<input.size();i++)input[i]=static_cast<unsigned char>(value>>(i*8));
  std::string output;output.reserve(12);
  for(size_t i=0;i<input.size();i+=3){const auto remaining=input.size()-i;const uint32_t bits=(uint32_t(input[i])<<16)|(remaining>1?uint32_t(input[i+1])<<8:0)|(remaining>2?input[i+2]:0);
    output+=alphabet[(bits>>18)&63];output+=alphabet[(bits>>12)&63];output+=remaining>1?alphabet[(bits>>6)&63]:'=';output+=remaining>2?alphabet[bits&63]:'=';}
  return output;
}
std::string remotePlayPin(uint32_t value){if(value>99999999)return {};char pin[9];std::snprintf(pin,sizeof(pin),"%08u",value);return pin;}

#ifdef PS5
namespace {
using Initialize=int(*)(void*,size_t);using Generate=int(*)(uint32_t*);using Confirm=int(*)(int*,int*);using Notify=int(*)(int);
struct Symbols {Initialize initialize{};Generate generate{};Confirm confirm{};Notify notify{};};
Symbols& symbols(){static Symbols value;static std::once_flag once;std::call_once(once,[&]{
  void* module=nullptr;for(const auto* path:{"/system/common/lib/libSceRemoteplay.sprx","/system_ex/common/lib/libSceRemoteplay.sprx","/system/priv/lib/libSceRemoteplay.sprx"})if((module=dlopen(path,RTLD_NOW|RTLD_LOCAL)))break;
  if(module){value.initialize=reinterpret_cast<Initialize>(dlsym(module,"sceRemoteplayInitialize"));value.generate=reinterpret_cast<Generate>(dlsym(module,"sceRemoteplayGeneratePinCode"));value.confirm=reinterpret_cast<Confirm>(dlsym(module,"sceRemoteplayConfirmDeviceRegist"));value.notify=reinterpret_cast<Notify>(dlsym(module,"sceRemoteplayNotifyPinCodeError"));}
 });return value;}
std::string remoteError(const char* operation,int error){char value[80];std::snprintf(value,sizeof(value),"REMOTE_PLAY_%s_%08X",operation,static_cast<unsigned>(error));return value;}
}
#endif

bool remotePlayAvailable(){
#ifdef PS5
  const auto& api=symbols();return api.initialize&&api.generate&&api.confirm&&api.notify;
#else
  return false;
#endif
}
Json beginRemotePlayPairing(unsigned userId){
#ifdef PS5
  auto& api=symbols();if(!remotePlayAvailable())return Json::object({{"state","ERROR"},{"error","REMOTE_PLAY_UNAVAILABLE"}});
  (void)sceUserServiceInitialize(nullptr);
  uint64_t account=0;int result=sceUserServiceGetNpAccountId(static_cast<int>(userId),&account);
  if(result||!account)return Json::object({{"state","ERROR"},{"error",result?remoteError("ACCOUNT",result):"REMOTE_PLAY_ACCOUNT_UNAVAILABLE"}});
  result=api.initialize(nullptr,0);if(result&&static_cast<unsigned>(result)!=0x80FC0003u)return Json::object({{"state","ERROR"},{"error",remoteError("INITIALIZE",result)}});
  api.notify(1);uint32_t raw=0;result=api.generate(&raw);auto pin=remotePlayPin(raw);
  if(result||pin.empty())return Json::object({{"state","ERROR"},{"error",result?remoteError("PIN",result):"REMOTE_PLAY_INVALID_PIN"}});
  return Json::object({{"state","READY"},{"pin",pin},{"accountId",remotePlayAccountId(account)}});
#else
  (void)userId;return Json::object({{"state","ERROR"},{"error","REMOTE_PLAY_UNAVAILABLE"}});
#endif
}
Json pollRemotePlayPairing(){
#ifdef PS5
  auto& api=symbols();if(!remotePlayAvailable())return Json::object({{"state","ERROR"},{"error","REMOTE_PLAY_UNAVAILABLE"}});
  const int initialized=api.initialize(nullptr,0);if(initialized&&static_cast<unsigned>(initialized)!=0x80FC0003u)return Json::object({{"state","ERROR"},{"error",remoteError("INITIALIZE",initialized)}});
  int state=0,error=0;const int result=api.confirm(&state,&error);
  if(result)return Json::object({{"state","ERROR"},{"error",remoteError("CONFIRM",result)}});
  if(state==2)return Json::object({{"state","PAIRED"}});
  if(state==3||state==4)return Json::object({{"state","ERROR"},{"error",remoteError("REJECTED",error)}});
#endif
  return Json();
}
void cancelRemotePlayPairing(){
#ifdef PS5
  auto& api=symbols();if(api.notify)api.notify(1);
#endif
}
void Agent::remotePlayPairing(){
  const auto request=client.request("GET","/api/v1/device/remote-play/pairing");
  if(request.null()){if(!remotePlayRequest_.empty())cancelRemotePlayPairing();remotePlayRequest_.clear();remotePlayMaterial_=Json();return;}
  const auto id=request["id"].string(),state=request["state"].string();if(id.empty())return;
  if(id!=remotePlayRequest_){if(!remotePlayRequest_.empty())cancelRemotePlayPairing();remotePlayRequest_=id;remotePlayMaterial_=Json();}
  if(state=="REQUESTED"){
    if(remotePlayMaterial_.null()){
      auto local=localUserId();
      try{remotePlayMaterial_=local.empty()?Json::object({{"state","ERROR"},{"error","REMOTE_PLAY_USER_UNAVAILABLE"}}):beginRemotePlayPairing(static_cast<unsigned>(std::stoul(local,nullptr,16)));}
      catch(...){remotePlayMaterial_=Json::object({{"state","ERROR"},{"error","REMOTE_PLAY_USER_UNAVAILABLE"}});}
    }
    client.request("POST","/api/v1/device/remote-play/pairing/"+id,remotePlayMaterial_);return;
  }
  if(state=="READY")if(const auto result=pollRemotePlayPairing();!result.null()){
    client.request("POST","/api/v1/device/remote-play/pairing/"+id,result);if(result["state"].string()=="ERROR")cancelRemotePlayPairing();remotePlayRequest_.clear();remotePlayMaterial_=Json();
  }
}
}
