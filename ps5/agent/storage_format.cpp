#include "storage_format.hpp"
#include "../common/client.hpp"
#include <algorithm>
#include <cerrno>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <mutex>
#include <optional>
#include <thread>
#include <vector>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#ifdef PS5
#include <sys/mount.h>
#include <dlfcn.h>
extern "C" int sceShellCoreUtilFormatExternalHdd(const char*);
extern "C" float sceShellCoreUtilGetProgressOfFormatExternalHdd();
#endif

namespace ps5library {
bool UsbFormatIdentity::operator==(const UsbFormatIdentity& other) const{return storageId==other.storageId&&mountPath==other.mountPath&&device==other.device&&wholeDevice==other.wholeDevice&&filesystem==other.filesystem&&mountDev==other.mountDev&&mountRdev==other.mountRdev&&deviceDev==other.deviceDev&&deviceRdev==other.deviceRdev&&wholeDev==other.wholeDev&&wholeRdev==other.wholeRdev&&totalBytes==other.totalBytes&&partitionOffset==other.partitionOffset&&volumeLength==other.volumeLength&&bootChecksum==other.bootChecksum&&volumeSerial==other.volumeSerial&&sectorShift==other.sectorShift;}

struct StorageFormatCoordinator::Shared {
  struct Confirmation {std::string value;UsbFormatIdentity identity;std::chrono::steady_clock::time_point expires;};
  std::mutex mutex;std::optional<Confirmation> confirmation;std::string storageId,formatState="IDLE",error;int64_t progress=0;
};

StorageFormatCoordinator::StorageFormatCoordinator(Probe probe,Busy busy,Format format,Progress progress,Notice notice):shared_(std::make_shared<Shared>()),probe_(std::move(probe)),busy_(std::move(busy)),format_(std::move(format)),progress_(std::move(progress)),notice_(std::move(notice)){}
static bool formatActiveState(const std::string& state){return state=="STARTING"||state=="FORMATTING";}
Json StorageFormatCoordinator::state() const {
  bool sample=false;{{std::lock_guard<std::mutex> lock(shared_->mutex);if(shared_->confirmation&&std::chrono::steady_clock::now()>shared_->confirmation->expires){shared_->confirmation.reset();if(shared_->formatState=="CONFIRMATION_REQUIRED")shared_->formatState="IDLE";}sample=shared_->formatState=="FORMATTING";}}
  if(sample&&progress_)try{const auto value=progress_();if(std::isfinite(value)){const auto percent=static_cast<int64_t>(std::clamp(value,0.f,1.f)*100.f);std::lock_guard<std::mutex> lock(shared_->mutex);if(shared_->formatState=="FORMATTING")shared_->progress=std::max(shared_->progress,percent);}}catch(...){ }
  std::lock_guard<std::mutex> lock(shared_->mutex);return Json::object({{"storageId",shared_->storageId},{"formatState",shared_->formatState},{"formatProgress",shared_->progress},{"formatError",shared_->error.empty()?Json():Json(shared_->error)}});
}
bool StorageFormatCoordinator::active() const {std::lock_guard<std::mutex> lock(shared_->mutex);return formatActiveState(shared_->formatState);}
Json StorageFormatCoordinator::describe(const std::string& storageId) const {
  bool eligible=false;try{auto identity=probe_(storageId);eligible=!busy_(identity)&&!active();}catch(...){ }
  auto result=state();if(result["storageId"].string()!=storageId)result=Json::object({{"storageId",storageId},{"formatState","IDLE"},{"formatProgress",int64_t(0)},{"formatError",Json()}});result.set("formatEligible",eligible);return result;
}
Json StorageFormatCoordinator::prepare(const std::string& storageId){
  {std::lock_guard<std::mutex> lock(shared_->mutex);if(formatActiveState(shared_->formatState))throw std::runtime_error("STORAGE_FORMAT_BUSY");}auto identity=probe_(storageId);if(busy_(identity))throw std::runtime_error("STORAGE_FORMAT_BUSY");auto challenge=randomHex(32);
  std::lock_guard<std::mutex> lock(shared_->mutex);if(formatActiveState(shared_->formatState))throw std::runtime_error("STORAGE_FORMAT_BUSY");shared_->confirmation=Shared::Confirmation{challenge,identity,std::chrono::steady_clock::now()+std::chrono::seconds(60)};shared_->storageId=storageId;shared_->formatState="CONFIRMATION_REQUIRED";shared_->progress=0;shared_->error.clear();return Json::object({{"challenge",challenge},{"expiresInSeconds",int64_t(60)}});
}
Json StorageFormatCoordinator::confirm(const std::string& storageId,const std::string& challenge){
  UsbFormatIdentity expected;{
    std::lock_guard<std::mutex> lock(shared_->mutex);const auto now=std::chrono::steady_clock::now();if(!shared_->confirmation||shared_->confirmation->value!=challenge||shared_->confirmation->identity.storageId!=storageId||now>shared_->confirmation->expires){shared_->confirmation.reset();throw std::runtime_error("STORAGE_FORMAT_CONFIRMATION_INVALID");}expected=shared_->confirmation->identity;shared_->confirmation.reset();shared_->storageId=storageId;shared_->formatState="STARTING";shared_->progress=0;shared_->error.clear();
  }
  try{auto current=probe_(storageId);if(!(current==expected))throw std::runtime_error("STORAGE_FORMAT_IDENTITY_CHANGED");if(busy_(current))throw std::runtime_error("STORAGE_FORMAT_BUSY");}
  catch(const std::exception& error){std::lock_guard<std::mutex> lock(shared_->mutex);shared_->formatState="ERROR";shared_->error=error.what();throw;}
  auto shared=shared_;auto probe=probe_;auto busy=busy_;auto format=format_;auto notice=notice_;if(notice)notice("USB extended storage formatting started. Keep the drive connected.");
  std::thread([shared,probe,busy,format,notice,expected]{try{
    auto current=probe(expected.storageId);if(!(current==expected))throw std::runtime_error("STORAGE_FORMAT_IDENTITY_CHANGED");if(busy(current))throw std::runtime_error("STORAGE_FORMAT_BUSY");{std::lock_guard<std::mutex> lock(shared->mutex);shared->formatState="FORMATTING";}
    const auto result=format(current);if(result){char code[64];std::snprintf(code,sizeof(code),"STORAGE_FORMAT_FAILED_%08X",static_cast<unsigned>(result));throw std::runtime_error(code);}{{std::lock_guard<std::mutex> lock(shared->mutex);shared->formatState="COMPLETE";shared->progress=100;}}std::fprintf(stderr,"USB format complete: %s\n",expected.storageId.c_str());if(notice)notice("USB extended storage is ready.");
  }catch(const std::exception& error){
    const bool reconnect=std::string(error.what())=="STORAGE_FORMAT_FINISHED_RECONNECT_USB";
    {std::lock_guard<std::mutex> lock(shared->mutex);shared->formatState=reconnect?"RECONNECT_REQUIRED":"ERROR";shared->progress=reconnect?100:shared->progress;shared->error=reconnect?"":error.what();}
    std::fprintf(stderr,reconnect?"USB format complete; reconnect required: %s\n":"USB format failed: %s\n",reconnect?expected.storageId.c_str():error.what());
    if(notice)notice(reconnect?"USB formatting finished. Unplug and reconnect the drive once.":"USB extended storage formatting failed. Open PS5Library for details.");
  }}).detach();
  return Json::object({{"accepted",true},{"formatState","STARTING"}});
}

#ifdef PS5
static std::string mountedString(const char* value,size_t size){return std::string(value,strnlen(value,size));}
static bool managedUsbMounted(){struct statfs mounted{};if(statfs("/mnt/ext0",&mounted))return false;auto device=mountedString(mounted.f_mntfromname,sizeof(mounted.f_mntfromname)),type=mountedString(mounted.f_fstypename,sizeof(mounted.f_fstypename));return type=="ufs"&&device.size()>=6&&device.compare(device.size()-6,6,".crypt")==0;}
static uint32_t le32(const unsigned char* value){return static_cast<uint32_t>(value[0])|static_cast<uint32_t>(value[1])<<8|static_cast<uint32_t>(value[2])<<16|static_cast<uint32_t>(value[3])<<24;}
static uint64_t le64(const unsigned char* value){return static_cast<uint64_t>(le32(value))|static_cast<uint64_t>(le32(value+4))<<32;}
static void readExact(int fd,unsigned char* value,size_t size){size_t offset=0;while(offset<size){auto count=pread(fd,value+offset,size-offset,static_cast<off_t>(offset));if(count<0&&errno==EINTR)continue;if(count<=0)throw std::runtime_error("STORAGE_FORMAT_BOOT_UNREADABLE");offset+=static_cast<size_t>(count);}}
static std::string wholeDisk(const std::string& partition){
  constexpr const char* prefix="/dev/da";if(partition.rfind(prefix,0)!=0)throw std::runtime_error("STORAGE_FORMAT_DEVICE_INVALID");size_t at=std::strlen(prefix),start=at;if(at>=partition.size()||partition[at]=='0')throw std::runtime_error("STORAGE_FORMAT_DEVICE_INVALID");while(at<partition.size()&&partition[at]>='0'&&partition[at]<='9')at++;if(at==start||at>=partition.size()||partition[at++]!='p'||at>=partition.size()||partition[at]=='0')throw std::runtime_error("STORAGE_FORMAT_DEVICE_INVALID");while(at<partition.size()&&partition[at]>='0'&&partition[at]<='9')at++;if(at!=partition.size())throw std::runtime_error("STORAGE_FORMAT_DEVICE_INVALID");auto result=partition.substr(0,partition.find('p',start));if(result.size()>=0x40)throw std::runtime_error("STORAGE_FORMAT_DEVICE_INVALID");return result;
}
static UsbFormatIdentity probeUsb(const std::string& storageId){
  if(storageId.size()<=3||storageId.rfind("usb",0)!=0||!std::all_of(storageId.begin()+3,storageId.end(),[](char c){return c>='0'&&c<='9';}))throw std::runtime_error("STORAGE_FORMAT_INELIGIBLE");if(managedUsbMounted())throw std::runtime_error("STORAGE_FORMAT_MANAGED_USB_PRESENT");
  UsbFormatIdentity identity;identity.storageId=storageId;identity.mountPath="/mnt/"+storageId;struct statfs mounted{};struct stat root{},partition{},disk{};if(lstat(identity.mountPath.c_str(),&root)||!S_ISDIR(root.st_mode)||statfs(identity.mountPath.c_str(),&mounted))throw std::runtime_error("STORAGE_FORMAT_INELIGIBLE");identity.device=mountedString(mounted.f_mntfromname,sizeof(mounted.f_mntfromname));identity.filesystem=mountedString(mounted.f_fstypename,sizeof(mounted.f_fstypename));if(identity.filesystem!="exfatfs"||mountedString(mounted.f_mntonname,sizeof(mounted.f_mntonname))!=identity.mountPath)throw std::runtime_error("STORAGE_FORMAT_INELIGIBLE");identity.wholeDevice=wholeDisk(identity.device);if(identity.wholeDevice=="/dev/da0"||identity.wholeDevice.size()>=0x40||lstat(identity.device.c_str(),&partition)||lstat(identity.wholeDevice.c_str(),&disk)||!S_ISCHR(partition.st_mode)||!S_ISCHR(disk.st_mode))throw std::runtime_error("STORAGE_FORMAT_DEVICE_INVALID");
  int fd=open(identity.device.c_str(),O_RDONLY|O_NOFOLLOW);if(fd<0)throw std::runtime_error("STORAGE_FORMAT_BOOT_UNREADABLE");struct File {int fd;~File(){close(fd);}} file{fd};struct stat opened{};if(fstat(fd,&opened)||opened.st_dev!=partition.st_dev||opened.st_rdev!=partition.st_rdev)throw std::runtime_error("STORAGE_FORMAT_DEVICE_CHANGED");std::vector<unsigned char> boot(512);readExact(fd,boot.data(),boot.size());if(std::memcmp(boot.data()+3,"EXFAT   ",8)||boot[510]!=0x55||boot[511]!=0xaa||boot[108]<9||boot[108]>12||boot[109]>25-boot[108]||(boot[110]!=1&&boot[110]!=2))throw std::runtime_error("STORAGE_FORMAT_NOT_EXFAT");const auto sectorSize=size_t(1)<<boot[108];boot.resize(sectorSize*12);readExact(fd,boot.data(),boot.size());uint32_t checksum=0;for(size_t i=0;i<sectorSize*11;i++)if(i!=106&&i!=107&&i!=112)checksum=((checksum<<31)|(checksum>>1))+boot[i];for(size_t i=sectorSize*11;i<sectorSize*12;i+=4)if(le32(boot.data()+i)!=checksum)throw std::runtime_error("STORAGE_FORMAT_BOOT_INVALID");
  identity.mountDev=static_cast<uint64_t>(root.st_dev);identity.mountRdev=static_cast<uint64_t>(root.st_rdev);identity.deviceDev=static_cast<uint64_t>(partition.st_dev);identity.deviceRdev=static_cast<uint64_t>(partition.st_rdev);identity.wholeDev=static_cast<uint64_t>(disk.st_dev);identity.wholeRdev=static_cast<uint64_t>(disk.st_rdev);if(mounted.f_blocks<=0||mounted.f_bsize<=0||static_cast<uint64_t>(mounted.f_blocks)>UINT64_MAX/static_cast<uint64_t>(mounted.f_bsize))throw std::runtime_error("STORAGE_FORMAT_CAPACITY_INVALID");identity.totalBytes=static_cast<uint64_t>(mounted.f_blocks)*static_cast<uint64_t>(mounted.f_bsize);identity.partitionOffset=le64(boot.data()+64);identity.volumeLength=le64(boot.data()+72);identity.volumeSerial=le32(boot.data()+100);identity.sectorShift=boot[108];identity.bootChecksum=checksum;if(!identity.totalBytes||!identity.volumeLength)throw std::runtime_error("STORAGE_FORMAT_CAPACITY_INVALID");return identity;
}
static bool pathMentioned(const fs::path& file,const std::string& mount){try{auto status=fs::symlink_status(file);if(!fs::exists(status))return false;if(fs::is_symlink(status)||!fs::is_regular_file(status)||fs::file_size(file)>65536)return true;std::ifstream input(file);std::string line;while(std::getline(input,line)){auto at=line.find(mount);if(at!=std::string::npos&&(at==0||line[at-1]=='\t'||line[at-1]==' ')&&(at+mount.size()==line.size()||line[at+mount.size()]=='/'||line[at+mount.size()]=='\t'||line[at+mount.size()]==' '))return true;}}catch(...){return true;}return false;}
static bool usbBusy(const UsbFormatIdentity& identity){try{auto staging=fs::path(identity.mountPath)/".ps5library/staging";if(fs::exists(staging)){if(fs::is_symlink(staging)||!fs::is_directory(staging))return true;std::error_code error;if(fs::directory_iterator(staging,fs::directory_options::skip_permission_denied,error)!=fs::directory_iterator()||error)return true;}}catch(...){return true;}return pathMentioned("/data/shadowmount/manual.status",identity.mountPath);}
struct UsbMountApi {
  using Init=int(*)(void*);using Request=int(*)(const char*);
  void* module=nullptr;Request requestUnmount=nullptr;int initialized=-1;
  UsbMountApi(){for(const auto* path:{"/system/common/lib/libSceUsbStorage.sprx","libSceUsbStorage.sprx"})if((module=dlopen(path,RTLD_NOW|RTLD_LOCAL)))break;if(!module)return;auto init=reinterpret_cast<Init>(dlsym(module,"sceUsbStorageInit"));requestUnmount=reinterpret_cast<Request>(dlsym(module,"_ZN23sceAutoMounterIpcClient14requestUnmountEPKc"));if(init&&requestUnmount)initialized=init(nullptr);}
  explicit operator bool() const{return module&&requestUnmount&&initialized==0;}
};
static UsbMountApi& usbMountApi(){static UsbMountApi api;return api;}
static void unmountUsb(const UsbFormatIdentity& identity){
  auto& api=usbMountApi();if(!api)throw std::runtime_error("STORAGE_FORMAT_UNMOUNT_UNAVAILABLE");int result=0;for(int i=0;i<20;i++){result=api.requestUnmount(identity.device.c_str());if(!result)break;if(result!=EBUSY&&static_cast<uint32_t>(result)!=0x80020010u)break;std::this_thread::sleep_for(std::chrono::milliseconds(250));}if(result){char error[64];std::snprintf(error,sizeof(error),"STORAGE_FORMAT_UNMOUNT_FAILED_%08X",static_cast<unsigned>(result));throw std::runtime_error(error);}
  for(int i=0;i<50;i++){struct statfs mounted{};if(statfs(identity.mountPath.c_str(),&mounted)||mountedString(mounted.f_mntonname,sizeof(mounted.f_mntonname))!=identity.mountPath)break;std::this_thread::sleep_for(std::chrono::milliseconds(100));}
  struct stat partition{},disk{};if(lstat(identity.device.c_str(),&partition)||lstat(identity.wholeDevice.c_str(),&disk)||static_cast<uint64_t>(partition.st_dev)!=identity.deviceDev||static_cast<uint64_t>(partition.st_rdev)!=identity.deviceRdev||static_cast<uint64_t>(disk.st_dev)!=identity.wholeDev||static_cast<uint64_t>(disk.st_rdev)!=identity.wholeRdev)throw std::runtime_error("STORAGE_FORMAT_DEVICE_CHANGED");
  struct statfs mounted{};if(!statfs(identity.mountPath.c_str(),&mounted)&&mountedString(mounted.f_mntonname,sizeof(mounted.f_mntonname))==identity.mountPath)throw std::runtime_error("STORAGE_FORMAT_UNMOUNT_TIMEOUT");
}
static int formatUsb(const UsbFormatIdentity& identity){unmountUsb(identity);const auto result=sceShellCoreUtilFormatExternalHdd(identity.wholeDevice.c_str());if(result)return result;for(int i=0;i<600&&!managedUsbMounted();i++)std::this_thread::sleep_for(std::chrono::milliseconds(100));if(!managedUsbMounted())throw std::runtime_error("STORAGE_FORMAT_FINISHED_RECONNECT_USB");return 0;}
#else
static UsbFormatIdentity probeUsb(const std::string&){throw std::runtime_error("STORAGE_FORMAT_UNAVAILABLE");}
static bool usbBusy(const UsbFormatIdentity&){return true;}
static int formatUsb(const UsbFormatIdentity&){throw std::runtime_error("STORAGE_FORMAT_UNAVAILABLE");}
#endif

StorageFormatCoordinator& storageFormatCoordinator(){static StorageFormatCoordinator coordinator(probeUsb,usbBusy,formatUsb,[]{
#ifdef PS5
  return sceShellCoreUtilGetProgressOfFormatExternalHdd();
#else
  return 0.f;
#endif
},[](const std::string& message){notify(message);});return coordinator;}
}
