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
constexpr std::size_t liveWrapperSize = 0xb20;
constexpr std::size_t livePayloadSize = 0x152750;
constexpr std::size_t liveTitleOffset = 0x6ada0;
constexpr std::size_t liveAppErrorOffset = 0xa6a9e;
constexpr std::size_t liveNavigateOffset = 0x40359;
constexpr std::size_t liveOrderOffset = liveAppErrorOffset - 0xc7;
constexpr std::size_t liveSourceOffset = sourceOffset - 0x1c0;
constexpr std::size_t liveAliasOffset = liveSourceOffset + 0x2d4;
constexpr char oldOrder[] = "[\"Fps\",\"Search\",\"Settings\",\"Profile\"]";
constexpr char newOrder[] = "[\"Search\",\"App\",\"Settings\",\"Profile\"]";
constexpr char oldAlias[] = "t.Fps=P";
constexpr char newAlias[] = "t.App=h";
constexpr char oldSource[] =
    "var h=(0,u().memo)((function(){var e=(0,m.default)().sendClientApplicationErrorEvent;return u().default.createElement(d.default,{iconId:\"download_error\",onPress:function(){var t=new Error(\"homeui ApplicationErrorEvent test\");e({errorMessage:t.message,stack:t.stack,severity:\"info\"})},title:\"Trigger AppError\",__source:{fileName:_,lineNumber:80}})}));t.ApplicationErrorEventTrigger=h;";
constexpr char newSource[] =
    "var h=(0,u().memo)((function(){var e=(0,f.useInteractivePress)({link:\"PS5Library?Status=1\"});return u().default.createElement(d.default,{iconId:{uri:\"/user/appmeta/PPSA99051/icon0.png\"},onPress:e,title:\"\",__source:{fileName:_,lineNumber:80}})}));t.ApplicationErrorEventTrigger=h;";

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

std::vector<unsigned char> live450() {
  std::vector<unsigned char> data(liveWrapperSize + livePayloadSize);
  put(data, 0, "RNPSHEDR", 8);
  data[0x1c] = static_cast<unsigned char>(liveWrapperSize & 0xff);
  data[0x1d] = static_cast<unsigned char>((liveWrapperSize >> 8) & 0xff);
  auto* payload = data.data() + liveWrapperSize;
  const unsigned char magic[] = {0xe5, 0xd1, 0x0b, 0xfb};
  std::memcpy(payload, magic, sizeof(magic));
  std::memcpy(payload + liveTitleOffset, "NPXS40002", 9);
  std::memcpy(payload + liveAppErrorOffset,
              "ApplicationErrorEventTrigger", 28);
  std::memcpy(payload + liveNavigateOffset,
              "pshomeui:navigateToHome", 23);
  std::memcpy(payload + liveOrderOffset, oldOrder, sizeof(oldOrder) - 1);
  std::memcpy(payload + liveSourceOffset, oldSource, sizeof(oldSource) - 1);
  std::memcpy(payload + liveAliasOffset, oldAlias, sizeof(oldAlias) - 1);
  return data;
}

void patchChecks() {
  assert(isPatchResultValue(static_cast<int>(PatchResult::Applied)));
  assert(isPatchResultValue(static_cast<int>(PatchResult::AlreadyApplied)));
  assert(isPatchResultValue(static_cast<int>(PatchResult::Rejected)));
  assert(!isPatchResultValue(-1));
  assert(!isPatchResultValue(3));
  assert(!patchSucceeded(-1));
  assert(patchSucceeded(static_cast<int>(PatchResult::Applied)));
  assert(patchSucceeded(static_cast<int>(PatchResult::AlreadyApplied)));
  assert(!patchSucceeded(static_cast<int>(PatchResult::Rejected)));
  assert(mergePatchResult(static_cast<int>(PatchResult::Applied),
                          PatchResult::Rejected) ==
         static_cast<int>(PatchResult::Applied));
  assert(mergePatchResult(static_cast<int>(PatchResult::Rejected),
                          PatchResult::Applied) ==
         static_cast<int>(PatchResult::Applied));
  assert(mergePatchResult(-1, PatchResult::Rejected) ==
         static_cast<int>(PatchResult::Rejected));
  assert(!homeReloadDue(false, -1, 0, 1'000, 500));
  assert(!homeReloadDue(true, -1, 0, 499, 500));
  assert(homeReloadDue(true, -1, 0, 500, 500));
  assert(homeReloadDue(true, static_cast<int>(PatchResult::Rejected), 2,
                       1'000, 500));
  assert(!homeReloadDue(true, static_cast<int>(PatchResult::Applied), 0,
                        1'000, 500));
  assert(!homeReloadDue(true, -1, homeReloadAttemptLimit, 1'000, 500));

  auto observedPayload = pristine();
  const auto observed = observeHomeUi450451(observedPayload.data(),
                                              observedPayload.size());
  assert(observed.size == observedPayload.size());
  assert(observed.declaredPayloadOffset == missingHomeUiMarker);
  assert(observed.legacyMagicOffset == 0);
  assert(observed.titleOffset == titleOffset);
  assert(observed.titleCount == 1);
  assert(observed.appErrorOffset == appErrorOffset);
  assert(observed.appErrorCount == 2);
  assert(observed.navigateOffset == navigateOffset);
  assert(observed.navigateCount == 1);
  assert(observed.oldOrderOffset == orderOffset);
  assert(observed.oldOrderCount == 1);
  assert(observed.oldAliasOffset == aliasOffset);
  assert(observed.oldAliasCount == 1);
  assert(observed.oldSourceOffset == sourceOffset);
  assert(observed.oldSourceCount == 1);
  assert(observed.inferredPayloadOffset == 0);

  constexpr std::size_t observedWrapper = 0xb20;
  std::vector<unsigned char> observedWrapped(observedWrapper +
                                              observedPayload.size());
  put(observedWrapped, 0, "RNPSHEDR", 8);
  observedWrapped[0x1c] = static_cast<unsigned char>(observedWrapper & 0xff);
  observedWrapped[0x1d] =
      static_cast<unsigned char>((observedWrapper >> 8) & 0xff);
  std::memcpy(observedWrapped.data() + observedWrapper,
              observedPayload.data(), observedPayload.size());
  const auto wrappedObservation = observeHomeUi450451(
      observedWrapped.data(), observedWrapped.size());
  assert(wrappedObservation.rnpsHeader);
  assert(wrappedObservation.declaredPayloadOffset == observedWrapper);
  assert(wrappedObservation.legacyMagicOffset == observedWrapper);
  assert(wrappedObservation.titleOffset == observedWrapper + titleOffset);
  assert(wrappedObservation.inferredPayloadOffset == observedWrapper);

  const auto emptyObservation = observeHomeUi450451(nullptr, 0);
  assert(emptyObservation.size == 0);
  assert(!emptyObservation.rnpsHeader);
  assert(emptyObservation.titleOffset == missingHomeUiMarker);
  assert(emptyObservation.inferredPayloadOffset == missingHomeUiMarker);

  std::vector<unsigned char> unrelated(3'884'528);
  put(unrelated, 0, "RNPSHEDR", 8);
  unrelated[0x1c] = 0x20;
  const auto unrelatedOriginal = unrelated;
  const auto unrelatedObservation =
      observeHomeUi450451(unrelated.data(), unrelated.size());
  assert(unrelatedObservation.size == unrelated.size());
  assert(unrelatedObservation.rnpsHeader);
  assert(unrelatedObservation.declaredPayloadOffset == 0x20);
  assert(unrelatedObservation.titleOffset == missingHomeUiMarker);
  assert(unrelatedObservation.inferredPayloadOffset == missingHomeUiMarker);
  assert(unrelated == unrelatedOriginal);

  PatchFailure failure = PatchFailure::Container;
  auto data = pristine();
  assert(patchHomeUi450451(data.data(), data.size(), &failure) ==
         PatchResult::Applied);
  assert(failure == PatchFailure::None);
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
  assert(patchHomeUi450451(corrupt.data(), corrupt.size(), &failure) ==
         PatchResult::Rejected);
  assert(failure == PatchFailure::Alias);
  assert(corrupt == unchanged);

  auto shortInput = pristine();
  shortInput.resize(aliasOffset + sizeof(oldAlias) - 2);
  const auto shortOriginal = shortInput;
  assert(patchHomeUi450451(shortInput.data(), shortInput.size(), &failure) ==
         PatchResult::Rejected);
  assert(failure == PatchFailure::Container);
  assert(shortInput == shortOriginal);

  auto wrongTitle = pristine();
  wrongTitle[titleOffset] ^= 1;
  assert(patchHomeUi450451(wrongTitle.data(), wrongTitle.size(), &failure) ==
         PatchResult::Rejected);
  assert(failure == PatchFailure::Container);

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

  // Hardware 4.50 exposes an exact 0x153270 normalized live view whose
  // immutable markers moved independently. Mutable fields are accepted only
  // when their complete old/target preimages remain unique and coherent.
  auto live = live450();
  assert(patchHomeUi450451(live.data(), live.size(), &failure) ==
         PatchResult::Applied);
  assert(failure == PatchFailure::None);
  assert(!std::memcmp(live.data() + liveWrapperSize + liveOrderOffset,
                      newOrder, sizeof(newOrder) - 1));
  assert(!std::memcmp(live.data() + liveWrapperSize + liveAliasOffset,
                      newAlias, sizeof(newAlias) - 1));
  assert(!std::memcmp(live.data() + liveWrapperSize + liveSourceOffset,
                      newSource, sizeof(newSource) - 1));
  const auto liveApplied = live;
  assert(patchHomeUi450451(live.data(), live.size(), &failure) ==
         PatchResult::AlreadyApplied);
  assert(live == liveApplied);

  auto liveWithUnrelatedMarker = live450();
  put(liveWithUnrelatedMarker, liveWrapperSize + 0x1000,
      "ApplicationErrorEventTrigger", 28);
  assert(patchHomeUi450451(liveWithUnrelatedMarker.data(),
                           liveWithUnrelatedMarker.size(), &failure) ==
         PatchResult::Applied);
  assert(failure == PatchFailure::None);

  auto duplicateLiveIdentity = live450();
  put(duplicateLiveIdentity, liveWrapperSize + 0x100, "NPXS40002", 9);
  put(duplicateLiveIdentity, liveWrapperSize + 0x120,
      "pshomeui:navigateToHome", 23);
  auto duplicateLiveIdentityExpected = duplicateLiveIdentity;
  std::memcpy(duplicateLiveIdentityExpected.data() + liveWrapperSize +
                  liveOrderOffset,
              newOrder, sizeof(newOrder) - 1);
  std::memcpy(duplicateLiveIdentityExpected.data() + liveWrapperSize +
                  liveAliasOffset,
              newAlias, sizeof(newAlias) - 1);
  std::memcpy(duplicateLiveIdentityExpected.data() + liveWrapperSize +
                  liveSourceOffset,
              newSource, sizeof(newSource) - 1);
  std::memset(duplicateLiveIdentityExpected.data() + liveWrapperSize +
                  liveSourceOffset + sizeof(newSource) - 1,
              ' ', sizeof(oldSource) - sizeof(newSource));
  assert(patchHomeUi450451(duplicateLiveIdentity.data(),
                           duplicateLiveIdentity.size(), &failure) ==
         PatchResult::Applied);
  assert(failure == PatchFailure::None);
  assert(duplicateLiveIdentity == duplicateLiveIdentityExpected);

  auto mixedLive = live450();
  std::memcpy(mixedLive.data() + liveWrapperSize + liveOrderOffset,
              newOrder, sizeof(newOrder) - 1);
  assert(patchHomeUi450451(mixedLive.data(), mixedLive.size(), &failure) ==
         PatchResult::Applied);
  assert(failure == PatchFailure::None);
  assert(mixedLive == liveApplied);

  auto duplicateLiveAlias = live450();
  std::memcpy(duplicateLiveAlias.data() + liveWrapperSize + 0x200,
              oldAlias, sizeof(oldAlias) - 1);
  const auto duplicateLiveAliasOriginal = duplicateLiveAlias;
  assert(patchHomeUi450451(duplicateLiveAlias.data(),
                           duplicateLiveAlias.size(), &failure) ==
         PatchResult::Rejected);
  assert(failure == PatchFailure::Alias);
  assert(duplicateLiveAlias == duplicateLiveAliasOriginal);

  auto movedLiveAlias = live450();
  std::memset(movedLiveAlias.data() + liveWrapperSize + liveAliasOffset, 0,
              sizeof(oldAlias) - 1);
  std::memcpy(movedLiveAlias.data() + liveWrapperSize + liveAliasOffset + 1,
              oldAlias, sizeof(oldAlias) - 1);
  const auto movedLiveAliasOriginal = movedLiveAlias;
  assert(patchHomeUi450451(movedLiveAlias.data(), movedLiveAlias.size(),
                           &failure) == PatchResult::Rejected);
  assert(failure == PatchFailure::Alias);
  assert(movedLiveAlias == movedLiveAliasOriginal);

  auto invalidLiveTarget = liveApplied;
  invalidLiveTarget[liveWrapperSize + liveSourceOffset +
                    sizeof(newSource)] = 'x';
  const auto invalidLiveTargetOriginal = invalidLiveTarget;
  assert(patchHomeUi450451(invalidLiveTarget.data(),
                           invalidLiveTarget.size(), &failure) ==
         PatchResult::Rejected);
  assert(failure == PatchFailure::Source);
  assert(invalidLiveTarget == invalidLiveTargetOriginal);

  auto shortLive = live450();
  shortLive.pop_back();
  const auto shortLiveOriginal = shortLive;
  assert(patchHomeUi450451(shortLive.data(), shortLive.size(), &failure) ==
         PatchResult::Rejected);
  assert(failure == PatchFailure::Container);
  assert(shortLive == shortLiveOriginal);

  // Ignore a misleading wrapper candidate and locate the exact HomeUI
  // profile from its immutable markers at a different payload boundary.
  constexpr std::size_t relocatedWrapper = 0x1200;
  auto relocatedPayload = pristine();
  std::vector<unsigned char> relocated(
      relocatedWrapper + relocatedPayload.size() + 32);
  put(relocated, 0, "RNPSHEDR", 8);
  relocated[0x1c] = static_cast<unsigned char>(wrapper & 0xff);
  relocated[0x1d] = static_cast<unsigned char>((wrapper >> 8) & 0xff);
  const unsigned char magic[] = {0xe5, 0xd1, 0x0b, 0xfb};
  std::memcpy(relocated.data() + wrapper, magic, sizeof(magic));
  std::memcpy(relocated.data() + relocatedWrapper, relocatedPayload.data(),
              relocatedPayload.size());
  const auto relocatedObservation =
      observeHomeUi450451(relocated.data(), relocated.size());
  assert(relocatedObservation.declaredPayloadOffset == wrapper);
  assert(relocatedObservation.inferredPayloadOffset == relocatedWrapper);
  assert(patchHomeUi450451(relocated.data(), relocated.size(), &failure) ==
         PatchResult::Applied);
  assert(failure == PatchFailure::None);
  assert(!std::memcmp(relocated.data() + relocatedWrapper + aliasOffset,
                      newAlias, sizeof(newAlias) - 1));

  auto decoyPayload = pristine();
  std::vector<unsigned char> decoy(
      relocatedWrapper + decoyPayload.size() + 32);
  std::memcpy(decoy.data(), magic, sizeof(magic));
  std::memcpy(decoy.data() + relocatedWrapper, decoyPayload.data(),
              decoyPayload.size());
  const auto decoyObservation =
      observeHomeUi450451(decoy.data(), decoy.size());
  assert(decoyObservation.legacyMagicOffset == 0);
  assert(decoyObservation.inferredPayloadOffset == relocatedWrapper);
  assert(patchHomeUi450451(decoy.data(), decoy.size(), &failure) ==
         PatchResult::Applied);
  assert(failure == PatchFailure::None);

  constexpr std::size_t partialViewPrefix = 0x8e0;
  auto partialViewPayload = pristine();
  std::vector<unsigned char> partialView(
      partialViewPrefix + partialViewPayload.size());
  std::memcpy(partialView.data() + partialViewPrefix,
              partialViewPayload.data(), partialViewPayload.size());
  assert(patchHomeUi450451(partialView.data(), partialView.size(), &failure) ==
         PatchResult::Applied);
  assert(failure == PatchFailure::None);

  auto padded450 = pristine();
  padded450.resize(padded450.size() + 0x8e0);
  assert(patchHomeUi450451(padded450.data(), padded450.size(), &failure) ==
         PatchResult::Applied);
  assert(failure == PatchFailure::None);
  assert(!std::memcmp(padded450.data() + aliasOffset, newAlias,
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
  assert(startupAllowed(0x04500005, false, false));
  assert(startupAllowed(0x04510001, false, false));
  assert(!startupAllowed(0x04520000, false, false));
  assert(!startupAllowed(firmware451, true, false));
  assert(!startupAllowed(firmware451, false, true));
  assert(!processSnapshotShouldStop(0));
  assert(!processSnapshotShouldStop(processSnapshotFailureLimit - 1));
  assert(processSnapshotShouldStop(processSnapshotFailureLimit));
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
