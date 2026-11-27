#include "lifecycle.hpp"

#include <array>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <climits>
#include <cstdio>
#include <fcntl.h>
#include <fstream>
#include <iterator>
#include <string_view>
#include <system_error>
#include <utility>
#include <unistd.h>

namespace ps5library::shell_indicator {
namespace {

constexpr std::string_view header = "PS5LIBRARY-INDICATOR/1\n";

bool decimal(std::string_view value, std::uint64_t& result) {
  if (value.empty()) return false;
  const auto parsed = std::from_chars(value.data(), value.data() + value.size(),
                                      result);
  return parsed.ec == std::errc{} && parsed.ptr == value.data() + value.size();
}

bool validSession(std::string_view value) {
  if (value.empty() || value.size() > 64) return false;
  for (const auto character : value)
    if (!((character >= '0' && character <= '9') ||
          (character >= 'a' && character <= 'f') || character == '-'))
      return false;
  return true;
}

bool consume(std::string_view& input, std::string_view key,
             std::string_view& value) {
  if (input.substr(0, key.size()) != key) return false;
  const auto end = input.find('\n', key.size());
  if (end == std::string_view::npos) return false;
  value = input.substr(key.size(), end - key.size());
  input.remove_prefix(end + 1);
  return true;
}

bool atomicWrite(const std::filesystem::path& path, const std::string& value,
                 const std::string& session, std::string& error) {
  std::error_code code;
  std::filesystem::create_directories(path.parent_path(), code);
  if (code || std::filesystem::is_symlink(path.parent_path(), code)) {
    error = "indicator directory unavailable";
    return false;
  }
  const auto temporary = path.string() + "." + session + ".tmp";
  const int descriptor =
      ::open(temporary.c_str(), O_WRONLY | O_CREAT | O_TRUNC | O_NOFOLLOW, 0644);
  if (descriptor < 0) {
    error = "indicator state open failed";
    return false;
  }
  std::size_t offset = 0;
  while (offset < value.size()) {
    const auto written =
        ::write(descriptor, value.data() + offset, value.size() - offset);
    if (written <= 0) {
      error = "indicator state write failed";
      ::close(descriptor);
      ::unlink(temporary.c_str());
      return false;
    }
    offset += static_cast<std::size_t>(written);
  }
  const bool synced = ::fsync(descriptor) == 0;
  const bool closed = ::close(descriptor) == 0;
  if (!synced || !closed || ::rename(temporary.c_str(), path.c_str()) != 0) {
    error = "indicator state publish failed";
    ::unlink(temporary.c_str());
    return false;
  }
  return true;
}

bool nameMatches(std::string_view observed, std::string_view expected) {
  const auto strip = [](std::string_view value) {
    return value.size() > 4 && value.substr(value.size() - 4) == ".elf"
               ? value.substr(0, value.size() - 4)
               : value;
  };
  observed = strip(observed);
  expected = strip(expected);
  if (observed == expected) return true;
  // FreeBSD exposes process and thread names through 19- and 16-byte fields.
  return (expected.size() > 19 && observed == expected.substr(0, 19)) ||
         (expected.size() > 16 && observed == expected.substr(0, 16));
}

}  // namespace

std::string encodeState(const State& state) {
  return std::string(header) + "pid=" + std::to_string(state.pid) +
         "\nsession=" + state.session +
         "\nlocal_ms=" + std::to_string(state.localHeartbeatMs) +
         "\nserver_ms=" + std::to_string(state.serverHeartbeatMs) +
         "\nserver_authenticated=" +
         (state.serverAuthenticated ? "1\n" : "0\n");
}

bool decodeState(const std::string& encoded, State& state) noexcept {
  try {
    std::string_view input(encoded);
    if (input.substr(0, header.size()) != header) return false;
    input.remove_prefix(header.size());
    std::string_view pid, session, local, server, authenticated;
    if (!consume(input, "pid=", pid) ||
        !consume(input, "session=", session) ||
        !consume(input, "local_ms=", local) ||
        !consume(input, "server_ms=", server) ||
        !consume(input, "server_authenticated=", authenticated) ||
        !input.empty() || !validSession(session) ||
        (authenticated != "0" && authenticated != "1"))
      return false;
    std::uint64_t parsedPid = 0, parsedLocal = 0, parsedServer = 0;
    if (!decimal(pid, parsedPid) || parsedPid == 0 || parsedPid > INT_MAX ||
        !decimal(local, parsedLocal) || !parsedLocal ||
        !decimal(server, parsedServer) || parsedServer > parsedLocal)
      return false;
    state = {static_cast<int>(parsedPid), std::string(session), parsedLocal,
             parsedServer, authenticated == "1"};
    return true;
  } catch (...) {
    return false;
  }
}

DisplayMode displayMode(const State& state, std::uint64_t nowMs,
                        bool pidIsAlive) noexcept {
  if (!pidIsAlive || !state.localHeartbeatMs ||
      nowMs < state.localHeartbeatMs ||
      nowMs - state.localHeartbeatMs > localHeartbeatMaxAgeMs)
    return DisplayMode::Hidden;
  if (state.serverAuthenticated && state.serverHeartbeatMs &&
      nowMs >= state.serverHeartbeatMs &&
      nowMs - state.serverHeartbeatMs <= serverHeartbeatMaxAgeMs)
    return DisplayMode::Pulse;
  return DisplayMode::Steady;
}

float indicatorOpacity(DisplayMode mode, std::uint64_t nowMs) noexcept {
  if (mode == DisplayMode::Hidden) return 0.0f;
  if (mode == DisplayMode::Steady) return 1.0f;
  const auto half = pulsePeriodMs / 2;
  float phase = static_cast<float>(nowMs % pulsePeriodMs) /
                static_cast<float>(half);
  if (phase > 1.0f) phase = 2.0f - phase;
  const float eased = phase * phase * (3.0f - 2.0f * phase);
  return pulseMinimumOpacity + (1.0f - pulseMinimumOpacity) * eased;
}

bool startupAllowed(std::uint32_t firmware, bool killSwitchPresent,
                    bool conflictingInjectorPresent) noexcept {
  return supportedFirmware(firmware) && !killSwitchPresent &&
         !conflictingInjectorPresent;
}

const char* conflictingInjector(const std::string& processName) noexcept {
  struct Entry {
    const char* family;
    const char* name;
  };
  // etaHEN/Yoncore/kylin/wmdw/CheatRunner names are pinned from OnionHEN's
  // libonion_conflict at b23ffe674b2de9f62fe634944c9230ff149d593a.
  constexpr Entry entries[] = {
      {"OnionHEN", "onion_daemon.elf"},
      {"OnionHEN", "onion_elfldr.elf"},
      {"etaHEN", "etaHEN Utility Daemon"},
      {"etaHEN", "etaHEN Critical services"},
      {"Yoncore", "Yoncore.elf"},
      {"kylin-core", "kylin-core.elf"},
      {"wmdw-jwm", "wmdw-jwm.elf"},
      {"CheatRunner", "CheatRunner.elf"},
  };
  for (const auto& entry : entries)
    if (nameMatches(processName, entry.name)) return entry.family;
  return nullptr;
}

std::uint64_t monotonicMilliseconds() noexcept {
  return static_cast<std::uint64_t>(
      std::chrono::duration_cast<std::chrono::milliseconds>(
          std::chrono::steady_clock::now().time_since_epoch())
          .count());
}

bool OptionsDoublePress::sample(bool pressed, std::uint64_t nowMs) noexcept {
  const bool rising = pressed && !previousPressed_;
  previousPressed_ = pressed;
  if (!rising) return false;

  if (waitingForSecond_ && nowMs >= firstPressMs_ &&
      nowMs - firstPressMs_ <= optionsDoublePressWindowMs) {
    waitingForSecond_ = false;
    return true;
  }

  waitingForSecond_ = true;
  firstPressMs_ = nowMs;
  return false;
}

void OptionsDoublePress::reset(bool pressed) noexcept {
  previousPressed_ = pressed;
  waitingForSecond_ = false;
  firstPressMs_ = 0;
}

OptionsObservation observeOptions(OptionsDoublePress& shortcut,
                                  const OptionsSample& sample,
                                  std::uint64_t nowMs) noexcept {
  return {
      (sample.buttonsDown & optionsStartButtonMask) != 0,
      (sample.buttonsUp & optionsStartButtonMask) != 0,
      shortcut.sample((sample.buttons & optionsStartButtonMask) != 0, nowMs),
  };
}

HeartbeatFile::HeartbeatFile(std::filesystem::path statePath,
                             std::filesystem::path killSwitchPath, int pid,
                             std::string session)
    : statePath_(std::move(statePath)),
      killSwitchPath_(std::move(killSwitchPath)) {
  state_.pid = pid;
  state_.session = std::move(session);
  if (pid <= 0 || !validSession(state_.session)) {
    active_ = false;
    error_ = "invalid indicator session";
  }
}

HeartbeatFile::~HeartbeatFile() { stop(); }

bool HeartbeatFile::beat(bool serverAuthenticated,
                         std::uint64_t nowMs,
                         std::uint64_t serverHeartbeatMs) noexcept {
  try {
    if (!active_) return false;
    if (std::filesystem::exists(killSwitchPath_)) {
      error_ = "disabled by kill switch";
      stop();
      return false;
    }
    state_.localHeartbeatMs = nowMs;
    state_.serverAuthenticated = serverAuthenticated;
    if (serverAuthenticated)
      state_.serverHeartbeatMs = serverHeartbeatMs ? serverHeartbeatMs : nowMs;
    if (state_.serverHeartbeatMs > nowMs) {
      error_ = "invalid server heartbeat";
      stop();
      return false;
    }
    if (!atomicWrite(statePath_, encodeState(state_), state_.session, error_)) {
      stop();
      return false;
    }
    return true;
  } catch (const std::exception& exception) {
    error_ = exception.what();
    stop();
    return false;
  } catch (...) {
    error_ = "indicator heartbeat failed";
    stop();
    return false;
  }
}

void HeartbeatFile::stop() noexcept {
  if (!active_) return;
  active_ = false;
  try {
    std::ifstream input(statePath_);
    const std::string encoded((std::istreambuf_iterator<char>(input)), {});
    State observed;
    if (decodeState(encoded, observed) && observed.pid == state_.pid &&
        observed.session == state_.session)
      std::filesystem::remove(statePath_);
  } catch (...) {
  }
}

}  // namespace ps5library::shell_indicator
