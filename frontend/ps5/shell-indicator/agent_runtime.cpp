#include "agent_runtime.hpp"
#include "injector.hpp"

#include <chrono>
#include <climits>
#include <cstddef>
#include <cstdlib>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <iomanip>
#include <ps5/kernel.h>
#include <sstream>
#include <sys/sysctl.h>
#include <sys/user.h>
#include <unistd.h>
#include <vector>

extern "C" {
extern unsigned char ps5library_shell_helper_elf[];
extern const std::uint64_t ps5library_shell_helper_elf_size;
}

namespace ps5library::shell_indicator {
namespace {

struct SystemSoftwareVersion {
  std::uint64_t size;
  char text[28];
  std::uint32_t version;
  std::uint64_t reserved;
};
extern "C" int sceKernelGetProsperoSystemSwVersion(SystemSoftwareVersion*);

struct Process {
  pid_t pid;
  std::string command;
  std::string thread;
};

bool processes(std::vector<Process>& result) {
  int mib[4] = {CTL_KERN, KERN_PROC, KERN_PROC_PROC, 0};
  std::size_t size = 0;
  if (::sysctl(mib, 4, nullptr, &size, nullptr, 0) || !size ||
      size > 4 * 1024 * 1024)
    return false;
  std::vector<unsigned char> data(size);
  if (::sysctl(mib, 4, data.data(), &size, nullptr, 0)) return false;
  for (std::size_t offset = 0; offset < size;) {
    if (size - offset < sizeof(int)) return false;
    int length = 0;
    std::memcpy(&length, data.data() + offset, sizeof(length));
    constexpr auto required = offsetof(kinfo_proc, ki_tdname) +
                              sizeof(kinfo_proc::ki_tdname);
    if (length < static_cast<int>(required) ||
        static_cast<std::size_t>(length) > size - offset)
      return false;
    const auto* process =
        reinterpret_cast<const kinfo_proc*>(data.data() + offset);
    result.push_back(
        {process->ki_pid,
         std::string(process->ki_comm,
                     strnlen(process->ki_comm, sizeof(process->ki_comm))),
         std::string(process->ki_tdname,
                     strnlen(process->ki_tdname, sizeof(process->ki_tdname)))});
    offset += static_cast<std::size_t>(length);
  }
  return true;
}

const char* conflict(const std::vector<Process>& processes) {
  for (const auto& process : processes) {
    if (const auto* found = conflictingInjector(process.command)) return found;
    if (const auto* found = conflictingInjector(process.thread)) return found;
  }
  return nullptr;
}

pid_t shellUiPid(const std::vector<Process>& processes) {
  for (const auto& process : processes)
    if (process.command == "SceShellUI" || process.thread == "SceShellUI")
      return process.pid;
  return -1;
}

pid_t readyPid() {
  const int descriptor = ::open("/system_tmp/ps5library/shell-helper.pid",
                                O_RDONLY | O_NOFOLLOW);
  if (descriptor < 0) return -1;
  char buffer[32]{};
  const auto length = ::read(descriptor, buffer, sizeof(buffer) - 1);
  ::close(descriptor);
  if (length <= 1 || buffer[length - 1] != '\n') return -1;
  buffer[length - 1] = '\0';
  char* end = nullptr;
  const long value = std::strtol(buffer, &end, 10);
  return end && *end == '\0' && value > 1 && value <= INT_MAX
             ? static_cast<pid_t>(value)
             : -1;
}

std::string helperStatus() {
  const int descriptor = ::open(
      "/system_tmp/ps5library/shell-helper.status", O_RDONLY | O_NOFOLLOW);
  if (descriptor < 0) return {};
  char buffer[96]{};
  const auto length = ::read(descriptor, buffer, sizeof(buffer) - 1);
  ::close(descriptor);
  if (length <= 1 || buffer[length - 1] != '\n') return {};
  buffer[length - 1] = '\0';
  for (const char* value = buffer; *value; ++value)
    if (!((*value >= 'A' && *value <= 'Z') ||
          (*value >= '0' && *value <= '9') || *value == '_'))
      return {};
  return buffer;
}

bool shellUiReady(pid_t pid) {
  std::uint32_t trophy = 0, trophy2 = 0;
  return pid > 1 &&
         kernel_dynlib_handle(pid, "libSceNpTrophy.sprx", &trophy) == 0 &&
         kernel_dynlib_handle(pid, "libSceNpTrophy2.sprx", &trophy2) == 0 &&
         trophy != static_cast<std::uint32_t>(-1) &&
         trophy2 != static_cast<std::uint32_t>(-1);
}

std::string sessionId() {
  std::ostringstream value;
  value << std::hex << std::setfill('0') << std::setw(8) << ::getpid() << '-'
        << std::setw(16) << monotonicMilliseconds();
  return value.str();
}

}  // namespace

AgentRuntime::AgentRuntime(const std::filesystem::path& configRoot) {
  const auto killSwitch = configRoot / "disable-shell-indicator";
  SystemSoftwareVersion system{};
  system.size = sizeof(system);
  if (sceKernelGetProsperoSystemSwVersion(&system) != 0) {
    status_ = "FIRMWARE_QUERY_FAILED";
    return;
  }
  const bool onionMarker =
      std::filesystem::exists("/system_tmp/onionhen/ready/toolbox");
  std::vector<Process> snapshot;
  if (!processes(snapshot)) {
    status_ = "PROCESS_SCAN_FAILED";
    return;
  }
  const char* conflictName = onionMarker ? "OnionHEN" : conflict(snapshot);
  if (!startupAllowed(system.version, std::filesystem::exists(killSwitch),
                      conflictName != nullptr)) {
    if (!supportedFirmware(system.version))
      status_ = "UNSUPPORTED_FIRMWARE";
    else if (std::filesystem::exists(killSwitch))
      status_ = "DISABLED";
    else
      status_ = std::string("CONFLICT_") + conflictName;
    return;
  }

  heartbeat_ = std::make_unique<HeartbeatFile>(
      "/system_tmp/ps5library/agent-indicator.state", killSwitch, ::getpid(),
      sessionId());
  running_.store(true, std::memory_order_release);
  thread_ = std::thread([this] {
    pid_t failedPid = -1;
    pid_t observedShellUi = -1;
    std::string loggedHelperStatus;
    while (running_.load(std::memory_order_acquire)) {
      const auto now = monotonicMilliseconds();
      const auto last =
          lastServerHeartbeatMs_.load(std::memory_order_acquire);
      const bool healthy =
          serverAuthenticated_.load(std::memory_order_acquire) && last &&
          now >= last && now - last <= serverHeartbeatMaxAgeMs;
      if (!heartbeat_->beat(healthy, now, last)) {
        std::fprintf(stderr, "Shell indicator heartbeat stopped: %s\n",
                     heartbeat_->error().c_str());
        running_.store(false, std::memory_order_release);
        break;
      }
      std::vector<Process> snapshot;
      if (!processes(snapshot)) {
        std::fprintf(stderr,
                     "Shell indicator stopped: process scan became unavailable\n");
        heartbeat_->stop();
        running_.store(false, std::memory_order_release);
        break;
      }
      const bool onionMarker =
          std::filesystem::exists("/system_tmp/onionhen/ready/toolbox");
      const char* conflictName = onionMarker ? "OnionHEN" : conflict(snapshot);
      if (conflictName) {
        std::fprintf(stderr,
                     "Shell indicator stopped: conflicting injector %s appeared\n",
                     conflictName);
        heartbeat_->stop();
        running_.store(false, std::memory_order_release);
        break;
      }
      {
        const auto shellUi = shellUiPid(snapshot);
        if (shellUi != observedShellUi) {
          observedShellUi = shellUi;
          loggedHelperStatus.clear();
        }
        if (shellUi > 1 && readyPid() != shellUi && failedPid != shellUi &&
            shellUiReady(shellUi)) {
          ::unlink("/system_tmp/ps5library/shell-helper.pid");
          ::unlink("/system_tmp/ps5library/shell-helper.status");
          const auto elfSize =
              static_cast<std::size_t>(ps5library_shell_helper_elf_size);
          const bool saneSize = elfSize >= 64 && elfSize <= 4 * 1024 * 1024;
          if (!saneSize ||
              !injectHelper(shellUi, ps5library_shell_helper_elf, elfSize)) {
            std::fprintf(stderr,
                         "Shell indicator helper injection failed for pid %d\n",
                         shellUi);
            failedPid = shellUi;
          } else {
            bool ready = false;
            for (int poll = 0; poll < 40 &&
                               running_.load(std::memory_order_acquire);
                 ++poll) {
              if (readyPid() == shellUi) {
                ready = true;
                std::fprintf(stderr,
                             "Shell indicator helper active for pid %d\n",
                             shellUi);
                break;
              }
              const auto pollNow = monotonicMilliseconds();
              const bool pollHealthy =
                  serverAuthenticated_.load(std::memory_order_acquire) && last &&
                  pollNow >= last &&
                  pollNow - last <= serverHeartbeatMaxAgeMs;
              if (!heartbeat_->beat(pollHealthy, pollNow, last)) break;
              std::this_thread::sleep_for(std::chrono::milliseconds(250));
            }
            if (!ready) {
              const auto detail = helperStatus();
              std::fprintf(stderr,
                           "Shell indicator helper readiness timed out for pid "
                           "%d%s%s\n",
                           shellUi, detail.empty() ? "" : ": ",
                           detail.c_str());
              failedPid = shellUi;
            }
          }
        }
        const auto detail =
            shellUi > 1 && readyPid() == shellUi ? helperStatus()
                                                : std::string{};
        if (!detail.empty() && detail != loggedHelperStatus) {
          loggedHelperStatus = detail;
          std::fprintf(stderr, "Shell indicator helper status for pid %d: %s\n",
                       shellUi, detail.c_str());
        }
      }
      for (int step = 0;
           step < 20 && running_.load(std::memory_order_acquire); ++step)
        std::this_thread::sleep_for(std::chrono::milliseconds(100));
    }
  });
  status_ = "HEARTBEAT_ACTIVE_HELPER_PENDING";
}

AgentRuntime::~AgentRuntime() {
  running_.store(false, std::memory_order_release);
  if (thread_.joinable()) thread_.join();
  heartbeat_.reset();
}

void AgentRuntime::serverHeartbeat(bool authenticated) noexcept {
  serverAuthenticated_.store(authenticated, std::memory_order_release);
  lastServerHeartbeatMs_.store(authenticated ? monotonicMilliseconds() : 0,
                               std::memory_order_release);
}

}  // namespace ps5library::shell_indicator
