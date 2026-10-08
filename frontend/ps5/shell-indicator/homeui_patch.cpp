/*
 * Copyright (C) 2025-2026 OnionHEN / LightningMods
 * Copyright (C) 2026 PS5Library contributors
 *
 * Derived from OnionHEN homeui_top_nav_patch.cpp at commit
 * b23ffe674b2de9f62fe634944c9230ff149d593a.
 * GPL-3.0-or-later. See LICENSE.GPL-3.0 in this directory.
 */
#include "homeui_patch.hpp"

#include <cstring>
#include <string_view>

namespace ps5library::shell_indicator {
namespace {

constexpr std::size_t payloadSize = 0x152990;
constexpr std::size_t titleOffset = 0x6ae31;
constexpr std::size_t appErrorOffset = 0xa6bb1;
constexpr std::size_t navigateOffset = 0x40386;
constexpr std::size_t orderOffset = 0xa6aea;
constexpr std::size_t sourceOffset = 0x1021c9;
constexpr std::size_t aliasOffset = 0x10249d;
constexpr std::size_t rnpsPayloadOffsetField = 0x1c;
constexpr std::size_t rnpsFallbackPayloadOffset = 0xb20;
constexpr unsigned char legacyMagic[] = {0xe5, 0xd1, 0x0b, 0xfb};
constexpr char rnpsMagic[] = "RNPSHEDR";
constexpr char oldOrder[] = "[\"Fps\",\"Search\",\"Settings\",\"Profile\"]";
constexpr char newOrder[] = "[\"Search\",\"App\",\"Settings\",\"Profile\"]";
constexpr char oldAlias[] = "t.Fps=P";
constexpr char newAlias[] = "t.App=h";
constexpr char oldSource[] =
    "var h=(0,u().memo)((function(){var e=(0,m.default)().sendClientApplicationErrorEvent;return u().default.createElement(d.default,{iconId:\"download_error\",onPress:function(){var t=new Error(\"homeui ApplicationErrorEvent test\");e({errorMessage:t.message,stack:t.stack,severity:\"info\"})},title:\"Trigger AppError\",__source:{fileName:_,lineNumber:80}})}));t.ApplicationErrorEventTrigger=h;";
constexpr char newSource[] =
    "var h=(0,u().memo)((function(){var e=(0,f.useInteractivePress)({link:\"PS5Library?Status=1\"});return u().default.createElement(d.default,{iconId:{uri:\"/system_tmp/ps5library/icon0.png\"},onPress:e,title:\"\",__source:{fileName:_,lineNumber:80}})}));t.ApplicationErrorEventTrigger=h;";

static_assert(sizeof(oldOrder) == sizeof(newOrder));
static_assert(sizeof(oldAlias) == sizeof(newAlias));
static_assert(sizeof(newSource) <= sizeof(oldSource));

bool range(std::size_t size, std::size_t offset, std::size_t length) {
  return offset <= size && length <= size - offset;
}

bool equal(const unsigned char* data, std::size_t offset,
           std::string_view expected) {
  return std::memcmp(data + offset, expected.data(), expected.size()) == 0;
}

std::uint32_t little32(const unsigned char* data) {
  return static_cast<std::uint32_t>(data[0]) |
         (static_cast<std::uint32_t>(data[1]) << 8) |
         (static_cast<std::uint32_t>(data[2]) << 16) |
         (static_cast<std::uint32_t>(data[3]) << 24);
}

unsigned char* locate(unsigned char* buffer, std::size_t size) {
  if (size == payloadSize &&
      !std::memcmp(buffer, legacyMagic, sizeof(legacyMagic)))
    return buffer;
  if (size < sizeof(rnpsMagic) - 1 ||
      std::memcmp(buffer, rnpsMagic, sizeof(rnpsMagic) - 1))
    return nullptr;

  std::size_t declared = rnpsFallbackPayloadOffset;
  if (range(size, rnpsPayloadOffsetField, sizeof(std::uint32_t))) {
    const auto value = little32(buffer + rnpsPayloadOffsetField);
    if (value > 0 && value < size) declared = value;
  }
  const std::size_t candidates[] = {declared, rnpsFallbackPayloadOffset};
  for (const auto offset : candidates) {
    if (!range(size, offset, payloadSize) || size - offset != payloadSize)
      continue;
    if (!std::memcmp(buffer + offset, legacyMagic, sizeof(legacyMagic)))
      return buffer + offset;
  }
  return nullptr;
}

enum class FieldState { Original, Target, Invalid };

FieldState field(const unsigned char* data, std::size_t offset,
                 std::string_view original, std::string_view target) {
  if (equal(data, offset, target)) return FieldState::Target;
  if (equal(data, offset, original)) return FieldState::Original;
  return FieldState::Invalid;
}

FieldState source(const unsigned char* data) {
  constexpr auto oldLength = sizeof(oldSource) - 1;
  constexpr auto newLength = sizeof(newSource) - 1;
  if (!std::memcmp(data + sourceOffset, oldSource, oldLength))
    return FieldState::Original;
  if (std::memcmp(data + sourceOffset, newSource, newLength))
    return FieldState::Invalid;
  for (std::size_t index = newLength; index < oldLength; ++index)
    if (data[sourceOffset + index] != ' ') return FieldState::Invalid;
  return FieldState::Target;
}

}  // namespace

PatchResult patchHomeUi450451(unsigned char* buffer, std::size_t size) {
  if (!buffer) return PatchResult::Rejected;
  auto* data = locate(buffer, size);
  if (!data) return PatchResult::Rejected;

  if (!equal(data, titleOffset, "NPXS40002") ||
      !equal(data, appErrorOffset, "ApplicationErrorEventTrigger") ||
      !equal(data, navigateOffset, "pshomeui:navigateToHome"))
    return PatchResult::Rejected;

  const auto order = field(data, orderOffset, oldOrder, newOrder);
  const auto alias = field(data, aliasOffset, oldAlias, newAlias);
  const auto body = source(data);
  if (order == FieldState::Invalid || alias == FieldState::Invalid ||
      body == FieldState::Invalid)
    return PatchResult::Rejected;
  if (order == FieldState::Target && alias == FieldState::Target &&
      body == FieldState::Target)
    return PatchResult::AlreadyApplied;

  // All bytes have been checked before the first mutation.
  if (order == FieldState::Original)
    std::memcpy(data + orderOffset, newOrder, sizeof(newOrder) - 1);
  if (alias == FieldState::Original)
    std::memcpy(data + aliasOffset, newAlias, sizeof(newAlias) - 1);
  if (body == FieldState::Original) {
    std::memcpy(data + sourceOffset, newSource, sizeof(newSource) - 1);
    std::memset(data + sourceOffset + sizeof(newSource) - 1, ' ',
                sizeof(oldSource) - sizeof(newSource));
  }
  return PatchResult::Applied;
}

const char* patchResultName(PatchResult result) noexcept {
  switch (result) {
    case PatchResult::Applied:
      return "APPLIED";
    case PatchResult::AlreadyApplied:
      return "ALREADY_APPLIED";
    case PatchResult::Rejected:
      return "REJECTED";
  }
  return "REJECTED";
}

}  // namespace ps5library::shell_indicator
