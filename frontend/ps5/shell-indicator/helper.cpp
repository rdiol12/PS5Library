/*
 * Copyright (C) 2026 PS5Library contributors
 * Uses OnionHEN's pinned GPL detour implementation.
 * GPL-3.0-or-later. See LICENSE.GPL-3.0.
 */
#include "homeui_patch.hpp"
#include "lifecycle.hpp"
#if defined(PS5LIBRARY_EXPERIMENTAL_SHELL_CHEAT_PAGE)
#include "cheat_page.hpp"
#endif

#include <onion/detour.h>

#include <array>
#include <atomic>
#include <cerrno>
#include <chrono>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <limits>
#include <mutex>
#include <optional>
#include <ps5/kernel.h>
#include <signal.h>
#include <string>
#if defined(PS5LIBRARY_EXPERIMENTAL_SHELL_CHEAT_PAGE)
#include <arpa/inet.h>
#include <netinet/in.h>
#include <sys/socket.h>
#include <sys/time.h>
#endif
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>
#include <utility>
#include <unordered_map>

struct MonoDomain;
struct MonoAssembly;
struct MonoImage;
struct MonoClass;
struct MonoMethod;
struct MonoObject;
struct MonoArray;
struct MonoProperty;
struct MonoString;
struct MonoThread;

extern int (*sceKernelMprotect)(void*, std::size_t, int);
extern bool has_hv_bypass;
extern "C" {
extern const unsigned char ps5library_shell_icon[];
extern const std::uint64_t ps5library_shell_icon_size;
}

namespace {

constexpr char statePath[] =
    "/system_tmp/ps5library/agent-indicator.state";
constexpr char readyPath[] = "/system_tmp/ps5library/shell-helper.pid";
constexpr char statusPath[] = "/system_tmp/ps5library/shell-helper.status";
constexpr char iconPath[] = "/system_tmp/ps5library/icon0.png";
constexpr char homeTitleId[] = "NPXS40002";
constexpr char indicatorUri[] = "PS5Library?Status=1";
constexpr unsigned long decryptRnpsBundle = 0xC0105203;
constexpr std::uint64_t ptraceAuthId = 0x4800000000010003ULL;

class AuthIdGuard final {
 public:
  AuthIdGuard() {
    previous_ = kernel_get_ucred_authid(getpid());
    active_ = previous_ != 0 &&
              kernel_set_ucred_authid(getpid(), ptraceAuthId) == 0;
  }
  ~AuthIdGuard() {
    if (active_) (void)kernel_set_ucred_authid(getpid(), previous_);
  }
  explicit operator bool() const noexcept { return active_; }

 private:
  std::uint64_t previous_ = 0;
  bool active_ = false;
};

struct SystemSoftwareVersion {
  std::uint64_t size;
  char text[28];
  std::uint32_t version;
  std::uint64_t reserved;
};

struct RnpsArgs {
  void* buffer;
  int size;
  int error;
};

using Ioctl = int (*)(int, unsigned long, void*);
using MonoGetRootDomain = MonoDomain* (*)();
using MonoThreadAttach = MonoThread* (*)(MonoDomain*);
using MonoDomainAssemblyOpen = MonoAssembly* (*)(MonoDomain*, const char*);
using MonoAssemblyGetImage = MonoImage* (*)(MonoAssembly*);
using MonoClassFromName = MonoClass* (*)(MonoImage*, const char*, const char*);
using MonoClassGetMethod = MonoMethod* (*)(MonoClass*, const char*, int);
using MonoCompileMethod = std::uint64_t (*)(MonoMethod*);
using MonoStringNew = MonoString* (*)(MonoDomain*, const char*);
using MonoStringToUtf8 = char* (*)(MonoString*);
using MonoFree = void (*)(void*);
using MonoObjectToString = MonoString* (*)(MonoObject*, MonoObject**);
using Update = void (*)(MonoObject*);
using Reload = void (*)(MonoString*);
using Boot3 = bool (*)(MonoString*, int, MonoString*);
using Boot2 = bool (*)(MonoString*, int);
using SetIconSource = void (*)(MonoObject*, MonoObject*);

#if defined(PS5LIBRARY_EXPERIMENTAL_SHELL_CHEAT_PAGE)
using MonoDomainGet = MonoDomain* (*)();
using MonoObjectGetClass = MonoClass* (*)(MonoObject*);
using MonoClassGetProperty = MonoProperty* (*)(MonoClass*, const char*);
using MonoPropertyGetMethod = MonoMethod* (*)(MonoProperty*);
using MonoRuntimeInvoke = MonoObject* (*)(MonoMethod*, void*, void**,
                                          MonoObject**);
using MonoArrayNew = MonoArray* (*)(MonoDomain*, MonoClass*, std::uint32_t);
using MonoGetByteClass = MonoClass* (*)();
using MonoArrayAddress = char* (*)(MonoArray*, int, std::uintptr_t);
using MonoObjectNew = MonoObject* (*)(MonoDomain*, MonoClass*);
using MonoGcHandleNew = std::uint32_t (*)(MonoObject*, int);
using MonoGcHandleFree = void (*)(std::uint32_t);
using GetManifestResource = std::uint64_t (*)(std::uint64_t, MonoString*);
using OnPressed = int (*)(MonoObject*, MonoObject*, MonoObject*);
#endif

#if defined(PS5LIBRARY_EXPERIMENTAL_SHELL_INPUT_DIAGNOSTIC)
// Exact managed value layout used by OnionHEN b23ffe6 for
// Sce.PlayStation.Core.Input.GamePad.GetData(int).
struct GamePadData {
  bool Skip = false;
  std::uint32_t Buttons = 0;
  std::uint32_t ButtonsPrev = 0;
  std::uint32_t ButtonsDown = 0;
  std::uint32_t ButtonsUp = 0;
  float AnalogLeftX = 0;
  float AnalogLeftY = 0;
  float AnalogRightX = 0;
  float AnalogRightY = 0;
};
static_assert(sizeof(GamePadData) == 36);
static_assert(offsetof(GamePadData, Buttons) == 4);
static_assert(offsetof(GamePadData, ButtonsDown) == 12);
static_assert(offsetof(GamePadData, ButtonsUp) == 16);
using GetGamePadData = GamePadData (*)(int);
#endif

Ioctl originalIoctl = nullptr;
Update originalUpdate = nullptr;
Boot3 originalBoot3 = nullptr;
Boot2 originalBoot2 = nullptr;
SetIconSource originalSetIconSource = nullptr;
SetIconSource setInvertedIconSource = nullptr;
Reload reloadHome = nullptr;
MonoDomain* rootDomain = nullptr;
MonoStringNew monoStringNew = nullptr;
MonoStringToUtf8 monoStringToUtf8 = nullptr;
MonoFree monoFree = nullptr;
MonoObjectToString monoObjectToString = nullptr;
#if defined(PS5LIBRARY_EXPERIMENTAL_SHELL_CHEAT_PAGE)
MonoDomainGet monoDomainGet = nullptr;
MonoObjectGetClass monoObjectGetClass = nullptr;
MonoClassGetProperty monoClassGetProperty = nullptr;
MonoPropertyGetMethod monoPropertyGetMethod = nullptr;
MonoRuntimeInvoke monoRuntimeInvoke = nullptr;
MonoArrayNew monoArrayNew = nullptr;
MonoGetByteClass monoGetByteClass = nullptr;
MonoArrayAddress monoArrayAddress = nullptr;
MonoObjectNew monoObjectNew = nullptr;
MonoGcHandleNew monoGcHandleNew = nullptr;
MonoGcHandleFree monoGcHandleFree = nullptr;
GetManifestResource originalGetManifestResource = nullptr;
OnPressed originalOnPressed = nullptr;
MonoClass* memoryStreamClass = nullptr;
MonoMethod* memoryStreamConstructor = nullptr;
#endif
#if defined(PS5LIBRARY_EXPERIMENTAL_SHELL_INPUT_DIAGNOSTIC)
GetGamePadData originalGetGamePadData = nullptr;
#endif
std::atomic<bool> hooksReady{false};
std::atomic<bool> patchEnabled{false};
std::atomic<bool> reloadPending{false};
std::atomic<int> homePatchResult{-1};
const char* installStage = "STARTING";
#if defined(PS5LIBRARY_EXPERIMENTAL_SHELL_CHEAT_PAGE)
std::atomic<bool> cheatPageReady{false};
#endif

#if defined(PS5LIBRARY_EXPERIMENTAL_SHELL_INPUT_DIAGNOSTIC)
constexpr char inputTracePath[] =
    "/system_tmp/ps5library/options-input.trace";

bool atomicWrite(const char* path, const std::string& value) {
  if (::mkdir("/system_tmp/ps5library", 0755) != 0 && errno != EEXIST)
    return false;
  struct stat directory {};
  if (::lstat("/system_tmp/ps5library", &directory) != 0 ||
      !S_ISDIR(directory.st_mode) || S_ISLNK(directory.st_mode))
    return false;
  const std::string temporary =
      std::string(path) + "." + std::to_string(getpid()) + ".tmp";
  const int descriptor =
      ::open(temporary.c_str(), O_CREAT | O_TRUNC | O_WRONLY | O_NOFOLLOW,
             0600);
  if (descriptor < 0) return false;
  std::size_t offset = 0;
  while (offset < value.size()) {
    const auto written =
        ::write(descriptor, value.data() + offset, value.size() - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) break;
    offset += static_cast<std::size_t>(written);
  }
  const bool complete = offset == value.size();
  const bool synced = complete && ::fsync(descriptor) == 0;
  const bool closed = ::close(descriptor) == 0;
  if (!complete || !synced || !closed ||
      ::rename(temporary.c_str(), path) != 0) {
    ::unlink(temporary.c_str());
    return false;
  }
  return true;
}

class InputTrace final {
 public:
  void setSession(const std::string& session, bool active) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (active_ == active && session_ == session) return;
    active_ = active;
    session_ = session;
    for (auto& slot : slots_) {
      slot.device = -1;
      slot.initialized = false;
      slot.shortcut.reset();
    }
    appendLocked(active ? "session=active" : "session=inactive");
  }

  void sample(int device, const GamePadData& value, std::uint64_t nowMs) {
    std::lock_guard<std::mutex> lock(mutex_);
    if (!active_ || device < 0) return;
    Slot* slot = nullptr;
    for (auto& candidate : slots_) {
      if (candidate.device == device) {
        slot = &candidate;
        break;
      }
      if (!slot && candidate.device < 0) slot = &candidate;
    }
    if (!slot) return;
    if (slot->device < 0) slot->device = device;

    const ps5library::shell_indicator::OptionsSample input{
        value.Buttons, value.ButtonsDown, value.ButtonsUp};
    const bool pressed =
        (input.buttons &
         ps5library::shell_indicator::optionsStartButtonMask) != 0;
    if (!slot->initialized) {
      const bool startsNow =
          (input.buttonsDown &
           ps5library::shell_indicator::optionsStartButtonMask) != 0;
      slot->shortcut.reset(pressed && !startsNow);
      slot->initialized = true;
    }
    const auto observed = ps5library::shell_indicator::observeOptions(
        slot->shortcut, input, nowMs);
    if (!observed.down && !observed.up && !observed.doublePress) return;

    char line[128]{};
    std::snprintf(line, sizeof(line),
                  "event=%llu ms=%llu device=%d down=%u up=%u double=%u",
                  static_cast<unsigned long long>(++sequence_),
                  static_cast<unsigned long long>(nowMs), device,
                  observed.down ? 1U : 0U, observed.up ? 1U : 0U,
                  observed.doublePress ? 1U : 0U);
    appendLocked(line);
  }

  void flush(std::uint64_t nowMs) {
    std::string snapshot;
    std::uint64_t generation = 0;
    {
      std::lock_guard<std::mutex> lock(mutex_);
      if (!dirty_ || nowMs < nextFlushMs_) return;
      snapshot = "PS5LIBRARY-OPTIONS/1\n";
      for (std::size_t index = 0; index < count_; ++index)
        snapshot += records_[(first_ + index) % records_.size()] + "\n";
      generation = generation_;
    }
    const bool written = atomicWrite(inputTracePath, snapshot);
    std::lock_guard<std::mutex> lock(mutex_);
    if (written && generation_ == generation) dirty_ = false;
    nextFlushMs_ = written ? nowMs : nowMs + 5'000;
  }

 private:
  struct Slot {
    int device = -1;
    bool initialized = false;
    ps5library::shell_indicator::OptionsDoublePress shortcut;
  };

  void appendLocked(std::string line) {
    const auto index = (first_ + count_) % records_.size();
    records_[index] = std::move(line);
    if (count_ < records_.size())
      ++count_;
    else
      first_ = (first_ + 1) % records_.size();
    ++generation_;
    dirty_ = true;
  }

  std::mutex mutex_;
  std::array<Slot, 4> slots_{};
  std::array<std::string, 32> records_{};
  std::string session_;
  std::size_t first_ = 0;
  std::size_t count_ = 0;
  std::uint64_t sequence_ = 0;
  std::uint64_t generation_ = 0;
  std::uint64_t nextFlushMs_ = 0;
  bool active_ = false;
  bool dirty_ = false;
};

InputTrace inputTrace;
#endif

#if defined(PS5LIBRARY_EXPERIMENTAL_SHELL_CHEAT_PAGE)
std::string monoText(MonoString* value);
constexpr char cheatSessionPath[] =
    "/system_tmp/ps5library/cheat-shell-session";
constexpr char cheatSnapshotPath[] =
    "/system_tmp/ps5library/cheats.snapshot.v1";
constexpr char debugSettingsResource[] =
    "Sce.Vsh.ShellUI.Legacy.src.Sce.Vsh.ShellUI.Settings.Plugins."
    "DebugSettings.data.debug_settings.xml";
constexpr char debugSettingsUri[] =
    "pssettings:play?mode=settings&function=debug_settings";
constexpr char debugSettingsUriSimple[] =
    "pssettings:play?function=debug_settings";
constexpr std::uint16_t cheatAgentPort = 37953;

struct PendingCheatAction {
  ps5library::shell_indicator::CheatRow row;
  std::string session;
  bool enabled = false;
  bool approve = false;
};

enum class MemoryAction {
  StartExact, StartUnknown, RefineExact, Changed, Unchanged, Increased,
  Decreased, Watch, Write, Freeze, Unfreeze, Restore, Clear
};
struct PendingMemoryAction {
  MemoryAction action = MemoryAction::Watch;
  std::string session;
  std::string value;
  std::string resultId;
  std::string valueType;
  std::string titleId;
  std::string version;
  std::string scanId;
};

std::mutex cheatPageMutex;
ps5library::shell_indicator::CheatSession displayedCheatSession;
ps5library::shell_indicator::CheatSnapshot displayedCheatSnapshot;
std::optional<PendingCheatAction> pendingCheatAction;
std::optional<PendingMemoryAction> pendingMemoryAction;
std::unordered_map<std::string, std::string> memoryDrafts;
std::atomic<std::uint64_t> cheatPagePendingUntilMs{0};
std::atomic<bool> cheatPageActive{false};
std::mutex xmlStreamMutex;
std::array<std::uint32_t, 4> xmlStreamHandles{};
std::size_t xmlStreamHandleCursor = 0;

std::uint64_t unixMilliseconds() {
  const auto value = std::chrono::duration_cast<std::chrono::milliseconds>(
                         std::chrono::system_clock::now().time_since_epoch())
                         .count();
  return value > 0 ? static_cast<std::uint64_t>(value) : 0;
}

bool readSecureFile(const char* path, std::size_t maximum,
                    std::string& result) {
  const int descriptor = ::open(path, O_RDONLY | O_NOFOLLOW);
  if (descriptor < 0) return false;
  struct File {
    int descriptor;
    ~File() { ::close(descriptor); }
  } file{descriptor};
  struct stat details {};
  if (::fstat(descriptor, &details) != 0 || !S_ISREG(details.st_mode) ||
      (details.st_mode & (S_IRWXG | S_IRWXO)) != 0 || details.st_size <= 0 ||
      details.st_size > static_cast<off_t>(maximum))
    return false;
  result.assign(static_cast<std::size_t>(details.st_size), '\0');
  std::size_t offset = 0;
  while (offset < result.size()) {
    const auto count =
        ::read(descriptor, result.data() + offset, result.size() - offset);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return false;
    offset += static_cast<std::size_t>(count);
  }
  return true;
}

bool sameSession(const ps5library::shell_indicator::CheatSession& left,
                 const ps5library::shell_indicator::CheatSession& right) {
  return left.session == right.session && left.token == right.token &&
         left.agentPid == right.agentPid;
}

bool loadCheatState(ps5library::shell_indicator::CheatSession& session,
                    ps5library::shell_indicator::CheatSnapshot& snapshot) {
  const auto now = unixMilliseconds();
  std::string encodedSession, encodedSnapshot, confirmedSession;
  ps5library::shell_indicator::CheatSession first, confirmed;
  if (!readSecureFile(cheatSessionPath, 4096, encodedSession) ||
      !ps5library::shell_indicator::decodeCheatSession(encodedSession, now,
                                                       first) ||
      (::kill(static_cast<pid_t>(first.agentPid), 0) != 0 && errno != EPERM) ||
      !readSecureFile(cheatSnapshotPath,
                      ps5library::shell_indicator::cheatSnapshotMaximumBytes,
                      encodedSnapshot) ||
      !ps5library::shell_indicator::decodeCheatSnapshot(
          encodedSnapshot, first.session, now, snapshot) ||
      !readSecureFile(cheatSessionPath, 4096, confirmedSession) ||
      !ps5library::shell_indicator::decodeCheatSession(confirmedSession, now,
                                                       confirmed) ||
      !sameSession(first, confirmed))
    return false;
  session = std::move(confirmed);
  return true;
}

MonoObject* createXmlStream(const std::string& xml) {
  MonoDomain* domain = monoDomainGet ? monoDomainGet() : rootDomain;
  if (!domain) domain = rootDomain;
  if (!domain || !memoryStreamClass || !memoryStreamConstructor ||
      !monoArrayNew || !monoGetByteClass || !monoArrayAddress ||
      !monoObjectNew || !monoRuntimeInvoke || !monoGcHandleNew ||
      !monoGcHandleFree || xml.empty() ||
      xml.size() > std::numeric_limits<std::uint32_t>::max())
    return nullptr;
  auto* bytes = monoArrayNew(domain, monoGetByteClass(),
                             static_cast<std::uint32_t>(xml.size()));
  char* address = bytes ? monoArrayAddress(bytes, 1, 0) : nullptr;
  if (!address) return nullptr;
  std::memcpy(address, xml.data(), xml.size());
  auto* stream = monoObjectNew(domain, memoryStreamClass);
  if (!stream) return nullptr;
  void* arguments[] = {bytes};
  MonoObject* exception = nullptr;
  (void)monoRuntimeInvoke(memoryStreamConstructor, stream, arguments,
                          &exception);
  if (exception) return nullptr;
  std::lock_guard<std::mutex> lock(xmlStreamMutex);
  auto& slot = xmlStreamHandles[xmlStreamHandleCursor];
  if (slot) monoGcHandleFree(slot);
  slot = monoGcHandleNew(stream, 1);
  xmlStreamHandleCursor = (xmlStreamHandleCursor + 1) % xmlStreamHandles.size();
  return slot ? stream : nullptr;
}

std::string propertyText(MonoObject* object, const char* name) {
  if (!object || !monoObjectGetClass || !monoClassGetProperty ||
      !monoPropertyGetMethod || !monoRuntimeInvoke)
    return {};
  auto* klass = monoObjectGetClass(object);
  auto* property = klass ? monoClassGetProperty(klass, name) : nullptr;
  auto* getter = property ? monoPropertyGetMethod(property) : nullptr;
  MonoObject* exception = nullptr;
  auto* value = getter ? monoRuntimeInvoke(getter, object, nullptr, &exception)
                       : nullptr;
  return exception || !value ? std::string{}
                             : monoText(reinterpret_cast<MonoString*>(value));
}

bool sendAll(int descriptor, const std::string& value) {
  std::size_t offset = 0;
  while (offset < value.size()) {
#ifdef MSG_NOSIGNAL
    const auto count = ::send(descriptor, value.data() + offset,
                              value.size() - offset, MSG_NOSIGNAL);
#else
    const auto count =
        ::send(descriptor, value.data() + offset, value.size() - offset, 0);
#endif
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return false;
    offset += static_cast<std::size_t>(count);
  }
  return true;
}

bool sendAgentAction(const std::string& request, std::string& response,
                     int timeoutSeconds = 2) {
  const int descriptor = ::socket(AF_INET, SOCK_STREAM, 0);
  if (descriptor < 0) return false;
  struct Socket {
    int descriptor;
    ~Socket() { ::close(descriptor); }
  } socket{descriptor};
  timeval timeout{timeoutSeconds, 0};
  (void)::setsockopt(descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout,
                     sizeof(timeout));
  (void)::setsockopt(descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout,
                     sizeof(timeout));
  sockaddr_in address{};
  address.sin_family = AF_INET;
  address.sin_port = htons(cheatAgentPort);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
#ifdef PS5
  address.sin_len = sizeof(address);
#endif
  if (::connect(descriptor, reinterpret_cast<sockaddr*>(&address),
                sizeof(address)) != 0 ||
      !sendAll(descriptor, request))
    return false;
  (void)::shutdown(descriptor, SHUT_WR);
  constexpr std::size_t maximumResponse = 64 * 1024;
  response.clear();
  char buffer[2048];
  while (response.size() < maximumResponse) {
    const auto count = ::recv(
        descriptor, buffer,
        std::min(sizeof(buffer), maximumResponse - response.size()), 0);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) break;
    response.append(buffer, static_cast<std::size_t>(count));
  }
  return response.rfind("HTTP/1.1 200 ", 0) == 0 &&
         response.find("\r\n\r\n") != std::string::npos;
}

bool sendCheatAction(
    const ps5library::shell_indicator::CheatSession& session,
    const ps5library::shell_indicator::CheatRow& row, bool enabled,
    bool approve) {
  const auto request = ps5library::shell_indicator::buildCheatRequest(
      session, row, enabled, approve);
  std::string response;
  if (!sendAgentAction(request, response)) return false;
  const auto body = response.find("\r\n\r\n");
  return response.find("\"profileId\":\"" + row.profileId + "\"", body) !=
             std::string::npos &&
         response.find("\"entryId\":\"" + row.entryId + "\"", body) !=
             std::string::npos &&
         response.find(enabled ? "\"enabled\":true" : "\"enabled\":false",
                       body) != std::string::npos;
}

bool sendMemoryAction(const std::string& request) {
  std::string response;
  return sendAgentAction(request, response, 30);
}

void processCheatAction() {
  try {
    std::optional<PendingCheatAction> action;
    {
      std::lock_guard<std::mutex> lock(cheatPageMutex);
      if (!pendingCheatAction) return;
      action = std::move(pendingCheatAction);
      pendingCheatAction.reset();
    }
    ps5library::shell_indicator::CheatSession session;
    ps5library::shell_indicator::CheatSnapshot snapshot;
    if (!loadCheatState(session, snapshot) ||
        session.session != action->session)
      return;
    const auto match = std::find_if(
        snapshot.rows.begin(), snapshot.rows.end(), [&](const auto& row) {
          return row.profileId == action->row.profileId &&
                 row.entryId == action->row.entryId &&
                 row.titleId == action->row.titleId &&
                 row.version == action->row.version;
        });
    if (match == snapshot.rows.end() ||
        !ps5library::shell_indicator::cheatRowActionable(*match) ||
        match->enabled == action->enabled)
      return;
    (void)sendCheatAction(session, *match, action->enabled, action->approve);
  } catch (...) {
    // The Settings page remains usable; a fresh agent snapshot is authoritative.
  }
}

void processMemoryAction() {
  try {
    std::optional<PendingMemoryAction> action;
    {
      std::lock_guard<std::mutex> lock(cheatPageMutex);
      if (!pendingMemoryAction) return;
      action = std::move(pendingMemoryAction);
      pendingMemoryAction.reset();
    }
    ps5library::shell_indicator::CheatSession session;
    ps5library::shell_indicator::CheatSnapshot snapshot;
    if (!loadCheatState(session, snapshot) ||
        session.session != action->session)
      return;
    const auto& view = snapshot.memory;
    const bool startAction = action->action == MemoryAction::StartExact ||
                             action->action == MemoryAction::StartUnknown;
    if (view.titleId != action->titleId || view.version != action->version ||
        (!startAction && view.scanId != action->scanId)) {
      std::lock_guard<std::mutex> lock(cheatPageMutex);
      memoryDrafts.clear();
      return;
    }
    const auto selected = std::find_if(
        view.results.begin(), view.results.end(), [&](const auto& result) {
          return result.resultId == action->resultId;
        });
    std::string request;
    switch (action->action) {
      case MemoryAction::StartExact:
        request = ps5library::shell_indicator::buildMemoryStartRequest(
            session, view, action->valueType, false, action->value);
        break;
      case MemoryAction::StartUnknown:
        request = ps5library::shell_indicator::buildMemoryStartRequest(
            session, view, action->valueType, true);
        break;
      case MemoryAction::RefineExact:
        request = ps5library::shell_indicator::buildMemoryRefineRequest(
            session, view, "EXACT", action->value);
        break;
      case MemoryAction::Changed:
        request = ps5library::shell_indicator::buildMemoryRefineRequest(
            session, view, "CHANGED");
        break;
      case MemoryAction::Unchanged:
        request = ps5library::shell_indicator::buildMemoryRefineRequest(
            session, view, "UNCHANGED");
        break;
      case MemoryAction::Increased:
        request = ps5library::shell_indicator::buildMemoryRefineRequest(
            session, view, "INCREASED");
        break;
      case MemoryAction::Decreased:
        request = ps5library::shell_indicator::buildMemoryRefineRequest(
            session, view, "DECREASED");
        break;
      case MemoryAction::Watch:
        request = ps5library::shell_indicator::buildMemoryWatchRequest(
            session, view);
        break;
      case MemoryAction::Write:
        if (selected == view.results.end()) return;
        request = ps5library::shell_indicator::buildMemoryWriteRequest(
            session, view, *selected, action->value, false);
        break;
      case MemoryAction::Freeze:
      case MemoryAction::Unfreeze:
        if (selected == view.results.end()) return;
        request = ps5library::shell_indicator::buildMemoryWriteRequest(
            session, view, *selected, selected->value,
            action->action == MemoryAction::Freeze);
        break;
      case MemoryAction::Restore:
        if (selected == view.results.end()) return;
        request = ps5library::shell_indicator::buildMemoryRestoreRequest(
            session, view, *selected);
        break;
      case MemoryAction::Clear:
        request = ps5library::shell_indicator::buildMemoryClearRequest(session);
        break;
    }
    if (sendMemoryAction(request)) {
      std::lock_guard<std::mutex> lock(cheatPageMutex);
      memoryDrafts.clear();
    }
  } catch (...) {
    // The current process-bound snapshot remains authoritative on any failure.
  }
}
#endif

template <typename Function>
Function symbol(std::uint32_t module, const char* name) {
  return reinterpret_cast<Function>(kernel_dynlib_dlsym(-1, module, name));
}

std::uint32_t module(const char* name) {
  std::uint32_t handle = 0;
  return kernel_dynlib_handle(getpid(), name, &handle) == 0 ? handle : 0;
}

MonoImage* image(MonoDomainAssemblyOpen openAssembly,
                 MonoAssemblyGetImage getImage, const char* name) {
  const std::string path = std::string("/system_ex/common_ex/lib/") + name;
  auto* assembly = openAssembly(rootDomain, path.c_str());
  return assembly ? getImage(assembly) : nullptr;
}

std::uint64_t method(MonoClassFromName classFromName,
                     MonoClassGetMethod getMethod, MonoCompileMethod compile,
                     MonoImage* assembly, const char* nameSpace,
                     const char* className, const char* methodName,
                     int parameterCount) {
  if (!assembly) return 0;
  auto* klass = classFromName(assembly, nameSpace, className);
  auto* value = klass ? getMethod(klass, methodName, parameterCount) : nullptr;
  return value ? compile(value) : 0;
}

ps5library::shell_indicator::DisplayMode currentMode(std::string* session) {
  constexpr std::size_t maximumStateSize = 512;
  const int descriptor = ::open(statePath, O_RDONLY | O_NOFOLLOW);
  if (descriptor < 0)
    return ps5library::shell_indicator::DisplayMode::Hidden;
  struct stat details {};
  if (::fstat(descriptor, &details) != 0 || !S_ISREG(details.st_mode) ||
      details.st_size <= 0 ||
      details.st_size > static_cast<off_t>(maximumStateSize)) {
    ::close(descriptor);
    return ps5library::shell_indicator::DisplayMode::Hidden;
  }
  char buffer[maximumStateSize];
  std::size_t offset = 0;
  while (offset < static_cast<std::size_t>(details.st_size)) {
    const auto read = ::read(descriptor, buffer + offset,
                             static_cast<std::size_t>(details.st_size) - offset);
    if (read < 0 && errno == EINTR) continue;
    if (read <= 0) break;
    offset += static_cast<std::size_t>(read);
  }
  ::close(descriptor);
  if (offset != static_cast<std::size_t>(details.st_size))
    return ps5library::shell_indicator::DisplayMode::Hidden;
  ps5library::shell_indicator::State state;
  if (!ps5library::shell_indicator::decodeState(
          std::string(buffer, offset), state))
    return ps5library::shell_indicator::DisplayMode::Hidden;
  if (session) *session = state.session;
  const bool alive = ::kill(state.pid, 0) == 0 || errno == EPERM;
  return ps5library::shell_indicator::displayMode(
      state, ps5library::shell_indicator::monotonicMilliseconds(), alive);
}

void refreshMode() {
  // Pulse is intentionally gated until opacity mutation is hardware-tested.
  // Both Steady and Pulse keep the real icon visible.
  std::string session;
  const bool visible = currentMode(&session) !=
                       ps5library::shell_indicator::DisplayMode::Hidden;
#if defined(PS5LIBRARY_EXPERIMENTAL_SHELL_INPUT_DIAGNOSTIC)
  inputTrace.setSession(visible ? session : std::string{}, visible);
#endif
  if (patchEnabled.exchange(visible, std::memory_order_acq_rel) != visible)
    reloadPending.store(true, std::memory_order_release);
}

#if defined(PS5LIBRARY_EXPERIMENTAL_SHELL_INPUT_DIAGNOSTIC)
GamePadData getGamePadDataHook(int deviceIndex) {
  const GamePadData value =
      originalGetGamePadData ? originalGetGamePadData(deviceIndex)
                             : GamePadData{};
  if (hooksReady.load(std::memory_order_acquire))
    inputTrace.sample(deviceIndex, value,
                      ps5library::shell_indicator::monotonicMilliseconds());
  return value;
}
#endif

bool publishFile(const char* path, const void* data, std::size_t size,
                 mode_t mode) {
  if (::mkdir("/system_tmp/ps5library", 0755) != 0 && errno != EEXIST)
    return false;
  struct stat directory {};
  if (::lstat("/system_tmp/ps5library", &directory) != 0 ||
      !S_ISDIR(directory.st_mode) || S_ISLNK(directory.st_mode))
    return false;
  const std::string temporary =
      std::string(path) + "." + std::to_string(getpid()) + ".tmp";
  const int descriptor =
      ::open(temporary.c_str(), O_CREAT | O_TRUNC | O_WRONLY | O_NOFOLLOW,
             mode);
  if (descriptor < 0) return false;
  std::size_t offset = 0;
  while (offset < size) {
    const auto written = ::write(
        descriptor, static_cast<const unsigned char*>(data) + offset,
        size - offset);
    if (written < 0 && errno == EINTR) continue;
    if (written <= 0) break;
    offset += static_cast<std::size_t>(written);
  }
  const bool complete = offset == size;
  const bool synced = complete && ::fsync(descriptor) == 0;
  const bool closed = ::close(descriptor) == 0;
  if (!complete || !synced || !closed ||
      ::rename(temporary.c_str(), path) != 0) {
    ::unlink(temporary.c_str());
    return false;
  }
  return true;
}

bool publishIcon() {
  constexpr unsigned char png[] = {0x89, 'P', 'N', 'G', '\r', '\n', 0x1a,
                                   '\n'};
  const auto size = static_cast<std::size_t>(ps5library_shell_icon_size);
  return size >= sizeof(png) && size <= 1024 * 1024 &&
         std::memcmp(ps5library_shell_icon, png, sizeof(png)) == 0 &&
         publishFile(iconPath, ps5library_shell_icon, size, 0644);
}

bool publishReady() {
  const auto value = std::to_string(getpid()) + "\n";
  return publishFile(readyPath, value.data(), value.size(), 0644);
}

bool publishStatus(const std::string& value) {
  const auto line = value + "\n";
  return publishFile(statusPath, line.data(), line.size(), 0644);
}

std::string monoText(MonoString* value) {
  if (!value || !monoStringToUtf8 || !monoFree) return {};
  char* encoded = monoStringToUtf8(value);
  if (!encoded) return {};
  std::string result(encoded);
  monoFree(encoded);
  return result;
}

#if defined(PS5LIBRARY_EXPERIMENTAL_SHELL_CHEAT_PAGE)
std::uint64_t getManifestResourceHook(std::uint64_t instance,
                                      MonoString* resource) {
  if (!hooksReady.load(std::memory_order_acquire) ||
      !cheatPageReady.load(std::memory_order_acquire) ||
      monoText(resource) != debugSettingsResource)
    return originalGetManifestResource
               ? originalGetManifestResource(instance, resource)
               : 0;
  auto deadline = cheatPagePendingUntilMs.load(std::memory_order_acquire);
  const auto now = ps5library::shell_indicator::monotonicMilliseconds();
  if (!deadline || now > deadline ||
      !cheatPagePendingUntilMs.compare_exchange_strong(
          deadline, 0, std::memory_order_acq_rel))
    return originalGetManifestResource
               ? originalGetManifestResource(instance, resource)
               : 0;

  ps5library::shell_indicator::CheatSession session;
  ps5library::shell_indicator::CheatSnapshot snapshot;
  (void)loadCheatState(session, snapshot);
  const auto page = ps5library::shell_indicator::buildCheatPage(snapshot);
  auto* stream = createXmlStream(page);
  if (!stream)
    return originalGetManifestResource
               ? originalGetManifestResource(instance, resource)
               : 0;
  {
    std::lock_guard<std::mutex> lock(cheatPageMutex);
    displayedCheatSession = std::move(session);
    displayedCheatSnapshot = std::move(snapshot);
    pendingCheatAction.reset();
    pendingMemoryAction.reset();
    memoryDrafts.clear();
    for (const auto& result : displayedCheatSnapshot.memory.results)
      memoryDrafts.emplace(result.resultId, result.value);
  }
  cheatPageActive.store(true, std::memory_order_release);
  return reinterpret_cast<std::uint64_t>(stream);
}

int onPressedHook(MonoObject* instance, MonoObject* element,
                  MonoObject* event) {
  if (!hooksReady.load(std::memory_order_acquire) ||
      !cheatPageReady.load(std::memory_order_acquire) ||
      !cheatPageActive.load(std::memory_order_acquire))
    return originalOnPressed ? originalOnPressed(instance, element, event) : 0;
  const auto id = propertyText(element, "Id");
  const auto value = propertyText(element, "Value");
  std::lock_guard<std::mutex> lock(cheatPageMutex);

  const auto cheatIndex = ps5library::shell_indicator::cheatRowIndex(
      id, displayedCheatSnapshot.rows.size());
  if (cheatIndex) {
    if ((value != "0" && value != "1") ||
        *cheatIndex >= displayedCheatSnapshot.rows.size() ||
        !displayedCheatSnapshot.available ||
        displayedCheatSession.session.empty())
      return 0;
    const auto& row = displayedCheatSnapshot.rows[*cheatIndex];
    if (!ps5library::shell_indicator::cheatRowActionable(row)) return 0;
    const bool enabled = value == "1";
    if (enabled != row.enabled && !pendingCheatAction)
      pendingCheatAction = PendingCheatAction{
          row, displayedCheatSession.session, enabled,
          enabled && row.trust == "UNVERIFIED"};
    return 0;
  }

#if defined(PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER)
  auto& memory = displayedCheatSnapshot.memory;
  if (id == "id_ps5library_memory_type") {
    constexpr const char* types[] = {"U8", "U16", "U32", "U64", "F32", "F64"};
    if (value.size() == 1 && value[0] >= '0' && value[0] <= '5')
      memory.valueType = types[value[0] - '0'];
    return 0;
  }
  auto queue = [&](MemoryAction action, std::string scalar = {},
                   std::string resultId = {}) {
    if (!pendingMemoryAction && displayedCheatSnapshot.available &&
        memory.enabled && memory.targetAvailable &&
        !displayedCheatSession.session.empty())
      pendingMemoryAction = PendingMemoryAction{
          action, displayedCheatSession.session, std::move(scalar),
          std::move(resultId), memory.valueType, memory.titleId,
          memory.version, memory.scanId};
  };
  if (id == "id_ps5library_memory_start") {
    if (ps5library::shell_indicator::memoryScalarValue(value))
      queue(MemoryAction::StartExact, value);
    return 0;
  }
  if (id == "id_ps5library_memory_unknown") {
    queue(MemoryAction::StartUnknown); return 0;
  }
  if (id == "id_ps5library_memory_refine_exact") {
    if (ps5library::shell_indicator::memoryScalarValue(value))
      queue(MemoryAction::RefineExact, value);
    return 0;
  }
  if (id == "id_ps5library_memory_changed") {
    queue(MemoryAction::Changed); return 0;
  }
  if (id == "id_ps5library_memory_unchanged") {
    queue(MemoryAction::Unchanged); return 0;
  }
  if (id == "id_ps5library_memory_increased") {
    queue(MemoryAction::Increased); return 0;
  }
  if (id == "id_ps5library_memory_decreased") {
    queue(MemoryAction::Decreased); return 0;
  }
  if (id == "id_ps5library_memory_refresh") {
    queue(MemoryAction::Watch); return 0;
  }
  if (id == "id_ps5library_memory_clear") {
    queue(MemoryAction::Clear); return 0;
  }
  auto resultIndex = ps5library::shell_indicator::memoryResultIndex(
      id, memory.results.size());
  bool valueField = resultIndex.has_value();
  bool writeControl = false, freezeControl = false, restoreControl = false;
  if (!resultIndex) {
    constexpr std::string_view writePrefix = "id_ps5library_memory_write_";
    constexpr std::string_view freezePrefix = "id_ps5library_memory_freeze_";
    constexpr std::string_view restorePrefix = "id_ps5library_memory_restore_";
    auto controlIndex = [&](std::string_view prefix) {
      return ps5library::shell_indicator::memoryResultIndex(
          "id_ps5library_memory_result_" + std::string(id.substr(prefix.size())),
          memory.results.size());
    };
    if (id.rfind(writePrefix, 0) == 0) {
      resultIndex = controlIndex(writePrefix); writeControl = true;
    } else if (id.rfind(freezePrefix, 0) == 0) {
      resultIndex = controlIndex(freezePrefix); freezeControl = true;
    } else if (id.rfind(restorePrefix, 0) == 0) {
      resultIndex = controlIndex(restorePrefix); restoreControl = true;
    }
  }
  if (resultIndex && *resultIndex < memory.results.size()) {
    const auto& result = memory.results[*resultIndex];
    if (!memory.writeEnabled || !result.writable) return 0;
    if (valueField) {
      if (ps5library::shell_indicator::memoryScalarValue(value))
        memoryDrafts[result.resultId] = value;
    } else if (writeControl) {
      const auto draft = memoryDrafts.find(result.resultId);
      if (draft != memoryDrafts.end())
        queue(MemoryAction::Write, draft->second, result.resultId);
    } else if (freezeControl) {
      queue(result.frozen ? MemoryAction::Unfreeze : MemoryAction::Freeze,
            {}, result.resultId);
    } else if (restoreControl && result.modified) {
      queue(MemoryAction::Restore, {}, result.resultId);
    }
    return 0;
  }
#endif
  if (id.rfind("id_ps5library_", 0) == 0) return 0;
  return originalOnPressed ? originalOnPressed(instance, element, event) : 0;
}
#endif

int ioctlHook(int descriptor, unsigned long request, void* argument) {
  const int result = originalIoctl
                         ? originalIoctl(descriptor, request, argument)
                         : -1;
  if (!hooksReady.load(std::memory_order_acquire) || result != 0 ||
      request != decryptRnpsBundle ||
      !patchEnabled.load(std::memory_order_acquire))
    return result;
  auto* args = static_cast<RnpsArgs*>(argument);
  if (args && args->buffer && args->size > 0) {
    const auto patch = ps5library::shell_indicator::patchHomeUi450451(
        static_cast<unsigned char*>(args->buffer),
        static_cast<std::size_t>(args->size));
    if (patch != ps5library::shell_indicator::PatchResult::Rejected)
      homePatchResult.store(static_cast<int>(patch), std::memory_order_release);
  }
  return result;
}

void updateHook(MonoObject* instance) {
  if (originalUpdate) originalUpdate(instance);
  if (!hooksReady.load(std::memory_order_acquire)) return;
  if (reloadPending.exchange(false, std::memory_order_acq_rel) && reloadHome &&
      monoStringNew && rootDomain)
    reloadHome(monoStringNew(rootDomain, homeTitleId));
}

bool bootHook3(MonoString* uri, int option, MonoString* title) {
  if (hooksReady.load(std::memory_order_acquire) &&
      monoText(uri) == indicatorUri) {
#if defined(PS5LIBRARY_EXPERIMENTAL_SHELL_CHEAT_PAGE)
    if (!cheatPageReady.load(std::memory_order_acquire) || !originalBoot3 ||
        !monoStringNew || !rootDomain)
      return true;
    cheatPageActive.store(false, std::memory_order_release);
    cheatPagePendingUntilMs.store(
        ps5library::shell_indicator::monotonicMilliseconds() + 5'000,
        std::memory_order_release);
    const bool opened = originalBoot3(
        monoStringNew(rootDomain, debugSettingsUri), option, title);
    if (!opened) cheatPagePendingUntilMs.store(0, std::memory_order_release);
    return opened;
#else
    return true;
#endif
  }
  return originalBoot3 ? originalBoot3(uri, option, title) : false;
}

bool bootHook2(MonoString* uri, int option) {
  if (hooksReady.load(std::memory_order_acquire) &&
      monoText(uri) == indicatorUri) {
#if defined(PS5LIBRARY_EXPERIMENTAL_SHELL_CHEAT_PAGE)
    if (!cheatPageReady.load(std::memory_order_acquire) || !originalBoot2 ||
        !monoStringNew || !rootDomain)
      return true;
    cheatPageActive.store(false, std::memory_order_release);
    cheatPagePendingUntilMs.store(
        ps5library::shell_indicator::monotonicMilliseconds() + 5'000,
        std::memory_order_release);
    const bool opened = originalBoot2(
        monoStringNew(rootDomain, debugSettingsUriSimple), option);
    if (!opened) cheatPagePendingUntilMs.store(0, std::memory_order_release);
    return opened;
#else
    return true;
#endif
  }
  return originalBoot2 ? originalBoot2(uri, option) : false;
}

void setIconSourceHook(MonoObject* instance, MonoObject* source) {
  if (originalSetIconSource) originalSetIconSource(instance, source);
  thread_local bool nested = false;
  if (nested || !hooksReady.load(std::memory_order_acquire) || !instance ||
      !source || !setInvertedIconSource || !monoObjectToString)
    return;
  MonoObject* exception = nullptr;
  const auto text = monoText(monoObjectToString(source, &exception));
  if (exception || text.find(iconPath) == std::string::npos) return;
  nested = true;
  setInvertedIconSource(instance, source);
  nested = false;
}

bool installOptional(std::uint64_t target, void* replacement,
                     void** original) {
  return target && InstallDetour(target, replacement, original);
}

bool install() {
  installStage = "ICON";
  if (!publishIcon()) return false;

  installStage = "MODULES";
  const auto kernel = module("libkernel_sys.sprx");
  const auto mono = module("libmonosgen-2.0.sprx");
  if (!kernel || !mono) return false;
  auto getVersion = symbol<int (*)(SystemSoftwareVersion*)>(
      kernel, "sceKernelGetProsperoSystemSwVersion");
  sceKernelMprotect =
      symbol<int (*)(void*, std::size_t, int)>(kernel, "sceKernelMprotect");
  originalIoctl = symbol<Ioctl>(0x2001, "ioctl");
  auto getRoot = symbol<MonoGetRootDomain>(mono, "mono_get_root_domain");
  auto attach = symbol<MonoThreadAttach>(mono, "mono_thread_attach");
  auto openAssembly =
      symbol<MonoDomainAssemblyOpen>(mono, "mono_domain_assembly_open");
  auto getImage =
      symbol<MonoAssemblyGetImage>(mono, "mono_assembly_get_image");
  auto classFromName =
      symbol<MonoClassFromName>(mono, "mono_class_from_name");
  auto getMethod = symbol<MonoClassGetMethod>(
      mono, "mono_class_get_method_from_name");
  auto compile = symbol<MonoCompileMethod>(mono, "mono_compile_method");
  monoStringNew = symbol<MonoStringNew>(mono, "mono_string_new");
  monoStringToUtf8 =
      symbol<MonoStringToUtf8>(mono, "mono_string_to_utf8");
  monoFree = symbol<MonoFree>(mono, "mono_free");
  monoObjectToString =
      symbol<MonoObjectToString>(mono, "mono_object_to_string");
#if defined(PS5LIBRARY_EXPERIMENTAL_SHELL_CHEAT_PAGE)
  monoDomainGet = symbol<MonoDomainGet>(mono, "mono_domain_get");
  monoObjectGetClass =
      symbol<MonoObjectGetClass>(mono, "mono_object_get_class");
  monoClassGetProperty = symbol<MonoClassGetProperty>(
      mono, "mono_class_get_property_from_name");
  monoPropertyGetMethod = symbol<MonoPropertyGetMethod>(
      mono, "mono_property_get_get_method");
  monoRuntimeInvoke =
      symbol<MonoRuntimeInvoke>(mono, "mono_runtime_invoke");
  monoArrayNew = symbol<MonoArrayNew>(mono, "mono_array_new");
  monoGetByteClass =
      symbol<MonoGetByteClass>(mono, "mono_get_byte_class");
  monoArrayAddress =
      symbol<MonoArrayAddress>(mono, "mono_array_addr_with_size");
  monoObjectNew = symbol<MonoObjectNew>(mono, "mono_object_new");
  monoGcHandleNew =
      symbol<MonoGcHandleNew>(mono, "mono_gchandle_new");
  monoGcHandleFree =
      symbol<MonoGcHandleFree>(mono, "mono_gchandle_free");
#endif
  if (!getVersion || !sceKernelMprotect || !originalIoctl || !getRoot ||
      !attach || !openAssembly || !getImage || !classFromName || !getMethod ||
      !compile || !monoStringNew || !monoStringToUtf8 || !monoFree ||
      !monoObjectToString)
    return false;
  installStage = "FIRMWARE";
  SystemSoftwareVersion version{};
  version.size = sizeof(version);
  if (getVersion(&version) != 0 ||
      !ps5library::shell_indicator::supportedFirmware(version.version))
    return false;
  installStage = "MONO_DOMAIN";
  rootDomain = getRoot();
  if (!rootDomain || !attach(rootDomain)) return false;

  // OnionHEN scopes PTRACE_AUTHID to the detour install window and restores
  // the stock ShellUI credential before the helper enters its keep-alive loop.
  installStage = "AUTHID";
  AuthIdGuard auth;
  if (!auth) return false;
  char probe[100]{};
  has_hv_bypass =
      sceKernelMprotect(probe, sizeof(probe),
                        PROT_READ | PROT_WRITE | PROT_EXEC) == 0;

  auto* pui = image(openAssembly, getImage, "Sce.PlayStation.PUI.dll");
  auto* reactCommon =
      image(openAssembly, getImage, "ReactNative.Vsh.Common.dll");
  auto* appSystem =
      image(openAssembly, getImage, "Sce.Vsh.ShellUI.AppSystem.dll");
  auto* reactPui = image(openAssembly, getImage, "ReactNative.PUI.dll");
#if defined(PS5LIBRARY_EXPERIMENTAL_SHELL_CHEAT_PAGE)
  auto* mscorlib = image(openAssembly, getImage, "mscorlib.dll");
  auto* legacy =
      image(openAssembly, getImage, "Sce.Vsh.ShellUI.Legacy.dll");
  memoryStreamClass =
      mscorlib ? classFromName(mscorlib, "System.IO", "MemoryStream")
               : nullptr;
  memoryStreamConstructor =
      memoryStreamClass ? getMethod(memoryStreamClass, ".ctor", 1) : nullptr;
  const auto getManifestResource = method(
      classFromName, getMethod, compile, mscorlib, "System.Reflection",
      "RuntimeAssembly", "GetManifestResourceStream", 1);
  const auto onPressed = method(
      classFromName, getMethod, compile, legacy,
      "Sce.Vsh.ShellUI.Settings.CoreUI3", "SettingPage", "OnPressed", 2);
  const bool cheatSymbols = monoDomainGet && monoObjectGetClass &&
                            monoClassGetProperty && monoPropertyGetMethod &&
                            monoRuntimeInvoke && monoArrayNew && monoGetByteClass &&
                            monoArrayAddress && monoObjectNew && monoGcHandleNew &&
                            monoGcHandleFree && memoryStreamClass &&
                            memoryStreamConstructor && getManifestResource &&
                            onPressed;
#endif
#if defined(PS5LIBRARY_EXPERIMENTAL_SHELL_INPUT_DIAGNOSTIC)
  auto* core = image(openAssembly, getImage, "Sce.PlayStation.Core.dll");
  const auto getGamePadData = method(
      classFromName, getMethod, compile, core, "Sce.PlayStation.Core.Input",
      "GamePad", "GetData", 1);
  if (!getGamePadData ||
      !InstallDetour(getGamePadData,
                     reinterpret_cast<void*>(&getGamePadDataHook),
                     reinterpret_cast<void**>(&originalGetGamePadData)))
    std::fprintf(stderr,
                 "PS5Library shell helper: Options observer unavailable\n");
#endif
  const auto update = method(classFromName, getMethod, compile, pui,
                             "Sce.PlayStation.PUI", "Application", "Update", 0);
  reloadHome = reinterpret_cast<Reload>(method(
      classFromName, getMethod, compile, reactCommon, "ReactNative.Vsh.Common",
      "ReactApplicationSceneManager", "ReloadApp", 1));
  installStage = "CORE_METHODS";
  if (!update || !reloadHome) return false;

  // Required hooks. They remain inert until hooksReady is published.
  installStage = "CORE_HOOKS";
  if (!InstallDetour(update, reinterpret_cast<void*>(&updateHook),
                     reinterpret_cast<void**>(&originalUpdate)) ||
      !InstallDetour(reinterpret_cast<std::uint64_t>(originalIoctl),
                     reinterpret_cast<void*>(&ioctlHook),
                     reinterpret_cast<void**>(&originalIoctl)))
    return false;
#if defined(PS5LIBRARY_EXPERIMENTAL_SHELL_CHEAT_PAGE)
  const bool resourceHook =
      cheatSymbols &&
      InstallDetour(getManifestResource,
                    reinterpret_cast<void*>(&getManifestResourceHook),
                    reinterpret_cast<void**>(&originalGetManifestResource));
  const bool pressHook =
      resourceHook &&
      InstallDetour(onPressed, reinterpret_cast<void*>(&onPressedHook),
                    reinterpret_cast<void**>(&originalOnPressed));
  cheatPageReady.store(resourceHook && pressHook, std::memory_order_release);
  if (!resourceHook || !pressHook)
    std::fprintf(stderr,
                 "PS5Library shell helper: cheat page unavailable\n");
#endif

  const auto boot3 = method(classFromName, getMethod, compile, appSystem,
                            "Sce.Vsh.ShellUI.AppSystem", "BootHelper", "Boot", 3);
  const auto boot2 = method(classFromName, getMethod, compile, appSystem,
                            "Sce.Vsh.ShellUI.AppSystem", "BootHelper", "Boot", 2);
  bool bootInstalled =
      installOptional(boot3, reinterpret_cast<void*>(&bootHook3),
                      reinterpret_cast<void**>(&originalBoot3));
  if (!bootInstalled)
    bootInstalled = installOptional(boot2, reinterpret_cast<void*>(&bootHook2),
                                    reinterpret_cast<void**>(&originalBoot2));
  installStage = "BOOT_HOOK";
  if (!bootInstalled) return false;

  const auto setIcon = method(classFromName, getMethod, compile, reactPui,
                              "ReactNative.Views.UI3.View",
                              "ReactButtonShadowNode", "SetIconSource", 1);
  setInvertedIconSource = reinterpret_cast<SetIconSource>(method(
      classFromName, getMethod, compile, reactPui,
      "ReactNative.Views.UI3.View", "ReactButtonShadowNode",
      "SetinvertedIconSource", 1));
  if (setIcon && setInvertedIconSource)
    (void)installOptional(setIcon, reinterpret_cast<void*>(&setIconSourceHook),
                          reinterpret_cast<void**>(&originalSetIconSource));

  refreshMode();
  installStage = "READY_FILE";
  if (!publishReady()) return false;
  hooksReady.store(true, std::memory_order_release);
  installStage = "ACTIVE";
  return true;
}

}  // namespace

// OnionHEN's detour implementation expects these weak host globals.
int (*sceKernelMprotect)(void*, std::size_t, int) = nullptr;
bool has_hv_bypass = false;

int main() {
  (void)publishStatus("STARTING");
  if (!install()) {
    (void)publishStatus(std::string("FAILED_") + installStage);
    std::fprintf(stderr, "PS5Library shell helper failed at %s\n", installStage);
    return 1;
  }
  (void)publishStatus("READY_HOMEUI_PENDING");
  int reportedPatch = -1;
  while (true) {
    refreshMode();
    const int patch = homePatchResult.load(std::memory_order_acquire);
    if (patch != reportedPatch &&
        patch >= static_cast<int>(
                     ps5library::shell_indicator::PatchResult::Applied) &&
        patch <= static_cast<int>(
                     ps5library::shell_indicator::PatchResult::AlreadyApplied)) {
      reportedPatch = patch;
      const auto result = static_cast<ps5library::shell_indicator::PatchResult>(
          patch);
      (void)publishStatus(std::string("HOMEUI_") +
                          ps5library::shell_indicator::patchResultName(result));
    }
#if defined(PS5LIBRARY_EXPERIMENTAL_SHELL_INPUT_DIAGNOSTIC)
    inputTrace.flush(ps5library::shell_indicator::monotonicMilliseconds());
#endif
#if defined(PS5LIBRARY_EXPERIMENTAL_SHELL_CHEAT_PAGE)
    processCheatAction();
    processMemoryAction();
#endif
    ::usleep(500 * 1000);
  }
}
