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

// Transactionally patches only the verified 4.50/4.51 NPXS40002 legacy RNPS
// source profile. A mismatch leaves the supplied buffer byte-for-byte intact.
PatchResult patchHomeUi450451(unsigned char* buffer, std::size_t size);

const char* patchResultName(PatchResult result) noexcept;

}  // namespace ps5library::shell_indicator
