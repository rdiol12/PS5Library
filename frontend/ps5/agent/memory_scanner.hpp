#pragma once
#include "cheats.hpp"
#include <memory>
#include <string>

namespace ps5library {

inline constexpr std::size_t maxMemoryScanBytes=32*1024*1024;
inline constexpr std::size_t maxMemoryScanResults=64*1024;
inline constexpr std::size_t maxMemoryWatchResults=256;
inline constexpr std::size_t maxMemoryModifiedResults=16;

class MemoryScanner {
public:
  struct Session;
private:
  CheatRuntime& runtime_;
  bool writeEnabled_;
  std::unique_ptr<Session> session_;
public:
  explicit MemoryScanner(CheatRuntime& runtime,bool writeEnabled=false);
  ~MemoryScanner();
  Json target();
  Json start(const std::string& titleId,const std::string& version,const std::string& type,const std::string& mode,const std::string& value={});
  Json refine(const std::string& scanId,const std::string& mode,const std::string& value={});
  Json watch(const std::string& scanId);
  Json write(const std::string& scanId,const std::string& resultId,const std::string& value,bool freeze=false);
  Json restore(const std::string& scanId,const std::string& resultId);
  std::size_t restoreAll();
  void reconcile() noexcept;
  void clear();
};

}
