#include "client.hpp"
#include "version.hpp"
#include <algorithm>
#include <arpa/inet.h>
#include <cctype>
#include <cerrno>
#include <charconv>
#include <chrono>
#include <cstdio>
#include <cstring>
#include <fcntl.h>
#include <memory>
#include <mutex>
#include <netinet/in.h>
#include <poll.h>
#include <regex>
#include <sys/socket.h>
#include <sys/time.h>
#include <thread>
#include <unistd.h>
#include <unordered_set>
#include <vector>

namespace ps5library {
using CurlHandle = std::unique_ptr<CURL, decltype(&curl_easy_cleanup)>;
using CurlHeaders = std::unique_ptr<curl_slist, decltype(&curl_slist_free_all)>;
static CURLcode perform(CURL *curl) {
  static std::mutex mutex;
  std::lock_guard lock(mutex);
  return curl_easy_perform(curl);
}
static bool fallbackNetworkError(CURLcode error, long status) {
  if (status)
    return false;
  switch (error) {
  case CURLE_COULDNT_RESOLVE_HOST:
  case CURLE_COULDNT_CONNECT:
  case CURLE_OPERATION_TIMEDOUT:
  case CURLE_SEND_ERROR:
  case CURLE_RECV_ERROR:
  case CURLE_GOT_NOTHING:
  case CURLE_PARTIAL_FILE:
    return true;
  default:
    return false;
  }
}
Client::Client(const Json &config, const fs::path &unixSocket)
    : base_(normalizeServerUrl(config["serverUrl"].string(), config["allowInsecureLan"].boolean())),
      fallback_(config["fallbackServerUrl"].string().empty()
                    ? std::string()
                    : normalizeServerUrl(config["fallbackServerUrl"].string(),
                                         config["allowInsecureLan"].boolean())),
      proxy_(normalizeProxyUrl(config["serverProxyUrl"].string())),
      fallbackProxy_(normalizeProxyUrl(config["fallbackProxyUrl"].string())),
      ca_(config["caBundle"].string()), unixSocket_(unixSocket.string()),
      insecure_(config["allowInsecureLan"].boolean()) {
  if (fallback_ == base_ || !unixSocket_.empty()) {
    fallback_.clear();
    fallbackProxy_.clear();
  }
  if (!unixSocket_.empty())
    proxy_.clear();
  static std::once_flag once;
  static CURLcode initialized = CURLE_FAILED_INIT;
  std::call_once(once, [] { initialized = curl_global_init(CURL_GLOBAL_DEFAULT); });
  if (initialized != CURLE_OK)
    throw std::runtime_error("Network initialization failed");
}
CURL *Client::handle(const std::string &relative, bool fallback, bool ignoreCancelled) const {
  if (!ignoreCancelled && cancelled && cancelled())
    throw std::runtime_error("Request aborted");
  if (relative.rfind("/api/v1/", 0) != 0 || relative.find("..") != std::string::npos)
    throw std::runtime_error("Invalid server API path");
  CurlHandle curl(curl_easy_init(), curl_easy_cleanup);
  if (!curl)
    throw std::runtime_error("Network allocation failed");
  const auto &endpoint = fallback ? fallback_ : base_;
  auto url = endpoint + relative;
  curl_easy_setopt(curl.get(), CURLOPT_URL, url.c_str());
  const auto &proxy = fallback ? fallbackProxy_ : proxy_;
  if (!proxy.empty() &&
      (curl_easy_setopt(curl.get(), CURLOPT_PROXY, proxy.c_str()) != CURLE_OK ||
       curl_easy_setopt(curl.get(), CURLOPT_PROXYTYPE, CURLPROXY_HTTP) != CURLE_OK))
    throw std::runtime_error("Cannot use configured proxy");
  if (!unixSocket_.empty() &&
      (curl_easy_setopt(curl.get(), CURLOPT_UNIX_SOCKET_PATH, unixSocket_.c_str()) != CURLE_OK ||
       curl_easy_setopt(curl.get(), CURLOPT_PROXY, "") != CURLE_OK))
    throw std::runtime_error("Local agent socket setup failed");
  curl_easy_setopt(curl.get(), CURLOPT_PROTOCOLS_STR, insecure_ ? "http,https" : "https");
  curl_easy_setopt(curl.get(), CURLOPT_FOLLOWLOCATION, 0L);
  curl_easy_setopt(curl.get(), CURLOPT_CONNECTTIMEOUT,
                   clientConnectTimeout(!fallback_.empty(), fallback));
  curl_easy_setopt(curl.get(), CURLOPT_TIMEOUT, 30L);
  curl_easy_setopt(curl.get(), CURLOPT_SSL_VERIFYPEER, 1L);
  curl_easy_setopt(curl.get(), CURLOPT_SSL_VERIFYHOST, 2L);
  curl_easy_setopt(curl.get(), CURLOPT_NOSIGNAL, 1L);
  curl_easy_setopt(curl.get(), CURLOPT_USERAGENT,
                   ("PS5Library/" + std::string(appVersion)).c_str());
  curl_easy_setopt(curl.get(), CURLOPT_NOPROGRESS, 0L);
  curl_easy_setopt(curl.get(), CURLOPT_XFERINFODATA, this);
  curl_easy_setopt(
      curl.get(), CURLOPT_XFERINFOFUNCTION,
      +[](void *data, curl_off_t, curl_off_t, curl_off_t, curl_off_t) -> int {
        auto *client = static_cast<const Client *>(data);
        return client->cancelled && client->cancelled() ? 1 : 0;
      });
  if (!ca_.empty())
    curl_easy_setopt(curl.get(), CURLOPT_CAINFO, ca_.c_str());
  return curl.release();
}
std::pair<CURLcode, long>
Client::withFallback(const std::string &relative,
                     const std::function<CURLcode(CURL *, bool)> &attempt) const {
  CURLcode error = CURLE_FAILED_INIT;
  long status = 0;
  for (int index = 0; index < (fallback_.empty() ? 1 : 2); index++) {
    const bool fallback = index == 1;
    CurlHandle curl(handle(relative, fallback), curl_easy_cleanup);
    error = attempt(curl.get(), fallback);
    status = 0;
    curl_easy_getinfo(curl.get(), CURLINFO_RESPONSE_CODE, &status);
    if (error == CURLE_OK) {
      fallbackActive_ = fallback;
      break;
    }
    if (!fallback && !fallbackNetworkError(error, status))
      break;
  }
  return {error, status};
}
static bool nativeDownloadPath(const std::string &value) {
  static const std::regex path(
      R"(^/api/v1/native-downloads/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/[0-9a-f]{64}/(game\.pkg|icon\.png)$)");
  return std::regex_match(value, path);
}
bool Client::nativeDownloadRelayRequired() const {
  return (fallbackActive_ && !fallback_.empty()) ? !fallbackProxy_.empty() : !proxy_.empty();
}
std::string Client::nativeDownloadUrl(const std::string &relative) const {
  if (!nativeDownloadPath(relative))
    throw std::runtime_error("Invalid native download path");
  if (nativeDownloadRelayRequired())
    throw std::runtime_error("NATIVE_INSTALL_DIRECT_URL_UNAVAILABLE");
  return (fallbackActive_ && !fallback_.empty() ? fallback_ : base_) + relative;
}
std::string Client::nativeUpdateUrl(const std::string &relative) const {
  static const std::regex path(
      R"(^/api/v1/native-updates/((PPSA99051|PPSA99783)/([1-9][0-9]*/packages/[0-9a-f]{64}\.pkg|icon\.png)|grants/[0-9a-f]{64}/(PPSA99051|PPSA99783)/(packages/[0-9a-f]{64}\.pkg|icon\.png))$)");
  if (!std::regex_match(relative, path))
    throw std::runtime_error("Invalid native update path");
  if ((fallbackActive_ && !fallback_.empty()) ? !fallbackProxy_.empty() : !proxy_.empty())
    throw std::runtime_error("NATIVE_INSTALL_DIRECT_URL_UNAVAILABLE");
  return (fallbackActive_ && !fallback_.empty() ? fallback_ : base_) + relative;
}
template <size_t Limit>
static size_t collect(char *ptr, size_t size, size_t count, void *userdata) {
  auto &out = *static_cast<std::string *>(userdata);
  if (out.size() > Limit || (size && count > (Limit - out.size()) / size))
    return 0;
  const auto bytes = size * count;
  out.append(ptr, bytes);
  return bytes;
}
static void appendHeader(CurlHeaders &list, const std::string &value) {
  auto *next = curl_slist_append(list.get(), value.c_str());
  if (!next)
    throw std::runtime_error("Network header allocation failed");
  list.release();
  list.reset(next);
}
static CurlHeaders headers(const std::string &credential) {
  CurlHeaders list(nullptr, curl_slist_free_all);
  appendHeader(list, "Content-Type: application/json");
  appendHeader(list, "Connection: close");
  appendHeader(list, "X-PS5Library-Client: ps5");
  if (!credential.empty())
    appendHeader(list, "Authorization: Bearer " + credential);
  return list;
}
struct NativeDownloadRelay::Impl {
  struct Request {
    bool head = false;
    std::string path, range, ifRange;
  };
  struct Response {
    int peer;
    long status = 0;
    bool sent = false, discard = false;
    std::string length, range, type, etag;
  };
  Client &client;
  int listener = -1;
  uint16_t port = 0;
  std::atomic<bool> stopping{false};
  std::mutex mutex;
  std::unordered_set<std::string> pinned;
  std::vector<std::thread> workers;
  static bool sendAll(int peer, const char *value, size_t size) {
    while (size) {
#ifdef MSG_NOSIGNAL
      auto count = send(peer, value, size, MSG_NOSIGNAL);
#else
      auto count = send(peer, value, size, 0);
#endif
      if (count < 0 && errno == EINTR)
        continue;
      if (count <= 0)
        return false;
      value += count;
      size -= static_cast<size_t>(count);
    }
    return true;
  }
  static bool sendAll(int peer, const std::string &value) {
    return sendAll(peer, value.data(), value.size());
  }
  static const char *reason(long status) {
    switch (status) {
    case 200:
      return "OK";
    case 206:
      return "Partial Content";
    case 400:
      return "Bad Request";
    case 404:
      return "Not Found";
    case 405:
      return "Method Not Allowed";
    case 409:
      return "Conflict";
    case 416:
      return "Range Not Satisfiable";
    default:
      return "Bad Gateway";
    }
  }
  static void sendStatus(int peer, long status) {
    sendAll(peer, "HTTP/1.1 " + std::to_string(status) + " " + reason(status) +
                      "\r\nCache-Control: no-store\r\nConnection: "
                      "close\r\nContent-Length: 0\r\n\r\n");
  }
  static std::string trim(std::string_view value) {
    auto first = value.find_first_not_of(" \t"), last = value.find_last_not_of(" \t\r\n");
    return first == std::string_view::npos ? std::string()
                                           : std::string(value.substr(first, last - first + 1));
  }
  static bool decimal(std::string_view value) {
    if (value.empty() || value.size() > 19)
      return false;
    uint64_t parsed = 0;
    auto result = std::from_chars(value.data(), value.data() + value.size(), parsed);
    return result.ec == std::errc() && result.ptr == value.data() + value.size() &&
           parsed <= static_cast<uint64_t>(INT64_MAX);
  }
  static bool validRange(const std::string &value) {
    if (value.rfind("bytes=", 0) != 0)
      return false;
    auto dash = value.find('-', 6);
    if (dash == std::string::npos || value.find(',', 6) != std::string::npos ||
        !decimal(std::string_view(value).substr(6, dash - 6)))
      return false;
    auto last = std::string_view(value).substr(dash + 1);
    if (last.empty())
      return true;
    if (!decimal(last))
      return false;
    uint64_t firstValue = 0, lastValue = 0;
    std::from_chars(value.data() + 6, value.data() + dash, firstValue);
    std::from_chars(last.data(), last.data() + last.size(), lastValue);
    return lastValue >= firstValue;
  }
  static bool validIfRange(const std::string &value) {
    static const std::regex etag(R"(^"[0-9a-f]{64}"$)"),
        date(
            R"(^((Mon|Tue|Wed|Thu|Fri|Sat|Sun), [0-9]{2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) [0-9]{4} [0-9]{2}:[0-9]{2}:[0-9]{2} GMT)$)");
    return std::regex_match(value, etag) || std::regex_match(value, date);
  }
  static bool parse(std::string_view raw, Request &request) {
    auto end = raw.find("\r\n"), firstSpace = raw.find(' '),
         secondSpace =
             firstSpace == std::string_view::npos ? firstSpace : raw.find(' ', firstSpace + 1);
    if (end == std::string_view::npos || firstSpace == std::string_view::npos ||
        secondSpace == std::string_view::npos || raw.find(' ', secondSpace + 1) < end)
      return false;
    auto method = raw.substr(0, firstSpace),
         version = raw.substr(secondSpace + 1, end - secondSpace - 1);
    request.head = method == "HEAD";
    if ((method != "GET" && !request.head) || (version != "HTTP/1.1" && version != "HTTP/1.0"))
      return false;
    request.path = std::string(raw.substr(firstSpace + 1, secondSpace - firstSpace - 1));
    if (request.path.empty() || request.path.size() > 2048 || request.path.front() != '/')
      return false;
    bool range = false, ifRange = false, contentLength = false;
    size_t cursor = end + 2;
    while (cursor < raw.size()) {
      auto next = raw.find("\r\n", cursor);
      if (next == std::string_view::npos)
        return false;
      if (next == cursor)
        break;
      auto line = raw.substr(cursor, next - cursor);
      cursor = next + 2;
      if (line.empty() || line.front() == ' ' || line.front() == '\t')
        return false;
      auto colon = line.find(':');
      if (colon == std::string_view::npos || !colon)
        return false;
      std::string name(line.substr(0, colon));
      for (char &c : name) {
        if (!std::isalnum(static_cast<unsigned char>(c)) && c != '-')
          return false;
        c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
      }
      auto value = trim(line.substr(colon + 1));
      for (unsigned char c : value)
        if (c < 32 || c == 127)
          return false;
      if (name == "range") {
        if (range || !validRange(value))
          return false;
        range = true;
        request.range = value;
      } else if (name == "if-range") {
        if (ifRange || !validIfRange(value))
          return false;
        ifRange = true;
        request.ifRange = value;
      } else if (name == "content-length") {
        if (contentLength || value != "0")
          return false;
        contentLength = true;
      } else if (name == "transfer-encoding")
        return false;
    }
    return !ifRange || range;
  }
  static size_t receiveHeader(char *data, size_t size, size_t count, void *output) {
    auto &response = *static_cast<Response *>(output);
    const auto bytes = size * count;
    std::string_view line(data, bytes);
    if (line.rfind("HTTP/", 0) == 0) {
      auto at = line.find(' ');
      response.status =
          at != std::string_view::npos && at + 4 <= line.size() &&
                  std::isdigit(static_cast<unsigned char>(line[at + 1])) &&
                  std::isdigit(static_cast<unsigned char>(line[at + 2])) &&
                  std::isdigit(static_cast<unsigned char>(line[at + 3]))
              ? (line[at + 1] - '0') * 100 + (line[at + 2] - '0') * 10 + line[at + 3] - '0'
              : 0;
      response.length.clear();
      response.range.clear();
      response.type.clear();
      response.etag.clear();
      return bytes;
    }
    if (line == "\r\n") {
      if (response.status != 200 && response.status != 206) {
        auto status = response.status == 404 || response.status == 409 || response.status == 416
                          ? response.status
                          : 502;
        sendStatus(response.peer, status);
        response.sent = true;
        response.discard = true;
        return bytes;
      }
      if (!decimal(response.length) ||
          (response.status == 206 &&
           (response.range.empty() ||
            !std::regex_match(response.range, std::regex(R"(^bytes [0-9]+-[0-9]+/[0-9]+$)"))))) {
        sendStatus(response.peer, 502);
        response.sent = true;
        response.discard = true;
        return 0;
      }
      auto header = "HTTP/1.1 " + std::to_string(response.status) + " " + reason(response.status) +
                    "\r\nContent-Length: " + response.length +
                    "\r\nAccept-Ranges: bytes\r\nConnection: close\r\n";
      if (!response.range.empty())
        header += "Content-Range: " + response.range + "\r\n";
      if (response.type == "application/octet-stream" || response.type == "image/png")
        header += "Content-Type: " + response.type + "\r\n";
      if (validIfRange(response.etag))
        header += "ETag: " + response.etag + "\r\n";
      header += "\r\n";
      response.sent = sendAll(response.peer, header);
      return response.sent ? bytes : 0;
    }
    auto colon = line.find(':');
    if (colon == std::string_view::npos)
      return bytes;
    std::string name(line.substr(0, colon));
    std::transform(name.begin(), name.end(), name.begin(),
                   [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    auto value = trim(line.substr(colon + 1));
    if (name == "content-length")
      response.length = value;
    else if (name == "content-range")
      response.range = value;
    else if (name == "content-type")
      response.type = value;
    else if (name == "etag")
      response.etag = value;
    return bytes;
  }
  static size_t receiveBody(char *data, size_t size, size_t count, void *output) {
    auto &response = *static_cast<Response *>(output);
    const auto bytes = size * count;
    if (response.discard)
      return bytes;
    return response.sent && sendAll(response.peer, data, bytes) ? bytes : 0;
  }
  void forward(int peer, const Request &request, const std::string &path) {
    const bool fallback = client.fallbackActive_ && !client.fallback_.empty();
    Response response{peer, 0, false, false, {}, {}, {}, {}};
    try {
      CurlHandle curl(client.handle(path, fallback, true), curl_easy_cleanup);
      auto list = headers(client.credential);
      if (!request.ifRange.empty())
        appendHeader(list, "If-Range: " + request.ifRange);
      if (!request.range.empty())
        curl_easy_setopt(curl.get(), CURLOPT_RANGE, request.range.c_str() + 6);
      curl_easy_setopt(curl.get(), CURLOPT_HTTPHEADER, list.get());
      curl_easy_setopt(curl.get(), CURLOPT_NOBODY, request.head ? 1L : 0L);
      curl_easy_setopt(curl.get(), CURLOPT_TIMEOUT, 0L);
      curl_easy_setopt(curl.get(), CURLOPT_LOW_SPEED_LIMIT, 1024L);
      curl_easy_setopt(curl.get(), CURLOPT_LOW_SPEED_TIME, 30L);
      curl_easy_setopt(curl.get(), CURLOPT_SUPPRESS_CONNECT_HEADERS, 1L);
      curl_easy_setopt(curl.get(), CURLOPT_HEADERFUNCTION, receiveHeader);
      curl_easy_setopt(curl.get(), CURLOPT_HEADERDATA, &response);
      curl_easy_setopt(curl.get(), CURLOPT_WRITEFUNCTION, receiveBody);
      curl_easy_setopt(curl.get(), CURLOPT_WRITEDATA, &response);
      curl_easy_setopt(curl.get(), CURLOPT_XFERINFODATA, this);
      curl_easy_setopt(
          curl.get(), CURLOPT_XFERINFOFUNCTION,
          +[](void *value, curl_off_t, curl_off_t, curl_off_t, curl_off_t) -> int {
            return static_cast<Impl *>(value)->stopping.load();
          });
      auto error = curl_easy_perform(curl.get());
      if (error != CURLE_OK && !stopping)
        std::fprintf(stderr, "Native download relay failed: %s\n", curl_easy_strerror(error));
    } catch (const std::exception &error) {
      std::fprintf(stderr, "Native download relay failed: %s\n", error.what());
    } catch (...) {
      std::fprintf(stderr, "Native download relay failed: unknown error\n");
    }
    if (!response.sent)
      sendStatus(peer, 502);
  }
  void serve(int peer) {
    timeval timeout{30, 0};
    setsockopt(peer, SOL_SOCKET, SO_RCVTIMEO, &timeout, sizeof(timeout));
    setsockopt(peer, SOL_SOCKET, SO_SNDTIMEO, &timeout, sizeof(timeout));
    constexpr size_t limit = 16 * 1024;
    std::string raw;
    char bytes[1024];
    while (raw.size() < limit && raw.find("\r\n\r\n") == std::string::npos) {
      auto count = recv(peer, bytes, std::min(sizeof(bytes), limit - raw.size()), 0);
      if (count < 0 && errno == EINTR)
        continue;
      if (count <= 0)
        break;
      raw.append(bytes, static_cast<size_t>(count));
    }
    Request request;
    if (raw.find("\r\n\r\n") == std::string::npos || !parse(raw, request)) {
      sendStatus(peer, 400);
      return;
    }
    auto query = request.path.find('?');
    auto route = request.path.substr(0, query);
    std::string path;
    {
      std::lock_guard lock(mutex);
      if (pinned.count(route))
        path = route;
    }
    if (path.empty()) {
      sendStatus(peer, 404);
      return;
    }
    forward(peer, request, path);
  }
  void run() {
    while (!stopping) {
      pollfd descriptor{listener, POLLIN, 0};
      auto ready = poll(&descriptor, 1, 100);
      if (ready < 0 && errno == EINTR)
        continue;
      if (ready <= 0 || !(descriptor.revents & POLLIN))
        continue;
      sockaddr_in address{};
      socklen_t size = sizeof(address);
      int peer = accept(listener, reinterpret_cast<sockaddr *>(&address), &size);
      if (peer < 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK || errno == EINTR)
          continue;
        if (stopping)
          break;
        continue;
      }
      if (address.sin_family == AF_INET && address.sin_addr.s_addr == htonl(INADDR_LOOPBACK))
        serve(peer);
      close(peer);
    }
  }
  explicit Impl(Client &source, uint16_t requested) : client(source) {
    listener = socket(AF_INET, SOCK_STREAM, 0);
    if (listener < 0)
      throw std::runtime_error("NATIVE_INSTALL_RELAY_UNAVAILABLE");
    int reuse = 1;
    setsockopt(listener, SOL_SOCKET, SO_REUSEADDR, &reuse, sizeof(reuse));
    sockaddr_in address{};
    address.sin_family = AF_INET;
    address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    address.sin_port = htons(requested);
#ifdef PS5
    address.sin_len = sizeof(address);
#endif
    if (bind(listener, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0 ||
        listen(listener, 4) != 0) {
      close(listener);
      listener = -1;
      throw std::runtime_error("NATIVE_INSTALL_RELAY_UNAVAILABLE");
    }
    auto flags = fcntl(listener, F_GETFL, 0);
    socklen_t size = sizeof(address);
    if (flags < 0 || fcntl(listener, F_SETFL, flags | O_NONBLOCK) != 0 ||
        getsockname(listener, reinterpret_cast<sockaddr *>(&address), &size) != 0) {
      close(listener);
      listener = -1;
      throw std::runtime_error("NATIVE_INSTALL_RELAY_UNAVAILABLE");
    }
    port = ntohs(address.sin_port);
    try {
      for (int i = 0; i < 2; i++)
        workers.emplace_back([this] { run(); });
    } catch (...) {
      stopping = true;
      for (auto &worker : workers)
        worker.join();
      close(listener);
      listener = -1;
      throw;
    }
  }
  ~Impl() {
    stopping = true;
    if (listener >= 0)
      shutdown(listener, SHUT_RDWR);
    for (auto &worker : workers)
      if (worker.joinable())
        worker.join();
    if (listener >= 0)
      close(listener);
  }
  std::string url(const std::string &path) const {
    return "http://127.0.0.1:" + std::to_string(port) + path;
  }
};
NativeDownloadRelay::NativeDownloadRelay(Client &client, uint16_t port)
    : impl_(std::make_unique<Impl>(client, port)) {
}
NativeDownloadRelay::~NativeDownloadRelay() = default;
std::pair<std::string, std::string> NativeDownloadRelay::pin(const std::string &packagePath,
                                                             const std::string &iconPath) {
  constexpr size_t jobPrefix = sizeof("/api/v1/native-downloads/") - 1 + 36 + 1;
  if (!nativeDownloadPath(packagePath) ||
      packagePath.compare(jobPrefix + 64, sizeof("/game.pkg") - 1, "/game.pkg") ||
      (!iconPath.empty() &&
       (!nativeDownloadPath(iconPath) ||
        iconPath.compare(jobPrefix + 64, sizeof("/icon.png") - 1, "/icon.png") ||
        iconPath.compare(0, jobPrefix, packagePath, 0, jobPrefix))))
    throw std::runtime_error("Invalid native download path");
  {
    std::lock_guard lock(impl_->mutex);
    impl_->pinned.clear();
    impl_->pinned.insert(packagePath);
    if (!iconPath.empty())
      impl_->pinned.insert(iconPath);
  }
  return {impl_->url(packagePath), iconPath.empty() ? std::string() : impl_->url(iconPath)};
}
Client::ImageResponse Client::artwork(const std::string &relative, const std::string &etag,
                                      const std::function<bool()> &cancelled) const {
  ImageResponse result;
  char details[CURL_ERROR_SIZE]{};
  auto [error, status] = withFallback(relative, [&](CURL *curl, bool) {
    result = {};
    details[0] = 0;
    auto list = headers(credential);
    if (!etag.empty())
      appendHeader(list, "If-None-Match: " + etag);
    curl_easy_setopt(curl, CURLOPT_ERRORBUFFER, details);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, list.get());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, collect<32 * 1024 * 1024>);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &result.data);
    curl_easy_setopt(curl, CURLOPT_NOPROGRESS, 0L);
    curl_easy_setopt(curl, CURLOPT_XFERINFODATA, &cancelled);
    curl_easy_setopt(
        curl, CURLOPT_XFERINFOFUNCTION,
        +[](void *callback, curl_off_t, curl_off_t, curl_off_t, curl_off_t) -> int {
          return (*static_cast<const std::function<bool()> *>(callback))() ? 1 : 0;
        });
    curl_easy_setopt(curl, CURLOPT_HEADERDATA, &result.etag);
    curl_easy_setopt(
        curl, CURLOPT_HEADERFUNCTION, (+[](char *data, size_t a, size_t b, void *output) -> size_t {
          std::string line(data, a * b);
          if (line.size() > 5 && (line.substr(0, 5) == "ETag:" || line.substr(0, 5) == "etag:")) {
            auto start = line.find_first_not_of(" \t", 5);
            auto end = line.find_last_not_of("\r\n ");
            if (start != std::string::npos)
              *static_cast<std::string *>(output) = line.substr(start, end - start + 1);
          }
          return a * b;
        }));
    return perform(curl);
  });
  if (error != CURLE_OK || !(status == 200 || status == 304))
    throw std::runtime_error(std::string("Artwork unavailable: ") +
                             (details[0] ? details : curl_easy_strerror(error)) + " (HTTP " +
                             std::to_string(status) + ")");
  result.unchanged = status == 304;
  return result;
}
std::string Client::bytes(const std::string &relative) const {
  std::string output;
  auto [error, status] = withFallback(relative, [&](CURL *curl, bool) {
    output.clear();
    auto list = headers(credential);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, list.get());
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, collect<12 * 1024 * 1024>);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &output);
    return perform(curl);
  });
  if (error != CURLE_OK || status < 200 || status >= 300)
    throw std::runtime_error("Server request failed (" + std::to_string(status) + ")");
  return output;
}
Json Client::request(const std::string &method, const std::string &relative,
                     const Json &body) const {
  auto data = body.dump();
  std::string output;
  char details[CURL_ERROR_SIZE]{};
  long osError = 0;
  auto [error, status] = withFallback(relative, [&](CURL *curl, bool) {
    output.clear();
    details[0] = 0;
    auto list = headers(credential);
    curl_easy_setopt(curl, CURLOPT_ERRORBUFFER, details);
    curl_easy_setopt(curl, CURLOPT_HTTPHEADER, list.get());
    curl_easy_setopt(curl, CURLOPT_CUSTOMREQUEST, method.c_str());
    if (method != "GET") {
      curl_easy_setopt(curl, CURLOPT_POSTFIELDS, data.c_str());
      curl_easy_setopt(curl, CURLOPT_POSTFIELDSIZE, static_cast<long>(data.size()));
    }
    curl_easy_setopt(curl, CURLOPT_WRITEFUNCTION, collect<12 * 1024 * 1024>);
    curl_easy_setopt(curl, CURLOPT_WRITEDATA, &output);
    auto error = perform(curl);
    osError = 0;
    curl_easy_getinfo(curl, CURLINFO_OS_ERRNO, &osError);
    return error;
  });
  if (error != CURLE_OK)
    throw std::runtime_error(std::string(details[0] ? details : curl_easy_strerror(error)) +
                             " (errno " + std::to_string(osError) + ")");
  auto result = Json::parse(output);
  if (status < 200 || status >= 300)
    throw RequestError(status, result["error"].string("Server error"));
  return result;
}
Json Client::uploadLaunchTrace(const fs::path &filename) const {
  constexpr size_t limit = 1024 * 1024;
  Json trace;
  try {
    trace = readJson(filename, limit);
    if (!trace.isObject() || !trace["traceCompletedAtUnixMs"].isInteger())
      throw std::runtime_error("Incomplete launch trace");
  } catch (...) {
    throw std::runtime_error("Launch trace unavailable, incomplete, or larger than 1 MiB");
  }
  return request("POST", "/api/v1/device/launch-traces", trace);
}
struct Transfer {
  FILE *file;
  int64_t limit, written = 0;
};
static size_t writeChunk(char *ptr, size_t size, size_t count, void *userdata) {
  auto &t = *static_cast<Transfer *>(userdata);
  auto bytes = size * count;
  if (bytes > static_cast<size_t>(t.limit - t.written))
    return 0;
  auto n = fwrite(ptr, 1, bytes, t.file);
  t.written += static_cast<int64_t>(n);
  return n;
}
void Client::download(const std::string &relative, const fs::path &part, int64_t size,
                      const std::string &hash,
                      const std::function<void(int64_t, int64_t)> &progress) const {
  if (size < 0 || hash.size() != 64 ||
      hash.find_first_not_of("0123456789abcdef") != std::string::npos)
    throw std::runtime_error("CORRUPT_INPUT");
  if (!part.parent_path().empty())
    fs::create_directories(part.parent_path());
  auto status = fs::symlink_status(part);
  if (fs::exists(status) && !fs::is_regular_file(status))
    throw std::runtime_error("CORRUPT_INPUT");
  auto offset = fs::exists(status) ? static_cast<int64_t>(fs::file_size(part)) : 0;
  if (offset > size)
    throw std::runtime_error("CORRUPT_INPUT");
  if (offset == size) {
    if (fileHash(part, cancelled) != hash)
      throw std::runtime_error("CORRUPT_INPUT");
    progress(size, 0);
    return;
  }
  constexpr int64_t chunkSize = 4 * 1024 * 1024;
  while (offset < size) {
    const auto wanted = std::min(chunkSize, size - offset), end = offset + wanted - 1;
    auto started = std::chrono::steady_clock::now();
    bool complete = false;
    for (int attempt = 0; attempt < (fallback_.empty() ? 1 : 2); attempt++) {
      CurlHandle curl(handle(relative, attempt == 1), curl_easy_cleanup);
      int fd =
          open(part.c_str(), O_CREAT | O_WRONLY | O_NOFOLLOW | (offset ? O_APPEND : O_TRUNC), 0600);
      if (fd < 0)
        throw std::runtime_error("Cannot open staging file");
      std::unique_ptr<FILE, decltype(&fclose)> file(fdopen(fd, offset ? "ab" : "wb"), fclose);
      if (!file) {
        close(fd);
        throw std::runtime_error("Cannot open staging file");
      }
      auto list = headers(credential);
      appendHeader(list, "If-Range: \"" + hash + "\"");
      const auto range = std::to_string(offset) + "-" + std::to_string(end);
      Transfer transfer{file.get(), wanted};
      curl_easy_setopt(curl.get(), CURLOPT_HTTPHEADER, list.get());
      curl_easy_setopt(curl.get(), CURLOPT_RANGE, range.c_str());
      curl_easy_setopt(curl.get(), CURLOPT_FAILONERROR, 1L);
      curl_easy_setopt(curl.get(), CURLOPT_TIMEOUT, 0L);
      curl_easy_setopt(curl.get(), CURLOPT_LOW_SPEED_LIMIT, 1024L);
      curl_easy_setopt(curl.get(), CURLOPT_LOW_SPEED_TIME, 30L);
      curl_easy_setopt(curl.get(), CURLOPT_WRITEFUNCTION, writeChunk);
      curl_easy_setopt(curl.get(), CURLOPT_WRITEDATA, &transfer);
      auto error = perform(curl.get());
      long response = 0;
      curl_easy_getinfo(curl.get(), CURLINFO_RESPONSE_CODE, &response);
      int flushed = fflush(file.get()), synced = flushed ? 0 : fsync(fd),
          closed = fclose(file.release());
      complete = error == CURLE_OK && response == 206 && transfer.written == wanted && !flushed &&
                 !synced && !closed && static_cast<int64_t>(fs::file_size(part)) == end + 1;
      if (complete) {
        fallbackActive_ = attempt == 1;
        break;
      }
      if (attempt == 0 && !fallback_.empty() && fallbackNetworkError(error, response)) {
        if (truncate(part.c_str(), offset) != 0)
          throw std::runtime_error("Transfer interrupted; partial file retained");
        continue;
      }
      throw std::runtime_error("Transfer interrupted; partial file retained");
    }
    if (!complete)
      throw std::runtime_error("Transfer interrupted; partial file retained");
    offset = end + 1;
    auto ms = std::max<int64_t>(1, std::chrono::duration_cast<std::chrono::milliseconds>(
                                       std::chrono::steady_clock::now() - started)
                                       .count());
    if (offset < size)
      progress(offset, wanted * 1000 / ms);
  }
  if (fileHash(part, cancelled) != hash)
    throw std::runtime_error("CORRUPT_INPUT");
  progress(size, 0);
}
} // namespace ps5library
