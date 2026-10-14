#include "storefront.hpp"

void Storefront::avatarModal() {
  const float x = Tokens::width * .13f, y = Tokens::height * .16f, w = Tokens::width * .74f;
  draw().fill({0, 0, Tokens::width, Tokens::height}, {2, 6, 12, 225});
  draw().rounded({x, y, w, Tokens::height * .7f}, {22, 32, 47, 248}, 28);
  draw().label("Choose your account picture", x + 35, y + 30, Tokens::title);
  draw().label("Choose game artwork, or upload a picture from Profile on your server.", x + 35,
               y + 108, Tokens::body, Tokens::muted);
  button("avatar-default", "Use default", {x + 35, y + 170, 270, 55}, 1, [this] {
    request("DELETE", "/api/v1/device/profile/avatar", Json(), [this](const Json &) {
      closeModal();
      lastRefresh_ = 0;
    });
  });
  auto all = catalog();
  for (size_t i = 0; i < std::min(size_t(14), all.size()); i++) {
    auto g = all[i];
    Rect rect{x + 35 + (i % 7) * 190, y + 265 + (i / 7) * 185, 162, 162};
    gameImage(g, rect);
    button(
        "avatar:" + g["id"].string(), "Select", {rect.x, rect.y + 112, rect.w, 44},
        2 + static_cast<int>(i / 7),
        [this, g] {
          request("PUT", "/api/v1/device/profile/avatar", Json::object({{"gameId", g["id"]}}),
                  [this](const Json &) {
                    closeModal();
                    lastRefresh_ = 0;
                  });
        },
        false, true);
  }
}
void Storefront::optionsModal() {
  const float x = Tokens::width * .13f, y = Tokens::height * .1f, w = Tokens::width * .74f,
              h = Tokens::height * .8f, left = x + 42, right = x + w * .52f, row = y + 145;
  draw().fill({0, 0, Tokens::width, Tokens::height}, {2, 6, 12, 220});
  draw().rounded({x, y, w, h}, {22, 32, 47, 250}, 28);
  draw().label("Options", left, y + 34, Tokens::title);
  draw().label("Press Circle to return", right, y + 57, Tokens::caption, Tokens::muted);
  button("network", "Server connection", {left, row, w * .42f, 62}, 1,
         [this] { networkSettings(); });
  button(
      "offline", offlineMode_ ? "Offline mode: on" : "Offline mode: off",
      {left, row + 82, w * .42f, 62}, 2, [this] { setOfflineMode(!offlineMode_); }, false,
      !updateRequest_.valid(), offlineMode_);
  button("advanced", advanced_ ? "Advanced information: on" : "Advanced information: off",
         {left, row + 164, w * .42f, 62}, 3, [this] { advanced_ = !advanced_; });
  button(
      "sounds",
      audio_->cuesAvailable()
          ? (audio_->enabled() ? "Interface sounds: on" : "Interface sounds: off")
          : "Interface sounds unavailable",
      {left, row + 246, w * .42f, 62}, 4,
      [this] {
        auto next = config_.deepCopy();
        next.set("interfaceSounds", !audio_->enabled());
        try {
          if (!options_.preview)
            atomicJson(options_.config, next);
          config_ = next;
          audio_->setEnabled(next["interfaceSounds"].boolean());
        } catch (const std::exception &) {
          toast("Could not save the sound setting.");
        }
      },
      false, audio_->cuesAvailable());
  button("autoplay",
         config_["autoplayTrailers"].null() || config_["autoplayTrailers"].boolean()
             ? "Trailer previews: on"
             : "Trailer previews: off",
         {left, row + 328, w * .42f, 62}, 5, [this] { togglePreference("autoplayTrailers"); });
  button("game-music",
         config_["gameMusic"].null() || config_["gameMusic"].boolean() ? "Game music: on"
                                                                       : "Game music: off",
         {right, row, w * .42f, 62}, 1, [this] { togglePreference("gameMusic"); });
  button("trailer-sound",
         config_["trailerSound"].null() || config_["trailerSound"].boolean() ? "Trailer sound: on"
                                                                             : "Trailer sound: off",
         {right, row + 82, w * .42f, 62}, 2, [this] { togglePreference("trailerSound"); });
  bool available = !updateManifest_.null();
  button(
      "app-update",
      available ? (nativeFrontend ? "Install update" : "Update & restart")
                : "Check for app updates",
      {right, row + 164, w * .42f, 62}, 3, [this, available] { appUpdate(available); }, available,
      !offlineMode_ && !updateRequest_.valid() && !credential_.empty() &&
          (!nativeFrontend || !available || localAgentSeen_));
  draw().label("PS5Library " + std::string(appVersion), right, row + 254, Tokens::body);
  draw().label(updateStatus_, right, row + 292, Tokens::caption, Tokens::muted,
               static_cast<int>(w * .42f), 2);
  if (updating_) {
    draw().bar({right, row + 355, w * .42f, 8}, updateBytes_, updateTotal_);
    draw().label(amount(updateBytes_) + " / " + amount(updateTotal_), right, row + 375,
                 Tokens::caption, Tokens::muted);
  }
  draw().label(config_["serverUrl"].string().empty() ? "No server configured"
                                                     : config_["serverUrl"].string(),
               left, y + h - 105, Tokens::caption, Tokens::muted, static_cast<int>(w - 84));
}
void Storefront::networkModal() {
  const float x = Tokens::width * .16f, y = Tokens::height * .16f, w = Tokens::width * .68f,
              h = Tokens::height * .72f;
  draw().fill({0, 0, Tokens::width, Tokens::height}, {2, 6, 12, 220});
  draw().rounded({x, y, w, h}, {22, 32, 47, 248}, 28);
  bool switching = modal_ == "SwitchServer";
  draw().label(switching ? "Switch servers?" : "Connect your library", x + 42, y + 36,
               Tokens::title);
  draw().label(switching ? "Pair this console again on the new server."
                         : "Enter the PS5Library server address from your PC.",
               x + 42, y + 116, Tokens::body, Tokens::muted, static_cast<int>(w - 84));
  if (networkPaused_) {
    draw().label("Saving your connection…", x + 42, y + 260, Tokens::heading);
    draw().bar({x + 42, y + 330, w - 84, 8}, 0, 0);
    return;
  }
  if (switching) {
    draw().label(draftServer_, x + 42, y + 215, Tokens::heading, Tokens::accent,
                 static_cast<int>(w - 84), 2);
    draw().label("Your downloaded files stay on this PS5.", x + 42, y + 335, Tokens::body,
                 Tokens::muted);
    button(
        "switch-server", "Switch & pair again", {x + 42, y + h - 190, w - 84, 66}, 1,
        [this] { saveNetwork(true); }, true);
    button("keep-server", "Keep current server", {x + 42, y + h - 100, 360, 56}, 2, [this] {
      modal_ = "Network";
      focus_.select("server-input");
    });
    return;
  }
  draw().label("Server address", x + 42, y + 175, Tokens::caption, Tokens::accent);
  button("server-input", draftServer_.empty() ? "https://library.example.net" : draftServer_,
         {x + 42, y + 207, w - 84, 64}, 1, [this] {
           replaceDraft_ = true;
           SDL_StartTextInput();
         });
  draw().label("Tailscale fallback (optional)", x + 42, y + 292, Tokens::caption, Tokens::accent);
  button("fallback-input", draftFallback_.empty() ? "http://100.x.x.x:3150" : draftFallback_,
         {x + 42, y + 324, w - 84, 64}, 2, [this] {
           replaceDraft_ = true;
           SDL_StartTextInput();
         });
  button("allow-http", draftHttp_ ? "Private HTTP: On" : "Private HTTP: Off",
         {x + 42, y + 414, w - 84, 54}, 3, [this] {
           draftHttp_ = !draftHttp_;
           SDL_StopTextInput();
         });
  draw().label("The normal address is always tried first. Tailscale is used "
               "only when that connection fails.",
               x + 42, y + 486, Tokens::caption, Tokens::muted, static_cast<int>(w - 84), 2);
  button(
      "save-server", "Save & connect", {x + 42, y + h - 190, w - 84, 66}, 4,
      [this] { saveNetwork(); }, true, !draftServer_.empty());
  button("cancel-server", "Cancel", {x + 42, y + h - 100, 200, 56}, 5, [this] { closeModal(); });
}
void Storefront::installReview() {
  const float x = 90, y = 58, w = 1740, h = 930;
  draw().fill({0, 0, Tokens::width, Tokens::height}, {2, 6, 12, 218});
  draw().rounded({x, y, w, h}, {18, 27, 40, 250}, 24);
  auto g = game(gameId_), r = selectedRelease();
  draw().label("Download and install", x + 40, y + 32, Tokens::title);
  draw().label("Review everything on one screen. Unsupported choices stay "
               "unavailable.",
               x + 40, y + 103, Tokens::body, Tokens::muted, 1050, 2);
  button("install-close", "Cancel", {x + w - 210, y + 35, 170, 52}, 0, [this] { closeModal(); });
  const float artX = x + 40, artY = y + 162;
  gameImage(g, {artX, artY, 238, 310});
  draw().label(g["title"].string(), artX, artY + 334, Tokens::heading, Tokens::white, 260, 3);
  draw().label(releaseLabel(r), artX, artY + 432, Tokens::caption, Tokens::accent, 260, 2);
  draw().label(r["size"].null() ? "Size unavailable" : amount(r["size"].number()), artX, artY + 486,
               Tokens::body, Tokens::muted);
  const float contentX = x + 324, contentW = 850;
  draw().label("Version", contentX, artY, Tokens::heading);
  auto releases = g["releases"];
  std::vector<size_t> choices;
  size_t addons = 0;
  for (size_t i = 0; i < releases.size(); i++) {
    const bool dlc = releases[i]["kind"].string() == "DLC";
    addons += dlc;
    if (dlc == releaseAddons_)
      choices.push_back(i);
  }
  button(
      "release-games", "Game and updates", {contentX, artY + 42, 240, 45}, 1,
      [this] {
        releaseAddons_ = false;
        releasePage_ = 0;
      },
      false, true, !releaseAddons_);
  button(
      "release-dlc", "DLC  " + std::to_string(addons), {contentX + 254, artY + 42, 170, 45}, 1,
      [this] {
        releaseAddons_ = true;
        releasePage_ = 0;
      },
      false, addons > 0, releaseAddons_);
  const size_t pages = std::max(size_t(1), (choices.size() + 2) / 3);
  releasePage_ = std::min(releasePage_, pages - 1);
  const float choiceW = (contentW - 28) / 3;
  for (size_t n = releasePage_ * 3; n < choices.size() && n < (releasePage_ + 1) * 3; n++) {
    const auto index = choices[n], column = n % 3;
    button(
        "version:" + std::to_string(index), releaseLabel(releases[index]),
        {contentX + column * (choiceW + 14), artY + 100, choiceW, 62}, 2,
        [this, index] {
          release_ = index;
          storageId_.clear();
          plan();
        },
        false, true, index == release_);
  }
  if (choices.empty())
    draw().label("No inspected release is available in this group.", contentX, artY + 112,
                 Tokens::body, Tokens::muted);
  if (pages > 1) {
    button(
        "releases-prev", "Previous", {contentX + contentW - 210, artY + 42, 94, 45}, 1,
        [this] {
          if (releasePage_)
            releasePage_--;
        },
        false, releasePage_ > 0);
    button(
        "releases-next", "Next", {contentX + contentW - 102, artY + 42, 102, 45}, 1,
        [this] { releasePage_++; }, false, releasePage_ + 1 < pages);
  }
  draw().label("Target PS5", contentX, artY + 190, Tokens::heading);
  auto all = consoles();
  const float consoleW = (contentW - 14) / 2;
  for (size_t i = 0; i < all.size() && i < 4; i++)
    button(
        "target:" + std::to_string(i),
        all[i]["name"].string() + "  /  " + friendly(all[i]["presence"].string("OFFLINE")),
        {contentX + (i % 2) * (consoleW + 14), artY + 232 + (i / 2) * 76, consoleW, 62},
        3 + static_cast<int>(i / 2),
        [this, id = all[i]["id"].string()] {
          consoleId_ = id;
          storageId_.clear();
          plan();
        },
        false, true, all[i]["id"].string() == consoleId_);
  draw().label("Install method", contentX, artY + 398, Tokens::heading);
  auto methods = plan_["methods"];
  auto methodLabel = [](const std::string &value) {
    return value == "SHADOWMOUNT" ? "Quick play" : value == "FPKG" ? "Console install" : "Homebrew";
  };
  const float methodW = (contentW - 28) / 3;
  for (size_t i = 0; i < methods.size() && i < 3; i++) {
    auto value = methods[i].string();
    button(
        "method:" + value, methodLabel(value),
        {contentX + i * (methodW + 14), artY + 440, methodW, 62}, 5,
        [this, value] {
          storageId_.clear();
          plan(value);
        },
        value == method_, true, value == method_);
  }
  if (plan_.null())
    draw().label("Checking compatibility and supported methods...", contentX, artY + 456,
                 Tokens::body, Tokens::muted);
  draw().label("Storage", contentX, artY + 530, Tokens::heading);
  auto stores = plan_["storage"];
  if (storageId_.empty())
    for (size_t i = 0; i < stores.size(); i++)
      if (stores[i]["allowed"].boolean()) {
        storageId_ = stores[i]["storageId"].string();
        break;
      }
  const float storageW = (contentW - 14) / 2;
  for (size_t i = 0; i < stores.size() && i < 4; i++) {
    auto store = stores[i];
    button(
        "destination:" + std::to_string(i),
        store["displayName"].string() + "  /  " + amount(store["freeBytes"].number()) + " free",
        {contentX + (i % 2) * (storageW + 14), artY + 572 + (i / 2) * 76, storageW, 62},
        6 + static_cast<int>(i / 2), [this, id = store["storageId"].string()] { storageId_ = id; },
        false, store["allowed"].boolean(), store["storageId"].string() == storageId_);
  }
  const float summaryX = x + 1245, summaryW = 455;
  draw().fill({summaryX - 24, artY, 1, 650}, {126, 148, 174, 65});
  draw().label("Install summary", summaryX, artY, Tokens::heading);
  draw().label("Game", summaryX, artY + 62, Tokens::caption, Tokens::muted);
  draw().label(g["title"].string(), summaryX, artY + 91, Tokens::body, Tokens::white, summaryW, 2);
  draw().label("Version", summaryX, artY + 160, Tokens::caption, Tokens::muted);
  draw().label(releaseLabel(r), summaryX, artY + 189, Tokens::body, Tokens::white, summaryW, 2);
  draw().label("Destination", summaryX, artY + 258, Tokens::caption, Tokens::muted);
  std::string destination = "Choose storage";
  for (size_t i = 0; i < stores.size(); i++)
    if (stores[i]["storageId"].string() == storageId_)
      destination = stores[i]["displayName"].string();
  draw().label(selectedConsole()["name"].string("Choose a PS5") + "  /  " + destination, summaryX,
               artY + 287, Tokens::body, Tokens::white, summaryW, 2);
  draw().label("Compatibility", summaryX, artY + 365, Tokens::caption, Tokens::muted);
  draw().label(plan_.null() ? "Checking..."
                            : friendly(plan_["compatibility"]["status"].string("UNKNOWN")),
               summaryX, artY + 394, Tokens::body,
               plan_["allowed"].boolean() ? Tokens::success : Tokens::warning, summaryW, 2);
  const bool allowed = plan_["allowed"].boolean() && !storageId_.empty();
  button(
      "confirm-download", "Download and prepare", {summaryX, artY + 532, summaryW, 68}, 8,
      [this] {
        const bool direct = plan_["directArtifact"].boolean();
        auto body = direct ? Json::object({{"artifactId", plan_["artifactId"]},
                                           {"consoleId", consoleId_},
                                           {"storageId", storageId_}})
                           : Json::object({{"sourceReleaseId", plan_["sourceReleaseId"]},
                                           {"consoleId", consoleId_},
                                           {"storageId", storageId_},
                                           {"method", method_}});
        request("POST", direct ? "/api/v1/device/transfers" : "/api/v1/device/installations", body,
                [this](const Json &) {
                  closeModal();
                  navigate("Downloads");
                  lastRefresh_ = 0;
                  toast("Download added to Activity");
                });
      },
      true, allowed);
  if (!allowed && !plan_.null())
    draw().label(plan_["message"].string("Choose an available storage destination."), summaryX,
                 artY + 618, Tokens::caption, Tokens::muted, summaryW, 2);
}
void Storefront::searchModal() {
  draw().fill({0, 0, Tokens::width, Tokens::height}, Tokens::background);
  draw().label("Search your library", Tokens::safe, Tokens::safe * 1.5f, Tokens::title);
  button("search-input", query_.empty() ? "Search games, publishers and genres…" : query_,
         {Tokens::safe, Tokens::safe * 3, Tokens::width - Tokens::safe * 2, 78}, 0,
         [] { SDL_StartTextInput(); });
  auto results = games([this](const Json &g) {
    return lower(g["title"].string() + " " + g["publisher"].string() + " " + list(g["genres"]) +
                 (advanced_ ? g["titleId"].string() : ""))
               .find(lower(query_)) != std::string::npos;
  });
  rail("Results", results, Tokens::safe * 5.5f, 2);
  button("search-back", "Close search", {Tokens::safe, Tokens::height - Tokens::safe - 70, 260, 58},
         4, [this] { closeModal(); });
}
void Storefront::removalModal() {
  const float w = Tokens::width * .6f, h = 460, x = (Tokens::width - w) / 2,
              y = (Tokens::height - h) / 2;
  draw().fill({0, 0, Tokens::width, Tokens::height}, {2, 6, 12, 215});
  draw().rounded({x, y, w, h}, {22, 32, 47, 250}, 28);
  draw().label("Delete from PS5?", x + 40, y + 35, Tokens::title);
  draw().label(removal_["title"].string(), x + 40, y + 120, Tokens::heading, Tokens::white,
               static_cast<int>(w - 80), 2);
  std::string destination = removalConsole_["name"].string();
  auto stores = removalConsole_["storage"];
  for (size_t i = 0; i < stores.size(); i++)
    if (stores[i]["storageId"].string() == removal_["storageId"].string())
      destination += " / " + stores[i]["displayName"].string();
  draw().label(destination, x + 40, y + 205, Tokens::body, Tokens::accent,
               static_cast<int>(w - 80));
  draw().label("Remove the game files from this console. Your server copy "
               "stays available.",
               x + 40, y + 260, Tokens::body, Tokens::muted, static_cast<int>(w - 80), 2);
  button("remove-confirm", "Delete from PS5", {x + 40, y + h - 85, w * .53f, 55}, 1, [this] {
    auto entry = removal_, console = removalConsole_;
    if (selectedConsoleIsLocal(localAgentSeen_, device_, console))
      localCommand("/api/v1/agent/titles/" + entry["titleId"].string() + "/delete/" +
                       entry["storageId"].string(),
                   [this](const Json &) {
                     closeModal();
                     lastLocalRefresh_ = 0;
                     localSnapshotRevision_ = 0;
                     toast("Removal started on this PS5");
                   });
    else
      request("POST", "/api/v1/device/consoles/" + console["id"].string() + "/library/remove",
              Json::object({{"releaseId", entry["releaseId"]},
                            {"storageId", entry["storageId"]},
                            {"confirm", true}}),
              [this](const Json &) {
                closeModal();
                navigate("Downloads");
                lastRefresh_ = 0;
                toast("Removal queued for your PS5");
              });
  });
  button("remove-cancel", "Keep game", {x + w * .61f, y + h - 85, w * .39f - 40, 55}, 1,
         [this] { closeModal(); });
}
void Storefront::moveModal() {
  const float w = Tokens::width * .6f, h = 570, x = (Tokens::width - w) / 2,
              y = (Tokens::height - h) / 2;
  draw().fill({0, 0, Tokens::width, Tokens::height}, {2, 6, 12, 215});
  draw().rounded({x, y, w, h}, {22, 32, 47, 250}, 28);
  draw().label("Move game", x + 40, y + 35, Tokens::title);
  draw().label(removal_["title"].string(), x + 40, y + 112, Tokens::heading, Tokens::white,
               static_cast<int>(w - 80), 2);
  const bool native =
      removal_["nativeRegistered"].boolean() &&
      (removal_["source"].string() == "INSTALLED_TITLE" || removal_["method"].string() == "FPKG");
  draw().label(native ? "Choose another PS5 storage location."
                      : "Choose another ShadowMount storage location.",
               x + 40, y + 170, Tokens::body, Tokens::muted);
  const bool selectedLocal = selectedConsoleIsLocal(localAgentSeen_, device_, removalConsole_);
  auto stores = removalConsole_["storage"];
  Json source;
  for (size_t i = 0; i < stores.size(); i++)
    if (stores[i]["storageId"].string() == removal_["storageId"].string()) {
      source = stores[i];
      break;
    }
  float top = y + 225;
  int row = 1, count = 0;
  for (size_t i = 0; selectedLocal && i < stores.size() && count < 4; i++) {
    auto storage = stores[i];
    if (!moveDestinationEligible(removal_, source, storage))
      continue;
    auto id = storage["storageId"].string();
    button("move:" + id, storage["displayName"].string(), {x + 40, top + count * 68, w - 80, 54},
           row + count, [this, id] {
             auto entry = removal_;
             if (!selectedConsoleIsLocal(localAgentSeen_, device_, removalConsole_)) {
               toast("Select this PS5 to move its game.");
               return;
             }
             localCommand("/api/v1/agent/titles/" + entry["titleId"].string() + "/move/" +
                              entry["storageId"].string() + "/" + id,
                          [this](const Json &) {
                            closeModal();
                            lastLocalRefresh_ = 0;
                            localSnapshotRevision_ = 0;
                            toast("Move started on this PS5");
                          });
           });
    count++;
  }
  if (!count)
    draw().label(selectedLocal ? "No other compatible writable storage is available."
                               : "Select this PS5 to move its game.",
                 x + 40, top + 24, Tokens::body, Tokens::muted);
  button("move-cancel", "Cancel", {x + 40, y + h - 78, 190, 50}, 8, [this] { closeModal(); });
}
void Storefront::formatStorageModal() {
  const float w = Tokens::width * .58f, h = 520, x = (Tokens::width - w) / 2,
              y = (Tokens::height - h) / 2;
  const auto total = formatStorage_["totalBytes"].number();
  draw().fill({0, 0, Tokens::width, Tokens::height}, {2, 6, 12, 225});
  draw().rounded({x, y, w, h}, {22, 32, 47, 252}, 28);
  draw().label("Format USB extended storage?", x + 40, y + 35, Tokens::title);
  draw().label(formatStorage_["displayName"].string(), x + 40, y + 120, Tokens::heading,
               Tokens::white, static_cast<int>(w - 80), 2);
  draw().label("Capacity: " + amount(total) + "  /  " + std::to_string(total) + " bytes", x + 40,
               y + 175, Tokens::body, Tokens::muted, static_cast<int>(w - 80));
  draw().label("All data on this USB drive will be permanently erased.", x + 40, y + 245,
               Tokens::heading, Tokens::danger, static_cast<int>(w - 80), 2);
  draw().label("The drive will be prepared for PS5 extended storage. This "
               "cannot be undone.",
               x + 40, y + 315, Tokens::body, Tokens::muted, static_cast<int>(w - 80), 2);
  const bool busy = localCommandRequest_.valid();
  button(
      "format-confirm", busy ? "Preparing drive..." : "Erase & Format",
      {x + 40, y + h - 85, w * .45f, 55}, 1,
      [this] {
        const auto storage = formatStorage_;
        const auto prepare = formatStoragePath(storage, "prepare");
        if (prepare.empty()) {
          toast("This USB drive is no longer eligible for formatting.");
          return;
        }
        focus_.select("format-cancel");
        localCommand(prepare, [this, storage](const Json &result) {
          const auto confirm = formatStoragePath(storage, "confirm", result["challenge"].string());
          if (confirm.empty()) {
            toast("The agent did not return a valid format confirmation.");
            return;
          }
          localCommand(confirm, [this, id = storage["storageId"].string()](const Json &) {
            if (modal_ == "FormatStorage" && formatStorage_["storageId"].string() == id)
              closeModal();
            lastLocalRefresh_ = 0;
            localSnapshotRevision_ = 0;
            toast("USB formatting started. Keep the drive connected.");
          });
        });
      },
      false, !busy);
  button(
      "format-cancel", "Cancel", {x + w * .55f, y + h - 85, w * .45f - 40, 55}, 1,
      [this] { closeModal(); }, true, !busy);
}
void Storefront::jobContextModal() {
  const float w = Tokens::width * .62f, h = 570, x = (Tokens::width - w) / 2,
              y = (Tokens::height - h) / 2;
  auto g = jobContextInstallation_ ? gameForSourceRelease(jobContext_["sourceReleaseId"].string())
                                   : gameForRelease(jobContext_["releaseId"].string());
  auto state = jobContext_["state"].string(), error = jobContext_["error"].string(),
       location = jobContext_["location"].string();
  draw().fill({0, 0, Tokens::width, Tokens::height}, {2, 6, 12, 220});
  draw().rounded({x, y, w, h}, {22, 32, 47, 252}, 28);
  draw().label(jobContextInstallation_ ? "Installation details" : "Download options", x + 40,
               y + 35, Tokens::title);
  draw().label(jobContext_["title"].string(g["title"].string("Selected release")), x + 40, y + 112,
               Tokens::heading, Tokens::white, static_cast<int>(w - 80), 2);
  draw().label(friendly(state), x + 40, y + 169, Tokens::body, Tokens::accent);
  draw().label(error.empty() ? "No error reported." : "Error: " + error, x + 40, y + 218,
               Tokens::caption, error.empty() ? Tokens::muted : SDL_Color{255, 166, 166, 255},
               static_cast<int>(w - 80), 2);
  draw().label(location.empty() ? "Location: No verified file was created."
                                : "Location: " + location,
               x + 40, y + 273, Tokens::caption, Tokens::muted, static_cast<int>(w - 80), 2);
  float bx = x + 40;
  int row = 1;
  const bool terminal =
      state == "COMPLETED" || state == "READY_ON_PS5" || state == "ERROR" || state == "CANCELLED";
  if (jobContextInstallation_) {
    button(
        "installation-cancel", "Cancel installation", {bx, y + h - 160, 300, 58}, row,
        [this] {
          auto id = jobContext_["id"].string();
          request("DELETE", "/api/v1/device/installations/" + id, Json(), [this](const Json &) {
            closeModal();
            lastRefresh_ = 0;
            toast("Installation cancelled");
          });
        },
        true);
    bx += 320;
  } else if (!terminal) {
    button(
        "job-cancel", "Cancel download", {bx, y + h - 160, 260, 58}, row,
        [this] {
          auto id = jobContext_["id"].string();
          request("POST", "/api/v1/device/jobs/" + id + "/control",
                  Json::object({{"action", "cancel"}}), [this](const Json &) {
                    closeModal();
                    lastRefresh_ = 0;
                    toast("Download cancelled");
                  });
        },
        true);
    bx += 280;
  } else if (state == "ERROR") {
    button(
        "job-retry", "Retry", {bx, y + h - 160, 230, 58}, row,
        [this] {
          auto id = jobContext_["id"].string();
          request("POST", "/api/v1/device/jobs/" + id + "/control",
                  Json::object({{"action", "retry"}}), [this](const Json &) {
                    closeModal();
                    lastRefresh_ = 0;
                    toast("Retry queued");
                  });
        },
        true);
    bx += 250;
  }
  if (!g.null()) {
    button("job-open", "View game", {bx, y + h - 160, 230, 58}, row, [this, g] {
      closeModal();
      openGame(g["id"].string());
    });
    bx += 250;
  }
  if (!jobContextInstallation_ &&
      (state == "COMPLETED" || state == "READY_ON_PS5" || state == "ERROR" || state == "CANCELLED"))
    button("job-remove", "Remove from Downloads", {bx, y + h - 160, 330, 58}, row, [this] {
      auto id = jobContext_["id"].string();
      request("DELETE", "/api/v1/device/jobs/" + id, Json(), [this](const Json &) {
        closeModal();
        lastRefresh_ = 0;
        toast("Removed from Downloads");
      });
    });
  button("job-close", "Close", {x + 40, y + h - 80, 190, 50}, 2, [this] { closeModal(); });
}
