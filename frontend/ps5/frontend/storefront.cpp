#include "storefront.hpp"
#ifdef PS5
#include "ps5_audio.hpp"
#endif

std::string amount(int64_t n) {
  char s[80];
  std::snprintf(s, sizeof(s), n >= 1000000000 ? "%.1f GB" : "%.1f MB",
                n / (n >= 1000000000 ? 1000000000.0 : 1000000.0));
  return s;
}
std::string friendly(std::string text) {
  if (text == "BACKPORT_PREPARING")
    return "Compatibility files preparing";
  std::replace(text.begin(), text.end(), '_', ' ');
  for (auto &c : text)
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  if (!text.empty())
    text.front() = static_cast<char>(std::toupper(static_cast<unsigned char>(text.front())));
  return text;
}
std::string lower(std::string text) {
  for (auto &c : text)
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return text;
}
std::string list(const Json &array) {
  std::string text;
  for (size_t i = 0; i < array.size(); i++) {
    if (i)
      text += " / ";
    text += array[i].string();
  }
  return text;
}
std::string saveDate(int64_t seconds) {
  if (seconds <= 0)
    return "Date unavailable";
  auto value = static_cast<std::time_t>(seconds);
  auto *date = std::gmtime(&value);
  char text[32];
  return date && std::strftime(text, sizeof(text), "%d %b %Y", date) ? text : "Date unavailable";
}
SDL_Rect crop(const Json &value) {
  return {static_cast<int>(value["x"].number()), static_cast<int>(value["y"].number()),
          static_cast<int>(value["w"].number()), static_cast<int>(value["h"].number())};
}
std::string localSession(const fs::path &config) {
  std::ifstream file(config.parent_path() / "cheat-session");
  std::string token;
  if (file >> token && token.size() == 64 &&
      token.find_first_not_of("0123456789abcdef") == std::string::npos)
    return token;
  return {};
}
#ifdef PS5
extern "C" {
extern const unsigned char ui_font[], ui_heading_font[], ui_font_license[], ui_certificates[];
extern const size_t ui_font_size, ui_heading_font_size, ui_font_license_size, ui_certificates_size;
}
static void localAssets(const fs::path &root) {
  for (const auto &item : std::vector<std::pair<std::string, std::string_view>>{
           {"Inter-Regular.otf", {reinterpret_cast<const char *>(ui_font), ui_font_size}},
           {"Inter-SemiBold.otf",
            {reinterpret_cast<const char *>(ui_heading_font), ui_heading_font_size}},
           {"OFL-Inter.txt",
            {reinterpret_cast<const char *>(ui_font_license), ui_font_license_size}},
           {"ca-bundle.crt",
            {reinterpret_cast<const char *>(ui_certificates), ui_certificates_size}}})
    if (!fs::exists(root / item.first))
      atomicBytes(root / item.first, item.second);
}
#endif

void Storefront::action(Action a) {
  if (a == Action::None)
    return;
  if (a == Action::Quit) {
    running_ = false;
    return;
  }
  if (networkPaused_ || SDL_IsScreenKeyboardShown(window_))
    return;
  if (a == Action::SelectPress) {
    if (focusedQueuedJob()) {
      selectPressed_ = true;
      selectPressedAt_ = SDL_GetTicks();
      selectPressedFocus_ = focus_.id();
      return;
    }
    activateFocused();
    return;
  }
  if (a == Action::SelectRelease) {
    if (reorderMode_) {
      finishQueueReorder();
      return;
    }
    if (selectPressed_ && focus_.id() == selectPressedFocus_)
      activateFocused();
    selectPressed_ = false;
    selectPressedFocus_.clear();
    return;
  }
  if (reorderMode_) {
    if (a == Action::Up)
      moveQueuedJob(-1);
    else if (a == Action::Down)
      moveQueuedJob(1);
    else if (a == Action::Back)
      cancelQueueReorder();
    return;
  }
  const auto before = focus_.id();
  if (a == Action::Up)
    focus_.move(Direction::Up);
  if (a == Action::Down)
    focus_.move(Direction::Down);
  if (a == Action::Left)
    focus_.move(Direction::Left);
  if (a == Action::Right) {
    focus_.move(Direction::Right);
    const bool selector = before.rfind("version:", 0) == 0 || before.rfind("target:", 0) == 0 ||
                          before.rfind("method", 0) == 0 || before.rfind("destination:", 0) == 0 ||
                          before == "release-games" || before == "release-dlc" ||
                          before == "releases-prev" || before == "releases-next";
    if (modal_ == "Download" && selector && focus_.id() == before && plan_["allowed"].boolean() &&
        !storageId_.empty())
      focus_.select("confirm-download");
  }
  if (before != focus_.id())
    audio_->play(Cue::Move);
  if (a == Action::Select)
    activateFocused();
  if (a == Action::Search)
    search();
  if (a == Action::Settings)
    openOptions();
  if (a == Action::Context) {
    if (!openJobContext()) {
      if (page_ == "Game")
        advanced_ = !advanced_;
      else
        search();
    }
  }
  if (a == Action::Back) {
    audio_->play(Cue::Back);
    if (!modal_.empty()) {
      if (modal_ == "Download" && modalStep_ > 0) {
        modalStep_--;
        focus_.select("");
      } else if (modal_ == "SwitchServer") {
        modal_ = "Network";
        focus_.select("server-input");
      } else
        closeModal();
    } else if (page_ == "Game") {
      page_ = returnPage_;
      focus_.select(screenFocus_[page_]);
    } else if (landingPage(page_, offlineMode_)) {
#ifdef PS5LIBRARY_NATIVE
      localCommand("/api/v1/agent/close", [](const Json &) {});
#else
      running_ = false;
#endif
    } else
      navigate("Home");
  }
  if (modal_.empty() && page_ != "Game" && (a == Action::NextTab || a == Action::PreviousTab)) {
    auto i = std::find(tabs_.begin(), tabs_.end(), page_);
    int index = i == tabs_.end() ? 0 : static_cast<int>(i - tabs_.begin());
    for (size_t n = 0; n < tabs_.size(); n++) {
      index = (index + static_cast<int>(tabs_.size()) + (a == Action::NextTab ? 1 : -1)) %
              static_cast<int>(tabs_.size());
      if (!offlineMode_ || offlinePageEnabled(tabs_[static_cast<size_t>(index)]))
        break;
    }
    navigate(tabs_[static_cast<size_t>(index)]);
    focus_.select("nav:" + page_);
    audio_->play(Cue::Move);
  }
}
Storefront::Storefront(Options options)
    : options_(std::move(options)), config_(readConfig(options_.config)), page_(options_.screen) {
  fs::create_directories(options_.config.parent_path());
  if (page_ == "Discover" || page_ == "New Releases" || page_ == "Categories" ||
      page_ == "Recently Added" || page_ == "Recently Updated")
    page_ = "Home";
#ifdef PS5
  localAssets(options_.config.parent_path());
#ifdef PS5LIBRARY_NATIVE
  auto lockPath = options_.config.parent_path() / "frontend.lock";
#else
  fs::path lockPath = "/data/ps5library/frontend.lock";
#endif
  frontendLock_ = open(lockPath.c_str(), O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
  if (frontendLock_ < 0 || fchmod(frontendLock_, 0644) != 0 ||
      flock(frontendLock_, LOCK_EX | LOCK_NB) != 0)
    throw std::runtime_error("PS5Library is already open or updating");
#endif
  if (!config_["serverUrl"].string().empty())
    try {
      config_.set("serverUrl", normalizeServerUrl(config_["serverUrl"].string(),
                                                  config_["allowInsecureLan"].boolean()));
      if (!config_["fallbackServerUrl"].string().empty())
        config_.set("fallbackServerUrl", normalizeServerUrl(config_["fallbackServerUrl"].string(),
                                                            config_["allowInsecureLan"].boolean()));
    } catch (const std::exception &e) {
      toast(e.what());
    }
  try {
    auto marker = readJsonIfPresent(options_.config.parent_path() / "offline-mode.json");
    offlineMode_ = marker && marker->boolean();
  } catch (...) {
    offlineMode_ = false;
  }
  if (offlineMode_) {
    serverLibrary_ = false;
    if (!offlinePageEnabled(page_))
      page_ = "Home";
  }
  if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_GAMECONTROLLER) != 0 || TTF_Init() != 0)
    throw std::runtime_error(SDL_GetError());
  IMG_Init(IMG_INIT_PNG | IMG_INIT_JPG | IMG_INIT_WEBP);
  SDL_SetHint(SDL_HINT_RENDER_SCALE_QUALITY, "1");
  Uint32 flags = SDL_WINDOW_SHOWN | SDL_WINDOW_RESIZABLE;
#ifdef PS5
  flags |= SDL_WINDOW_FULLSCREEN_DESKTOP;
#endif
  window_ = SDL_CreateWindow("PS5Library", SDL_WINDOWPOS_CENTERED, SDL_WINDOWPOS_CENTERED,
                             options_.width, options_.height, flags);
  renderer_ = SDL_CreateRenderer(window_, -1, SDL_RENDERER_ACCELERATED | SDL_RENDERER_PRESENTVSYNC);
  if (!renderer_)
    renderer_ = SDL_CreateRenderer(window_, -1, SDL_RENDERER_SOFTWARE);
  if (!renderer_)
    throw std::runtime_error(SDL_GetError());
  SDL_RenderSetLogicalSize(renderer_, static_cast<int>(Tokens::width),
                           static_cast<int>(Tokens::height));
  backdropCacheEnabled_ = SDL_RenderTargetSupported(renderer_) == SDL_TRUE;
  SDL_RendererInfo rendererInfo{};
  SDL_GetRendererInfo(renderer_, &rendererInfo);
  heroCrossfadeEnabled_ = heroCrossfade(rendererInfo.flags);
  fs::path font = config_["font"].string("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf");
#ifdef PS5
  if (config_["font"].string().empty() || font == options_.config.parent_path() / "DejaVuSans.ttf")
    font = options_.config.parent_path() / "Inter-Regular.otf";
#endif
  auto headingFont = font.parent_path() / "Inter-SemiBold.otf";
  const bool inter = font.filename() == "Inter-Regular.otf" && fs::exists(headingFont);
  canvas_ = std::make_unique<Canvas>(renderer_, font.string(), inter ? headingFont.string() : "");
  art_ = std::make_unique<Artwork>(config_, options_.config.parent_path() / "artwork-cache",
                                   options_.preview);
  art_->offline(offlineMode_);
  input_ = std::make_unique<Input>();
  audio_ = std::make_unique<UiAudio>(config_["interfaceSounds"].null() ||
                                     config_["interfaceSounds"].boolean());
  video_ = std::make_unique<VideoPreview>(options_.config.parent_path() / "trailer-cache", *audio_);
  if (options_.preview) {
    model_ = readJson(options_.config.parent_path() / "preview.json");
    device_ = model_["device"];
    credential_ = "preview";
    consoleId_ = consoles()[size_t(0)]["id"].string();
    loading_ = false;
    auto all = catalog();
    if (all.size())
      gameId_ = all[size_t(0)]["id"].string();
  } else {
    auto cache = options_.config.parent_path() / "catalog-cache.json",
         state = options_.config.parent_path() / "device-state.json";
    try {
      if (offlineMode_) {
        if (auto saved = readJsonIfPresent(cache))
          model_ = std::move(*saved);
        if (auto saved = readJsonIfPresent(state))
          device_ = std::move(*saved);
        else
          device_ = model_["device"];
        credential_ = device_["credential"].string();
        consoleId_ = device_["consoleId"].string();
        art_->credentials(credential_);
        offline_ = true;
        loading_ = false;
        serverLibrary_ = false;
        startAgent();
      } else if (!config_["serverUrl"].string().empty()) {
        device_ = loadDeviceState(options_.config, config_);
        credential_ = device_["credential"].string();
        art_->credentials(credential_);
        consoleId_ = device_["consoleId"].string();
        if (auto saved = readJsonIfPresent(cache);
            saved && (*saved)["serverUrl"].string() == config_["serverUrl"].string() &&
            (*saved)["device"]["consoleId"].string() == consoleId_ && !consoleId_.empty()) {
          model_ = std::move(*saved);
          offline_ = true;
        }
        startAgent();
        refresh();
      }
    } catch (const std::exception &e) {
      toast(e.what());
    }
  }
  if (!options_.script.empty()) {
    std::string command;
    for (char c : options_.script) {
      if (c == ',') {
        script_.push_back(command);
        command.clear();
      } else
        command += c;
    }
    if (!command.empty())
      script_.push_back(command);
  }
  focus_.select(page_ == "Game" ? "download" : "first-card");
  if (!options_.preview && !offlineMode_ && config_["serverUrl"].string().empty()) {
    loading_ = false;
    networkSettings();
  }
}
Storefront::~Storefront() {
  running_ = false;
  if (updateRequest_.valid())
    updateRequest_.wait();
  if (request_.valid())
    request_.wait();
#if !defined(PS5LIBRARY_NATIVE) || !defined(PS5)
  if (liveRequest_.valid())
    liveRequest_.wait();
#endif
  if (localAgentRequest_.valid())
    localAgentRequest_.wait();
  if (localCommandRequest_.valid())
    localCommandRequest_.wait();
  if (agent_.joinable())
    agent_.join();
  video_.reset();
  audio_.reset();
  art_.reset();
  SDL_DestroyTexture(backdropCache_);
  canvas_.reset();
  input_.reset();
  SDL_DestroyRenderer(renderer_);
  SDL_DestroyWindow(window_);
  IMG_Quit();
  TTF_Quit();
  SDL_Quit();
  if (frontendLock_ >= 0)
    close(frontendLock_);
}
std::string Storefront::launchTitle() const {
  return launchTitle_;
}
void Storefront::run() {
  const bool measure = options_.preview || options_.frames;
  auto previous = std::chrono::steady_clock::now();
  while (running_) {
    native_stage(100);
    auto start = std::chrono::steady_clock::now();
    delta_ = std::min(.05f, std::chrono::duration<float>(start - previous).count());
    previous = start;
    native_stage(101);
    pump();
    native_stage(102);
    pumpUpdate();
    native_stage(103);
    art_->upload(renderer_);
    native_stage(110);
    SDL_Event event;
    while (SDL_PollEvent(&event)) {
      visibility_.event(event);
      if (windowActive_ != visibility_.active()) {
        windowActive_ = visibility_.active();
        video_->stop();
        audio_->suspend(!windowActive_);
      }
      if (!windowActive_ && event.type != SDL_QUIT)
        continue;
      if (textEvent(event))
        continue;
      if (event.type == SDL_KEYDOWN && event.key.keysym.sym == SDLK_SLASH &&
          (modal_ == "Network" || modal_ == "Search"))
        continue;
      if (event.type == SDL_MOUSEBUTTONDOWN) {
        float x, y;
        SDL_RenderWindowToLogical(renderer_, event.button.x, event.button.y, &x, &y);
        for (const auto &[id, rect] : rects_)
          if (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h) {
            focus_.select(id);
            action(Action::Select);
            break;
          }
      } else
        action(input_->read(event));
    }
    if (windowActive_)
      action(input_->analog());
    if (!windowActive_) {
      preview();
      SDL_Delay(50);
      previous = std::chrono::steady_clock::now();
      continue;
    }
    if (frameCount_ > 0 && frameCount_ % 25 == 0 && scriptIndex_ < script_.size()) {
      auto command = script_[scriptIndex_++];
      const std::map<std::string, Action> commands = {{"up", Action::Up},
                                                      {"down", Action::Down},
                                                      {"left", Action::Left},
                                                      {"right", Action::Right},
                                                      {"select", Action::Select},
                                                      {"select-down", Action::SelectPress},
                                                      {"select-up", Action::SelectRelease},
                                                      {"back", Action::Back},
                                                      {"next", Action::NextTab},
                                                      {"prev", Action::PreviousTab},
                                                      {"search", Action::Search},
                                                      {"settings", Action::Settings}};
      if (command == "enter") {
        SDL_Event typed{};
        typed.type = SDL_KEYDOWN;
        typed.key.keysym.sym = SDLK_RETURN;
        SDL_PushEvent(&typed);
      } else if (command.rfind("text:", 0) == 0) {
        auto text = command.substr(5);
        for (size_t offset = 0; offset < text.size();) {
          SDL_Event typed{};
          typed.type = SDL_TEXTINPUT;
          auto count = std::min(text.size() - offset, sizeof(typed.text.text) - 1);
          std::memcpy(typed.text.text, text.data() + offset, count);
          SDL_PushEvent(&typed);
          offset += count;
        }
      } else if (commands.count(command))
        action(commands.at(command));
    }
    updateSelectHold();
    native_stage(120);
    preview();
    desiredImages_.clear();
    actions_.clear();
    rects_.clear();
    focus_.clear();
    Json backdrop = settledBackdrop(page_ == "Profile" ? Json() : heroGame());
    native_stage(130);
    background(backdrop);
    if (modal_.empty() && highlighted().null() && page_ != "Game")
      ambientBackdrop();
    native_stage(140);
    if (!options_.preview && !offlineMode_ && credential_.empty()) {
      bool configured = !config_["serverUrl"].string().empty();
      title("Make yourself at home.",
            configured ? (nativeFrontend ? "In the companion, enter this code and "
                                           "choose your registered PS5."
                                         : "Open the companion and pair this "
                                           "console with your account.")
                       : "Connect your server to start exploring your collection.");
      draw().label(configured ? device_["pairing"]["code"].string("Contacting your server…")
                              : "Your library. Your PS5.",
                   Tokens::safe, Tokens::height * .38f, Tokens::title, Tokens::accent);
      draw().label("Pair once. Your games and consoles stay with your account.", Tokens::safe,
                   Tokens::height * .52f, Tokens::body, Tokens::muted);
      button(
          "pair-network", configured ? "Server connection" : "Connect server",
          {Tokens::safe, Tokens::height * .65f, 350, 60}, 1, [this] { networkSettings(); }, true);
      if (configured)
        button("pair-retry", "Retry", {Tokens::safe + 380, Tokens::height * .65f, 220, 60}, 1,
               [this] { lastRefresh_ = 0; });
    } else if (page_ == "Game") {
      native_stage(152);
      details();
    } else if (page_ == "Downloads") {
      native_stage(153);
      downloadJobs();
    } else if (page_ == "My PS5") {
      native_stage(154);
      myPS5();
    } else if (page_ == "Profile") {
      native_stage(156);
      profile();
    } else if (page_ == "Home") {
      native_stage(157);
      homePage();
    } else {
      native_stage(158);
      libraryPage();
    }
    if (page_ != "Game")
      navigation();
    footer();
    if (!modal_.empty()) {
      focus_.clear();
      actions_.clear();
      rects_.clear();
      if (modal_ == "Download")
        installReview();
      else if (modal_ == "Network" || modal_ == "SwitchServer")
        networkModal();
      else if (modal_ == "Options")
        optionsModal();
      else if (modal_ == "Avatar")
        avatarModal();
      else if (modal_ == "RemoveGame")
        removalModal();
      else if (modal_ == "MoveGame")
        moveModal();
      else if (modal_ == "FormatStorage")
        formatStorageModal();
      else if (modal_ == "JobContext")
        jobContextModal();
      else
        searchModal();
    }
    if (!focus_.current() && focus_.id() == "first-card") {
      auto candidate = page_ == "My Library" ? libraryGames() : games();
      if (!candidate.empty())
        focus_.select((page_ == "Home" ? "home:" : "grid:") + candidate[0]["id"].string());
    }
    focus_.ensure();
    if (SDL_GetTicks() < toastUntil_) {
      Rect rect{Tokens::width * .2f, Tokens::height - 115, Tokens::width * .6f, 58};
      draw().rounded(rect, {35, 51, 73, 245}, 16);
      draw().label(message_, rect.x + 22, rect.y + 15, Tokens::caption, Tokens::white,
                   static_cast<int>(rect.w - 44));
    }
    native_stage(170);
    if (!loading_)
      art_->desire(desiredImages_);
    native_stage(171);
    draw().end();
    native_stage(172);
    native_stage(180);
    SDL_RenderPresent(renderer_);
    native_stage(181);
    if (measure) {
      auto rendered = std::chrono::steady_clock::now();
      if (frameTimes_.size() < 6000)
        frameTimes_.push_back(std::chrono::duration<double, std::milli>(rendered - start).count());
      else
        frameTimes_[frameCount_ % 6000] =
            std::chrono::duration<double, std::milli>(rendered - start).count();
    }
    frameCount_++;
    if (frameCount_ == 60)
      atomicJson(
          options_.config.parent_path() / "update-boot.json",
          Json::object({{"build", appBuild}, {"version", appVersion}, {"launchId", launchId_}}));
    if (options_.frames && frameCount_ >= options_.frames) {
      if (!options_.capture.empty()) {
        int w, h;
        SDL_GetRendererOutputSize(renderer_, &w, &h);
        auto *surface = SDL_CreateRGBSurfaceWithFormat(0, w, h, 32, SDL_PIXELFORMAT_ARGB8888);
        SDL_RenderReadPixels(renderer_, nullptr, SDL_PIXELFORMAT_ARGB8888, surface->pixels,
                             surface->pitch);
        SDL_SaveBMP(surface, options_.capture.c_str());
        SDL_FreeSurface(surface);
      }
      break;
    }
    if (options_.frames)
      SDL_Delay(10);
#ifndef PS5
    else
      SDL_Delay(1);
#endif
    // PS5 SDL already blocks on the display flip. An extra sleep can miss the
    // next refresh.
  }
  std::sort(frameTimes_.begin(), frameTimes_.end());
  if (!frameTimes_.empty()) {
    auto count = frameTimes_.size();
    Json metrics = Json::object(
        {{"musicStarts", static_cast<int64_t>(video_->musicStarts())},
         {"musicAudioBytes", static_cast<int64_t>(video_->musicBytes())},
         {"backdropCompositions", backdropCompositions_},
         {"trailerStarts", static_cast<int64_t>(video_->starts())},
         {"trailerFrames", static_cast<int64_t>(video_->displayed())},
         {"trailerDecodedFrames", static_cast<int64_t>(video_->decoded())},
         {"trailerAudioBytes", static_cast<int64_t>(video_->audioBytes())},
         {"trailerActive", video_->active()},
         {"previewError", video_->error()},
         {"audioAvailable", audio_->available()},
         {"soundCuesPlayed", static_cast<int64_t>(audio_->played())},
         {"frames", static_cast<int64_t>(count)},
         {"renderMedianMicros", static_cast<int64_t>(frameTimes_[count / 2] * 1000)},
         {"renderP95Micros", static_cast<int64_t>(frameTimes_[count * 95 / 100] * 1000)},
         {"textureBytes", static_cast<int64_t>(art_->textureBytes())},
         {"screen", page_},
         {"focus", focus_.id()},
         {"preview", options_.preview},
         {"offline", offline_},
         {"offlineMode", offlineMode_.load()}});
    atomicJson(options_.config.parent_path() / "performance.json", metrics);
    std::puts(metrics.dump().c_str());
  }
}
