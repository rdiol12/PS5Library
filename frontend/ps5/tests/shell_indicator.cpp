#include "../shell-indicator/homeui_patch.hpp"
#include "../shell-indicator/cheat_page.hpp"
#include "../shell-indicator/lifecycle.hpp"

#include <cassert>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <string>
#include <vector>

using namespace ps5library::shell_indicator;

namespace {

constexpr std::size_t payloadSize = 0x152990;
constexpr std::size_t titleOffset = 0x6ae31;
constexpr std::size_t appErrorOffset = 0xa6bb1;
constexpr std::size_t navigateOffset = 0x40386;
constexpr std::size_t orderOffset = 0xa6aea;
constexpr std::size_t sourceOffset = 0x1021c9;
constexpr std::size_t aliasOffset = 0x10249d;
constexpr char oldOrder[] = "[\"Fps\",\"Search\",\"Settings\",\"Profile\"]";
constexpr char newOrder[] = "[\"Search\",\"App\",\"Settings\",\"Profile\"]";
constexpr char oldAlias[] = "t.Fps=P";
constexpr char newAlias[] = "t.App=h";
constexpr char oldSource[] =
    "var h=(0,u().memo)((function(){var e=(0,m.default)().sendClientApplicationErrorEvent;return u().default.createElement(d.default,{iconId:\"download_error\",onPress:function(){var t=new Error(\"homeui ApplicationErrorEvent test\");e({errorMessage:t.message,stack:t.stack,severity:\"info\"})},title:\"Trigger AppError\",__source:{fileName:_,lineNumber:80}})}));t.ApplicationErrorEventTrigger=h;";
constexpr char newSource[] =
    "var h=(0,u().memo)((function(){var e=(0,f.useInteractivePress)({link:\"PS5Library?Status=1\"});return u().default.createElement(d.default,{iconId:{uri:\"/system_tmp/ps5library/icon0.png\"},onPress:e,title:\"\",__source:{fileName:_,lineNumber:80}})}));t.ApplicationErrorEventTrigger=h;";

void put(std::vector<unsigned char>& data, std::size_t offset,
         const char* value, std::size_t length) {
  std::memcpy(data.data() + offset, value, length);
}

std::vector<unsigned char> pristine() {
  std::vector<unsigned char> data(payloadSize);
  const unsigned char magic[] = {0xe5, 0xd1, 0x0b, 0xfb};
  std::memcpy(data.data(), magic, sizeof(magic));
  put(data, titleOffset, "NPXS40002", 9);
  put(data, appErrorOffset, "ApplicationErrorEventTrigger", 28);
  put(data, navigateOffset, "pshomeui:navigateToHome", 23);
  put(data, orderOffset, oldOrder, sizeof(oldOrder) - 1);
  put(data, aliasOffset, oldAlias, sizeof(oldAlias) - 1);
  put(data, sourceOffset, oldSource, sizeof(oldSource) - 1);
  return data;
}

void patchChecks() {
  auto data = pristine();
  assert(patchHomeUi450451(data.data(), data.size()) == PatchResult::Applied);
  assert(!std::memcmp(data.data() + orderOffset, newOrder,
                      sizeof(newOrder) - 1));
  assert(!std::memcmp(data.data() + aliasOffset, newAlias,
                      sizeof(newAlias) - 1));
  assert(!std::memcmp(data.data() + sourceOffset, newSource,
                      sizeof(newSource) - 1));
  for (std::size_t i = sizeof(newSource) - 1; i < sizeof(oldSource) - 1; ++i)
    assert(data[sourceOffset + i] == ' ');
  const auto applied = data;
  assert(patchHomeUi450451(data.data(), data.size()) ==
         PatchResult::AlreadyApplied);
  assert(data == applied);

  auto corrupt = pristine();
  corrupt[aliasOffset + 2] ^= 1;
  const auto unchanged = corrupt;
  assert(patchHomeUi450451(corrupt.data(), corrupt.size()) ==
         PatchResult::Rejected);
  assert(corrupt == unchanged);

  auto shortInput = pristine();
  shortInput.pop_back();
  const auto shortOriginal = shortInput;
  assert(patchHomeUi450451(shortInput.data(), shortInput.size()) ==
         PatchResult::Rejected);
  assert(shortInput == shortOriginal);

  constexpr std::size_t wrapper = 0xb20;
  auto wrappedPayload = pristine();
  std::vector<unsigned char> wrapped(wrapper + wrappedPayload.size());
  put(wrapped, 0, "RNPSHEDR", 8);
  wrapped[0x1c] = static_cast<unsigned char>(wrapper & 0xff);
  wrapped[0x1d] = static_cast<unsigned char>((wrapper >> 8) & 0xff);
  std::memcpy(wrapped.data() + wrapper, wrappedPayload.data(),
              wrappedPayload.size());
  assert(patchHomeUi450451(wrapped.data(), wrapped.size()) ==
         PatchResult::Applied);
  assert(!std::memcmp(wrapped.data() + wrapper + aliasOffset, newAlias,
                      sizeof(newAlias) - 1));
}

void stateChecks() {
  State state{123, "0000007b-0000000000000001", 1000, 900, true};
  const auto encoded = encodeState(state);
  State decoded;
  assert(decodeState(encoded, decoded));
  assert(decoded.pid == state.pid && decoded.session == state.session &&
         decoded.localHeartbeatMs == state.localHeartbeatMs &&
         decoded.serverHeartbeatMs == state.serverHeartbeatMs &&
         decoded.serverAuthenticated);
  assert(displayMode(decoded, 1100, true) == DisplayMode::Pulse);
  decoded.localHeartbeatMs = 16000;
  assert(displayMode(decoded, 16000, true) == DisplayMode::Steady);
  decoded.localHeartbeatMs = 1000;
  assert(displayMode(decoded, 14000, true) == DisplayMode::Hidden);
  assert(displayMode(decoded, 1100, false) == DisplayMode::Hidden);
  assert(indicatorOpacity(DisplayMode::Hidden, 0) == 0.0f);
  assert(indicatorOpacity(DisplayMode::Steady, 0) == 1.0f);
  assert(indicatorOpacity(DisplayMode::Pulse, 0) == pulseMinimumOpacity);
  assert(indicatorOpacity(DisplayMode::Pulse, pulsePeriodMs / 2) == 1.0f);
  assert(!decodeState(encoded + "extra=1\n", decoded));
  assert(startupAllowed(firmware451, false, false));
  assert(startupAllowed(firmware450, false, false));
  assert(!startupAllowed(firmware451, true, false));
  assert(!startupAllowed(firmware451, false, true));
  assert(std::string(conflictingInjector("etaHEN Utility Daemon")) ==
         "etaHEN");
  assert(std::string(conflictingInjector("CheatRunner")) == "CheatRunner");
  assert(conflictingInjector("ps5library-agent") == nullptr);

  const auto root = std::filesystem::temp_directory_path() /
                    "ps5library-shell-indicator-check";
  std::error_code error;
  std::filesystem::remove_all(root, error);
  std::filesystem::create_directories(root);
  const auto path = root / "indicator.state";
  const auto kill = root / "disable-shell-indicator";
  {
    HeartbeatFile file(path, kill, 123, state.session);
    assert(file.beat(false, 2000));
    std::ifstream input(path);
    const std::string persisted((std::istreambuf_iterator<char>(input)), {});
    assert(decodeState(persisted, decoded));
    assert(displayMode(decoded, 2100, true) == DisplayMode::Steady);
    std::ofstream(kill).put('1');
    assert(!file.beat(true, 2200));
    assert(!std::filesystem::exists(path));
  }
  std::filesystem::remove_all(root, error);
}

void optionsDoublePressChecks() {
  OptionsDoublePress shortcut;
  const OptionsSample untouched{0x8100, 0x1100, 0x2100};
  const auto first = observeOptions(shortcut, untouched, 1000);
  assert(first.down && first.up && !first.doublePress);
  assert(untouched.buttons == 0x8100 && untouched.buttonsDown == 0x1100 &&
         untouched.buttonsUp == 0x2100);
  shortcut.reset();

  // A held button is one edge, so key-repeat/polling never opens the panel.
  assert(!shortcut.sample(true, 1000));
  assert(!shortcut.sample(true, 1016));
  assert(!shortcut.sample(true, 1032));
  assert(!shortcut.sample(false, 1050));

  // Only the matched second rising edge is consumed.
  assert(shortcut.sample(true, 1250));
  assert(!shortcut.sample(true, 1266));
  assert(!shortcut.sample(false, 1280));

  // A late second edge starts a new pair instead of triggering the old one.
  assert(!shortcut.sample(true, 1700));
  assert(!shortcut.sample(false, 1720));
  assert(!shortcut.sample(true, 2100));
  assert(!shortcut.sample(false, 2120));
  assert(shortcut.sample(true, 2300));
  assert(!shortcut.sample(false, 2320));

  // A title/session transition discards a half-complete gesture and ignores a
  // button already held across the transition until it is released.
  assert(!shortcut.sample(true, 2600));
  shortcut.reset(true);
  assert(!shortcut.sample(true, 2616));
  assert(!shortcut.sample(false, 2630));
  assert(!shortcut.sample(true, 2700));
  assert(!shortcut.sample(false, 2720));
  assert(shortcut.sample(true, 2900));
}

std::string hex(std::string_view value) {
  constexpr char digits[] = "0123456789abcdef";
  std::string result;
  result.reserve(value.size() * 2);
  for (const unsigned char byte : value) {
    result += digits[byte >> 4];
    result += digits[byte & 15];
  }
  return result;
}

void cheatPageChecks() {
  constexpr std::uint64_t now = 2'000'000;
  const std::string sessionId(32, 'a');
  const std::string token(64, 'b');
  const std::string profile(64, 'c');
  const std::string entry(64, 'd');
  const std::string session =
      "{\"schemaVersion\":1,\"session\":\"" + sessionId +
      "\",\"token\":\"" + token +
      "\",\"agentPid\":321,\"heartbeatAtUnixMs\":1999990}";

  CheatSession decodedSession;
  assert(decodeCheatSession(session, now, decodedSession));
  assert(decodedSession.session == sessionId && decodedSession.token == token &&
         decodedSession.agentPid == 321 &&
         decodedSession.heartbeatMs == 1'999'990);
  assert(!decodeCheatSession(session, now + cheatStateMaximumAgeMs + 1,
                            decodedSession));
  assert(!decodeCheatSession(session + " ", now, decodedSession));

  const std::string name = "Infinite & <Health>";
  const std::string description = "Exact title/version only";
  const std::string row =
      "C\t" + profile + "\t" + entry +
      "\tPPSA12345\t1.00\t" + hex("eboot.bin") +
      "\tVALID\tSERVER_APPROVED_HASH_DECLARED\t1\tREADY\t0\t" +
      hex(name) + "\t" + hex(description) + "\n";
  const std::string snapshot =
      "PS5LC1\t" + sessionId + "\t1999995\t1\t0\n" + row;

  CheatSnapshot decoded;
  assert(decodeCheatSnapshot(snapshot, sessionId, now, decoded));
  assert(decoded.rows.size() == 1 && decoded.rows[0].name == name &&
         decoded.rows[0].process == "eboot.bin" &&
         decoded.rows[0].installed && !decoded.rows[0].enabled &&
         decoded.available && cheatRowActionable(decoded.rows[0]));
  assert(!decodeCheatSnapshot(snapshot, std::string(32, 'f'), now, decoded));
  assert(!decodeCheatSnapshot(snapshot.substr(0, snapshot.size() - 2) +
                                 "z\n",
                             sessionId, now, decoded));

  const auto xml = buildCheatPage(decoded);
  assert(xml.find("PS5Library Cheats") != std::string::npos);
  assert(xml.find("Infinite &amp; &lt;Health&gt;") != std::string::npos);
  assert(xml.find(profile) == std::string::npos);
  assert(xml.find(entry) == std::string::npos);
  assert(xml.find("offset") == std::string::npos);
  assert(xml.find("id_ps5library_cheat_0") != std::string::npos);
  CheatSnapshot unavailable;
  assert(buildCheatPage(unavailable).find("PS5Library Agent unavailable") !=
         std::string::npos);
  auto blocked = decoded;
  blocked.rows[0].runtime = "HARDWARE_UNVERIFIED";
  const auto blockedXml = buildCheatPage(blocked);
  assert(blockedXml.find("id_ps5library_info_0") != std::string::npos);
  assert(blockedXml.find("id_ps5library_cheat_0") == std::string::npos);

  assert(cheatRowIndex("id_ps5library_cheat_0", 1) == 0);
  assert(!cheatRowIndex("id_ps5library_cheat_01", 2));
  assert(!cheatRowIndex("id_ps5library_cheat_1", 1));

  const auto request =
      buildCheatRequest(decodedSession, decoded.rows[0], true, false);
  assert(request.find("POST /api/v1/agent/cheats/" + profile + "/" + entry +
                      "/enable HTTP/1.1\r\n") == 0);
  assert(request.find("Authorization: Bearer " + token + "\r\n") !=
         std::string::npos);
  assert(request.find("X-PS5Library-Cheat-Session") == std::string::npos);
  assert(request.find("X-PS5Library-Cheat-Approval") == std::string::npos);
  auto unverified = decoded.rows[0];
  unverified.trust = "UNVERIFIED";
  const auto approved =
      buildCheatRequest(decodedSession, unverified, true, true);
  assert(approved.find("X-PS5Library-Cheat-Approval: " + profile + "\r\n") !=
         std::string::npos);
}

}  // namespace

int main() {
  patchChecks();
  stateChecks();
  optionsDoublePressChecks();
  cheatPageChecks();
}
