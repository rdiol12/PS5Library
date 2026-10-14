#include "client.hpp"
#include <algorithm>
#include <arpa/inet.h>
#include <cctype>
#include <cerrno>
#include <charconv>
#include <csignal>
#include <cstddef>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <fcntl.h>
#include <fstream>
#include <netinet/in.h>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <sys/file.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/un.h>
#include <unistd.h>
#include <vector>
#ifdef PS5
#include <ps5/kernel.h>
#include <sys/sysctl.h>
extern "C" int sceNotificationSend(int, bool, const char *);
union SceNetCtlInfo {
  char ip_address[16];
  unsigned char storage[256];
};
static_assert(sizeof(SceNetCtlInfo) == 256);
extern "C" int sceNetCtlInit();
extern "C" int sceNetCtlGetInfo(int32_t, SceNetCtlInfo *);
#endif

namespace ps5library {
struct ScopedFd {
  int value;
  ~ScopedFd() {
    if (value >= 0)
      close(value);
  }
};
static bool validSecret(const std::string &value) {
  return value.size() == 64 && value.find_first_not_of("0123456789abcdef") == std::string::npos;
}
static bool privateHttpHost(std::string host) {
  if (host.size() > 2 && host.front() == '[' && host.back() == ']')
    host = host.substr(1, host.size() - 2);
  std::transform(host.begin(), host.end(), host.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  if (host == "localhost" || (host.size() > 6 && host.compare(host.size() - 6, 6, ".local") == 0))
    return true;
#ifndef PS5
  if (host == "host.docker.internal")
    return true;
#endif
  in_addr ipv4{};
  if (inet_pton(AF_INET, host.c_str(), &ipv4) == 1) {
    const auto *b = reinterpret_cast<const unsigned char *>(&ipv4);
    return b[0] == 10 || b[0] == 127 || (b[0] == 172 && b[1] >= 16 && b[1] <= 31) ||
           (b[0] == 192 && b[1] == 168) || (b[0] == 169 && b[1] == 254) ||
           (b[0] == 100 && b[1] >= 64 && b[1] <= 127);
  }
#ifndef PS5
  in6_addr ipv6{};
  if (inet_pton(AF_INET6, host.c_str(), &ipv6) == 1) {
    const auto *b = ipv6.s6_addr;
    bool loopback = true;
    for (int i = 0; i < 15; i++)
      loopback = loopback && b[i] == 0;
    return (loopback && b[15] == 1) || (b[0] & 0xfe) == 0xfc ||
           (b[0] == 0xfe && (b[1] & 0xc0) == 0x80);
  }
#endif
  return false;
}
std::optional<Json> readJsonIfPresent(const fs::path &filename, size_t limit) {
  int fd = open(filename.c_str(), O_RDONLY | O_NOFOLLOW);
  if (fd < 0) {
    if (errno == ENOENT)
      return std::nullopt;
    throw std::runtime_error("Cannot read configuration/state");
  }
  ScopedFd file{fd};
  struct stat status{};
  if (fstat(fd, &status) || !S_ISREG(status.st_mode) || status.st_size < 0 ||
      static_cast<uint64_t>(status.st_size) > limit)
    throw std::runtime_error("Cannot read configuration/state");
  std::string text;
  char buffer[16384];
  for (;;) {
    auto count = read(fd, buffer, sizeof(buffer));
    if (count < 0 && errno == EINTR)
      continue;
    if (count < 0)
      throw std::runtime_error("Cannot read configuration/state");
    if (!count)
      break;
    if (text.size() + static_cast<size_t>(count) > limit)
      throw std::runtime_error("Cannot read configuration/state");
    text.append(buffer, static_cast<size_t>(count));
  }
  if (text.size() >= 3 && static_cast<unsigned char>(text[0]) == 0xef &&
      static_cast<unsigned char>(text[1]) == 0xbb && static_cast<unsigned char>(text[2]) == 0xbf)
    text.erase(0, 3);
  return Json::parse(text);
}
Json readJson(const fs::path &filename, size_t limit) {
  auto value = readJsonIfPresent(filename, limit);
  if (!value)
    throw std::runtime_error("Cannot read configuration/state");
  return std::move(*value);
}
std::string normalizeServerUrl(const std::string &input, bool allowHttp) {
  auto first = input.find_first_not_of(" \t\r\n"), last = input.find_last_not_of(" \t\r\n");
  if (first == std::string::npos || input.size() > 2048)
    throw std::runtime_error("Enter your server's full HTTPS address");
  auto value = input.substr(first, last - first + 1);
  std::unique_ptr<CURLU, decltype(&curl_url_cleanup)> url(curl_url(), curl_url_cleanup);
  if (!url || curl_url_set(url.get(), CURLUPART_URL, value.c_str(), 0) != CURLUE_OK)
    throw std::runtime_error("Invalid server address");
  auto part = [&](CURLUPart name, unsigned flags = 0) {
    char *text = nullptr;
    curl_url_get(url.get(), name, &text, flags);
    std::string result = text ? text : "";
    curl_free(text);
    return result;
  };
  auto scheme = part(CURLUPART_SCHEME), host = part(CURLUPART_HOST);
  if (scheme != "https" && !(allowHttp && scheme == "http" && privateHttpHost(host)))
    throw std::runtime_error("Use HTTPS, or HTTP only for a private LAN address");
  if (host.empty() || part(CURLUPART_PATH) != "/" || value.find('@') != std::string::npos ||
      value.find('?') != std::string::npos || value.find('#') != std::string::npos)
    throw std::runtime_error("Use the server address without a path, password, query or fragment");
  std::transform(host.begin(), host.end(), host.begin(),
                 [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
  curl_url_set(url.get(), CURLUPART_HOST, host.c_str(), 0);
  value = part(CURLUPART_URL, CURLU_NO_DEFAULT_PORT);
  if (!value.empty() && value.back() == '/')
    value.pop_back();
  return value;
}
std::string normalizeProxyUrl(const std::string &input) {
  if (input.empty())
    return {};
  auto value = normalizeServerUrl(input, true);
  std::unique_ptr<CURLU, decltype(&curl_url_cleanup)> url(curl_url(), curl_url_cleanup);
  if (!url || curl_url_set(url.get(), CURLUPART_URL, value.c_str(), 0) != CURLUE_OK)
    throw std::runtime_error("Invalid proxy address");
  char *text = nullptr;
  if (curl_url_get(url.get(), CURLUPART_SCHEME, &text, 0) != CURLUE_OK || !text)
    throw std::runtime_error("Invalid proxy address");
  std::string scheme(text);
  curl_free(text);
  text = nullptr;
  if (curl_url_get(url.get(), CURLUPART_HOST, &text, 0) != CURLUE_OK || !text)
    throw std::runtime_error("Invalid proxy address");
  std::string host(text);
  curl_free(text);
  in_addr ipv4{};
  in6_addr ipv6{};
  const bool loopback =
      host == "localhost" ||
      (inet_pton(AF_INET, host.c_str(), &ipv4) == 1 && (ntohl(ipv4.s_addr) >> 24) == 127) ||
      (inet_pton(AF_INET6, host.c_str(), &ipv6) == 1 && IN6_IS_ADDR_LOOPBACK(&ipv6));
  if (scheme != "http" || !loopback)
    throw std::runtime_error("Use a loopback HTTP proxy");
  return value;
}
long clientConnectTimeout(bool fallbackConfigured, bool fallbackAttempt) {
  return fallbackAttempt || !fallbackConfigured ? 10L : 3L;
}
Json readConfig(const fs::path &filename) {
  if (auto config = readJsonIfPresent(filename)) {
    if (const auto *launcher = std::getenv("PS5LIBRARY_LAUNCHER_URL"))
      config->set("launcherUrl", normalizeServerUrl(launcher, true));
    return std::move(*config);
  }
  auto value = Json::object({{"serverUrl", ""},
                             {"fallbackServerUrl", ""},
                             {"serverProxyUrl", ""},
                             {"fallbackProxyUrl", ""},
                             {"name", "My PS5"},
                             {"runtime", "unknown"},
                             {"allowInsecureLan", false}});
#ifdef PS5
  value.set("font", (filename.parent_path() / "DejaVuSans.ttf").string());
  value.set("caBundle", (filename.parent_path() / "ca-bundle.crt").string());
  auto stores = Json::array();
  stores.add(Json::object(
      {{"storageId", "internal"}, {"displayName", "Internal Storage"}, {"path", "/data"}}));
  stores.add(
      Json::object({{"storageId", "usb0"}, {"displayName", "USB SSD"}, {"path", "/mnt/usb0"}}));
  value.set("storage", stores);
#endif
  return value;
}
Json loadDeviceState(const fs::path &configPath, const Json &config) {
  auto server =
      normalizeServerUrl(config["serverUrl"].string(), config["allowInsecureLan"].boolean());
  auto saved = readJsonIfPresent(configPath.parent_path() / "device-state.json");
  auto state = saved ? std::move(*saved)
                     : Json::object({{"deviceId", deviceId()}, {"libraryRevision", int64_t(0)}});
  auto bound = state["serverUrl"].string();
  if (bound.empty() && !state["credential"].string().empty())
    throw std::runtime_error("Device credential has no server binding; reset and pair again");
  if (!bound.empty() && normalizeServerUrl(bound, true) != server)
    throw std::runtime_error("Server address changed; reset the local device "
                             "identity before pairing to the new server");
  state.set("serverUrl", server);
  return state;
}
void atomicBytes(const fs::path &filename, std::string_view data) {
#ifdef PS5
  // This is the last writer proven on real PS5 title sandboxes. The stronger
  // directory-fd variant introduced after 0.2.34 crashes firmware 4.51.
  fs::create_directories(fs::absolute(filename).parent_path());
  auto temp = filename.string() + ".tmp";
  int fd = open(temp.c_str(), O_CREAT | O_TRUNC | O_WRONLY | O_NOFOLLOW, 0600);
  if (fd < 0)
    throw std::runtime_error("Cannot write state");
  size_t written = 0;
  while (written < data.size()) {
    auto n = write(fd, data.data() + written, data.size() - written);
    if (n < 0 && errno == EINTR)
      continue;
    if (n <= 0) {
      close(fd);
      throw std::runtime_error("State write failed");
    }
    written += static_cast<size_t>(n);
  }
  if (fsync(fd) != 0) {
    close(fd);
    throw std::runtime_error("State sync failed");
  }
  close(fd);
  fs::rename(temp, filename);
  return;
#else
  constexpr mode_t mode = 0600;
  auto path = fs::absolute(filename), parent = path.parent_path();
  fs::create_directories(parent);
  auto leaf = path.filename().string();
  if (leaf.empty() || leaf == "." || leaf == "..")
    throw std::runtime_error("Cannot write state");
  struct stat parentStatus{};
  if (lstat(parent.c_str(), &parentStatus) != 0 || !S_ISDIR(parentStatus.st_mode) ||
      S_ISLNK(parentStatus.st_mode))
    throw std::runtime_error("Cannot write state");
  int directory = open(parent.c_str(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
  if (directory < 0)
    throw std::runtime_error("Cannot write state");
  ScopedFd directoryGuard{directory};
  struct stat openedParent{};
  if (fstat(directory, &openedParent) != 0 || openedParent.st_dev != parentStatus.st_dev ||
      openedParent.st_ino != parentStatus.st_ino)
    throw std::runtime_error("Cannot write state");
  int fd = -1;
  fs::path temp;
  for (int attempt = 0; attempt < 8; attempt++) {
    temp = parent / ("." + leaf + ".tmp-" + randomHex(12));
    fd = open(temp.c_str(), O_CREAT | O_EXCL | O_WRONLY | O_NOFOLLOW, mode);
    if (fd >= 0)
      break;
    if (errno != EEXIST)
      throw std::runtime_error("Cannot write state");
  }
  if (fd < 0)
    throw std::runtime_error("Cannot write state");
  struct Temporary {
    int fd;
    fs::path name;
    bool renamed = false;
    ~Temporary() {
      if (fd >= 0)
        close(fd);
      if (!renamed)
        unlink(name.c_str());
    }
  } temporary{fd, temp};
  struct stat created{};
  if (fstat(fd, &created) != 0 || !S_ISREG(created.st_mode) || created.st_nlink != 1)
    throw std::runtime_error("Cannot write state");
  size_t written = 0;
  while (written < data.size()) {
    auto n = write(fd, data.data() + written, data.size() - written);
    if (n < 0 && errno == EINTR)
      continue;
    if (n <= 0)
      throw std::runtime_error("State write failed");
    written += static_cast<size_t>(n);
  }
  if (fchmod(fd, mode) != 0 || fsync(fd) != 0)
    throw std::runtime_error("State sync failed");
  close(fd);
  temporary.fd = -1;
  struct stat currentParent{};
  if (lstat(parent.c_str(), &currentParent) != 0 || currentParent.st_dev != openedParent.st_dev ||
      currentParent.st_ino != openedParent.st_ino)
    throw std::runtime_error("Cannot publish state");
  fs::rename(temp, path);
  temporary.renamed = true;
  if (fsync(directory) != 0)
    throw std::runtime_error("State sync failed");
#endif
}
void atomicJson(const fs::path &filename, const Json &value) {
  atomicBytes(filename, value.dump());
}
Json pairFrontend(const fs::path &configPath, const Json &config,
                  const std::function<bool()> &cancelled) {
  auto state = loadDeviceState(configPath, config);
  auto path = configPath.parent_path() / "device-state.json";
  if (!state["credential"].string().empty())
    return state;
  // Persist the app identity before making a request, including failed
  // requests.
  atomicJson(path, state);
  Client client(config);
  client.cancelled = cancelled;
  if (!state["recoveryChecked"].boolean() && !state["recoveryToken"].string().empty()) {
    auto body =
        Json::object({{"deviceId", state["deviceId"]}, {"recoveryToken", state["recoveryToken"]}});
    try {
      auto result = client.request("POST", "/api/v1/hardware/recover", body);
      auto credential = result["credential"].string(), token = result["recoveryToken"].string();
      if (!validSecret(credential) || !validSecret(token) || result["consoleId"].string().empty())
        throw std::runtime_error("Invalid recovery response");
      state.set("credential", credential);
      state.set("consoleId", result["consoleId"]);
      state.set("recoveryToken", token);
      state.set("recoveryChecked", true);
      state.set("pairing", Json());
      atomicJson(path, state);
      return state;
    } catch (const RequestError &e) {
      if (e.status != 404)
        throw;
      state.set("recoveryToken", Json());
      state.set("recoveryChecked", true);
      atomicJson(path, state);
    }
  }
  if (!state["pairing"].null()) {
    Json result;
    try {
      result =
          client.request("POST", "/api/v1/pairings/" + state["pairing"]["id"].string() + "/poll",
                         Json::object({{"pollSecret", state["pairing"]["pollSecret"]}}));
    } catch (const RequestError &e) {
      if (e.status != 410)
        throw;
      state.set("pairing", Json());
      atomicJson(path, state);
    }
    if (result["status"].string() == "PAIRED") {
      auto credential = result["credential"].string();
      if (!validSecret(credential) || result["consoleId"].string().empty())
        throw std::runtime_error("Invalid pairing response");
      state.set("credential", credential);
      state.set("consoleId", result["consoleId"]);
      if (validSecret(result["recoveryToken"].string()))
        state.set("recoveryToken", result["recoveryToken"]);
      state.set("pairing", Json());
      atomicJson(path, state);
      return state;
    }
  }
  if (state["pairing"].null()) {
    state.set("pairing", client.request("POST", "/api/v1/frontend/pairings",
                                        Json::object({{"deviceId", state["deviceId"]}})));
    atomicJson(path, state);
  }
  return state;
}
bool resetRejectedFrontendCredential(const fs::path &configPath,
                                     const std::string &rejectedCredential) {
  if (rejectedCredential.empty())
    return false;
  auto saved = readJsonIfPresent(configPath.parent_path() / "device-state.json");
  if (!saved || (*saved)["credential"].string() != rejectedCredential)
    return false;
  auto state = std::move(*saved);
  auto path = configPath.parent_path() / "device-state.json";
  state.set("credential", Json());
  state.set("consoleId", Json());
  state.set("pairing", Json());
  state.set("recoveryChecked", false);
  atomicJson(path, state);
  return true;
}
std::string localAgentAddress() {
#ifdef PS5
  static const int initialized = sceNetCtlInit();
  (void)initialized;
  SceNetCtlInfo info{};
  if (sceNetCtlGetInfo(14, &info) < 0)
    throw std::runtime_error("Console network unavailable");
  auto length = strnlen(info.ip_address, sizeof(info.ip_address));
  if (!length || length == sizeof(info.ip_address))
    throw std::runtime_error("Console network unavailable");
  std::string address(info.ip_address, length);
  if (!privateHttpHost(address))
    throw std::runtime_error("Console private address unavailable");
  return address;
#else
  return "127.0.0.1";
#endif
}
std::string localAgentUrl() {
  return "http://" + localAgentAddress() + ":" + std::to_string(localAgentPort);
}
Json localAgentRequest(const std::string &method, const std::string &path, uint16_t port,
                       const fs::path &requestedSocket, const std::string &sensitiveToken,
                       const std::string &approvalProfileId, const std::string &bearer) {
  const auto socketPath = requestedSocket;
  if ((method != "GET" && method != "POST") || (!port && socketPath.empty()) ||
      path.rfind("/api/v1/agent/", 0) != 0 || path.find("..") != std::string::npos ||
      path.find_first_of("?#\\\r\n ") != std::string::npos)
    throw std::runtime_error("Invalid local agent request");
  int socketFd = socket(socketPath.empty() ? AF_INET : AF_UNIX, SOCK_STREAM, 0);
  if (socketFd < 0)
    throw std::runtime_error("Local agent unavailable");
  ScopedFd socketGuard{socketFd};
  timeval timeout{10, 0};
  setsockopt(socketFd, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
  setsockopt(socketFd, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
  std::signal(SIGPIPE, SIG_IGN);
  std::string host = "127.0.0.1";
  if (socketPath.empty()) {
    host = localAgentAddress();
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_port = htons(port);
    if (inet_pton(AF_INET, host.c_str(), &address.sin_addr) != 1)
      throw std::runtime_error("Invalid local agent address");
#ifdef PS5
    address.sin_len = sizeof(address);
#endif
    if (connect(socketFd, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0)
      throw std::runtime_error("Local agent unavailable (connect " + std::to_string(errno) + ")");
  } else {
    auto value = socketPath.string();
    sockaddr_un address{};
    if (value.empty() || value.size() >= sizeof(address.sun_path))
      throw std::runtime_error("Invalid local agent socket");
    address.sun_family = AF_UNIX;
    std::memcpy(address.sun_path, value.c_str(), value.size() + 1);
    auto size = static_cast<socklen_t>(offsetof(sockaddr_un, sun_path) + value.size() + 1);
#ifdef PS5
    address.sun_len = static_cast<unsigned char>(size);
#endif
    if (connect(socketFd, reinterpret_cast<sockaddr *>(&address), size) != 0)
      throw std::runtime_error("Local agent unavailable (connect " + std::to_string(errno) + ")");
  }
  if (bearer.empty() || bearer.size() > 128 || bearer.find_first_of("\r\n") != std::string::npos ||
      (!sensitiveToken.empty() && !validSecret(sensitiveToken)) ||
      (!approvalProfileId.empty() && !validSecret(approvalProfileId)))
    throw std::runtime_error("Invalid local agent credential");
  auto request = method + " " + path + " HTTP/1.1\r\nHost: " + host + "\r\nAuthorization: Bearer " +
                 bearer + "\r\n";
  if (!sensitiveToken.empty())
    request += "X-PS5Library-Cheat-Session: " + sensitiveToken + "\r\n";
  if (!approvalProfileId.empty())
    request += "X-PS5Library-Cheat-Approval: " + approvalProfileId + "\r\n";
  request += "Connection: close\r\nContent-Length: 0\r\n\r\n";
  size_t sent = 0;
  while (sent < request.size()) {
#ifdef MSG_NOSIGNAL
    auto count = send(socketFd, request.data() + sent, request.size() - sent, MSG_NOSIGNAL);
#else
    auto count = send(socketFd, request.data() + sent, request.size() - sent, 0);
#endif
    if (count < 0 && errno == EINTR)
      continue;
    if (count <= 0)
      throw std::runtime_error("Local agent request failed");
    sent += static_cast<size_t>(count);
  }
  constexpr size_t limit = 12 * 1024 * 1024, headerLimit = 16 * 1024;
  std::string response;
  char bytes[16 * 1024];
  for (;;) {
    auto count = recv(socketFd, bytes, sizeof(bytes), 0);
    if (count < 0 && errno == EINTR)
      continue;
    if (count < 0)
      throw std::runtime_error("Local agent response failed");
    if (!count)
      break;
    if (response.size() + static_cast<size_t>(count) > limit + headerLimit)
      throw std::runtime_error("Local agent response too large");
    response.append(bytes, static_cast<size_t>(count));
  }
  auto headersEnd = response.find("\r\n\r\n"), lineEnd = response.find("\r\n");
  if (headersEnd == std::string::npos || headersEnd > headerLimit || lineEnd == std::string::npos ||
      response.rfind("HTTP/1.1 ", 0) != 0)
    throw std::runtime_error("Invalid local agent response");
  long status = 0;
  auto statusText = std::string_view(response).substr(9, 3);
  auto statusParse =
      std::from_chars(statusText.data(), statusText.data() + statusText.size(), status);
  if (statusParse.ec != std::errc() || statusParse.ptr != statusText.data() + statusText.size())
    throw std::runtime_error("Invalid local agent response");
  const std::string lengthHeader = "\r\nContent-Length: ";
  auto lengthAt = response.find(lengthHeader);
  if (lengthAt == std::string::npos || lengthAt > headersEnd)
    throw std::runtime_error("Invalid local agent response");
  lengthAt += lengthHeader.size();
  auto lengthEnd = response.find("\r\n", lengthAt);
  if (lengthEnd == std::string::npos || lengthEnd > headersEnd)
    throw std::runtime_error("Invalid local agent response");
  uint64_t length = 0;
  auto lengthParse =
      std::from_chars(response.data() + lengthAt, response.data() + lengthEnd, length);
  if (lengthParse.ec != std::errc() || lengthParse.ptr != response.data() + lengthEnd ||
      length > limit || response.size() - headersEnd - 4 != length)
    throw std::runtime_error("Incomplete local agent response");
  auto result = Json::parse(response.substr(headersEnd + 4));
  if (status < 200 || status >= 300)
    throw RequestError(status, result["error"].string("Local agent error"));
  return result;
}
Json saveServerSettings(const fs::path &configPath, const std::string &input, bool allowHttp,
                        bool resetPairing, const std::string &fallbackInput) {
  auto path = fs::absolute(configPath);
  auto server = normalizeServerUrl(input, allowHttp),
       fallback =
           fallbackInput.empty() ? std::string() : normalizeServerUrl(fallbackInput, allowHttp);
  if (fallback == server)
    fallback.clear();
  fs::create_directories(path.parent_path());
  int lock = open((path.parent_path() / "agent.lock").c_str(), O_CREAT | O_RDWR | O_NOFOLLOW, 0600);
  if (lock < 0)
    throw std::runtime_error("Cannot access console settings");
  ScopedFd lockGuard{lock};
  if (flock(lock, LOCK_EX | LOCK_NB) != 0)
    throw std::runtime_error("Stop the separate PS5Library agent before changing servers");
  auto config = readConfig(path);
  auto statePath = path.parent_path() / "device-state.json";
  auto saved = readJsonIfPresent(statePath);
  bool hadState = static_cast<bool>(saved);
  auto state = saved ? std::move(*saved) : Json();
  bool changed = true;
  try {
    changed = normalizeServerUrl(state["serverUrl"].string(), true) != server;
  } catch (const std::exception &) {
  }
  if (changed && !state["credential"].string().empty() && !resetPairing)
    throw PairingResetRequired();
  if (changed) {
    auto previous = Json::object({{"serverUrl", state["serverUrl"]},
                                  {"deviceId", state["deviceId"]},
                                  {"consoleId", state["consoleId"]},
                                  {"libraryRevision", state["libraryRevision"]}});
    atomicJson(path.parent_path() / "previous-server.json",
               Json::object({{"config", config}, {"device", previous}}));
    atomicJson(statePath, Json::object({{"serverUrl", server},
                                        {"deviceId", deviceId()},
                                        {"libraryRevision", int64_t(0)}}));
  }
  auto next = config.deepCopy();
  next.set("serverUrl", server);
  next.set("fallbackServerUrl", fallback);
  next.set("allowInsecureLan", allowHttp);
  try {
    atomicJson(path, next);
  } catch (...) {
    if (changed) {
      if (hadState)
        atomicJson(statePath, state);
      else
        fs::remove(statePath);
    }
    throw;
  }
  return next;
}
std::string randomHex(size_t bytes) {
  std::string data(bytes, '\0');
  if (RAND_bytes(reinterpret_cast<unsigned char *>(data.data()), static_cast<int>(bytes)) != 1)
    throw std::runtime_error("Secure random unavailable");
  return localHex(data);
}
std::string deviceId() {
  auto id = randomHex(16);
  id[12] = '4';
  id[16] = '8';
  return id.substr(0, 8) + "-" + id.substr(8, 4) + "-" + id.substr(12, 4) + "-" + id.substr(16, 4) +
         "-" + id.substr(20);
}
std::string hardwareProofFromMaterial(const std::string &server, std::string_view material) {
  if (material.empty())
    return {};
  const auto origin = normalizeServerUrl(server, true),
             domain = std::string("PS5Library hardware proof v1\0", 29);
  auto *context = EVP_MD_CTX_new();
  if (!context)
    throw std::runtime_error("Hardware identity unavailable");
  unsigned char digest[32];
  unsigned length = 0;
  if (EVP_DigestInit_ex(context, EVP_sha256(), nullptr) != 1 ||
      EVP_DigestUpdate(context, domain.data(), domain.size()) != 1 ||
      EVP_DigestUpdate(context, origin.data(), origin.size()) != 1 ||
      EVP_DigestUpdate(context, "\0", 1) != 1 ||
      EVP_DigestUpdate(context, material.data(), material.size()) != 1 ||
      EVP_DigestFinal_ex(context, digest, &length) != 1) {
    EVP_MD_CTX_free(context);
    throw std::runtime_error("Hardware identity unavailable");
  }
  EVP_MD_CTX_free(context);
  return localHex(std::string_view(reinterpret_cast<const char *>(digest), length));
}
std::string consoleHardwareProof(const std::string &server) {
#ifdef PS5
  unsigned char id[16]{};
  size_t length = sizeof(id);
  if (sysctlbyname("machdep.openpsid_for_sys", id, &length, nullptr, 0) || length != sizeof(id) ||
      std::all_of(std::begin(id), std::end(id), [](unsigned char value) { return value == 0; }))
    return {};
  return hardwareProofFromMaterial(
      server, std::string_view(reinterpret_cast<const char *>(id), sizeof(id)));
#else
  (void)server;
  return {};
#endif
}
std::string fileHash(const fs::path &filename, const std::function<bool()> &cancelled) {
  std::ifstream file(filename, std::ios::binary);
  if (!file)
    throw std::runtime_error("File missing");
  auto *ctx = EVP_MD_CTX_new();
  EVP_DigestInit_ex(ctx, EVP_sha256(), nullptr);
  std::vector<char> buffer(1024 * 1024);
  while (file) {
    if (cancelled && cancelled()) {
      EVP_MD_CTX_free(ctx);
      throw std::runtime_error("Verification aborted");
    }
    file.read(buffer.data(), buffer.size());
    EVP_DigestUpdate(ctx, buffer.data(), static_cast<size_t>(file.gcount()));
  }
  if (!file.eof()) {
    EVP_MD_CTX_free(ctx);
    throw std::runtime_error("File read failed");
  }
  unsigned char digest[32];
  unsigned length = 0;
  EVP_DigestFinal_ex(ctx, digest, &length);
  EVP_MD_CTX_free(ctx);
  return localHex(std::string_view(reinterpret_cast<const char *>(digest), length));
}
fs::path beneath(const fs::path &root, const std::string &relative) {
  if (relative.empty() || relative.front() == '/' || relative.find('\\') != std::string::npos ||
      relative.find(':') != std::string::npos || relative.find('\n') != std::string::npos ||
      relative.find('\r') != std::string::npos)
    throw std::runtime_error("Unsafe path");
  fs::path value = fs::canonical(root);
  for (const auto &component : fs::path(relative)) {
    if (component == ".." || component == "." || component.empty())
      throw std::runtime_error("Unsafe path");
    value /= component;
    if (fs::is_symlink(fs::symlink_status(value)))
      throw std::runtime_error("Symlinks are not allowed");
  }
  return value;
}
std::string notificationPayload(const std::string &message, const std::string &createdAt,
                                const std::string &id, const std::string &icon,
                                const std::string &title) {
  auto view = Json::object(
      {{"icon", Json::object({{"type", "Url"}, {"parameters", Json::object({{"url", icon}})}})},
       {"message", Json::object({{"body", message}})},
       {"subMessage", Json::object({{"body", title.empty() ? "PS5Library" : title}})}});
  auto raw = Json::object({{"viewTemplateType", "ToastTemplateB"},
                           {"channelType", "Downloads"},
                           {"bundleName", "PS5Library"},
                           {"useCaseId", "IDC"},
                           {"toastOverwriteType", "No"},
                           {"isImmediate", true},
                           {"priority", 100},
                           {"viewData", view}});
  // Omit soundEffect so ShellUI selects its native informative notification
  // sound.
  return Json::object(
             {{"rawData", raw}, {"createdDateTime", createdAt}, {"localNotificationId", id}})
      .dump();
}
bool notify(const std::string &message, const std::string &title) {
#ifdef PS5
  const char *icon = "/user/appmeta/PPSA99051/icon0.png";
  char timestamp[32]{};
  std::time_t now = std::time(nullptr);
  std::tm utc{};
  if (gmtime_r(&now, &utc) &&
      std::strftime(timestamp, sizeof(timestamp), "%Y-%m-%dT%H:%M:%S.000Z", &utc))
    try {
      auto payload = notificationPayload(message, timestamp, randomHex(8), icon, title);
      const int result = sceNotificationSend(0xFE, true, payload.c_str());
      if (result == 0)
        return true;
      std::fprintf(stderr, "Native notification unavailable: %#x\n", result);
    } catch (const std::exception &error) {
      std::fprintf(stderr, "Native notification invalid: %s\n", error.what());
    }
  return false;
#else
  std::fprintf(stderr, "%s: %s\n", title.c_str(), message.c_str());
  return true;
#endif
}
} // namespace ps5library
