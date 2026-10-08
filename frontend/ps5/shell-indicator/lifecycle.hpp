#pragma once

#include <cstdint>
#include <filesystem>
#include <string>

namespace ps5library::shell_indicator {

inline constexpr std::uint32_t firmware450 = 0x04500000;
inline constexpr std::uint32_t firmware451 = 0x04510000;
inline constexpr bool supportedFirmware(std::uint32_t firmware) noexcept {
  return firmware == firmware450 || firmware == firmware451;
}
inline constexpr std::uint64_t localHeartbeatMaxAgeMs = 12'000;
inline constexpr std::uint64_t serverHeartbeatMaxAgeMs = 15'000;
inline constexpr std::uint64_t pulsePeriodMs = 2'400;
inline constexpr float pulseMinimumOpacity = 0.86f;
inline constexpr std::uint64_t optionsDoublePressWindowMs = 350;
inline constexpr std::uint32_t optionsStartButtonMask = 0x100;

struct State {
  int pid = 0;
  std::string session;
  std::uint64_t localHeartbeatMs = 0;
  std::uint64_t serverHeartbeatMs = 0;
  bool serverAuthenticated = false;
};

enum class DisplayMode : std::uint8_t { Hidden, Steady, Pulse };

std::string encodeState(const State& state);
bool decodeState(const std::string& encoded, State& state) noexcept;
DisplayMode displayMode(const State& state, std::uint64_t nowMs,
                        bool pidIsAlive) noexcept;
float indicatorOpacity(DisplayMode mode, std::uint64_t nowMs) noexcept;
bool startupAllowed(std::uint32_t firmware, bool killSwitchPresent,
                    bool conflictingInjectorPresent) noexcept;
const char* conflictingInjector(const std::string& processName) noexcept;
std::uint64_t monotonicMilliseconds() noexcept;

// Recognizes two distinct rising edges. It does not consume controller input;
// the ShellUI hook may consume the matched second edge only after that behavior
// is verified on the target firmware.
class OptionsDoublePress final {
 public:
  bool sample(bool pressed, std::uint64_t nowMs) noexcept;
  void reset(bool pressed = false) noexcept;

 private:
  bool previousPressed_ = false;
  bool waitingForSecond_ = false;
  std::uint64_t firstPressMs_ = 0;
};

struct OptionsSample {
  std::uint32_t buttons = 0;
  std::uint32_t buttonsDown = 0;
  std::uint32_t buttonsUp = 0;
};

struct OptionsObservation {
  bool down = false;
  bool up = false;
  bool doublePress = false;
};

OptionsObservation observeOptions(OptionsDoublePress& shortcut,
                                  const OptionsSample& sample,
                                  std::uint64_t nowMs) noexcept;

// Owns one agent-session heartbeat. It never consults the Library Server:
// local liveness controls icon presence; authenticated server health only
// controls the optional pulse bit consumed by the injected helper.
class HeartbeatFile final {
 public:
  HeartbeatFile(std::filesystem::path statePath,
                std::filesystem::path killSwitchPath, int pid,
                std::string session);
  ~HeartbeatFile();
  HeartbeatFile(const HeartbeatFile&) = delete;
  HeartbeatFile& operator=(const HeartbeatFile&) = delete;

  bool beat(bool serverAuthenticated,
            std::uint64_t nowMs = monotonicMilliseconds(),
            std::uint64_t serverHeartbeatMs = 0) noexcept;
  void stop() noexcept;
  bool active() const noexcept { return active_; }
  const std::string& error() const noexcept { return error_; }

 private:
  std::filesystem::path statePath_;
  std::filesystem::path killSwitchPath_;
  State state_;
  bool active_ = true;
  std::string error_;
};

}  // namespace ps5library::shell_indicator
