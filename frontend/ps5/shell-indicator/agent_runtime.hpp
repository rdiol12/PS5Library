#pragma once

#include "lifecycle.hpp"

#include <atomic>
#include <filesystem>
#include <memory>
#include <string>
#include <thread>

namespace ps5library::shell_indicator {

class AgentRuntime final {
 public:
  explicit AgentRuntime(const std::filesystem::path& configRoot);
  ~AgentRuntime();
  AgentRuntime(const AgentRuntime&) = delete;
  AgentRuntime& operator=(const AgentRuntime&) = delete;

  void serverHeartbeat(bool authenticated) noexcept;
  bool active() const noexcept { return heartbeat_ != nullptr; }
  const std::string& status() const noexcept { return status_; }

 private:
  std::unique_ptr<HeartbeatFile> heartbeat_;
  std::atomic<bool> running_{false};
  std::atomic<bool> serverAuthenticated_{false};
  std::atomic<std::uint64_t> lastServerHeartbeatMs_{0};
  std::thread thread_;
  std::string status_;
};

}  // namespace ps5library::shell_indicator
