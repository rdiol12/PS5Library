#pragma once
#include "../common/json.hpp"
#include <cstdint>
#include <filesystem>
#include <memory>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace ps5library {
namespace fs = std::filesystem;

inline constexpr std::uintmax_t maxCheatProfileBytes=1024*1024;
inline constexpr std::size_t maxCheatPatchedBytes=64*1024;
inline constexpr bool memoryRuntimeSupported(std::uint32_t firmware){return firmware==0x4500000||firmware==0x4510000;}
inline constexpr bool memoryDiscoverySupported(std::uint32_t firmware){return memoryRuntimeSupported(firmware);}
inline constexpr bool titleMainExecutable(std::string_view name){return name=="eboot"||name=="eboot.bin";}
inline constexpr bool titleProcessAlive(unsigned char state){return state!=5;} // FreeBSD SZOMB.

struct CheatPatch {
  std::uint64_t offset=0;
  std::vector<unsigned char> enabled,expected;
};
struct CheatEntry {
  std::string id,name,description;
  std::vector<CheatPatch> patches;
};
struct CheatProfile {
  std::string id,fileName,titleId,version,process,contentId,targetExecutableSha256,format="JSON",validation="VALID";
  bool serverApproved=false,localApproved=false;
  std::vector<CheatEntry> entries;
};
struct CheatMemoryRange {
  std::uint64_t offset=0,size=0;
  bool readable=false,writable=false;
};
struct CheatTarget {
  std::uint64_t token=0;
  std::int32_t pid=-1;
  std::int64_t startedSeconds=0,startedMicroseconds=0;
  std::uint64_t moduleBase=0,moduleSize=0;
  std::string titleId,version,process,contentId,executableSha256;
  std::vector<CheatMemoryRange> ranges;
};

#ifdef PS5
struct Ps5MdbgFlags {int callResult=0;std::int64_t status=0;std::uint64_t flags=0;};
std::optional<CheatTarget> probePs5CheatTarget(std::string_view process={});
int ps5TitleProcessId(int appId,std::string_view titleId);
std::optional<Ps5MdbgFlags> pollPs5MdbgFlags(int pid) noexcept;
Json capturePs5ExceptionSnapshot(int pid,std::uint64_t stackPointer) noexcept;
#endif

class CheatRuntime {
public:
  virtual ~CheatRuntime()=default;
  virtual std::optional<CheatTarget> running(std::string_view process={})=0;
  virtual bool canRead()const{return false;}
  virtual bool canWrite()const{return false;}
  virtual bool canPatch()const{return canRead()&&canWrite();}
  virtual std::vector<unsigned char> read(const CheatTarget& target,std::uint64_t moduleOffset,std::size_t size)=0;
  virtual std::vector<unsigned char> scanRead(const CheatTarget& target,std::uint64_t moduleOffset,std::size_t size){return read(target,moduleOffset,size);}
  virtual void write(const CheatTarget& target,std::uint64_t moduleOffset,const std::vector<unsigned char>& bytes)=0;
};

CheatProfile parseCheatProfile(const fs::path& file,const Json& receipt=Json());
std::string cheatEntryId(const std::string& profileId,const std::string& name);

class CheatEngine {
  struct Active;
  CheatRuntime& runtime_;
  fs::path journalRoot_;
  std::vector<std::unique_ptr<Active>> active_;
  void journal(const Active& active,const std::string& state,const std::string& error={}) const;
public:
  CheatEngine(CheatRuntime& runtime,fs::path journalRoot);
  ~CheatEngine();
  Json enable(const CheatProfile& profile,const std::string& entryId);
  Json disable(const std::string& profileId,const std::string& entryId);
  void disableProfile(const std::string& profileId);
  void reconcile();
  void stop() noexcept;
  bool enabled(const std::string& profileId,const std::string& entryId) const;
};

class Client;
class MemoryScanner;
class CheatService {
  class UnavailableRuntime;
  fs::path root_;
  std::unique_ptr<CheatRuntime> runtime_;
  std::unique_ptr<CheatEngine> engine_;
  std::unique_ptr<MemoryScanner> scanner_;
  std::vector<CheatProfile> scan() const;
public:
  explicit CheatService(fs::path root);
  ~CheatService();
  Json list(const Json& inventory,const Json& volumes) const;
  Json enable(const std::string& profileId,const std::string& entryId,const Json& inventory,const Json& volumes,bool explicitApproval=false);
  Json disable(const std::string& profileId,const std::string& entryId);
  Json memoryScanTarget();
  Json memoryScanStart(const std::string& titleId,const std::string& version,const std::string& type,const std::string& mode,const std::string& value={});
  Json memoryScanRefine(const std::string& scanId,const std::string& mode,const std::string& value={});
  Json memoryScanWatch(const std::string& scanId);
  Json memoryScanWrite(const std::string& scanId,const std::string& resultId,const std::string& value,bool freeze=false);
  Json memoryScanRestore(const std::string& scanId,const std::string& resultId);
  std::size_t memoryScanRestoreAll();
  void memoryScanClear();
  std::string stage(const Json& delivery);
  void remove(const Json& delivery);
  void reconcile();
  void stop() noexcept;
};
}
