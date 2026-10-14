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
#include <limits>
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
constexpr std::size_t liveContainerSize = 0x153270;
constexpr std::size_t livePayloadSize = 0x152750;
constexpr std::size_t liveTitleOffset = 0x6ada0;
constexpr std::size_t liveAppErrorOffset = 0xa6a9e;
constexpr std::size_t liveNavigateOffset = 0x40359;
constexpr std::size_t liveFieldWindow = 0x400;
constexpr unsigned char legacyMagic[] = {0xe5, 0xd1, 0x0b, 0xfb};
constexpr char rnpsMagic[] = "RNPSHEDR";
constexpr char oldOrder[] = "[\"Fps\",\"Search\",\"Settings\",\"Profile\"]";
constexpr char newOrder[] = "[\"Search\",\"App\",\"Settings\",\"Profile\"]";
constexpr char oldAlias[] = "t.Fps=P";
constexpr char newAlias[] = "t.App=h";
constexpr char oldSource[] =
    "var h=(0,u().memo)((function(){var e=(0,m.default)().sendClientApplicationErrorEvent;return u().default.createElement(d.default,{iconId:\"download_error\",onPress:function(){var t=new Error(\"homeui ApplicationErrorEvent test\");e({errorMessage:t.message,stack:t.stack,severity:\"info\"})},title:\"Trigger AppError\",__source:{fileName:_,lineNumber:80}})}));t.ApplicationErrorEventTrigger=h;";
constexpr char newSource[] =
    "var h=(0,u().memo)((function(){var e=(0,f.useInteractivePress)({link:\"PS5Library?Status=1\"});return u().default.createElement(d.default,{iconId:{uri:\"/user/appmeta/PPSA99051/icon0.png\"},onPress:e,title:\"\",__source:{fileName:_,lineNumber:80}})}));t.ApplicationErrorEventTrigger=h;";

static_assert(liveContainerSize ==
              rnpsFallbackPayloadOffset + livePayloadSize);
static_assert(liveTitleOffset + sizeof("NPXS40002") - 1 <= livePayloadSize);
static_assert(liveAppErrorOffset + sizeof("ApplicationErrorEventTrigger") - 1 <=
              livePayloadSize);
static_assert(liveNavigateOffset + sizeof("pshomeui:navigateToHome") - 1 <=
              livePayloadSize);
static_assert(sizeof(oldOrder) == sizeof(newOrder));
static_assert(sizeof(oldAlias) == sizeof(newAlias));
static_assert(sizeof(newSource) <= sizeof(oldSource));
constexpr std::size_t verifiedPayloadSize =
    aliasOffset + sizeof(oldAlias) - 1;
static_assert(titleOffset + sizeof("NPXS40002") - 1 <= verifiedPayloadSize);
static_assert(appErrorOffset + sizeof("ApplicationErrorEventTrigger") - 1 <=
              verifiedPayloadSize);
static_assert(navigateOffset + sizeof("pshomeui:navigateToHome") - 1 <=
              verifiedPayloadSize);
static_assert(orderOffset + sizeof(oldOrder) - 1 <= verifiedPayloadSize);
static_assert(sourceOffset + sizeof(oldSource) - 1 <= verifiedPayloadSize);
static_assert(aliasOffset + sizeof(oldAlias) - 1 <= verifiedPayloadSize);

bool range(std::size_t size, std::size_t offset, std::size_t length) {
  return offset <= size && length <= size - offset;
}

bool equal(const unsigned char* data, std::size_t offset,
           std::string_view expected) {
  return std::memcmp(data + offset, expected.data(), expected.size()) == 0;
}

bool homeProfileAt(const unsigned char* buffer, std::size_t size,
                   std::size_t offset) {
  if (!range(size, offset, verifiedPayloadSize)) return false;
  auto* data = buffer + offset;
  return !std::memcmp(data, legacyMagic, sizeof(legacyMagic)) &&
         equal(data, titleOffset, "NPXS40002") &&
         equal(data, appErrorOffset, "ApplicationErrorEventTrigger") &&
         equal(data, navigateOffset, "pshomeui:navigateToHome");
}

std::size_t findMarker(const unsigned char* buffer, std::size_t size,
                       std::string_view marker, std::size_t start = 0) {
  if (!buffer || marker.empty() || !range(size, start, marker.size()))
    return std::numeric_limits<std::size_t>::max();
  const auto* cursor = buffer + start;
  const auto* end = buffer + size;
  while (static_cast<std::size_t>(end - cursor) >= marker.size()) {
    cursor = static_cast<const unsigned char*>(
        std::memchr(cursor, static_cast<unsigned char>(marker.front()),
                    static_cast<std::size_t>(end - cursor)));
    if (!cursor || static_cast<std::size_t>(end - cursor) < marker.size())
      return std::numeric_limits<std::size_t>::max();
    if (!std::memcmp(cursor, marker.data(), marker.size()))
      return static_cast<std::size_t>(cursor - buffer);
    ++cursor;
  }
  return std::numeric_limits<std::size_t>::max();
}

struct MarkerStats {
  std::size_t first = std::numeric_limits<std::size_t>::max();
  std::size_t second = std::numeric_limits<std::size_t>::max();
  unsigned count = 0;
};

MarkerStats markerStats(const unsigned char* buffer, std::size_t size,
                        std::string_view marker) {
  MarkerStats result;
  auto position = findMarker(buffer, size, marker);
  while (position != std::numeric_limits<std::size_t>::max()) {
    if (!result.count) result.first = position;
    else if (result.count == 1) result.second = position;
    ++result.count;
    position = findMarker(buffer, size, marker, position + 1);
  }
  return result;
}

std::size_t findHomeProfileOffset(const unsigned char* buffer,
                                  std::size_t size) {
  constexpr std::string_view title = "NPXS40002";
  auto position = findMarker(buffer, size, title, titleOffset);
  while (position != std::numeric_limits<std::size_t>::max()) {
    const auto offset = position - titleOffset;
    if (homeProfileAt(buffer, size, offset)) return offset;
    position = findMarker(buffer, size, title, position + 1);
  }
  return std::numeric_limits<std::size_t>::max();
}

std::uint32_t observedOffset(std::size_t value) {
  return value < missingHomeUiMarker ? static_cast<std::uint32_t>(value)
                                    : missingHomeUiMarker;
}

std::uint32_t little32(const unsigned char* data) {
  return static_cast<std::uint32_t>(data[0]) |
         (static_cast<std::uint32_t>(data[1]) << 8) |
         (static_cast<std::uint32_t>(data[2]) << 16) |
         (static_cast<std::uint32_t>(data[3]) << 24);
}

unsigned char* locate(unsigned char* buffer, std::size_t size) {
  if (size >= payloadSize && homeProfileAt(buffer, size, 0)) return buffer;
  const std::size_t trailing =
      size >= payloadSize ? size - payloadSize : size;
  if (range(size, trailing, payloadSize) &&
      homeProfileAt(buffer, size, trailing))
    return buffer + trailing;
  if (size >= sizeof(rnpsMagic) - 1 &&
      !std::memcmp(buffer, rnpsMagic, sizeof(rnpsMagic) - 1)) {
    std::size_t declared = rnpsFallbackPayloadOffset;
    if (range(size, rnpsPayloadOffsetField, sizeof(std::uint32_t))) {
      const auto value = little32(buffer + rnpsPayloadOffsetField);
      if (value > 0 && value < size) declared = value;
    }
    const std::size_t candidates[] = {
        declared, rnpsFallbackPayloadOffset};
    for (const auto offset : candidates) {
      if (homeProfileAt(buffer, size, offset)) return buffer + offset;
    }
  }

  // Some live ioctl views do not expose the same wrapper boundary as the
  // on-disk RNPS file. Recover only the exact verified 4.x HomeUI profile.
  const auto recovered = findHomeProfileOffset(buffer, size);
  if (recovered != std::numeric_limits<std::size_t>::max())
    return buffer + recovered;

  return nullptr;
}

enum class FieldState { Original, Target, Invalid };

struct ResolvedField {
  std::size_t offset = std::numeric_limits<std::size_t>::max();
  FieldState state = FieldState::Invalid;
};

bool nearPinned(std::size_t offset, std::size_t pinned) {
  const auto lower = pinned > liveFieldWindow ? pinned - liveFieldWindow : 0;
  return offset >= lower && offset <= pinned + liveFieldWindow;
}

ResolvedField resolveField(const unsigned char* data, std::size_t size,
                           std::size_t pinned, std::string_view original,
                           std::string_view target) {
  const auto old = markerStats(data, size, original);
  const auto next = markerStats(data, size, target);
  if (old.count + next.count != 1) return {};
  const auto offset = old.count ? old.first : next.first;
  if (!nearPinned(offset, pinned)) return {};
  return {offset, old.count ? FieldState::Original : FieldState::Target};
}

ResolvedField resolveSource(const unsigned char* data, std::size_t size) {
  auto result = resolveField(data, size, sourceOffset, oldSource, newSource);
  if (result.state != FieldState::Target) return result;
  constexpr auto oldLength = sizeof(oldSource) - 1;
  constexpr auto newLength = sizeof(newSource) - 1;
  if (!range(size, result.offset, oldLength)) return {};
  for (std::size_t index = newLength; index < oldLength; ++index)
    if (data[result.offset + index] != ' ') return {};
  return result;
}

unsigned char* locateLive450(unsigned char* buffer, std::size_t size) {
  if (size != liveContainerSize ||
      std::memcmp(buffer, rnpsMagic, sizeof(rnpsMagic) - 1) ||
      little32(buffer + rnpsPayloadOffsetField) != rnpsFallbackPayloadOffset)
    return nullptr;
  auto* data = buffer + rnpsFallbackPayloadOffset;
  if (std::memcmp(data, legacyMagic, sizeof(legacyMagic)) ||
      !equal(data, liveTitleOffset, "NPXS40002") ||
      !equal(data, liveAppErrorOffset, "ApplicationErrorEventTrigger") ||
      !equal(data, liveNavigateOffset, "pshomeui:navigateToHome"))
    return nullptr;
  return data;
}

FieldState field(const unsigned char* data, std::size_t offset,
                 std::string_view original, std::string_view target) {
  if (equal(data, offset, target)) return FieldState::Target;
  if (equal(data, offset, original)) return FieldState::Original;
  return FieldState::Invalid;
}

FieldState source(const unsigned char* data, std::size_t offset) {
  constexpr auto oldLength = sizeof(oldSource) - 1;
  constexpr auto newLength = sizeof(newSource) - 1;
  if (!std::memcmp(data + offset, oldSource, oldLength))
    return FieldState::Original;
  if (std::memcmp(data + offset, newSource, newLength))
    return FieldState::Invalid;
  for (std::size_t index = newLength; index < oldLength; ++index)
    if (data[offset + index] != ' ') return FieldState::Invalid;
  return FieldState::Target;
}

}  // namespace

HomeUiObservation observeHomeUi450451(const unsigned char* buffer,
                                      std::size_t size) noexcept {
  HomeUiObservation observed;
  observed.size = size < missingHomeUiMarker
                      ? static_cast<std::uint32_t>(size)
                      : missingHomeUiMarker;
  if (!buffer || !size) return observed;

  observed.rnpsHeader =
      size >= sizeof(rnpsMagic) - 1 &&
      !std::memcmp(buffer, rnpsMagic, sizeof(rnpsMagic) - 1);
  if (observed.rnpsHeader &&
      range(size, rnpsPayloadOffsetField, sizeof(std::uint32_t))) {
    const auto declared = little32(buffer + rnpsPayloadOffsetField);
    if (declared > 0 && declared < size)
      observed.declaredPayloadOffset = declared;
  }
  observed.legacyMagicOffset = observedOffset(findMarker(
      buffer, size,
      std::string_view(reinterpret_cast<const char*>(legacyMagic),
                       sizeof(legacyMagic))));
  const auto title = markerStats(buffer, size, "NPXS40002");
  observed.titleOffset = observedOffset(title.first);
  observed.titleCount = title.count;
  const auto appError =
      markerStats(buffer, size, "ApplicationErrorEventTrigger");
  observed.appErrorOffset = observedOffset(appError.first);
  observed.appErrorCount = appError.count;
  const auto navigate = markerStats(buffer, size, "pshomeui:navigateToHome");
  observed.navigateOffset = observedOffset(navigate.first);
  observed.navigateCount = navigate.count;
  const auto oldOrderMatch = markerStats(buffer, size, oldOrder);
  observed.oldOrderOffset = observedOffset(oldOrderMatch.first);
  observed.oldOrderCount = oldOrderMatch.count;
  const auto newOrderMatch = markerStats(buffer, size, newOrder);
  observed.newOrderOffset = observedOffset(newOrderMatch.first);
  observed.newOrderCount = newOrderMatch.count;
  const auto oldAliasMatch = markerStats(buffer, size, oldAlias);
  observed.oldAliasOffset = observedOffset(oldAliasMatch.first);
  observed.oldAliasCount = oldAliasMatch.count;
  const auto newAliasMatch = markerStats(buffer, size, newAlias);
  observed.newAliasOffset = observedOffset(newAliasMatch.first);
  observed.newAliasCount = newAliasMatch.count;
  const auto oldSourceMatch = markerStats(buffer, size, oldSource);
  observed.oldSourceOffset = observedOffset(oldSourceMatch.first);
  observed.oldSourceCount = oldSourceMatch.count;
  const auto newSourceMatch = markerStats(buffer, size, newSource);
  observed.newSourceOffset = observedOffset(newSourceMatch.first);
  observed.newSourceCount = newSourceMatch.count;
  observed.inferredPayloadOffset =
      observedOffset(findHomeProfileOffset(buffer, size));
  return observed;
}

PatchResult patchHomeUi450451(unsigned char* buffer, std::size_t size,
                             PatchFailure* failure) {
  if (failure) *failure = PatchFailure::None;
  if (!buffer) {
    if (failure) *failure = PatchFailure::Container;
    return PatchResult::Rejected;
  }
  auto* data = locate(buffer, size);
  const bool live = !data && (data = locateLive450(buffer, size));
  if (!data) {
    if (failure) *failure = PatchFailure::Container;
    return PatchResult::Rejected;
  }

  const auto actualTitle = live ? liveTitleOffset : titleOffset;
  const auto actualAppError = live ? liveAppErrorOffset : appErrorOffset;
  const auto actualNavigate = live ? liveNavigateOffset : navigateOffset;
  if (!equal(data, actualTitle, "NPXS40002")) {
    if (failure) *failure = PatchFailure::Title;
    return PatchResult::Rejected;
  }
  if (!equal(data, actualAppError, "ApplicationErrorEventTrigger")) {
    if (failure) *failure = PatchFailure::AppError;
    return PatchResult::Rejected;
  }
  if (!equal(data, actualNavigate, "pshomeui:navigateToHome")) {
    if (failure) *failure = PatchFailure::Navigate;
    return PatchResult::Rejected;
  }

  std::size_t actualOrder = orderOffset, actualAlias = aliasOffset,
              actualSource = sourceOffset;
  auto order = field(data, actualOrder, oldOrder, newOrder);
  auto alias = field(data, actualAlias, oldAlias, newAlias);
  auto body = source(data, actualSource);
  if (live) {
    const auto resolvedOrder = resolveField(data, livePayloadSize, orderOffset,
                                            oldOrder, newOrder);
    if (resolvedOrder.state == FieldState::Invalid) {
      if (failure) *failure = PatchFailure::Order;
      return PatchResult::Rejected;
    }
    const auto resolvedAlias = resolveField(data, livePayloadSize, aliasOffset,
                                            oldAlias, newAlias);
    if (resolvedAlias.state == FieldState::Invalid) {
      if (failure) *failure = PatchFailure::Alias;
      return PatchResult::Rejected;
    }
    const auto resolvedSource = resolveSource(data, livePayloadSize);
    if (resolvedSource.state == FieldState::Invalid) {
      if (failure) *failure = PatchFailure::Source;
      return PatchResult::Rejected;
    }
    actualOrder = resolvedOrder.offset;
    actualAlias = resolvedAlias.offset;
    actualSource = resolvedSource.offset;
    order = resolvedOrder.state;
    alias = resolvedAlias.state;
    body = resolvedSource.state;
    const auto embedded = actualSource +
                          (body == FieldState::Original ? 0x160 : 0xf8);
    if (actualOrder + 0xc7 != actualAppError) {
      if (failure) *failure = PatchFailure::Order;
      return PatchResult::Rejected;
    }
    if (actualAlias != actualSource + 0x2d4) {
      if (failure) *failure = PatchFailure::Alias;
      return PatchResult::Rejected;
    }
    if (!equal(data, embedded, "ApplicationErrorEventTrigger")) {
      if (failure) *failure = PatchFailure::Source;
      return PatchResult::Rejected;
    }
  }
  if (order == FieldState::Invalid) {
    if (failure) *failure = PatchFailure::Order;
    return PatchResult::Rejected;
  }
  if (alias == FieldState::Invalid) {
    if (failure) *failure = PatchFailure::Alias;
    return PatchResult::Rejected;
  }
  if (body == FieldState::Invalid) {
    if (failure) *failure = PatchFailure::Source;
    return PatchResult::Rejected;
  }
  if (order == FieldState::Target && alias == FieldState::Target &&
      body == FieldState::Target)
    return PatchResult::AlreadyApplied;

  // All bytes have been checked before the first mutation.
  if (order == FieldState::Original)
    std::memcpy(data + actualOrder, newOrder, sizeof(newOrder) - 1);
  if (alias == FieldState::Original)
    std::memcpy(data + actualAlias, newAlias, sizeof(newAlias) - 1);
  if (body == FieldState::Original) {
    std::memcpy(data + actualSource, newSource, sizeof(newSource) - 1);
    std::memset(data + actualSource + sizeof(newSource) - 1, ' ',
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

const char* patchFailureName(PatchFailure failure) noexcept {
  switch (failure) {
    case PatchFailure::None: return "NONE";
    case PatchFailure::Container: return "CONTAINER";
    case PatchFailure::Title: return "TITLE";
    case PatchFailure::AppError: return "APP_ERROR";
    case PatchFailure::Navigate: return "NAVIGATE";
    case PatchFailure::Order: return "ORDER";
    case PatchFailure::Alias: return "ALIAS";
    case PatchFailure::Source: return "SOURCE";
  }
  return "UNKNOWN";
}

}  // namespace ps5library::shell_indicator
