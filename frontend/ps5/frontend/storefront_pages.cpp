#include "storefront.hpp"

void Storefront::profile() {
  const auto data = model_["profile"];
  auto profileConsoles = data["consoles"], console = selectedConsole();
  Json selected;
  for (size_t i = 0; i < profileConsoles.size(); i++)
    if (profileConsoles[i]["id"].string() == consoleId_)
      selected = profileConsoles[i];
  const bool online =
      console["presence"].string() == "ONLINE" || console["presence"].string() == "LOCAL" ||
      selected["presence"].string() == "ONLINE" || selected["presence"].string() == "LOCAL";
  draw().rounded({Tokens::safe, 138, Tokens::width - Tokens::safe * 2, 142}, {20, 31, 45, 190}, 18);
  avatar({Tokens::safe + 24, 154, 110, 110});
  draw().label(data["username"].string("Your profile"), Tokens::safe + 170, 157, Tokens::title,
               Tokens::white, 1020);
  draw().rounded({Tokens::safe + 172, 237, 9, 9}, online ? Tokens::success : Tokens::muted, 5);
  draw().label(selected["name"].string(console["name"].string("Select your PS5")),
               Tokens::safe + 194, 224, Tokens::body, Tokens::muted);
  button(
      "profile-picture", "Change picture", {Tokens::width - Tokens::safe - 310, 181, 284, 58}, 1,
      [this] {
        screenFocus_["before-modal"] = focus_.id();
        modal_ = "Avatar";
        focus_.select("avatar-default");
      },
      false, !offlineMode_);
  float x = Tokens::safe;
  for (size_t i = 0; i < profileConsoles.size(); i++) {
    auto c = profileConsoles[i];
    button(
        "profile-console:" + c["id"].string(), c["name"].string(), {x, 304, 290, 50}, 2,
        [this, c] {
          consoleId_ = c["id"].string();
          lastRefresh_ = 0;
        },
        false, true, c["id"].string() == consoleId_);
    x += 310;
    if (x > Tokens::width - 350)
      break;
  }
  button(
      "profile-games", "Games", {Tokens::safe, 376, 210, 50}, 3, [this] { profileSection_ = 0; },
      false, true, profileSection_ == 0);
  button(
      "profile-trophies", "Trophies", {Tokens::safe + 230, 376, 220, 50}, 3,
      [this] { profileSection_ = 1; }, false, true, profileSection_ == 1);
  button(
      "profile-saves", "Saved data", {Tokens::safe + 470, 376, 230, 50}, 3,
      [this] { profileSection_ = 2; }, false, true, profileSection_ == 2);
  button(
      "profile-friends", "Friends", {Tokens::safe + 720, 376, 210, 50}, 3,
      [this] { profileSection_ = 3; }, false, !offlineMode_, profileSection_ == 3);
  int64_t available = 0;
  auto reported = selected["games"];
  for (size_t i = 0; i < reported.size(); i++)
    available += reported[i]["available"].boolean();
  const auto runtime = console["runtimeStatus"];
  const auto shadow = friendly(runtime["shadowMount"].string("UNKNOWN"));
  const std::vector<std::pair<std::string, std::string>> facts = {
      {"Status", online ? "Connected" : "Offline"},
      {"Firmware", console["firmware"].string("Not reported")},
      {"Available", std::to_string(available) + " games"},
      {"ShadowMountPlus", shadow}};
  x = Tokens::safe;
  for (size_t i = 0; i < facts.size(); i++) {
    if (i)
      draw().fill({x - 28, Tokens::profileFactsY, 1, 58}, {126, 148, 174, 60});
    draw().label(facts[i].first, x, Tokens::profileFactsY, Tokens::caption, Tokens::muted);
    draw().label(facts[i].second, x, Tokens::profileFactsY + 28, Tokens::heading, Tokens::white,
                 370, 1);
    x += 440;
  }
  if (profileSection_ == 3) {
    auto account = model_["communityAccount"], friends = model_["communityFriends"];
    if (account["state"].string() != "CONNECTED") {
      draw().label("Connect your Community Master account from the companion "
                   "or server profile.",
                   Tokens::safe, 565, Tokens::heading, Tokens::muted, 1200, 2);
      return;
    }
    draw().label("Connected as @" + account["account"]["handle"].string(), Tokens::safe, 555,
                 Tokens::body, Tokens::accent);
    if (!model_["communityError"].string().empty())
      draw().label("Community temporarily unavailable: " +
                       friendly(model_["communityError"].string()),
                   Tokens::safe, 590, Tokens::caption, Tokens::warning, 1450, 2);
    if (!friends.size())
      draw().label("No friends yet. Add friends from your companion.", Tokens::safe, 640,
                   Tokens::body, Tokens::muted);
    for (size_t i = 0; i < std::min(size_t(8), friends.size()); i++) {
      auto friendData = friends[i];
      float left = Tokens::safe + (i % 2) * 875, y = 620 + (i / 2) * 92;
      Rect row{left, y, 840, 74};
      auto id = "friend:" + friendData["id"].string();
      button(id, "", row, 4 + static_cast<int>(i / 2), [] {}, false, true, false, true);
      auto state = friendData["state"].string("OFFLINE");
      auto session = friendData["session"];
      SDL_Color color = state == "ONLINE" ? Tokens::success
                        : state == "AWAY" ? Tokens::warning
                                          : Tokens::muted;
      draw().rounded({left + 18, y + 31, 10, 10}, color, 5);
      draw().label(friendData["displayName"].string(friendData["handle"].string()), left + 48,
                   y + 7, Tokens::body);
      auto activity = session.null() ? friendly(state)
                                     : "Playing online  /  " +
                                           std::to_string(session["playerCount"].number()) +
                                           " of " + std::to_string(session["maxPlayers"].number());
      draw().label("@" + friendData["handle"].string() + "  /  " + activity, left + 48, y + 39,
                   Tokens::caption, session.null() ? Tokens::muted : Tokens::accent);
      draw().fill({left, y + row.h - 1, row.w, 1}, {126, 148, 174, 55});
    }
    return;
  }
  if (profileSection_ == 2) {
    auto saves = selected["saveData"];
    draw().label("Saved data on this PS5", Tokens::safe, 548, Tokens::heading);
    draw().label(saves.size() ? "Select a game to manage its saves from Game Details."
                              : "No save data has been reported by the local agent.",
                 Tokens::safe, 588, Tokens::body, Tokens::muted, 1100, 2);
    for (size_t i = 0; i < std::min(size_t(6), saves.size()); i++) {
      const auto save = saves[i];
      const float left = Tokens::safe + (i % 2) * 875, y = 660 + (i / 2) * 98;
      draw().rounded({left, y, 840, 78}, Tokens::surface, 12);
      draw().label(
          save["title"].string(save["subtitle"].string(save["gameTitleId"].string("Saved data"))),
          left + 22, y + 12, Tokens::body, Tokens::white, 570, 1);
      draw().label(amount(save["sizeBytes"].number()) + "  /  Updated " +
                       saveDate(save["modifiedAt"].number()),
                   left + 22, y + 45, Tokens::caption, Tokens::muted, 570, 1);
      draw().label(save["gameTitleId"].string(), left + 650, y + 25, Tokens::caption,
                   Tokens::accent, 160, 1);
    }
    return;
  }
  auto stores = storageCards(console["storage"]);
  draw().label("Storage", Tokens::safe, 548, Tokens::heading);
  if (!stores.size())
    draw().label("No storage reported by this console.", Tokens::safe, 592, Tokens::body,
                 Tokens::muted);
  for (size_t i = 0; i < std::min(size_t(2), stores.size()); i++) {
    auto store = stores[i];
    const float y = 590 + i * 55;
    draw().label(store["displayName"].string("Storage"), Tokens::safe, y, Tokens::body,
                 Tokens::white, 260);
    draw().bar({Tokens::safe + 285, y + 10, 535, 7},
               store["totalBytes"].number() - store["freeBytes"].number(),
               store["totalBytes"].number());
    draw().label(amount(store["freeBytes"].number()) + " free", Tokens::safe + 842, y,
                 Tokens::caption, Tokens::muted, 210);
  }
  const float trophyX = 1165;
  draw().fill({trophyX - 44, 548, 1, 132}, {126, 148, 174, 60});
  draw().label("Trophies", trophyX, 548, Tokens::heading);
  auto summary = selected["trophySummary"], earned = summary["earnedTrophies"];
  const std::pair<const char *, const char *> trophyGrades[] = {
      {"platinum", "Platinum"}, {"gold", "Gold"}, {"silver", "Silver"}, {"bronze", "Bronze"}};
  for (size_t i = 0; i < 4; i++) {
    const float left = trophyX + i * 165;
    draw().label(summary.null() ? "--" : std::to_string(earned[trophyGrades[i].first].number()),
                 left, 594, Tokens::heading);
    draw().label(trophyGrades[i].second, left, 629, Tokens::caption, Tokens::muted);
  }
  std::vector<Json> visible;
  for (size_t i = 0; i < reported.size(); i++)
    if (profileSection_ == 1 || reported[i]["available"].boolean()) {
      auto g = game(reported[i]["gameId"].string());
      if (!g.null())
        visible.push_back(g);
    }
  rail(profileSection_ == 1 ? "Trophies by game" : "Currently on this console", visible,
       Tokens::profileRailY, 4);
}
void Storefront::button(std::string id, std::string title, Rect rect, int row,
                        std::function<void()> callback, bool primary, bool enabled, bool selected,
                        bool plain, const std::string &icon) {
  if (enabled) {
    focus_.add(id, row, {rect.x, rect.y, rect.w, rect.h});
    actions_[id] = std::move(callback);
    rects_[id] = rect;
  }
  const bool focused = enabled && focus_.id() == id;
  auto &a = animation_[id];
  a += (focused ? 1.f - a : -a) * std::min(1.f, delta_ / Tokens::focusSeconds);
  const bool visible = !plain || selected || primary || a > .05f;
  if (visible) {
    const auto fill = !enabled   ? Tokens::disabled
                      : primary  ? SDL_Color{238, 242, 248, 250}
                      : selected ? Tokens::surfaceActive
                                 : Tokens::surface;
    draw().rounded(rect, fill, rect.h / 2);
    draw().edge(rect,
                !enabled   ? SDL_Color{89, 102, 119, 75}
                : primary  ? SDL_Color{255, 255, 255, 230}
                : selected ? SDL_Color{121, 174, 230, 145}
                           : SDL_Color{126, 148, 174, 65},
                rect.h / 2);
  }
  if (a > .02f)
    draw().outline(rect, a, rect.h / 2);
  const float content = draw().measure(title, Tokens::control) + (icon.empty() ? 0 : 48),
              left = rect.x + (rect.w - content) / 2;
  if (!icon.empty()) {
    if (primary && enabled)
      draw().rounded({left - 2, rect.cy() - 16, 32, 32}, Tokens::background, 16);
    draw().icon(icon, left + 14, rect.cy(),
                primary && enabled ? Tokens::white
                : !enabled         ? Tokens::muted
                                   : Tokens::white);
  }
  draw().label(
      title, left + (icon.empty() ? 0 : 48),
      rect.y +
          (rect.h - draw().textHeight(title, Tokens::control, static_cast<int>(rect.w - 20))) / 2,
      Tokens::control,
      !enabled  ? Tokens::muted
      : primary ? Tokens::background
                : Tokens::white,
      static_cast<int>(rect.w - 20));
}
void Storefront::title(const std::string &text, const std::string &subtitle) {
  draw().label(text, Tokens::safe, Tokens::header + Tokens::gap * 2, Tokens::title);
  draw().label(subtitle, Tokens::safe,
               Tokens::header + Tokens::gap * 2 + Tokens::title + Tokens::gap, Tokens::body,
               Tokens::muted);
}
void Storefront::badge(const std::string &text, Rect rect) {
  draw().rounded(rect, {29, 37, 46, 182}, rect.h / 2);
  draw().label(
      text, rect.x + Tokens::gap / 2,
      rect.y +
          (rect.h - draw().textHeight(text, Tokens::caption, static_cast<int>(rect.w - 12))) / 2,
      Tokens::caption, Tokens::muted, static_cast<int>(rect.w - 12));
}
void Storefront::gameImage(const Json &g, Rect rect, bool hero, Uint8 opacity) {
  auto url = g[hero ? "heroUrl" : "coverUrl"].string();
  auto c = crop(g[hero ? "heroCrop" : "coverCrop"]);
  wantArtwork(url, rect, c);
  c = art_->scaledCrop(url, c);
  auto *image = art_->get(url);
  draw().cover(image, rect, c.w > 0 ? &c : nullptr, opacity, hero ? 0 : Tokens::radius);
  if (!image && !hero && !g["title"].string().empty()) {
    draw().rounded({rect.x + 4, rect.y + rect.h * .66f, rect.w - 8, rect.h * .32f},
                   {24, 34, 47, 255}, 4);
    draw().label(g["title"].string(), rect.x + 14, rect.y + rect.h * .7f, Tokens::caption,
                 Tokens::white, static_cast<int>(rect.w - 28), 2);
  }
}
void Storefront::background(const Json &game) {
  auto url = backgroundUrl(game);
  const bool immersive = backdropMode(page_) != 'L';
  const auto rect = backdropRect();
  auto heroCrop = crop(game["heroCrop"]);
  wantArtwork(url, rect, heroCrop, true);
  auto *image = art_->get(url);
  if (image && heroUrl_ != url) {
    oldHero_ = heroCrossfadeEnabled_ ? heroUrl_ : "";
    heroUrl_ = url;
    heroMix_ = heroCrossfadeEnabled_ ? 0 : 1;
  }
  heroMix_ = heroCrossfadeEnabled_ ? std::min(1.f, heroMix_ + delta_ / Tokens::fadeSeconds) : 1;
  auto *video = video_->frame(renderer_);
  auto paint = [&] {
    draw().fill({0, 0, Tokens::width, Tokens::height}, Tokens::background);
    if (!oldHero_.empty() && heroMix_ < 1) {
      wantArtwork(oldHero_, rect, {}, true);
      draw().cover(art_->get(oldHero_), rect);
    }
    if (image) {
      auto source = art_->scaledCrop(url, crop(game["heroCrop"]));
      draw().cover(image, rect, !immersive && source.w > 0 ? &source : nullptr,
                   static_cast<Uint8>(255 * heroMix_));
    }
    if (video)
      draw().cover(video, rect);
    if (image || video || heroMix_ < 1) {
      const float fadeTop = page_ == "Home" || page_ == "My Library"
                                ? Tokens::libraryStripY - 100
                                : std::floor(Tokens::heroBottom * .68f);
      draw().fade({rect.x, 0, rect.w * .58f, rect.h}, true, true, 255);
      draw().fade({0, fadeTop, Tokens::width, rect.h - fadeTop}, false);
      draw().fade({0, 0, Tokens::width, Tokens::header * 1.2f}, false, true, 150);
    }
    draw().fill({0, 0, Tokens::width, Tokens::height},
                {7, 11, 17,
                 static_cast<Uint8>(page_ == "Game"                            ? 85
                                    : page_ == "Home" || page_ == "My Library" ? 72
                                                                               : 180)});
  };
  // Compose the static hero once. SDL's PS5 software renderer otherwise
  // blends millions of unchanged pixels every frame.
  if (!video && heroMix_ >= 1 && backdropCacheEnabled_ && SDL_RenderTargetSupported(renderer_)) {
    if (!backdropCache_)
      backdropCache_ =
          SDL_CreateTexture(renderer_, SDL_PIXELFORMAT_ARGB8888, SDL_TEXTUREACCESS_TARGET,
                            static_cast<int>(Tokens::width), static_cast<int>(Tokens::height));
    const auto key = std::string(1, backdropMode(page_)) + url + game["heroCrop"].dump() +
                     (image ? ":loaded:" + std::to_string(art_->textureKey(url)) : ":empty");
    if (backdropCache_) {
      if (key != backdropKey_) {
        if (SDL_SetRenderTarget(renderer_, backdropCache_) != 0) {
          paint();
          return;
        }
        paint();
        SDL_SetRenderTarget(renderer_, nullptr);
        backdropKey_ = key;
        backdropCompositions_++;
      }
      SDL_SetTextureBlendMode(backdropCache_, SDL_BLENDMODE_NONE);
      SDL_RenderCopy(renderer_, backdropCache_, nullptr, nullptr);
      return;
    }
  }
  paint();
}
void Storefront::navigation() {
  const float y = Tokens::safe * .65f, utilities = Tokens::width * .78125f;
  float x = Tokens::safe;
  // Queue the asynchronously loaded avatar before navigation text. Some SDL
  // backends flush their geometry batch when a new texture is bound.
  button(
      "profile", "", {utilities + 132, y, 50, 52}, 0, [this] { navigate("Profile"); }, false, true,
      false, true);
  draw().vibrantRing(utilities + 157, y + 25, 23, std::fmod(SDL_GetTicks64() / 4200.f, 1.f));
  avatar({utilities + 137, y + 5, 40, 40});
  draw().icon("controller", x + 25, y + 22, {232, 238, 254, 255});
  x += 76;
  draw().label("PS5", x, y - 7, Tokens::brand, {114, 167, 228, 255});
  draw().label("Library", x + draw().measure("PS5", Tokens::brand), y - 7, Tokens::brand);
  draw().label("Games without limits", x, y + 34, Tokens::caption, Tokens::muted);
  x = Tokens::width * .208f;
  const float right = Tokens::width * .74f, tabGap = Tokens::gap * 1.5f;
  auto tabLabel = [](const std::string &tab) {
    return tab == "My Library" ? "Games" : tab == "Downloads" ? "Activity" : tab;
  };
  float total = 0;
  for (const auto &tab : tabs_)
    total += draw().measure(tabLabel(tab), Tokens::control) + Tokens::gap * 3;
  float scale = std::min(1.f, (right - x - tabGap * (tabs_.size() - 1)) / total);
  float indicator = -1;
  for (size_t i = 0; i < tabs_.size(); i++) {
    const auto label = tabLabel(tabs_[i]);
    float width = (draw().measure(label, Tokens::control) + Tokens::gap * 3) * scale;
    const bool enabled = !offlineMode_ || offlinePageEnabled(tabs_[i]);
    button(
        "nav:" + tabs_[i], label, {x, y - 3, width, 58}, 0, [this, i] { navigate(tabs_[i]); },
        false, enabled, page_ == tabs_[i], true);
    if (page_ == tabs_[i])
      indicator = x + width / 2;
    x += width + tabGap;
  }
  if (indicator >= 0) {
    if (navIndicatorX_ < 0)
      navIndicatorX_ = indicator;
    navIndicatorX_ += (indicator - navIndicatorX_) * std::min(1.f, delta_ * 12);
    draw().rounded({navIndicatorX_ - 22, y + 57, 44, 3}, Tokens::accent, 2);
  }
  if (offlineMode_) {
    const float pulse = .55f + .45f * std::sin(SDL_GetTicks() / 420.f);
    draw().rounded({1434, y + 14, 10, 10}, {111, 210, 181, static_cast<Uint8>(150 + 95 * pulse)},
                   5);
    draw().label(localAgentSeen_ ? "LOCAL" : "WAIT", 1452, y + 7, Tokens::caption,
                 localAgentSeen_ ? SDL_Color{178, 235, 217, 255} : Tokens::muted);
  }
  x = utilities;
  button("search", "", {x, y, 50, 52}, 0, [this] { search(); }, false, true, false, true);
  draw().icon("search", x + 25, y + 25);
  button(
      "settings", "", {x + 66, y, 50, 52}, 0, [this] { openOptions(); }, false, true, false, true);
  draw().icon("settings", x + 91, y + 25);
  std::time_t now = std::time(nullptr);
  char clock[12];
  std::strftime(clock, sizeof(clock), "%H:%M", std::localtime(&now));
  draw().label(clock, Tokens::width - Tokens::safe - 78, y + 10, Tokens::body, Tokens::muted);
}
void Storefront::card(const Json &g, Rect rect, int row, const std::string &id) {
  focus_.add(id, row, {rect.x, rect.y, rect.w, rect.h});
  actions_[id] = [this, id = g["id"].string()] { openGame(id); };
  rects_[id] = rect;
  auto &a = animation_[id];
  a += (focus_.id() == id ? 1.f - a : -a) * std::min(1.f, delta_ / Tokens::focusSeconds);
  float grow = a * (Tokens::focusScale - 1);
  rect = {rect.x - rect.w * grow / 2, rect.y - rect.h * grow / 2 - a * 5, rect.w * (1 + grow),
          rect.h * (1 + grow)};
  gameImage(g, {rect.x + 2, rect.y + 2, rect.w - 4, rect.h - 4});
  if (a > .01f) {
    draw().outline(rect, a);
    draw().rounded(
        {rect.x + rect.w * .27f, rect.y + rect.h + 7, rect.w * .46f, 4},
        {Tokens::accent.r, Tokens::accent.g, Tokens::accent.b, static_cast<Uint8>(220 * a)}, 2);
  }
  if (page_ == "My Library" && (serverLibrary_ ? serverReady(g) : ready(g)))
    badge(serverLibrary_ ? "SERVER" : "ON PS5", {rect.x + 9, rect.y + 10, 105, 29});
}
void Storefront::rail(const std::string &name, const std::vector<Json> &games, float y, int row) {
  const auto key = std::to_string(row);
  draw().label(name, Tokens::safe, y, Tokens::heading);
  const float top = y + Tokens::railTitle + Tokens::gap;
  float target = 0;
  for (size_t i = 0; i < games.size(); i++)
    if (focus_.id() == "rail" + key + ":" + games[i]["id"].string()) {
      float cardLeft = static_cast<float>(i) * (Tokens::cardWidth + Tokens::gap);
      target = std::max(0.f, cardLeft - (Tokens::width - Tokens::safe * 2 - Tokens::cardWidth) / 2);
    }
  target = std::min(target, std::max(0.f, games.size() * (Tokens::cardWidth + Tokens::gap) -
                                              Tokens::gap - (Tokens::width - Tokens::safe * 2)));
  if (focus_.id().rfind("rail" + key + ":", 0) == 0)
    scroll_[key] += (target - scroll_[key]) * std::min(1.f, delta_ * 14);
  float x = Tokens::safe - scroll_[key];
  SDL_Rect clip{static_cast<int>(Tokens::safe - 10), static_cast<int>(top - 14),
                static_cast<int>(Tokens::width - Tokens::safe + 10),
                static_cast<int>(Tokens::cardHeight + 30)};
  SDL_RenderSetClipRect(renderer_, &clip);
  for (size_t i = 0; i < games.size(); i++) {
    Rect rect{x + static_cast<float>(i) * (Tokens::cardWidth + Tokens::gap), top, Tokens::cardWidth,
              Tokens::cardHeight};
    auto id = "rail" + key + ":" + games[i]["id"].string();
    if (rect.x + rect.w > 0 && rect.x < Tokens::width + Tokens::cardWidth)
      card(games[i], rect, row, id);
    else {
      focus_.add(id, row, {rect.x, rect.y, rect.w, rect.h});
      actions_[id] = [this, g = games[i]] { openGame(g["id"].string()); };
    }
  }
  SDL_RenderSetClipRect(renderer_, nullptr);
  if (games.empty()) {
    if (loading_)
      for (int i = 0; i < 8; i++)
        draw().cover(nullptr, {Tokens::safe + i * (Tokens::cardWidth + Tokens::gap), top,
                               Tokens::cardWidth, Tokens::cardHeight});
    else
      draw().label("No games in this collection yet.", Tokens::safe, top + Tokens::gap,
                   Tokens::body, Tokens::muted);
  }
}
std::vector<Json> Storefront::games(const std::function<bool(const Json &)> &filter) const {
  std::vector<Json> out;
  auto all = catalog();
  for (size_t i = 0; i < all.size(); i++)
    if (!filter || filter(all[i]))
      out.push_back(all[i]);
  return out;
}
std::vector<Json> Storefront::libraryGames() const {
  return serverLibrary_ ? games([](const Json &g) { return serverAvailable(g); })
                        : games([this](const Json &g) { return ready(g); });
}
void Storefront::homePage() {
  auto available = offlineMode_ ? games([this](const Json &g) { return ready(g); })
                                : games([](const Json &g) { return serverAvailable(g); });
  if (available.empty())
    available = games();
  if (available.empty()) {
    title(offlineMode_ ? "Your PS5 is ready offline" : "Your library starts here",
          offlineMode_ ? "Waiting for the local agent to report installed games."
                       : "Add authorized content to your server, then refresh this "
                         "screen.");
    button(
        "home-library", "Open Games", {Tokens::safe, 410, 260, 62}, 1,
        [this] { navigate("My Library"); }, true);
    return;
  }
  for (const auto &g : available)
    if (focus_.id() == "home:" + g["id"].string()) {
      homeGameId_ = g["id"].string();
      break;
    }
  if (homeGameId_.empty() || game(homeGameId_).null())
    homeGameId_ = available.front()["id"].string();
  if (focus_.id() == "first-card")
    focus_.select("home:" + homeGameId_);
  Json selected = game(homeGameId_);
  if (selected.null())
    selected = available.front();
  auto releases = selected["releases"];
  Json release;
  for (size_t i = 0; i < releases.size(); i++)
    if (releases[i]["kind"].string() != "DLC") {
      release = releases[i];
      break;
    }
  const auto name = selected["title"].string("Untitled game");
  const int titleSize =
      draw().measure(name, Tokens::title) > 820 ? Tokens::compactTitle : Tokens::title;
  const float x = Tokens::safe, y = 225;
  draw().label(offlineMode_            ? "Available on this PS5"
               : serverReady(selected) ? "READY TO DOWNLOAD"
                                       : "AVAILABLE ON YOUR SERVER",
               x, y, Tokens::caption, offlineMode_ ? Tokens::success : Tokens::accent);
  draw().label(name, x, y + 44, titleSize, Tokens::white, 820, 2);
  const float copyY = y + 44 + draw().textHeight(name, titleSize, 820, 2) + 24;
  draw().label(selected["description"].string("Open this game to see releases and availability."),
               x, copyY, Tokens::body, {218, 225, 235, 255}, 760, 3);
  std::string metadata = selected["platform"].string("PS5");
  if (!release["version"].string().empty())
    metadata += "  /  Version " + release["version"].string();
  if (!release["size"].null())
    metadata += "  /  " + amount(release["size"].number());
  draw().label(metadata, x, copyY + 122, Tokens::caption, Tokens::muted, 760, 2);
  button(
      "home-open", ready(selected) ? "Play or manage" : "View game", {x, copyY + 174, 270, 64}, 1,
      [this] { openGame(homeGameId_); }, true);
  button("home-games", "All games", {x + 292, copyY + 174, 210, 64}, 1,
         [this] { navigate("My Library"); });
  const float railY = 742;
  draw().label(offlineMode_ ? "On this PS5" : "Your games", Tokens::safe, railY, Tokens::heading);
  draw().label(std::to_string(available.size()) + (available.size() == 1 ? " title" : " titles"),
               Tokens::width - Tokens::safe - 130, railY + 3, Tokens::caption, Tokens::muted);
  const float top = railY + 50;
  float target = 0;
  for (size_t i = 0; i < available.size(); i++)
    if (focus_.id() == "home:" + available[i]["id"].string())
      target = std::max(0.f, i * (Tokens::cardWidth + Tokens::gap) -
                                 (Tokens::width - Tokens::safe * 2 - Tokens::cardWidth) / 2);
  target = std::min(target, std::max(0.f, available.size() * (Tokens::cardWidth + Tokens::gap) -
                                              Tokens::gap - (Tokens::width - Tokens::safe * 2)));
  auto &offset = scroll_["home"];
  offset += (target - offset) * std::min(1.f, delta_ * 14);
  SDL_Rect clip{static_cast<int>(Tokens::safe - 12), static_cast<int>(top - 14),
                static_cast<int>(Tokens::width - Tokens::safe + 12),
                static_cast<int>(Tokens::cardHeight + 30)};
  SDL_RenderSetClipRect(renderer_, &clip);
  for (size_t i = 0; i < available.size(); i++) {
    Rect rect{Tokens::safe + i * (Tokens::cardWidth + Tokens::gap) - offset, top, Tokens::cardWidth,
              Tokens::cardHeight};
    const auto id = "home:" + available[i]["id"].string();
    if (rect.x + rect.w > 0 && rect.x < Tokens::width + Tokens::cardWidth)
      card(available[i], rect, 2, id);
    else {
      focus_.add(id, 2, {rect.x, rect.y, rect.w, rect.h});
      actions_[id] = [this, g = available[i]] { openGame(g["id"].string()); };
    }
  }
  SDL_RenderSetClipRect(renderer_, nullptr);
}
void Storefront::libraryPage() {
  const float scopeY = Tokens::header + Tokens::gap;
  auto choose = [this](bool server) {
    serverLibrary_ = server;
    auto available = libraryGames();
    focus_.select(available.empty() ? (server ? "library-server" : "library-console")
                                    : "grid:" + available.front()["id"].string());
  };
  auto all = libraryGames(),
       consoleGames = serverLibrary_ ? games([this](const Json &g) { return ready(g); }) : all;
  const auto console = selectedConsole();
  const auto presence = localConsoleSelected() ? "LOCAL" : console["presence"].string("OFFLINE");
  const auto consoleLabel = friendly(presence) + " / " + std::to_string(consoleGames.size()) +
                            (consoleGames.size() == 1 ? " game" : " games");
  button(
      "library-server", "On Server", {Tokens::safe, scopeY, 220, 50}, 1, [choose] { choose(true); },
      false, !offlineMode_, serverLibrary_);
  button(
      "library-console", consoleLabel, {Tokens::safe + 238, scopeY, 270, 50}, 1,
      [choose] { choose(false); }, false, true, !serverLibrary_);
  if (all.empty()) {
    if (focus_.id() == "first-card")
      focus_.select(serverLibrary_ ? "library-server" : "library-console");
    draw().label(serverLibrary_ ? "Nothing available on this server yet"
                                : "No games reported by this PS5",
                 Tokens::safe, 270, Tokens::title, Tokens::white, 1000, 2);
    draw().label(serverLibrary_ ? "Add a dump or package to the server watch folder."
                                : "Refresh after the local agent finishes scanning the console.",
                 Tokens::safe, 410, Tokens::body, Tokens::muted, 800, 2);
    return;
  }
  bool validFocus = false;
  for (const auto &g : all)
    validFocus |= focus_.id() == "grid:" + g["id"].string();
  if (focus_.id() == "first-card" || (!validFocus && focus_.id().rfind("grid:", 0) == 0))
    focus_.select("grid:" + all.front()["id"].string());
  Json selected = all.front();
  for (const auto &g : all)
    if (focus_.id() == "grid:" + g["id"].string()) {
      selected = g;
      break;
    }
  Json release;
  auto releases = selected["releases"];
  for (size_t i = 0; i < releases.size(); i++)
    if (releases[i]["kind"].string() != "DLC") {
      release = releases[i];
      break;
    }
  const float x = Tokens::safe, titleY = 238;
  auto name = selected["title"].string("Untitled game");
  const int titleSize =
      draw().measure(name, Tokens::title) > 820 ? Tokens::compactTitle : Tokens::title;
  draw().label(name, x, titleY, titleSize, Tokens::white, 820, 2);
  const float statusY = titleY + draw().textHeight(name, titleSize, 820, 2) + 20;
  if (serverLibrary_) {
    const auto status = serverReady(selected) ? "READY ON SERVER" : "NEEDS PREPARATION";
    const auto statusColor = serverReady(selected) ? Tokens::success : Tokens::warning;
    const float statusW = draw().measure(status, Tokens::caption) + 32;
    draw().rounded({x, statusY, statusW, 34}, {16, 27, 39, 224}, 17);
    draw().label(status, x + 16, statusY + 6, Tokens::caption, statusColor);
  }
  const float copyY = statusY + (serverLibrary_ ? 62 : 0);
  auto description = selected["description"].string("Open the game to view details and actions.");
  draw().label(description, x, copyY, Tokens::body, {218, 225, 235, 255}, 760, 3);
  std::string metadata = selected["platform"].string("PS5");
  if (!release["version"].string().empty())
    metadata += "  /  Version " + release["version"].string();
  if (!release["size"].null())
    metadata += "  /  " + amount(release["size"].number());
  draw().label(metadata, x, copyY + 122, Tokens::caption, Tokens::muted, 780, 2);
  draw().icon("cross", x + 12, copyY + 179, Tokens::white);
  draw().label("Open game", x + 36, copyY + 166, Tokens::control, Tokens::white);
  if (serverLibrary_) {
    draw().label("Server library", Tokens::safe, Tokens::libraryStripY - 48, Tokens::heading);
    draw().label(std::to_string(all.size()) + (all.size() == 1 ? " game" : " games"),
                 Tokens::width - Tokens::safe - 130, Tokens::libraryStripY - 45, Tokens::caption,
                 Tokens::muted);
  }
  float target = 0;
  for (size_t i = 0; i < all.size(); i++)
    if (focus_.id() == "grid:" + all[i]["id"].string()) {
      const float left = i * (Tokens::libraryTileWidth + Tokens::gap);
      target =
          std::max(0.f, left - (Tokens::width - Tokens::safe * 2 - Tokens::libraryTileWidth) / 2);
    }
  target = std::min(target, std::max(0.f, all.size() * (Tokens::libraryTileWidth + Tokens::gap) -
                                              Tokens::gap - (Tokens::width - Tokens::safe * 2)));
  auto &offset = scroll_[serverLibrary_ ? "library-server" : "library-console"];
  offset += (target - offset) * std::min(1.f, delta_ * 14);
  SDL_Rect clip{static_cast<int>(Tokens::safe - 12), static_cast<int>(Tokens::libraryStripY - 12),
                static_cast<int>(Tokens::width - Tokens::safe + 12),
                static_cast<int>(Tokens::libraryTileHeight + 24)};
  SDL_RenderSetClipRect(renderer_, &clip);
  for (size_t i = 0; i < all.size(); i++) {
    Rect rect{Tokens::safe + i * (Tokens::libraryTileWidth + Tokens::gap) - offset,
              Tokens::libraryStripY, Tokens::libraryTileWidth, Tokens::libraryTileHeight};
    const auto id = "grid:" + all[i]["id"].string();
    focus_.add(id, 2, {rect.x, rect.y, rect.w, rect.h});
    actions_[id] = [this, g = all[i]] { openGame(g["id"].string()); };
    rects_[id] = rect;
    if (rect.x + rect.w < 0 || rect.x > Tokens::width)
      continue;
    auto &a = animation_[id];
    a += (focus_.id() == id ? 1.f - a : -a) * std::min(1.f, delta_ / Tokens::focusSeconds);
    rect.y -= a * 4;
    draw().rounded(rect, a > .05f ? Tokens::surfaceActive : Tokens::surface, 16);
    gameImage(all[i], {rect.x + 12, rect.y + 12, 96, rect.h - 24});
    draw().label(all[i]["title"].string(), rect.x + 126, rect.y + 20, Tokens::body, Tokens::white,
                 static_cast<int>(rect.w - 144), 2);
    auto itemReleases = all[i]["releases"];
    std::string version;
    for (size_t n = 0; n < itemReleases.size(); n++)
      if (itemReleases[n]["kind"].string() != "DLC") {
        version = itemReleases[n]["version"].string();
        break;
      }
    draw().label(version.empty() ? all[i]["platform"].string("PS5") : "Version " + version,
                 rect.x + 126, rect.y + 98, Tokens::caption, Tokens::muted,
                 static_cast<int>(rect.w - 144));
    if (serverLibrary_) {
      const auto itemState = serverReady(all[i]) ? "Ready" : "Prepare";
      draw().label(itemState, rect.x + 126, rect.y + 123, Tokens::caption,
                   serverReady(all[i]) ? Tokens::accent : Tokens::warning);
    }
    if (a > .01f) {
      draw().outline(rect, a, 16);
      draw().rounded(
          {rect.x + rect.w * .34f, rect.y + rect.h + 6, rect.w * .32f, 4},
          {Tokens::accent.r, Tokens::accent.g, Tokens::accent.b, static_cast<Uint8>(220 * a)}, 2);
    }
  }
  SDL_RenderSetClipRect(renderer_, nullptr);
}
void Storefront::details() {
  auto g = game(gameId_), r = selectedRelease();
  const float y = Tokens::safe, coverW = Tokens::width * .19f,
              x = Tokens::safe + coverW + Tokens::gap * 3;
  gameImage(g, {Tokens::safe, y, coverW, coverW * 1.3f});
  draw().label(g["title"].string(), x, y + 10, Tokens::title, Tokens::white, 1100, 2);
  draw().label(list(g["genres"]), x, y + Tokens::title * 2 + Tokens::gap, Tokens::body,
               Tokens::accent);
  draw().label(g["description"].string("Description unavailable."), x,
               y + Tokens::title * 2 + Tokens::gap * 4, Tokens::body, Tokens::muted, 1080, 3);
  draw().label(releaseLabel(r) + "    " +
                   (r["size"].null() ? "Size not scanned" : amount(r["size"].number())) + "    " +
                   friendly(r["kind"].string()) + "    " + r["region"].string("Region unknown"),
               x, y + 300, Tokens::body);
  draw().label(list(r["languages"]) + "    " + g["publisher"].string(), x, y + 343, Tokens::caption,
               Tokens::muted);
  auto library = model_["library"];
  const bool selectedReady = releaseReady(r, library);
  const auto playableId = playable(g, r);
  const bool admin = model_["profile"]["role"].string() == "ADMIN",
             downloadable = r["artifacts"].size() > 0,
             preparable = admin && r["sources"].size() > 0;
  const auto action =
      gameActionState(!playableId.empty(), deliveryActive(r, installations(), jobs(), consoleId_),
                      selectedReady, offlineMode_, downloadable, preparable);
  button(
      "download", action.label, {x, y + 410, 290, 66}, 1,
      [this, playableId] {
        if (!playableId.empty()) {
#ifdef PS5LIBRARY_NATIVE
          localCommand("/api/v1/agent/titles/" + playableId + "/launch", [](const Json &) {});
#else
          launchTitle_ = playableId;
          running_ = false;
#endif
          return;
        }
        screenFocus_["before-modal"] = focus_.id();
        modal_ = "Download";
        modalStep_ = 0;
        releasePage_ = 0;
        releaseAddons_ = false;
        storageId_.clear();
        focus_.select("release-games");
        plan_ = Json();
        if (!consoleId_.empty())
          plan();
      },
      true, action.enabled);
  Json installed;
  for (size_t i = 0; i < library.size(); i++)
    if (library[i]["releaseId"].string() == r["id"].string()) {
      installed = library[i];
      break;
    }
  if (!selectedReady)
    draw().label(r["artifacts"].size() ? "Verified copy ready on server"
                                       : "Server preparation required",
                 x + 330, y + 421, Tokens::body, Tokens::muted, 700);
  if (selectedReady) {
    draw().label(installed["registrationBlocked"].boolean() ? "Old PS5 registration needs cleanup"
                                                            : "Available on your PS5",
                 x + 330, y + 421, Tokens::body,
                 installed["registrationBlocked"].boolean() ? Tokens::warning : Tokens::accent);
    draw().label(installed["registrationBlocked"].boolean()
                     ? "The game files are safe. Remove the stale *FG* "
                       "registration before mounting this dump."
                 : playableId.empty() ? "Mount this dump with its supported launcher first."
                                      : "Play closes PS5Library and opens the game.",
                 x, y + 495, Tokens::caption, Tokens::muted, 1080, 2);
  }
  if (installed["canMove"].boolean())
    button(
        "move-game", "Move", {x + 320, y + 410, 240, 66}, 1,
        [this, installed] {
          removal_ = installed;
          removalConsole_ = selectedConsole();
          screenFocus_["before-modal"] = focus_.id();
          modal_ = "MoveGame";
          focus_.select("move-cancel");
        },
        false, localConsoleSelected());
  if (installed["canDelete"].boolean())
    button(
        "remove-game", "Delete from PS5", {x + 590, y + 410, 310, 66}, 1,
        [this, installed] {
          removal_ = installed;
          removalConsole_ = selectedConsole();
          screenFocus_["before-modal"] = focus_.id();
          modal_ = "RemoveGame";
          focus_.select("remove-cancel");
        },
        false, localConsoleSelected() || !offlineMode_);
  float lower = Tokens::height * .65f;
  draw().label("Available releases", Tokens::safe, lower, Tokens::heading);
  auto releases = g["releases"];
  for (size_t i = 0; i < releases.size() && i < 5; i++) {
    auto release = releases[i];
    float w = (Tokens::width - Tokens::safe * 2 - Tokens::gap * 4) / 5;
    button(
        "release:" + std::to_string(i), releaseLabel(release),
        {Tokens::safe + i * (w + Tokens::gap), lower + 48, w, 58}, 3, [this, i] { release_ = i; },
        false, true, i == release_);
  }
  draw().label("Screenshots", Tokens::safe, lower + 146, Tokens::heading);
  auto shots = g["screenshotUrls"];
  for (size_t i = 0; i < shots.size() && i < 4; i++) {
    auto url = shots[i].string();
    Rect shot{Tokens::safe + i * 250, lower + 190, 230, 125};
    wantArtwork(url, shot);
    draw().cover(art_->get(url), shot);
  }
  if (!shots.size())
    draw().label("No screenshots supplied for this release.", Tokens::safe, lower + 195,
                 Tokens::caption, Tokens::muted);
  Json profileConsole;
  auto profileConsoles = model_["profile"]["consoles"];
  for (size_t i = 0; i < profileConsoles.size(); i++)
    if (profileConsoles[i]["id"].string() == consoleId_)
      profileConsole = profileConsoles[i];
  std::vector<Json> saves;
  auto reported = profileConsole["saveData"];
  for (size_t i = 0; i < reported.size(); i++)
    if (reported[i]["gameTitleId"].string() == g["titleId"].string() ||
        reported[i]["saveTitleId"].string() == g["titleId"].string())
      saves.push_back(reported[i]);
  const float saveX = Tokens::width * .57f;
  draw().label("Save data", saveX, lower + 146, Tokens::heading);
  if (saves.empty())
    draw().label("No save data reported for this game.", saveX, lower + 195, Tokens::caption,
                 Tokens::muted);
  else
    for (size_t i = 0; i < saves.size() && i < 2; i++) {
      const auto save = saves[i];
      const auto name =
          save["subtitle"].string(save["title"].string(save["directory"].string("Save data")));
      draw().label(name, saveX, lower + 190 + i * 64, Tokens::body, Tokens::white, 720);
      draw().label(amount(save["sizeBytes"].number()) + "   Updated " +
                       saveDate(save["modifiedAt"].number()),
                   saveX, lower + 222 + i * 64, Tokens::caption, Tokens::muted, 720);
    }
  if (advanced_)
    draw().label(g["titleId"].string() + "  " + r["contentId"].string(), x, y + 550,
                 Tokens::caption, Tokens::muted);
}
void Storefront::downloadJobs() {
  title("Activity", "Downloads, preparation and installation continue when "
                    "you leave this screen.");
  std::vector<std::pair<Json, bool>> list;
  auto currentJobs = reorderIds_.empty() ? jobs() : orderedJobs(), pending = installations();
  for (size_t i = 0; i < currentJobs.size(); i++)
    list.push_back({currentJobs[i], false});
  for (size_t i = 0; i < pending.size(); i++) {
    auto state = pending[i]["state"].string();
    if (pending[i]["transferJobId"].null() && state != "READY_ON_PS5" && state != "ERROR" &&
        state != "CANCELLED")
      list.push_back({pending[i], true});
  }
  auto key = [&](size_t i) {
    return std::string(list[i].second ? "installation:" : "job:") + list[i].first["id"].string();
  };
  auto target = [this](const Json &job) {
    std::string value;
    auto all = consoles();
    for (size_t n = 0; n < all.size(); n++)
      if (all[n]["id"].string() == job["consoleId"].string()) {
        value = all[n]["name"].string();
        auto stores = all[n]["storage"];
        for (size_t s = 0; s < stores.size(); s++)
          if (stores[s]["storageId"].string() == job["storageId"].string())
            value += "  /  " + stores[s]["displayName"].string();
      }
    return value;
  };
  const float top = 270, queueW = Tokens::downloadQueueWidth, summaryX = Tokens::safe + queueW + 48;
  size_t first = static_cast<size_t>(scroll_["jobs"]);
  if (first >= list.size())
    first = 0;
  if (list.size() && !downloadItemCount_)
    focus_.select(key(0));
  downloadItemCount_ = list.size();
  for (size_t i = 0; i < list.size(); i++)
    if (focus_.id() == key(i)) {
      if (i < first)
        first = i;
      if (i >= first + 3)
        first = i - 2;
    }
  scroll_["jobs"] = static_cast<float>(first);
  for (size_t i = 0; i < list.size(); i++)
    focus_.add(key(i), static_cast<int>(i) + 1,
               {Tokens::safe,
                top + (static_cast<int>(i) - static_cast<int>(first)) * Tokens::downloadRowHeight,
                queueW, Tokens::downloadRowHeight - 10});
  float y = top;
  for (size_t i = first; i < list.size() && i < first + 3; i++) {
    auto j = list[i].first;
    const bool installation = list[i].second;
    auto g = installation ? gameForSourceRelease(j["sourceReleaseId"].string())
                          : gameForRelease(j["releaseId"].string());
    auto id = key(i);
    auto &animatedY = animation_["queue-y:" + id];
    if (animatedY < 1)
      animatedY = y;
    animatedY += (y - animatedY) * std::min(1.f, delta_ * 15);
    const bool moving = reorderMode_ && id == "job:" + reorderJobId_;
    Rect row{Tokens::safe + (moving ? 10 : 0), animatedY - (moving ? 4 : 0),
             queueW - (moving ? 10 : 0), Tokens::downloadRowHeight - 10};
    auto &selected = animation_[id];
    selected += (focus_.id() == id ? 1.f - selected : -selected) *
                std::min(1.f, delta_ / Tokens::focusSeconds);
    if (selected > .03f || moving) {
      draw().rounded(row,
                     moving ? SDL_Color{31, 59, 88, 235}
                            : SDL_Color{27, 41, 58, static_cast<Uint8>(110 + 90 * selected)},
                     12);
      draw().outline(row, moving ? 1.f : selected, 12);
    }
    if (moving) {
      const float pulse = .55f + .45f * std::sin(SDL_GetTicks() / 120.f);
      draw().rounded({row.x, row.y + 18, 4, row.h - 36},
                     {Tokens::accent.r, Tokens::accent.g, Tokens::accent.b,
                      static_cast<Uint8>(150 + 95 * pulse)},
                     2);
      badge("MOVING", {row.x + row.w - 132, row.y + 14, 112, 28});
    }
    if (!g.null())
      actions_[id] = [this, g] { openGame(g["id"].string()); };
    rects_[id] = row;
    gameImage(g, {row.x + 16, row.y + 16, 100, 142});
    const float x = row.x + 142, w = row.w - 166, ry = row.y;
    draw().label(j["title"].string(g["title"].string("Selected release")), x, ry + 10,
                 Tokens::heading, Tokens::white, static_cast<int>(w - 220), 1);
    const auto state = j["state"].string();
    const bool building = !installation && j["kind"].string() == "BUILD",
               stopped = state == "ERROR" || state == "CANCELLED";
    auto p = j["progress"], byteProgress = buildByteProgress(j);
    const auto reportedStage = p["stage"].string();
    auto stateLabel = building && !stopped && state != "COMPLETED" && !reportedStage.empty()
                          ? friendly(reportedStage)
                          : friendly(state);
    if (state == "QUEUED" && !j["queuePosition"].null())
      stateLabel += "  /  Queue " + std::to_string(j["queuePosition"].number());
    const auto stateColor = state == "ERROR"                                  ? Tokens::danger
                            : state == "COMPLETED" || state == "READY_ON_PS5" ? Tokens::success
                            : state == "CANCELLED"                            ? Tokens::muted
                                                                              : Tokens::accent;
    draw().label(stateLabel, x, ry + 48, Tokens::caption, stateColor, static_cast<int>(w));
    if (stopped)
      draw().label(j["error"].string(state == "CANCELLED" ? "Download cancelled"
                                                          : "No error details were reported."),
                   x, ry + 86, Tokens::caption, state == "ERROR" ? Tokens::danger : Tokens::muted,
                   static_cast<int>(w), 2);
    else if (installation) {
      draw().bar({x, ry + 91, w, 7}, 0, 0);
      draw().label(state == "WAITING_FOR_PS5"       ? "Waiting for your PS5 to come online"
                   : state == "WAITING_FOR_STORAGE" ? "Waiting for compatible writable storage"
                                                    : "Preparing game and compatibility files",
                   x, ry + 111, Tokens::caption, Tokens::muted, static_cast<int>(w));
    } else if (j["kind"].string() == "DELETE") {
      if (state != "COMPLETED")
        draw().bar({x, ry + 91, w, 7}, 0, 0);
      draw().label(state == "COMPLETED" ? "Removed from PS5; inventory confirmed"
                                        : "Removing game from your PS5",
                   x, ry + 111, Tokens::caption, Tokens::muted);
    } else if (building && !byteProgress.null()) {
      auto done = byteProgress["completedBytes"].number(),
           total = byteProgress["totalBytes"].number();
      draw().bar({x, ry + 91, w, 7}, done, total);
      std::string metrics =
          std::to_string(std::clamp(done * 100 / total, int64_t(0), int64_t(100))) + "%  /  " +
          amount(done) + " / " + amount(total);
      if (state == "DOWNLOADING" && j["speedBytesPerSecond"].number() > 0)
        metrics += "  /  " + amount(j["speedBytesPerSecond"].number()) + "/s";
      draw().label(metrics, x, ry + 111, Tokens::caption, Tokens::muted);
    } else if (building) {
      if (state != "COMPLETED")
        draw().bar({x, ry + 91, w, 7}, 0, 0);
      draw().label(state == "COMPLETED"    ? "Preparation complete"
                   : reportedStage.empty() ? "Preparing on your server"
                                           : friendly(reportedStage),
                   x, ry + 111, Tokens::caption, Tokens::muted);
    } else {
      auto total = j["totalBytes"].number(), done = j["downloadedBytes"].number();
      draw().bar({x, ry + 91, w, 7}, done, total);
      std::string metrics =
          (total
               ? std::to_string(std::clamp(done * 100 / total, int64_t(0), int64_t(100))) + "%  /  "
               : "") +
          amount(done) + (total ? " / " + amount(total) : " transferred");
      if (j["speedBytesPerSecond"].number() > 0)
        metrics += "  /  " + amount(j["speedBytesPerSecond"].number()) + "/s";
      if (!j["etaSeconds"].null())
        metrics += "  /  About " + std::to_string(j["etaSeconds"].number() / 60) + "m " +
                   std::to_string(j["etaSeconds"].number() % 60) + "s";
      draw().label(metrics, x, ry + 111, Tokens::caption, Tokens::muted);
    }
    auto destination = target(j);
    draw().label(destination.empty() ? "Server preparation" : "To " + destination, x, ry + 148,
                 Tokens::caption, Tokens::muted, static_cast<int>(w));
    draw().fill({row.x, row.y + row.h - 1, row.w, 1}, {126, 148, 174, 58});
    y += Tokens::downloadRowHeight;
  }
  if (!list.size())
    draw().label("You're all caught up.", Tokens::safe, top + 55, Tokens::heading, Tokens::muted);
  draw().fill({summaryX - 24, top - 8, 1, 610}, {126, 148, 174, 60});
  draw().label("Current route", summaryX, top, Tokens::heading);
  size_t route = list.size();
  for (size_t i = 0; i < list.size(); i++) {
    auto state = list[i].first["state"].string();
    if (state != "COMPLETED" && state != "READY_ON_PS5" && state != "ERROR" &&
        state != "CANCELLED") {
      route = i;
      break;
    }
  }
  if (route == list.size() && list.size())
    route = 0;
  if (route < list.size()) {
    auto job = list[route].first;
    auto destination = target(job);
    draw().label("Destination", summaryX, top + 58, Tokens::caption, Tokens::muted);
    draw().label(destination.empty() ? "Server cache" : destination, summaryX, top + 88,
                 Tokens::body, Tokens::white, static_cast<int>(Tokens::downloadSummaryWidth), 2);
    draw().label("Pipeline", summaryX, top + 162, Tokens::caption, Tokens::muted);
    draw().label(job["kind"].string() == "TRANSFER" ? "Transfer after verification"
                                                    : "Verify before transfer",
                 summaryX, top + 192, Tokens::body, Tokens::white,
                 static_cast<int>(Tokens::downloadSummaryWidth), 2);
    draw().label("Next in queue", summaryX, top + 272, Tokens::caption, Tokens::muted);
    int next = 0;
    for (size_t i = 0; i < list.size() && next < 3; i++)
      if (i != route) {
        auto jobGame = list[i].second
                           ? gameForSourceRelease(list[i].first["sourceReleaseId"].string())
                           : gameForRelease(list[i].first["releaseId"].string());
        next++;
        draw().label(std::to_string(next) + "   " +
                         list[i].first["title"].string(jobGame["title"].string("Selected release")),
                     summaryX, top + 306 + (next - 1) * 48, Tokens::caption, Tokens::white,
                     static_cast<int>(Tokens::downloadSummaryWidth), 1);
      }
    if (!next)
      draw().label("No other active jobs", summaryX, top + 306, Tokens::caption, Tokens::muted);
  } else
    draw().label("Waiting for the next job.", summaryX, top + 58, Tokens::body, Tokens::muted,
                 static_cast<int>(Tokens::downloadSummaryWidth), 2);
}
void Storefront::myPS5() {
  auto c = selectedConsole();
  const bool selectedLocal = localConsoleSelected();
  title(c["name"].string("My PS5"), (selectedLocal ? "LOCAL" : c["presence"].string("OFFLINE")) +
                                        "    Firmware " + c["firmware"].string("unknown"));
  float y = Tokens::header + Tokens::title + Tokens::gap * 7, x = Tokens::safe;
  button(
      "refresh-console", "Refresh console information",
      {Tokens::width - Tokens::safe - 470, Tokens::header + Tokens::gap * 2, 470, 58}, 0,
      [this, selectedLocal] {
        if (selectedLocal)
          localCommand("/api/v1/agent/refresh", [this](const Json &value) {
            if (offlineMode_)
              applyLocalSnapshot(value);
            else
              observeLocalSnapshot(value);
            lastLocalRefresh_ = SDL_GetTicks();
            toast("Console scan refreshed.");
          });
        else
          request("POST", "/api/v1/device/consoles/" + consoleId_ + "/refresh", Json::object(),
                  [this](const Json &) {
                    toast("Firmware refresh requested. Your PS5 will measure "
                          "it when connected.");
                    lastRefresh_ = 0;
                  });
      },
      false, selectedLocal || (!offlineMode_ && !c.null() && !options_.preview));
  auto all = consoles();
  for (size_t i = 0; i < all.size() && i < 4; i++) {
    button(
        "console:" + all[i]["id"].string(), all[i]["name"].string(), {x, y, 330, 57}, 1,
        [this, id = all[i]["id"].string()] {
          consoleId_ = id;
          lastRefresh_ = 0;
        },
        false, true, all[i]["id"].string() == consoleId_);
    x += 350;
  }
  y += 98;
  const auto observed = c["runtimeStatus"];
  const bool local = selectedLocal || c["presence"].string() == "LOCAL",
             online = c["presence"].string() == "ONLINE" || local;
  const auto shadow = !online ? "Last seen: " + friendly(observed["shadowMount"].string("UNKNOWN"))
                              : friendly(observed["shadowMount"].string("UNKNOWN"));
  const auto backport = observed["backportConflict"].boolean() ? "Runtime conflict"
                        : observed["fakelibEnabled"].null()    ? "Unknown"
                        : observed["fakelibEnabled"].boolean() ? "Runtime enabled"
                                                               : "Runtime disabled";
  const std::vector<std::pair<std::string, std::string>> facts = {
      {"PS5Library Agent", local    ? (localAgentSeen_ ? "Local scan active" : "Waiting for scan")
                           : online ? "Connected"
                                    : "Offline"},
      {"ShadowMountPlus", shadow},
      {"Backport runtime", backport},
      {"Games", std::to_string(c["games"].number())}};
  x = Tokens::safe;
  for (const auto &[name, value] : facts) {
    draw().label(name, x, y, Tokens::caption, Tokens::muted);
    draw().label(value, x, y + 37, Tokens::heading, Tokens::white,
                 static_cast<int>(Tokens::width * .225f), 2);
    x += Tokens::width * .235f;
  }
  y += 130;
  draw().label(c["capabilities"]["nativeDownloads"].boolean()
                   ? "FPKG downloads use PS5 Downloads. ShadowMount "
                     "transfers run while the store is open."
                   : "Console transfers run while PS5Library is open.",
               Tokens::safe, y - 33, Tokens::caption, Tokens::muted);
  const auto format = c["storageFormat"];
  const auto formatState = format["formatState"].string();
  if (formatState == "STARTING" || formatState == "FORMATTING" || formatState == "ERROR" ||
      formatState == "COMPLETE" || formatState == "RECONNECT_REQUIRED") {
    const auto active = formatState == "STARTING" || formatState == "FORMATTING";
    draw().rounded({Tokens::safe, y, Tokens::width - Tokens::safe * 2, 72},
                   active ? SDL_Color{24, 49, 74, 245} : Tokens::surface, 18);
    draw().label(formatState == "COMPLETE" ? "USB extended storage is ready"
                 : formatState == "RECONNECT_REQUIRED"
                     ? "USB formatted — unplug and reconnect it once"
                 : formatState == "ERROR" ? "USB formatting failed"
                                          : "Formatting USB extended storage",
                 Tokens::safe + 24, y + 16, Tokens::body,
                 formatState == "ERROR" ? Tokens::danger : Tokens::white);
    if (active)
      draw().bar({Tokens::safe + 520, y + 31, Tokens::width - Tokens::safe * 2 - 550, 8},
                 format["formatProgress"].number(), 100);
    else if (formatState == "ERROR")
      draw().label(friendly(format["formatError"].string("Unknown error")), Tokens::safe + 520,
                   y + 20, Tokens::caption, Tokens::muted,
                   static_cast<int>(Tokens::width - Tokens::safe * 2 - 550), 2);
    y += 92;
  }
  const bool localConsole = selectedLocal;
  auto storage = Json::array(), cards = storageCards(c["storage"]);
  for (size_t i = 0; i < cards.size(); i++)
    if (cards[i]["installMethodsSupported"].size() ||
        (localConsole && formatEligibleStorage(cards[i])))
      storage.add(cards[i]);
  for (size_t i = 0; i < storage.size() && i < 4; i++) {
    auto s = storage[i];
    float w = (Tokens::width - Tokens::safe * 2 - Tokens::gap) / 2;
    Rect rect{Tokens::safe + (i % 2) * (w + Tokens::gap), y + (i / 2) * 210, w, 180};
    draw().rounded(rect, Tokens::surface, 20);
    draw().label(s["displayName"].string(), rect.x + 30, rect.y + 25, Tokens::heading);
    draw().bar({rect.x + 30, rect.y + 90, rect.w - 60, 9},
               s["totalBytes"].number() - s["freeBytes"].number(), s["totalBytes"].number());
    draw().label(amount(s["freeBytes"].number()) + " available", rect.x + 30, rect.y + 120,
                 Tokens::body, Tokens::muted, static_cast<int>(rect.w - 320));
    if (localConsole && formatEligibleStorage(s))
      button("format-storage:" + s["storageId"].string(), "Format for PS5",
             {rect.x + rect.w - 250, rect.y + 112, 220, 48}, 3 + static_cast<int>(i / 2),
             [this, s] {
               formatStorage_ = s;
               screenFocus_["before-modal"] = focus_.id();
               modal_ = "FormatStorage";
               focus_.select("format-cancel");
             });
  }
  if (!storage.size()) {
    draw().label("No compatible storage reported", Tokens::safe, y + 28, Tokens::heading);
    draw().label("Refresh after the local agent reports a writable "
                 "destination and supported install method.",
                 Tokens::safe, y + 76, Tokens::body, Tokens::muted, 1050, 2);
  }
}
void Storefront::footer() {
  draw().fade({0, Tokens::height - 68, Tokens::width, 68}, false);
  draw().label(options_.preview ? "DESIGN PREVIEW"
               : offlineMode_   ? (localAgentSeen_ ? "OFFLINE MODE  ·  LOCAL CONSOLE"
                                                   : "OFFLINE MODE  ·  WAITING FOR LOCAL AGENT")
               : offline_       ? "SERVER OFFLINE  ·  Cached collection"
               : loading_ && !serverConnected_ ? "CONNECTING TO SERVER  ·  Cached collection"
                                               : "PS5Library",
               Tokens::safe, Tokens::height - 39, Tokens::caption, Tokens::muted);
  const std::vector<std::pair<std::string, std::string>> hints =
      reorderMode_ ? std::vector<std::pair<std::string, std::string>>{{"move", "Move"},
                                                                      {"cross", "Release to save"},
                                                                      {"circle", "Cancel"}}
      : page_ == "Game" ? std::vector<std::pair<std::string, std::string>>{{"cross", "Select"},
                                                                           {"circle", "Back"}}
      : page_ == "Downloads"
          ? std::vector<std::pair<std::string, std::string>>{{"options", "Actions"},
                                                             {"shoulders", "Switch Tab"},
                                                             {"cross", "View / hold to reorder"},
                                                             {"circle", "Back"}}
          : std::vector<std::pair<std::string, std::string>>{{"triangle", "Utilities"},
                                                             {"shoulders", "Switch Tab"},
                                                             {"cross", "Select"},
                                                             {"circle", "Back"}};
  float total = 0;
  for (const auto &hint : hints)
    total += draw().measure(hint.second, Tokens::caption) +
             (hint.first == "shoulders" ? 94
              : hint.first == "move"    ? 78
              : hint.first == "options" ? 46
                                        : 36) +
             26;
  float x = Tokens::width - Tokens::safe - total + 26, cy = Tokens::height - 28;
  for (const auto &[kind, label] : hints) {
    if (kind == "shoulders") {
      for (int i = 0; i < 2; i++) {
        draw().rounded({x + i * 39, cy - 11, 31, 22}, {225, 232, 241, 255}, 4);
        draw().label(i ? "R1" : "L1", x + i * 39 + 4, cy - 10, Tokens::caption, Tokens::background);
      }
      x += 94;
    } else if (kind == "options") {
      draw().rounded({x, cy - 11, 34, 22}, Tokens::white, 5);
      for (int i = 0; i < 3; i++)
        draw().stroke(x + 8, cy - 5 + i * 5, x + 26, cy - 5 + i * 5, Tokens::background, 1.7f);
      x += 46;
    } else if (kind == "move") {
      draw().label("UP/DOWN", x, cy - 10, Tokens::caption, Tokens::accent);
      x += 78;
    } else {
      if (kind == "cross") {
        draw().rounded({x, cy - 12, 24, 24}, Tokens::white, 12);
        draw().icon(kind, x + 12, cy, Tokens::background);
      } else
        draw().icon(kind, x + 12, cy);
      x += 36;
    }
    draw().label(label, x, cy - 11, Tokens::caption);
    x += draw().measure(label, Tokens::caption) + 26;
  }
}
