/*
 * Copyright (C) 2025-2026 OnionHEN / LightningMods
 * Copyright (C) 2026 PS5Library contributors
 *
 * GPL-3.0-or-later. See LICENSE.GPL-3.0 in this directory.
 */
#pragma once

#include <cstddef>
#include <cstdint>

namespace ps5library::shell_indicator {

enum class PatchResult : std::uint8_t {
  Applied,
  AlreadyApplied,
  Rejected,
};

enum class PatchFailure : std::uint8_t {
  None,
  Container,
  Title,
  AppError,
  Navigate,
  Order,
  Alias,
  Source,
};

inline constexpr std::uint32_t missingHomeUiMarker = UINT32_MAX;

struct HomeUiObservation {
  std::uint32_t size = 0;
  std::uint32_t declaredPayloadOffset = missingHomeUiMarker;
  std::uint32_t legacyMagicOffset = missingHomeUiMarker;
  std::uint32_t titleOffset = missingHomeUiMarker;
  std::uint32_t titleCount = 0;
  std::uint32_t appErrorOffset = missingHomeUiMarker;
  std::uint32_t appErrorCount = 0;
  std::uint32_t navigateOffset = missingHomeUiMarker;
  std::uint32_t navigateCount = 0;
  std::uint32_t oldOrderOffset = missingHomeUiMarker;
  std::uint32_t oldOrderCount = 0;
  std::uint32_t newOrderOffset = missingHomeUiMarker;
  std::uint32_t newOrderCount = 0;
  std::uint32_t oldAliasOffset = missingHomeUiMarker;
  std::uint32_t oldAliasCount = 0;
  std::uint32_t newAliasOffset = missingHomeUiMarker;
  std::uint32_t newAliasCount = 0;
  std::uint32_t oldSourceOffset = missingHomeUiMarker;
  std::uint32_t oldSourceCount = 0;
  std::uint32_t newSourceOffset = missingHomeUiMarker;
  std::uint32_t newSourceCount = 0;
  std::uint32_t inferredPayloadOffset = missingHomeUiMarker;
  bool rnpsHeader = false;
};

constexpr bool isPatchResultValue(int value) noexcept {
  return value >= static_cast<int>(PatchResult::Applied) &&
         value <= static_cast<int>(PatchResult::Rejected);
}

constexpr bool patchSucceeded(int value) noexcept {
  return value == static_cast<int>(PatchResult::Applied) ||
         value == static_cast<int>(PatchResult::AlreadyApplied);
}

constexpr int mergePatchResult(int current, PatchResult observed) noexcept {
  return patchSucceeded(current) && observed == PatchResult::Rejected
             ? current
             : static_cast<int>(observed);
}

inline constexpr unsigned homeReloadAttemptLimit = 3;

constexpr bool homeReloadDue(bool enabled, int patchResult,
                             unsigned attempts, std::uint64_t now,
                             std::uint64_t nextAttempt) noexcept {
  return enabled && !patchSucceeded(patchResult) &&
         attempts < homeReloadAttemptLimit && now >= nextAttempt;
}

// Transactionally patches only the verified 4.50/4.51 NPXS40002 legacy RNPS
// source profile. A mismatch leaves the supplied buffer byte-for-byte intact.
PatchResult patchHomeUi450451(unsigned char* buffer, std::size_t size,
                             PatchFailure* failure = nullptr);

// Reports marker offsets only. It never copies or mutates bundle contents.
HomeUiObservation observeHomeUi450451(const unsigned char* buffer,
                                      std::size_t size) noexcept;

const char* patchResultName(PatchResult result) noexcept;
const char* patchFailureName(PatchFailure failure) noexcept;

}  // namespace ps5library::shell_indicator
