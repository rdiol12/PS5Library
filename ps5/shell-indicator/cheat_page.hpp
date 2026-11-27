#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <string_view>
#include <vector>

namespace ps5library::shell_indicator {

inline constexpr std::size_t cheatSnapshotMaximumBytes = 64 * 1024;
inline constexpr std::size_t cheatSnapshotMaximumRows = 128;
inline constexpr std::uint64_t cheatStateMaximumAgeMs = 15'000;

struct CheatSession {
  std::string session;
  std::string token;
  std::int64_t agentPid = 0;
  std::uint64_t heartbeatMs = 0;
};

struct CheatRow {
  std::string profileId;
  std::string entryId;
  std::string titleId;
  std::string version;
  std::string process;
  std::string validation;
  std::string trust;
  std::string runtime;
  std::string name;
  std::string description;
  bool installed = false;
  bool enabled = false;
};

struct MemoryScanResult {
  std::string resultId;
  std::string value;
  bool changed = false;
  bool writable = false;
  bool modified = false;
  bool frozen = false;
};

struct MemoryScanView {
  bool targetAvailable = false;
  bool enabled = false;
  bool writeEnabled = false;
  std::string titleId;
  std::string version;
  std::string process;
  std::string scanId;
  std::string valueType = "U32";
  std::string state;
  std::uint64_t matchCount = 0;
  bool truncated = false;
  std::vector<MemoryScanResult> results;
};

struct CheatSnapshot {
  std::string session;
  std::uint64_t generatedMs = 0;
  bool available = false;
  bool truncated = false;
  std::vector<CheatRow> rows;
  MemoryScanView memory;
};

bool decodeCheatSession(std::string_view encoded, std::uint64_t nowMs,
                        CheatSession& result) noexcept;
bool decodeCheatSnapshot(std::string_view encoded,
                         std::string_view expectedSession,
                         std::uint64_t nowMs,
                         CheatSnapshot& result) noexcept;
std::string buildCheatPage(const CheatSnapshot& snapshot);
bool cheatRowActionable(const CheatRow& row) noexcept;
std::optional<std::size_t> cheatRowIndex(std::string_view id,
                                         std::size_t rowCount) noexcept;
std::optional<std::size_t> memoryResultIndex(std::string_view id,
                                             std::size_t rowCount) noexcept;
bool memoryScalarValue(std::string_view value) noexcept;
std::string buildMemoryTargetRequest(const CheatSession& session);
std::string buildMemoryStartRequest(const CheatSession& session,
                                    const MemoryScanView& view,
                                    std::string_view type, bool unknown,
                                    std::string_view value = {});
std::string buildMemoryRefineRequest(const CheatSession& session,
                                     const MemoryScanView& view,
                                     std::string_view mode,
                                     std::string_view value = {});
std::string buildMemoryWatchRequest(const CheatSession& session,
                                    const MemoryScanView& view);
std::string buildMemoryWriteRequest(const CheatSession& session,
                                    const MemoryScanView& view,
                                    const MemoryScanResult& result,
                                    std::string_view value,
                                    bool freeze = false);
std::string buildMemoryRestoreRequest(const CheatSession& session,
                                      const MemoryScanView& view,
                                      const MemoryScanResult& result);
std::string buildMemoryClearRequest(const CheatSession& session);
std::string buildCheatRequest(const CheatSession& session,
                              const CheatRow& row, bool enabled,
                              bool approveUnverified);

}  // namespace ps5library::shell_indicator
