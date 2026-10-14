#pragma once

#include "../common/client.hpp"
#include "../common/update.hpp"
#include "artwork.hpp"
#include "async.hpp"
#include "audio.hpp"
#include "collections.hpp"
#include "design.hpp"
#include "focus.hpp"
#include "input.hpp"
#include "lifecycle.hpp"
#include "render.hpp"
#include "video.hpp"
#include <SDL_image.h>
#include <atomic>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstring>
#include <ctime>
#include <fcntl.h>
#include <fstream>
#include <functional>
#include <regex>
#include <sys/file.h>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>

using namespace ps5library;
using namespace storefront;

#ifdef PS5LIBRARY_NATIVE
inline constexpr bool nativeFrontend = true;
#else
inline constexpr bool nativeFrontend = false;
#endif

#if defined(PS5LIBRARY_NATIVE) && defined(PS5)
extern "C" void native_stage(int);
#else
inline void native_stage(int) {
}
#endif

std::string amount(int64_t value);
std::string friendly(std::string text);
std::string lower(std::string text);
std::string list(const Json &array);
std::string saveDate(int64_t seconds);
SDL_Rect crop(const Json &value);
std::string localSession(const fs::path &config);

struct Options {
#ifdef PS5LIBRARY_NATIVE
  fs::path config = "/download0/ps5library/config.json";
#else
  fs::path config = "/data/ps5library/config.json";
#endif
  bool preview = false;
  int width = 1920, height = 1080, frames = 0;
  std::string screen = "Home", capture, script;
};

class Storefront {
  Options options_;
  Json config_, model_ = Json::object(), device_, plan_, localSnapshot_;
  std::string credential_, query_;
  SDL_Window *window_ = nullptr;
  SDL_Renderer *renderer_ = nullptr;
  std::unique_ptr<Canvas> canvas_;
  std::unique_ptr<Artwork> art_;
  std::unique_ptr<Input> input_;
  std::unique_ptr<UiAudio> audio_;
  std::unique_ptr<VideoPreview> video_;
  PreviewDelay previewDelay_, musicDelay_;
  std::string previewKey_, musicKey_;
  bool windowActive_ = true;
  Visibility visibility_;
  int profileSection_ = 0;
  bool serverLibrary_ = true;
  bool releaseAddons_ = false;
  size_t releasePage_ = 0;
  Json removal_, removalConsole_, formatStorage_, jobContext_;
  bool jobContextInstallation_ = false;
  SDL_Texture *backdropCache_ = nullptr;
  std::string backdropKey_, launchTitle_, settledBackdropKey_;
  Json settledBackdrop_;
  BackdropRequestGate backdropRequestGate_;
  Focus focus_;
  std::unordered_map<std::string, std::function<void()>> actions_;
  std::unordered_map<std::string, Rect> rects_;
  std::unordered_map<std::string, float> animation_, scroll_;
  std::unordered_map<std::string, std::string> screenFocus_;
  std::vector<ArtworkNeed> desiredImages_;
  std::vector<std::string> tabs_ = {"Home", "My Library", "Downloads", "My PS5"};
  std::string page_ = "Home", returnPage_, gameId_, homeGameId_, consoleId_, storageId_, method_,
              modal_, message_, heroUrl_, oldHero_, networkError_, agentPairingCode_,
              agentHardwareProof_, launchId_ = randomHex(16), selectPressedFocus_, reorderJobId_;
  size_t release_ = 0;
  bool offline_ = false, loading_ = true, serverConnected_ = false, advanced_ = false,
       backdropCacheEnabled_ = false, heroCrossfadeEnabled_ = false, localAgentSeen_ = false,
       selectPressed_ = false, reorderMode_ = false;
  float delta_ = 1.f / 60.f, heroMix_ = 1, navIndicatorX_ = -1;
  Uint32 toastUntil_ = 0, lastRefresh_ = 0, lastLocalRefresh_ = 0, lastLocalSnapshotSeen_ = 0,
         selectPressedAt_ = 0;
  int64_t localSnapshotRevision_ = 0;
  size_t downloadItemCount_ = 0;
  int modalStep_ = 0;
  std::vector<std::string> reorderIds_;
  std::atomic<bool> running_{true}, offlineMode_{false};
  std::thread agent_;
  AsyncWorker network_;
#if !defined(PS5LIBRARY_NATIVE) || !defined(PS5)
  AsyncWorker liveNetwork_;
  AsyncWorker::Result liveRequest_;
#endif
  AsyncWorker localNetwork_;
  AsyncWorker::Result request_, localAgentRequest_, localCommandRequest_;
  std::function<void(const Json &)> complete_, localCommandComplete_;
  std::atomic<bool> connected_{false};
  std::atomic<int> refreshStage_{0};
  std::atomic<bool> networkPaused_{false};
  bool setupInFlight_ = false, draftHttp_ = false, replaceDraft_ = false,
       localRequestOffline_ = false, localRequestConfigured_ = false, liveDirty_ = false;
  std::string draftServer_, draftFallback_, localRequestServer_, localRequestFallback_;
  int64_t liveCursor_ = 0;
  Uint32 liveRetryAt_ = 0;
  std::function<void()> pending_;
  uint64_t planRevision_ = 0;
  std::vector<double> frameTimes_;
  int backdropCompositions_ = 0;
  std::vector<std::string> script_;
  size_t scriptIndex_ = 0;
  int frameCount_ = 0;
  AsyncWorker::Result updateRequest_;
  Json updateEnvelope_, updateManifest_;
  std::string updateStatus_ = "Updates are checked automatically.";
  Uint32 lastUpdateCheck_ = 0;
  std::atomic<int64_t> updateBytes_{0}, updateTotal_{0};
  bool updating_ = false;
  int frontendLock_ = -1;
  Canvas &draw();
  Rect backdropRect() const;
  void wantArtwork(const std::string &url, Rect rect, SDL_Rect crop = {}, bool backdrop = false);
  Json catalog() const;
  Json consoles() const;
  Json jobs() const;
  Json installations() const;
  Json game(const std::string &id) const;
  Json gameForRelease(const std::string &id) const;
  Json gameForSourceRelease(const std::string &id) const;
  Json selectedRelease() const;
  Json selectedConsole() const;
  bool localConsoleSelected() const;
  std::string backgroundUrl(const Json &game) const;
  Json highlighted() const;
  Json heroGame() const;
  Json settledBackdrop(const Json &candidate);
  void preview();
  void ambientBackdrop();
  void togglePreference(const std::string &key);
  void avatar(Rect rect);
  bool ready(const Json &g) const;
  std::string playable(const Json &g, const Json &release) const;
  void toast(std::string text);
  void recordNetworkError(const Json &error);
  void navigate(std::string page);
  void openGame(const std::string &id);
  void closeModal();
  void search();
  void openOptions();
  bool openJobContext();
  static bool queuedJob(const Json &job);
  std::vector<std::string> queuedJobIds() const;
  bool focusedQueuedJob() const;
  Json orderedJobs() const;
  void moveQueuedJob(int direction);
  void finishQueueReorder();
  void cancelQueueReorder();
  void updateSelectHold();
  void activateFocused();
  void profile();
  void avatarModal();
  void networkSettings();
  void setOfflineMode(bool enabled);
  void appUpdate(bool install = false);
  void pumpUpdate();
  void startAgent();
  void resetArtwork();
  void saveNetwork(bool reset = false);
  bool textEvent(const SDL_Event &event);
  void request(const std::string &method, const std::string &url, const Json &body,
               std::function<void(const Json &)> complete);
  void localCommand(const std::string &url, std::function<void(const Json &)> complete);
  void refresh();
#if defined(PS5LIBRARY_NATIVE) && defined(PS5)
  void pumpLive();
#else
  void startLive();
  void pumpLive();
#endif
  void applyLocalSnapshot(const Json &value);
  void observeLocalSnapshot(const Json &value);
  void refreshLocal();
  void pump();
  void button(std::string id, std::string title, Rect rect, int row, std::function<void()> callback,
              bool primary = false, bool enabled = true, bool selected = false, bool plain = false,
              const std::string &icon = "");
  void title(const std::string &text, const std::string &subtitle = "");
  void badge(const std::string &text, Rect rect);
  void gameImage(const Json &g, Rect rect, bool hero = false, Uint8 opacity = 255);
  void background(const Json &game);
  void navigation();
  void card(const Json &g, Rect rect, int row, const std::string &id);
  void rail(const std::string &name, const std::vector<Json> &games, float y, int row);
  std::vector<Json> games(const std::function<bool(const Json &)> &filter = {}) const;
  std::vector<Json> libraryGames() const;
  void homePage();
  void libraryPage();
  void details();
  void downloadJobs();
  void myPS5();
  void optionsModal();
  void networkModal();
  void plan(const std::string &method = "");
  void installReview();

  void searchModal();
  void removalModal();
  void moveModal();
  void formatStorageModal();
  void jobContextModal();
  void footer();
  void action(Action a);

public:
  explicit Storefront(Options options);
  ~Storefront();
  std::string launchTitle() const;
  void run();
};
