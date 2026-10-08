#include "../agent/local.hpp"
#include "../agent/storage_format.hpp"
#include <atomic>
#include <cassert>
#include <chrono>
#include <thread>

int main(){using namespace ps5library;
  const auto auth=std::string(" HTTP/1.1\r\nAuthorization: Bearer ")+localAgentCredential+"\r\n\r\n";
  auto parsed=parseLocalAgentRequest("POST /api/v1/agent/storage/usb0/format/prepare"+auth);assert(parsed.action==LocalAgentAction::FormatPrepare&&parsed.storageId=="usb0");
  const std::string token(64,'a');parsed=parseLocalAgentRequest("POST /api/v1/agent/storage/usb0/format/confirm/"+token+auth);assert(parsed.action==LocalAgentAction::FormatConfirm&&parsed.storageId=="usb0"&&parsed.challenge==token);
  assert(parseLocalAgentRequest("POST /api/v1/agent/storage/ext0/format/prepare"+auth).action==LocalAgentAction::Invalid);

  std::atomic<uint32_t> serial{7};std::atomic<int> calls{0};
  auto identity=[&](const std::string& id){assert(id=="usb0");UsbFormatIdentity value;value.storageId=id;value.mountPath="/mnt/usb0";value.device="/dev/da1p1";value.wholeDevice="/dev/da1";value.filesystem="exfatfs";value.mountDev=11;value.deviceDev=22;value.deviceRdev=33;value.wholeDev=22;value.wholeRdev=32;value.totalBytes=1024*1024;value.volumeSerial=serial.load();value.volumeLength=2048;value.sectorShift=9;return value;};
  StorageFormatCoordinator formatter(identity,[](const UsbFormatIdentity&){return false;},[&](const UsbFormatIdentity& value){assert(value.wholeDevice=="/dev/da1");calls++;return 0;},[]{return .5f;});
  auto first=formatter.prepare("usb0");serial=8;bool rejected=false;try{formatter.confirm("usb0",first["challenge"].string());}catch(const std::exception& error){rejected=std::string(error.what())=="STORAGE_FORMAT_IDENTITY_CHANGED";}assert(rejected&&calls==0);
  serial=7;rejected=false;try{formatter.confirm("usb0",first["challenge"].string());}catch(const std::exception& error){rejected=std::string(error.what())=="STORAGE_FORMAT_CONFIRMATION_INVALID";}assert(rejected&&calls==0);
  auto second=formatter.prepare("usb0");auto accepted=formatter.confirm("usb0",second["challenge"].string());assert(accepted["accepted"].boolean());
  for(int i=0;i<100&&formatter.state()["formatState"].string()!="COMPLETE";i++)std::this_thread::sleep_for(std::chrono::milliseconds(2));assert(calls==1&&formatter.state()["formatState"].string()=="COMPLETE");
  rejected=false;try{formatter.confirm("usb0",second["challenge"].string());}catch(const std::exception& error){rejected=std::string(error.what())=="STORAGE_FORMAT_CONFIRMATION_INVALID";}assert(rejected&&calls==1);
  StorageFormatCoordinator failed(identity,[](const UsbFormatIdentity&){return false;},[](const UsbFormatIdentity&){return static_cast<int>(0x80020001u);},[]{return 0.f;});
  auto third=failed.prepare("usb0");failed.confirm("usb0",third["challenge"].string());for(int i=0;i<100&&failed.state()["formatState"].string()!="ERROR";i++)std::this_thread::sleep_for(std::chrono::milliseconds(2));assert(failed.state()["formatError"].string()=="STORAGE_FORMAT_FAILED_80020001");
  std::atomic<bool> reconnectNotice{false};StorageFormatCoordinator reconnect(identity,[](const UsbFormatIdentity&){return false;},[](const UsbFormatIdentity&)->int{throw std::runtime_error("STORAGE_FORMAT_FINISHED_RECONNECT_USB");},[]{return 1.f;},[&](const std::string& value){reconnectNotice=value.find("reconnect")!=std::string::npos;});
  auto reconnectToken=reconnect.prepare("usb0");reconnect.confirm("usb0",reconnectToken["challenge"].string());for(int i=0;i<100&&(reconnect.state()["formatState"].string()!="RECONNECT_REQUIRED"||!reconnectNotice);i++)std::this_thread::sleep_for(std::chrono::milliseconds(2));assert(reconnect.state()["formatProgress"].number()==100&&reconnect.state()["formatError"].null()&&reconnectNotice);
  std::atomic<bool> release{false};std::atomic<int> probes{0};StorageFormatCoordinator active([&](const std::string& id){probes++;return identity(id);},[](const UsbFormatIdentity&){return false;},[&](const UsbFormatIdentity&){while(!release)std::this_thread::sleep_for(std::chrono::milliseconds(1));return 0;},[]{return 0.f;});auto fourth=active.prepare("usb0");active.confirm("usb0",fourth["challenge"].string());for(int i=0;i<100&&active.state()["formatState"].string()!="FORMATTING";i++)std::this_thread::sleep_for(std::chrono::milliseconds(2));const auto before=probes.load();rejected=false;try{active.prepare("usb0");}catch(const std::exception& error){rejected=std::string(error.what())=="STORAGE_FORMAT_BUSY";}assert(rejected&&probes==before);release=true;for(int i=0;i<100&&active.state()["formatState"].string()!="COMPLETE";i++)std::this_thread::sleep_for(std::chrono::milliseconds(2));assert(active.state()["formatState"].string()=="COMPLETE");
}
