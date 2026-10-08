#pragma once
#include "../common/json.hpp"
#include <cstdint>
#include <functional>
#include <memory>
#include <string>

namespace ps5library {
struct UsbFormatIdentity {
  std::string storageId,mountPath,device,wholeDevice,filesystem;
  uint64_t mountDev=0,mountRdev=0,deviceDev=0,deviceRdev=0,wholeDev=0,wholeRdev=0,totalBytes=0,partitionOffset=0,volumeLength=0,bootChecksum=0;
  uint32_t volumeSerial=0;uint8_t sectorShift=0;
  bool operator==(const UsbFormatIdentity& other) const;
};
class StorageFormatCoordinator {
public:
  using Probe=std::function<UsbFormatIdentity(const std::string&)>;
  using Busy=std::function<bool(const UsbFormatIdentity&)>;
  using Format=std::function<int(const UsbFormatIdentity&)>;
  using Progress=std::function<float()>;
  using Notice=std::function<void(const std::string&)>;
  StorageFormatCoordinator(Probe probe,Busy busy,Format format,Progress progress,Notice notice={});
  Json describe(const std::string& storageId) const;
  Json prepare(const std::string& storageId);
  Json confirm(const std::string& storageId,const std::string& challenge);
  Json state() const;
  bool active() const;
private:
  struct Shared;std::shared_ptr<Shared> shared_;Probe probe_;Busy busy_;Format format_;Progress progress_;Notice notice_;
};
StorageFormatCoordinator& storageFormatCoordinator();
std::string applyUsbHighSpeedStoragePatch();
std::string applyExternalFpkgStoragePatch();
}
