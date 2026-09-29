#pragma once
#include <cstdint>
#include <string_view>
#ifndef PS5LIBRARY_NATIVE_CONTENT_VERSION
#define PS5LIBRARY_NATIVE_CONTENT_VERSION "01.000.000"
#endif
namespace ps5library {
inline constexpr const char* appVersion="0.2.55";
inline constexpr int64_t appBuild=2026092901;
inline constexpr const char* nativeContentVersion=PS5LIBRARY_NATIVE_CONTENT_VERSION;
inline constexpr const char* nativeTitleId="PPSA99051";
inline constexpr const char* nativeContentId="UP9000-PPSA99051_00-PS5LIBRARYHOMETE";
inline constexpr const char* nativeTitle="PS5Library";
struct NativeUpdateIdentity {const char* titleId;const char* contentId;const char* name;};
inline constexpr NativeUpdateIdentity nativeUpdateIdentities[]={
  {nativeTitleId,nativeContentId,nativeTitle},
  {"PPSA99783","UP9000-PPSA99783_00-OPENSTORYPS50000","OpenStory"},
};
inline const NativeUpdateIdentity* nativeUpdateIdentity(std::string_view titleId){for(const auto& identity:nativeUpdateIdentities)if(titleId==identity.titleId)return &identity;return nullptr;}
}
