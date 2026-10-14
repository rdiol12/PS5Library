#include "storefront.hpp"

Canvas &Storefront::draw() {
  return *canvas_;
}
Rect Storefront::backdropRect() const {
  return backdropMode(page_) != 'L'
             ? Rect{0, 0, Tokens::width, Tokens::height}
             : Rect{Tokens::width * .25f, 0, Tokens::width * .75f,
                    std::ceil(Tokens::heroBottom + Tokens::cardHeight * .35f)};
}
void Storefront::wantArtwork(const std::string &url, Rect rect, SDL_Rect crop, bool backdrop) {
  desiredImages_.push_back(backdrop ? backdropArtworkNeed(url, rect.w, rect.h, crop.w, crop.h)
                                    : foregroundArtworkNeed(url, rect.w, rect.h, crop.w, crop.h));
}
Json Storefront::catalog() const {
  return model_["catalog"];
}
Json Storefront::consoles() const {
  auto all = model_["consoles"], result = Json::array();
  for (size_t i = 0; i < all.size(); i++)
    result.add(withLocalConsoleState(all[i], localSnapshot_, localAgentSeen_,
                                     device_["consoleId"].string()));
  return result;
}
Json Storefront::jobs() const {
  return model_["jobs"];
}
Json Storefront::installations() const {
  return model_["installations"];
}
Json Storefront::game(const std::string &id) const {
  auto all = catalog();
  for (size_t i = 0; i < all.size(); i++)
    if (all[i]["id"].string() == id)
      return all[i];
  return Json();
}
Json Storefront::gameForRelease(const std::string &id) const {
  for (const auto &item : games()) {
    auto releases = item["releases"];
    for (size_t n = 0; n < releases.size(); n++)
      if (releases[n]["id"].string() == id)
        return item;
  }
  return Json();
}
Json Storefront::gameForSourceRelease(const std::string &id) const {
  for (const auto &item : games()) {
    auto releases = item["releases"];
    for (size_t n = 0; n < releases.size(); n++) {
      auto sources = releases[n]["sources"];
      for (size_t source = 0; source < sources.size(); source++)
        if (sources[source]["id"].string() == id)
          return item;
    }
  }
  return Json();
}
Json Storefront::selectedRelease() const {
  return game(gameId_)["releases"][release_];
}
Json Storefront::selectedConsole() const {
  return consoleById(consoles(), consoleId_);
}
bool Storefront::localConsoleSelected() const {
  return selectedConsoleIsLocal(localAgentSeen_, device_, selectedConsole());
}
std::string Storefront::backgroundUrl(const Json &game) const {
  auto hero = game["heroUrl"].string();
  return hero.empty() ? game["coverUrl"].string() : hero;
}
Json Storefront::highlighted() const {
  if (!modal_.empty())
    return Json();
  if (page_ == "Game")
    return game(gameId_);
  const auto id = focus_.id();
  if (id.rfind("rail", 0) == 0 || id.rfind("grid:", 0) == 0 || id.rfind("home:", 0) == 0)
    return game(id.substr(id.find(':') + 1));
  return Json();
}
Json Storefront::heroGame() const {
  const auto selected = highlighted();
  if (!selected.null())
    return selected;
  if (page_ == "Game")
    return game(gameId_);
  if (page_ == "Home")
    return game(homeGameId_);
  return Json();
}
Json Storefront::settledBackdrop(const Json &candidate) {
  auto url = backgroundUrl(candidate), key = url + candidate["heroCrop"].dump();
  if (url.empty()) {
    settledBackdrop_ = Json();
    settledBackdropKey_.clear();
    backdropRequestGate_.reset();
    return Json();
  }
  if (settledBackdrop_.null() || key == settledBackdropKey_) {
    settledBackdrop_ = candidate;
    settledBackdropKey_ = key;
    backdropRequestGate_.reset();
    return settledBackdrop_;
  }
  auto *cached = art_->get(url);
  if (backdropRequestGate_.requestable(key, cached, SDL_GetTicks64())) {
    if (cached) {
      settledBackdrop_ = candidate;
      settledBackdropKey_ = key;
      backdropRequestGate_.reset();
      return settledBackdrop_;
    }
    wantArtwork(url, backdropRect(), crop(candidate["heroCrop"]), true);
  }
  return settledBackdrop_;
}
void Storefront::preview() {
  auto g = highlighted(), trailer = g["trailer"], music = g["music"];
  std::string key, musicKey;
  if (!options_.preview && windowActive_) {
    const bool server = !credential_.empty() || offlineMode_;
    if (server && (config_["autoplayTrailers"].null() || config_["autoplayTrailers"].boolean()) &&
        !trailer.null())
      key = page_ + ":" + g["id"].string() + ":" + trailer["sha256"].string();
    if ((config_["gameMusic"].null() || config_["gameMusic"].boolean()) && server && !music.null())
      musicKey = page_ + ":" + g["id"].string() + ":" + music["sha256"].string();
  }
  if (key != previewKey_ || musicKey != musicKey_) {
    video_->stop();
    previewKey_ = key;
    musicKey_ = musicKey;
  }
  const auto now = SDL_GetTicks64();
  bool startMusic = musicDelay_.ready(musicKey, now, 650),
       startTrailer = previewDelay_.ready(key, now);
  if (startTrailer) {
    audio_->ambient(false);
    video_->start(key, config_, credential_, trailer,
                  config_["trailerSound"].null() || config_["trailerSound"].boolean(), false,
                  offline_);
  } else if (startMusic && !video_->active()) {
    audio_->ambient(false);
    video_->start(musicKey, config_, credential_, music, true, true, offline_);
  }
  audio_->ambient(windowActive_ &&
                  (config_["gameMusic"].null() || config_["gameMusic"].boolean()) &&
                  !video_->active());
}
void Storefront::ambientBackdrop() {
  const float time = SDL_GetTicks64() / 1000.f;
  constexpr SDL_Color colors[] = {{74, 169, 255, 24}, {155, 93, 255, 20}, {255, 92, 174, 16}};
  for (int band = 0; band < 3; band++) {
    SDL_FPoint points[36];
    for (int part = 0; part < 36; part++)
      points[part] = {part * Tokens::width / 35,
                      260 + band * 210 +
                          std::sin(part * .31f + time * (.16f + band * .035f) + band) * 48};
    draw().lineStrip(points, 36, colors[band]);
  }
}
void Storefront::togglePreference(const std::string &key) {
  auto next = config_.deepCopy();
  next.set(key.c_str(), !(next[key.c_str()].null() || next[key.c_str()].boolean()));
  try {
    if (!options_.preview)
      atomicJson(options_.config, next);
    config_ = next;
  } catch (...) {
    toast("Could not save the setting.");
  }
}
void Storefront::avatar(Rect rect) {
  auto data = model_["profile"];
  auto url = data["avatarUrl"].string();
  auto source = crop(data["avatarCrop"]);
  wantArtwork(url, rect, source);
  auto *texture = art_->get(url);
  if (texture) {
    source = art_->scaledCrop(url, source);
    draw().cover(texture, rect, source.w > 0 ? &source : nullptr, 255, rect.w / 2);
  } else {
    draw().rounded(rect, {32, 53, 77, 255}, rect.w / 2);
    auto name = data["username"].string("P");
    int size = rect.w > 80 ? Tokens::title : Tokens::caption;
    draw().label(name.substr(0, 1), rect.cx() - draw().measure(name.substr(0, 1), size) / 2,
                 rect.cy() - size * .62f, size, Tokens::white);
  }
  draw().edge(rect, {66, 161, 231, 235}, rect.w / 2, 1.7f);
}
bool Storefront::ready(const Json &g) const {
  auto releases = g["releases"], library = model_["library"];
  for (size_t i = 0; i < releases.size(); i++)
    for (size_t j = 0; j < library.size(); j++)
      if (releases[i]["kind"].string() != "DLC" &&
          library[j]["releaseId"].string() == releases[i]["id"].string() &&
          library[j]["state"].string() == "READY_ON_PS5")
        return true;
  return false;
}
std::string Storefront::playable(const Json &g, const Json &release) const {
  return consoleId_ != device_["consoleId"].string() ||
                 (nativeFrontend ? !localAgentSeen_
                                 : (offline_ || config_["launcherUrl"].string().empty()))
             ? ""
             : launchableRelease(g, release, model_["library"]);
}
void Storefront::toast(std::string text) {
  message_ = std::move(text);
  toastUntil_ = SDL_GetTicks() + 6500;
}
void Storefront::recordNetworkError(const Json &error) {
#if defined(PS5LIBRARY_NATIVE) && defined(PS5)
  auto text = error.string();
  if (text != networkError_) {
    networkError_ = text;
    native_error(text.c_str());
  }
#else
  (void)error;
#endif
}
void Storefront::navigate(std::string page) {
  if (offlineMode_ && !offlinePageEnabled(page))
    page = "Home";
  screenFocus_[page_] = focus_.id();
  page_ = std::move(page);
  focus_.select(screenFocus_.count(page_) ? screenFocus_[page_] : "first-card");
  modal_.clear();
  SDL_StopTextInput();
}
void Storefront::openGame(const std::string &id) {
  screenFocus_[page_] = focus_.id();
  returnPage_ = page_;
  gameId_ = id;
  release_ = 0;
  page_ = "Game";
  modal_.clear();
  SDL_StopTextInput();
  focus_.select("download");
  plan_ = Json();
}
void Storefront::closeModal() {
  modal_.clear();
  focus_.select(screenFocus_["before-modal"]);
  SDL_StopTextInput();
}
void Storefront::search() {
  screenFocus_["before-modal"] = focus_.id();
  modal_ = "Search";
  focus_.select("search-input");
  SDL_StartTextInput();
}
void Storefront::openOptions() {
  if (modal_ == "Options")
    closeModal();
  else if (modal_.empty() && !openJobContext()) {
    screenFocus_["before-modal"] = focus_.id();
    modal_ = "Options";
    focus_.select("network");
  }
}
bool Storefront::openJobContext() {
  if (page_ != "Downloads" || !modal_.empty())
    return false;
  jobContextInstallation_ = focus_.id().rfind("installation:", 0) == 0;
  const auto prefix = jobContextInstallation_ ? 13 : 4;
  if (!jobContextInstallation_ && focus_.id().rfind("job:", 0) != 0)
    return false;
  auto list = jobContextInstallation_ ? installations() : jobs();
  for (size_t i = 0; i < list.size(); i++)
    if (list[i]["id"].string() == focus_.id().substr(prefix)) {
      jobContext_ = list[i];
      screenFocus_["before-modal"] = focus_.id();
      modal_ = "JobContext";
      auto g = jobContextInstallation_
                   ? gameForSourceRelease(jobContext_["sourceReleaseId"].string())
                   : gameForRelease(jobContext_["releaseId"].string());
      auto state = jobContext_["state"].string();
      const bool terminal = state == "COMPLETED" || state == "READY_ON_PS5" || state == "ERROR" ||
                            state == "CANCELLED";
      focus_.select(jobContextInstallation_ ? "installation-cancel"
                    : !terminal             ? "job-cancel"
                    : state == "ERROR"      ? "job-retry"
                    : g.null()              ? "job-close"
                                            : "job-open");
      return true;
    }
  return false;
}
bool Storefront::queuedJob(const Json &job) {
  const auto kind = job["kind"].string();
  return job["state"].string() == "QUEUED" && (kind == "DOWNLOAD" || kind == "BUILD");
}
std::vector<std::string> Storefront::queuedJobIds() const {
  std::vector<std::string> ids;
  auto all = jobs();
  for (size_t i = 0; i < all.size(); i++)
    if (queuedJob(all[i]))
      ids.push_back(all[i]["id"].string());
  return ids;
}
bool Storefront::focusedQueuedJob() const {
  if (page_ != "Downloads" || !modal_.empty() || focus_.id().rfind("job:", 0) != 0)
    return false;
  const auto id = focus_.id().substr(4);
  auto all = jobs();
  for (size_t i = 0; i < all.size(); i++)
    if (all[i]["id"].string() == id)
      return queuedJob(all[i]);
  return false;
}
Json Storefront::orderedJobs() const {
  auto source = jobs(), result = Json::array();
  size_t queued = 0;
  for (size_t i = 0; i < source.size(); i++) {
    if (!queuedJob(source[i]) || queued >= reorderIds_.size()) {
      result.add(source[i]);
      continue;
    }
    Json replacement;
    for (size_t n = 0; n < source.size(); n++)
      if (source[n]["id"].string() == reorderIds_[queued]) {
        replacement = source[n];
        break;
      }
    result.add(replacement.null() ? source[i] : replacement);
    queued++;
  }
  return result;
}
void Storefront::moveQueuedJob(int direction) {
  auto found = std::find(reorderIds_.begin(), reorderIds_.end(), reorderJobId_);
  if (found == reorderIds_.end())
    return;
  auto index = static_cast<int>(found - reorderIds_.begin()), next = index + direction;
  if (next < 0 || next >= static_cast<int>(reorderIds_.size()))
    return;
  std::swap(reorderIds_[static_cast<size_t>(index)], reorderIds_[static_cast<size_t>(next)]);
  audio_->play(Cue::Move);
}
void Storefront::finishQueueReorder() {
  auto ids = Json::array();
  for (const auto &id : reorderIds_)
    ids.add(id);
  model_.set("jobs", orderedJobs());
  reorderMode_ = false;
  selectPressed_ = false;
  selectPressedFocus_.clear();
  reorderJobId_.clear();
  reorderIds_.clear();
  request("POST", "/api/v1/device/jobs/reorder", Json::object({{"ids", ids}}),
          [this](const Json &) {
            lastRefresh_ = 0;
            toast("Queue order saved");
          });
}
void Storefront::cancelQueueReorder() {
  reorderMode_ = false;
  selectPressed_ = false;
  selectPressedFocus_.clear();
  reorderJobId_.clear();
  reorderIds_.clear();
  toast("Queue order unchanged");
}
void Storefront::updateSelectHold() {
  if (!selectPressed_ || reorderMode_ || focus_.id() != selectPressedFocus_ ||
      SDL_GetTicks() - selectPressedAt_ < 450)
    return;
  auto ids = queuedJobIds();
  if (ids.size() < 2)
    return;
  reorderIds_ = std::move(ids);
  reorderJobId_ = selectPressedFocus_.substr(4);
  reorderMode_ = true;
  audio_->play(Cue::Select);
}
void Storefront::activateFocused() {
  auto found = actions_.find(focus_.id());
  if (found != actions_.end()) {
    auto callback = found->second;
    callback();
    audio_->play(Cue::Select);
  }
}
void Storefront::networkSettings() {
  if (updateRequest_.valid()) {
    toast("Finish the app update request before changing servers.");
    return;
  }
  screenFocus_["before-modal"] = focus_.id();
  draftServer_ = config_["serverUrl"].string();
  draftFallback_ = config_["fallbackServerUrl"].string();
  draftHttp_ = config_["allowInsecureLan"].boolean();
  replaceDraft_ = true;
  modal_ = "Network";
  focus_.select("server-input");
  SDL_StartTextInput();
}
void Storefront::setOfflineMode(bool enabled) {
  if (updateRequest_.valid()) {
    toast("Finish the app update before changing offline mode.");
    return;
  }
  try {
    if (!options_.preview)
      atomicJson(options_.config.parent_path() / "offline-mode.json", Json(enabled));
  } catch (...) {
    toast("Could not save offline mode.");
    return;
  }
  offlineMode_ = enabled;
  lastLocalRefresh_ = 0;
  video_->stop();
  art_->offline(enabled || offline_);
  if (enabled) {
    offline_ = true;
    serverConnected_ = false;
    loading_ = false;
    serverLibrary_ = false;
    navigate("Home");
    lastLocalRefresh_ = 0;
    toast("Offline mode uses this PS5 and makes no server requests.");
    return;
  }
  localAgentSeen_ = false;
  art_->offline(offline_);
  startAgent();
  lastRefresh_ = 0;
  refresh();
  toast("Reconnecting to your server...");
}
void Storefront::appUpdate(bool install) {
  if (options_.preview || offlineMode_ || credential_.empty() || networkPaused_ ||
      updateRequest_.valid())
    return;
#ifdef PS5LIBRARY_NATIVE
  if (install) {
    if (!localAgentSeen_) {
      updateStatus_ = "PS5Library Agent is required to install this update.";
      return;
    }
    const auto base = updateManifest_["baseContentVersion"].string();
    if (base.empty()) {
      updateStatus_ = "The published update is missing its base version.";
      return;
    }
    updateStatus_ = "Starting the native PS5 download...";
    localCommand("/api/v1/agent/app-update/" + std::string(nativeTitleId) + "/" + base,
                 [this](const Json &) { updateStatus_ = "Update started in PS5 Downloads."; });
    return;
  }
#endif
  lastUpdateCheck_ = SDL_GetTicks();
  updating_ = install;
  updateStatus_ = install ? "Downloading verified app update..." : "Checking for updates...";
  updateBytes_ = 0;
  updateTotal_ = install ? updateManifest_["size"].number() : 0;
  auto configuration = config_.dump(), token = credential_, envelope = updateEnvelope_.dump();
  auto root = options_.config.parent_path() / "updates";
  updateRequest_ = network_.submit([this, configuration, token, envelope, root, install] {
    try {
      Client client(Json::parse(configuration));
      client.credential = token;
      client.cancelled = [this] { return !running_; };
      if (!install) {
#ifdef PS5LIBRARY_NATIVE
        auto release = client.request("GET", "/api/v1/device/native-updates");
        if (release.null() || release["contentVersion"].string() <= nativeContentVersion)
          return Json::object({{"status", "PS5Library is up to date."}});
        if (release["baseContentVersion"].string().empty())
          throw std::runtime_error("Published update has no base version");
        return Json::object(
            {{"manifest", release},
             {"status", "Native update " + release["contentVersion"].string() + " is available."}});
#else
        auto release = client.request("GET", "/api/v1/device/updates");
        if (release.null())
          return Json::object({{"status", "No update published by your server."}});
        auto manifest = verifyUpdate(release, updatePublicKey(), 0);
        if (manifest["build"].number() <= appBuild)
          return Json::object({{"status", "PS5Library is up to date."}});
        return Json::object(
            {{"envelope", release},
             {"manifest", manifest},
             {"status", "Version " + manifest["version"].string() + " is available."}});
#endif
      }
#ifndef PS5LIBRARY_NATIVE
      auto manifest = verifyUpdate(Json::parse(envelope), updatePublicKey(), appBuild);
      auto file = downloadUpdate(client, root, manifest,
                                 [this](int64_t bytes, int64_t) { updateBytes_ = bytes; });
#ifdef PS5
      if (root != fs::path("/data/ps5library/updates"))
        throw std::runtime_error("Automatic installation requires the "
                                 "standard PS5Library location");
      // websrv passes args as the complete argv, including the program name.
      loaderRequest(Json::parse(configuration)["launcherUrl"].string(),
                    "/elfldr?elf=" + file.string() +
                        "&cwd=/data/"
                        "ps5library&args=ps5library-install%20--update&pipe=0");
      return Json::object({{"restart", true}});
#else
      return Json::object({{"status", "Update verified. Installation requires a PS5."}});
#endif
#else
      return Json::object({{"status", "Exit to Home, highlight PS5Library, press Options, "
                                      "then Check for Update."}});
#endif
    } catch (const std::exception &e) {
      return Json::object({{"error", e.what()}});
    }
  });
}
void Storefront::pumpUpdate() {
  if (updateRequest_.valid() &&
      updateRequest_.wait_for(std::chrono::seconds(0)) == AsyncWorker::Status::ready) {
    auto result = AsyncWorker::take(updateRequest_);
    const bool checked = !updating_;
    updating_ = false;
    if (result["restart"].boolean()) {
      running_ = false;
      return;
    }
    if (!result["error"].null())
      updateStatus_ = result["error"].string();
    else {
      updateStatus_ = result["status"].string();
      if (!result["manifest"].null()) {
        updateManifest_ = result["manifest"];
        updateEnvelope_ = result["envelope"];
        toast(updateStatus_ + " Open Settings to update.");
      } else if (checked) {
        updateManifest_ = Json();
        updateEnvelope_ = Json();
      }
    }
  }
  if (!options_.preview && !offlineMode_ && !networkPaused_ && !credential_.empty() &&
      (!lastUpdateCheck_ || SDL_GetTicks() - lastUpdateCheck_ > 6 * 60 * 60 * 1000))
    appUpdate();
}
void Storefront::startAgent() {
#ifndef PS5LIBRARY_NATIVE
  if (options_.preview || config_["serverUrl"].string().empty() || agent_.joinable())
    return;
  agent_ = std::thread([this] {
    int lock = open((options_.config.parent_path() / "agent.lock").c_str(),
                    O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
    if (lock < 0 || flock(lock, LOCK_EX | LOCK_NB) != 0) {
      if (lock >= 0)
        close(lock);
      return;
    }
    try {
      Agent agent(options_.config);
      while (running_ && !networkPaused_) {
        const bool local = offlineMode_;
        agent.client.cancelled = [this, local] {
          return !running_ || networkPaused_ || offlineMode_ != local;
        };
        try {
          if (!local)
            agent.tick();
        } catch (const std::exception &e) {
          if (running_ && !networkPaused_)
            std::fprintf(stderr, "Agent: %s\n", e.what());
        }
        const int waitTicks = (local ? 5 : agent.heartbeatIntervalSeconds()) * 10;
        for (int i = 0; i < waitTicks && running_ && !networkPaused_ && offlineMode_ == local; i++)
          std::this_thread::sleep_for(std::chrono::milliseconds(100));
      }
    } catch (const std::exception &e) {
      std::fprintf(stderr, "Agent setup: %s\n", e.what());
    }
    close(lock);
  });
#endif
  // A native title's sandbox cannot authoritatively scan the console.
  // Inventory and transfers belong to the separately running, paired payload
  // agent.
}
void Storefront::resetArtwork() {
  art_ = std::make_unique<Artwork>(config_, options_.config.parent_path() / "artwork-cache",
                                   options_.preview);
  art_->credentials(credential_);
  art_->offline(offlineMode_ || offline_);
}
void Storefront::saveNetwork(bool reset) {
  if (options_.preview) {
    toast("Design preview — connection settings are not saved.");
    return;
  }
  std::string url, fallback;
  try {
    url = normalizeServerUrl(draftServer_, draftHttp_);
    if (!draftFallback_.empty())
      fallback = normalizeServerUrl(draftFallback_, draftHttp_);
    if (fallback == url)
      fallback.clear();
  } catch (const std::exception &e) {
    toast(e.what());
    return;
  }
  if (offlineMode_)
    try {
      atomicJson(options_.config.parent_path() / "offline-mode.json", Json(false));
      offlineMode_ = false;
      art_->offline(false);
    } catch (...) {
      toast("Could not leave offline mode.");
      return;
    }
  networkPaused_ = true;
  SDL_StopTextInput();
  complete_ = {};
  auto file = options_.config;
  bool http = draftHttp_;
  pending_ = [this, file, url, fallback, http, reset] {
    setupInFlight_ = true;
    complete_ = [this](const Json &value) {
      config_ = value["config"];
      device_ = value["device"];
      credential_ = device_["credential"].string();
      consoleId_ = device_["consoleId"].string();
      agentHardwareProof_.clear();
      model_ = Json::object();
      plan_ = Json();
      gameId_.clear();
      heroUrl_.clear();
      oldHero_.clear();
      settledBackdrop_ = Json();
      settledBackdropKey_.clear();
      backdropRequestGate_.reset();
      scroll_.clear();
      updateManifest_ = Json();
      updateEnvelope_ = Json();
      lastUpdateCheck_ = 0;
      lastLocalRefresh_ = 0;
      liveCursor_ = 0;
      liveRetryAt_ = 0;
      liveDirty_ = false;
      resetArtwork();
      setupInFlight_ = false;
      networkPaused_ = false;
      loading_ = true;
      offline_ = false;
      serverConnected_ = false;
      serverLibrary_ = true;
      closeModal();
      navigate("My Library");
      startAgent();
      lastRefresh_ = 0;
    };
    request_ = network_.submit([this, file, url, fallback, http, reset] {
      if (agent_.joinable())
        agent_.join();
      art_->stop();
      try {
        auto config = saveServerSettings(file, url, http, reset, fallback);
        return Json::object(
            {{"result",
              Json::object({{"config", config}, {"device", loadDeviceState(file, config)}})}});
      } catch (const PairingResetRequired &e) {
        return Json::object({{"error", e.what()}, {"pairingResetRequired", true}});
      } catch (const std::exception &e) {
        return Json::object({{"error", e.what()}});
      }
    });
  };
}
bool Storefront::textEvent(const SDL_Event &event) {
  bool network =
      modal_ == "Network" && (focus_.id() == "server-input" || focus_.id() == "fallback-input");
  if (networkPaused_ || (!network && modal_ != "Search"))
    return false;
  if (event.type == SDL_KEYDOWN && event.key.keysym.sym == SDLK_RETURN &&
      (network || focus_.id() == "search-input")) {
    SDL_StopTextInput();
    if (network)
      focus_.select(focus_.id() == "server-input" ? "fallback-input" : "allow-http");
    else
      focus_.move(Direction::Down);
    return true;
  }
  auto &value =
      network ? (focus_.id() == "fallback-input" ? draftFallback_ : draftServer_) : query_;
  if (event.type == SDL_TEXTINPUT) {
    if (network && replaceDraft_) {
      value.clear();
      replaceDraft_ = false;
    }
    if (value.size() + std::strlen(event.text.text) <= (network ? 2048 : 200))
      value += event.text.text;
    return true;
  }
  if (event.type == SDL_KEYDOWN && event.key.keysym.sym == SDLK_BACKSPACE) {
    replaceDraft_ = false;
    eraseLastCharacter(value);
    return true;
  }
  return false;
}
void Storefront::request(const std::string &method, const std::string &url, const Json &body,
                         std::function<void(const Json &)> complete) {
  if (offlineMode_) {
    toast("This action needs your PS5Library server.");
    return;
  }
  if (networkPaused_)
    return;
  if (options_.preview) {
    toast("Design preview — connect to your server to perform this action.");
    return;
  }
  if (request_.valid()) {
    if (!pending_)
      pending_ = [this, method, url, body, complete = std::move(complete)]() mutable {
        request(method, url, body, std::move(complete));
      };
    else
      toast("Finishing the current request…");
    return;
  }
  auto configuration = config_.dump(), payload = body.dump(), token = credential_;
  complete_ = std::move(complete);
  request_ = network_.submit([this, configuration, payload, token, method, url] {
    try {
      Client client(Json::parse(configuration));
      client.cancelled = [this] { return !running_ || networkPaused_ || offlineMode_; };
      client.credential = token;
      return Json::object({{"result", client.request(method, url, Json::parse(payload))}});
    } catch (const RequestError &e) {
      return Json::object({{"error", e.what()}, {"serverReachable", true}});
    } catch (const std::exception &e) {
      return Json::object({{"error", e.what()}});
    }
  });
}
void Storefront::localCommand(const std::string &url, std::function<void(const Json &)> complete) {
  if (localCommandRequest_.valid()) {
    toast("A console action is already running.");
    return;
  }
  localCommandComplete_ = std::move(complete);
  localCommandRequest_ = localNetwork_.submit([url] {
    try {
      return Json::object({{"result", localAgentRequest("POST", url)}});
    } catch (const std::exception &e) {
      return Json::object({{"error", e.what()}});
    }
  });
}
void Storefront::refresh() {
  if (options_.preview || offlineMode_ || request_.valid() || networkPaused_ ||
      config_["serverUrl"].string().empty())
    return;
  lastRefresh_ = SDL_GetTicks();
  auto config = config_.dump();
  auto file = options_.config;
  auto console = consoleId_, agentPairingCode = agentPairingCode_;
  std::string presence = windowActive_ ? "ONLINE" : "AWAY";
  complete_ = [this](const Json &value) {
    device_ = value["device"];
    credential_ = device_["credential"].string();
    art_->credentials(credential_);
    if (!value["catalog"].null()) {
      model_ = value;
      offline_ = false;
      art_->offline(false);
      loading_ = false;
      consoleId_ =
          consoleSelectionAfterServerRefresh(consoles(), consoleId_, device_["consoleId"].string());
      try {
        auto cached = value.deepCopy();
        cached.set("device", Json::object({{"consoleId", device_["consoleId"]}}));
        cached.set("serverUrl", config_["serverUrl"]);
        atomicJson(options_.config.parent_path() / "catalog-cache.json", cached);
      } catch (...) {
      }
    }
  };
  request_ = network_.submit([this, config, file, console, agentPairingCode, presence] {
    std::string token;
    try {
      refreshStage_ = 1;
      auto configuration = Json::parse(config);
#ifdef PS5LIBRARY_NATIVE
      auto device = pairFrontend(file, configuration,
                                 [this] { return !running_ || networkPaused_ || offlineMode_; });
#else
      auto device = loadDeviceState(file, configuration);
#endif
      auto value = Json::object({{"device", device}});
      token = device["credential"].string();
      if (!token.empty()) {
        Client client(configuration);
        client.cancelled = [this] { return !running_ || networkPaused_ || offlineMode_; };
        client.credential = token;
        if (!agentPairingCode.empty())
          try {
            client.request("POST", "/api/v1/pairings/claim",
                           Json::object({{"code", agentPairingCode}}));
          } catch (const RequestError &e) {
            if (!(e.status == 410 ||
                  (e.status == 409 && std::string(e.what()) == "PAIRING_ALREADY_CLAIMED")))
              throw;
          }
        refreshStage_ = 2;
        auto own = client.request("GET", "/api/v1/device/status");
        connected_ = true;
        refreshStage_ = 3;
        value.set("catalog", client.request("GET", "/api/v1/device/catalog"));
        refreshStage_ = 5;
        value.set("jobs", client.request("GET", "/api/v1/device/jobs"));
        try {
          value.set("installations", client.request("GET", "/api/v1/device/installations"));
        } catch (const RequestError &e) {
          if (e.status != 404)
            throw;
          value.set("installations", Json::array());
        }
        refreshStage_ = 6;
        auto owned = client.request("GET", "/api/v1/device/consoles");
        value.set("consoles", owned);
        value.set("status", own);
        refreshStage_ = 7;
        try {
          value.set("profile", client.request("GET", "/api/v1/device/profile"));
        } catch (const RequestError &e) {
          if (e.status != 404)
            throw;
        }
        refreshStage_ = 8;
        auto selected = consoleSelectionAfterServerRefresh(owned, console, own["id"].string());
        value.set("library",
                  selected == own["id"].string()
                      ? own["library"]
                      : client.request("GET", "/api/v1/device/consoles/" + selected + "/library"));
        try {
          auto account = client.request("GET", "/api/v1/device/community/account");
          value.set("communityAccount", account);
          if (account["state"].string() == "CONNECTED") {
            client.request("PUT", "/api/v1/device/community/presence",
                           Json::object({{"state", presence}}));
            value.set("communityFriends",
                      client.request("GET", "/api/v1/device/community/friends/presence"));
          }
        } catch (const std::exception &e) {
          value.set("communityError", e.what());
        }
      }
      refreshStage_ = 0;
      return Json::object({{"result", value}});
    } catch (const RequestError &e) {
      refreshStage_ = -1;
#ifdef PS5LIBRARY_NATIVE
      if (e.status == 401 && resetRejectedFrontendCredential(file, token))
        return Json::object(
            {{"result", Json::object({{"device", loadDeviceState(file, Json::parse(config))}})}});
#endif
      return Json::object({{"error", e.what()}, {"serverReachable", true}});
    } catch (const std::exception &e) {
      refreshStage_ = -1;
      return Json::object({{"error", e.what()}});
    }
  });
}
#if defined(PS5LIBRARY_NATIVE) && defined(PS5)
void Storefront::pumpLive() {
}
#else
void Storefront::startLive() {
  if (options_.preview || offlineMode_ || networkPaused_ || liveRequest_.valid() ||
      credential_.empty() || config_["serverUrl"].string().empty() ||
      (liveRetryAt_ && !SDL_TICKS_PASSED(SDL_GetTicks(), liveRetryAt_)))
    return;
  auto configuration = config_.dump(), token = credential_;
  const auto cursor = liveCursor_;
  liveRequest_ = liveNetwork_.submit([this, configuration, token, cursor] {
    try {
      Client client(Json::parse(configuration));
      client.credential = token;
      client.cancelled = [this] { return !running_ || offlineMode_ || networkPaused_; };
      return Json::object({{"result", client.request("GET", "/api/v1/device/events?after=" +
                                                                std::to_string(cursor))}});
    } catch (const std::exception &e) {
      return Json::object({{"error", e.what()}});
    }
  });
}
void Storefront::pumpLive() {
  if (liveRequest_.valid() &&
      liveRequest_.wait_for(std::chrono::seconds(0)) == AsyncWorker::Status::ready) {
    try {
      auto response = AsyncWorker::take(liveRequest_);
      if (!response["error"].null())
        liveRetryAt_ = SDL_GetTicks() + 3000;
      else {
        liveRetryAt_ = SDL_GetTicks() + 1000;
        auto events = response["result"]["events"], current = model_["jobs"];
        for (size_t i = 0; i < events.size(); i++) {
          const auto event = events[i];
          const auto state = event["state"].string();
          liveCursor_ = event["id"].number(liveCursor_);
          const bool terminal = state == "COMPLETED" || state == "READY_ON_PS5" ||
                                state == "ERROR" || state == "CANCELLED";
          if (!mergeJobEvent(current, event) || terminal)
            liveDirty_ = true;
        }
        if (events.size())
          model_.set("jobs", current);
      }
    } catch (...) {
      liveRetryAt_ = SDL_GetTicks() + 3000;
    }
  }
  if (liveDirty_ && !request_.valid()) {
    liveDirty_ = false;
    refresh();
  }
  startLive();
}
#endif
void Storefront::applyLocalSnapshot(const Json &value) {
  auto envelope = localEnvelope(value), snapshot = envelope["snapshot"],
       identity = localIdentity(envelope["device"], consoleId_);
  localSnapshot_ = snapshot;
  device_.set("consoleId", identity["consoleId"]);
  consoleId_ = identity["consoleId"].string();
  localSnapshotRevision_ = snapshot["libraryRevision"].number();
  model_ = localModel(model_, snapshot, identity, config_["name"].string("My PS5"));
  lastLocalSnapshotSeen_ = SDL_GetTicks();
  localAgentSeen_ = true;
  offline_ = true;
  loading_ = false;
}
void Storefront::observeLocalSnapshot(const Json &value) {
  auto envelope = localEnvelope(value), snapshot = envelope["snapshot"],
       identity = localIdentity(envelope["device"], consoleId_);
  const auto previousLocalId = device_["consoleId"].string(),
             observedLocalId = identity["consoleId"].string();
  auto consoles = model_["consoles"];
  localSnapshot_ = snapshot;
  agentPairingCode_ = identity["pairingCode"].string();
  agentHardwareProof_ = identity["hardwareProof"].string();
  localSnapshotRevision_ = snapshot["libraryRevision"].number();
  lastLocalSnapshotSeen_ = SDL_GetTicks();
  localAgentSeen_ = true;
  consoleId_ =
      consoleSelectionAfterLocalSnapshot(consoles, consoleId_, previousLocalId, observedLocalId);
  device_.set("consoleId", identity["consoleId"]);
  if (consoleId_ == observedLocalId)
    model_ =
        withObservedLocalInventory(model_, snapshot, identity, config_["name"].string("My PS5"));
  model_.set("consoles",
             withObservedLocalConsole(consoles, snapshot, previousLocalId, observedLocalId,
                                      config_["name"].string("My PS5")));
  auto status = model_["status"];
  if (status["id"].string().empty() || status["id"].string() == previousLocalId ||
      status["id"].string() == observedLocalId) {
    if (status.null())
      status = Json::object();
    status.set("id", observedLocalId);
    for (const auto *key :
         {"firmware", "runtime", "runtimeStatus", "storage", "storageFormat", "capabilities"})
      status.set(key, snapshot[key]);
    model_.set("status", status);
  }
}
void Storefront::refreshLocal() {
#ifdef PS5LIBRARY_NATIVE
  if (options_.preview || networkPaused_)
    return;
  if (localAgentRequest_.valid()) {
    if (localAgentRequest_.wait_for(std::chrono::seconds(0)) != AsyncWorker::Status::ready)
      return;
    try {
      auto result = AsyncWorker::take(localAgentRequest_);
      const bool configured = !config_["serverUrl"].string().empty();
      const auto server = config_["serverUrl"].string(),
                 fallback = config_["fallbackServerUrl"].string();
      if (localRequestOffline_ == offlineMode_ && localRequestConfigured_ == configured &&
          localRequestServer_ == server && localRequestFallback_ == fallback &&
          !result["error"].null())
        throw std::runtime_error(result["error"].string());
      if (localRequestOffline_ == offlineMode_ && localRequestConfigured_ == configured &&
          localRequestServer_ == server && localRequestFallback_ == fallback) {
        auto value = result["result"].null() ? result : result["result"];
        if (localRequestOffline_ || !configured)
          applyLocalSnapshot(value);
        else
          observeLocalSnapshot(value);
      }
    } catch (const std::exception &e) {
      std::fprintf(stderr, "Local agent: %s\n", e.what());
#if defined(PS5LIBRARY_NATIVE) && defined(PS5)
      auto error = std::string("Local agent: ") + e.what();
      native_error(error.c_str());
#endif
    }
  }
  const auto now = SDL_GetTicks();
  if (lastLocalRefresh_ && now - lastLocalRefresh_ < localAgentRefreshDelay(localAgentSeen_))
    return;
  lastLocalRefresh_ = now;
  localRequestOffline_ = offlineMode_;
  localRequestConfigured_ = !config_["serverUrl"].string().empty();
  localRequestServer_ = config_["serverUrl"].string();
  localRequestFallback_ = config_["fallbackServerUrl"].string();
  const bool local = localRequestOffline_, configured = localRequestConfigured_,
             allow = config_["allowInsecureLan"].boolean();
  const auto server = localRequestServer_, fallback = localRequestFallback_;
  const auto path = !configured ? "/api/v1/agent/disconnect"
                                : localAgentModePath(local, allow, server, fallback),
             session = agentHardwareProof_.empty() ? localSession(options_.config) : std::string();
  localAgentRequest_ = localNetwork_.submit([path, session] {
    try {
      auto value = localAgentRequest("POST", path);
      if (!session.empty())
        try {
          auto proof = localAgentRequest("GET", "/api/v1/agent/hardware-proof", localAgentPort, {},
                                         session),
               device = value["device"];
          device.set("hardwareProof", proof["hardwareProof"]);
          value.set("device", device);
        } catch (...) {
        }
      return value;
    } catch (const std::exception &e) {
      return Json::object({{"error", e.what()}});
    }
  });
#else
  if (options_.preview)
    return;
#endif
}
void Storefront::pump() {
  native_stage(1011);
  if (connected_.exchange(false) && !offlineMode_) {
    offline_ = false;
    art_->offline(false);
    serverConnected_ = true;
    recordNetworkError(Json(""));
  }
  native_stage(1012);
  if (localCommandRequest_.valid() &&
      localCommandRequest_.wait_for(std::chrono::seconds(0)) == AsyncWorker::Status::ready) {
    auto result = AsyncWorker::take(localCommandRequest_);
    auto done = std::move(localCommandComplete_);
    localCommandComplete_ = {};
    if (!result["error"].null())
      toast(friendly(result["error"].string()));
    else if (done)
      done(result["result"]);
  }
  native_stage(1013);
  const bool requestValid = request_.valid();
  native_stage(10131);
  if (requestValid) {
    const auto requestStatus = request_.wait_for(std::chrono::seconds(0));
    native_stage(10132);
    if (requestStatus == AsyncWorker::Status::ready) {
      native_stage(10133);
      auto result = AsyncWorker::take(request_, native_stage);
      native_stage(10134);
      auto done = std::move(complete_);
      complete_ = {};
      native_stage(10135);
      if (offlineMode_) {
        pending_ = {};
      } else if (!result["error"].null()) {
        native_stage(10136);
        recordNetworkError(result["error"]);
        if (setupInFlight_) {
          setupInFlight_ = false;
          networkPaused_ = false;
          resetArtwork();
          startAgent();
          if (result["pairingResetRequired"].boolean()) {
            modal_ = "SwitchServer";
            focus_.select("keep-server");
          } else
            toast(result["error"].string());
        } else if (!networkPaused_) {
          offline_ = !result["serverReachable"].boolean();
          art_->offline(offline_);
          if (offline_)
            serverConnected_ = false;
          loading_ = false;
          toast(friendly(result["error"].string()));
        }
      } else {
        native_stage(10137);
        recordNetworkError(Json(""));
        offline_ = false;
        art_->offline(false);
        if (done)
          done(result["result"]);
      }
    }
  }
  native_stage(1014);
  if (pending_ && !request_.valid()) {
    auto next = std::move(pending_);
    pending_ = {};
    next();
  }
  native_stage(1015);
  refreshLocal();
  native_stage(1016);
  pumpLive();
  native_stage(1017);
  if (localAgentSeen_ && SDL_GetTicks() - lastLocalSnapshotSeen_ > 15000) {
    localAgentSeen_ = false;
    lastLocalRefresh_ = 0;
  }
  native_stage(1018);
  if (!options_.preview && !offlineMode_ && SDL_GetTicks() - lastRefresh_ > 5000)
    refresh();
  native_stage(1019);
}
void Storefront::plan(const std::string &method) {
  if (options_.preview) {
    method_ = method.empty() ? "SHADOWMOUNT" : method;
    auto stores = Json::array();
    auto source = selectedConsole()["storage"];
    for (size_t i = 0; i < source.size(); i++) {
      auto s = source[i].deepCopy();
      s.set("allowed", true);
      stores.add(s);
    }
    auto methods = Json::array();
    methods.add("SHADOWMOUNT");
    methods.add("FPKG");
    plan_ = Json::object({{"method", method_},
                          {"methods", methods},
                          {"allowed", true},
                          {"storage", stores},
                          {"compatibility", Json::object({{"status", "NATIVE_COMPATIBLE"}})}});
    return;
  }
  auto revision = ++planRevision_;
  auto r = selectedRelease();
  const bool cachedOnly = cachedArtifactOnly(r);
  if (!r["sources"].size() && !cachedOnly) {
    toast("No source or verified server copy is available for this release.");
    return;
  }
  auto body = cachedOnly ? Json::object({{"releaseId", r["id"]}, {"consoleId", consoleId_}})
                         : Json::object({{"sourceReleaseId", r["sources"][size_t(0)]["id"]},
                                         {"consoleId", consoleId_}});
  if (!cachedOnly && !method.empty())
    body.set("method", method);
  plan_ = Json();
  request("POST",
          cachedOnly ? "/api/v1/device/transfers/plan" : "/api/v1/device/installations/plan", body,
          [this, revision, cachedOnly](const Json &raw) {
            if (revision != planRevision_)
              return;
            auto result = raw.deepCopy();
            if (cachedOnly) {
              const auto selected = result["compatibility"]["method"].string();
              auto methods = Json::array();
              if (!selected.empty())
                methods.add(selected);
              result.set("method", selected);
              result.set("methods", methods);
              result.set("directArtifact", true);
            }
            plan_ = result;
            method_ = result["method"].string();
            if (!result["message"].string().empty())
              toast(result["message"].string());
            if (modal_ != "Download")
              return;
            auto stores = result["storage"];
            bool available = false;
            std::string first;
            for (size_t i = 0; i < stores.size(); i++)
              if (stores[i]["allowed"].boolean()) {
                if (first.empty())
                  first = stores[i]["storageId"].string();
                if (stores[i]["storageId"].string() == storageId_)
                  available = true;
              }
            if (!available)
              storageId_ = first;
          });
}
