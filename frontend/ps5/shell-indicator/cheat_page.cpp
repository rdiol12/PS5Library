#include "cheat_page.hpp"

#include <algorithm>
#include <charconv>
#include <limits>
#include <stdexcept>

namespace ps5library::shell_indicator {
namespace {

bool lowerHex(std::string_view value, std::size_t size) {
  return value.size() == size &&
         std::all_of(value.begin(), value.end(), [](char c) {
           return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f');
         });
}

bool token(std::string_view value, std::size_t maximum = 64) {
  return !value.empty() && value.size() <= maximum &&
         std::all_of(value.begin(), value.end(), [](char c) {
           return (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') ||
                  c == '_';
         });
}

bool number(std::string_view value, std::uint64_t& result) {
  if (value.empty() || value.size() > 20) return false;
  const auto parsed =
      std::from_chars(value.data(), value.data() + value.size(), result);
  return parsed.ec == std::errc{} && parsed.ptr == value.data() + value.size();
}

bool fresh(std::uint64_t timestamp, std::uint64_t now) {
  constexpr std::uint64_t futureToleranceMs = 5'000;
  return timestamp >= now ? timestamp - now <= futureToleranceMs
                          : now - timestamp <= cheatStateMaximumAgeMs;
}

std::vector<std::string_view> fields(std::string_view line) {
  std::vector<std::string_view> result;
  for (;;) {
    const auto separator = line.find('\t');
    result.push_back(line.substr(0, separator));
    if (separator == std::string_view::npos) break;
    line.remove_prefix(separator + 1);
  }
  return result;
}

bool validUtf8(std::string_view value) {
  for (std::size_t index = 0; index < value.size();) {
    const auto first = static_cast<unsigned char>(value[index]);
    std::uint32_t code = 0;
    std::size_t count = 0;
    if (first < 0x80) {
      code = first;
      count = 1;
    } else if ((first & 0xe0) == 0xc0) {
      code = first & 0x1f;
      count = 2;
    } else if ((first & 0xf0) == 0xe0) {
      code = first & 0x0f;
      count = 3;
    } else if ((first & 0xf8) == 0xf0) {
      code = first & 0x07;
      count = 4;
    } else {
      return false;
    }
    if (index + count > value.size()) return false;
    for (std::size_t offset = 1; offset < count; ++offset) {
      const auto next = static_cast<unsigned char>(value[index + offset]);
      if ((next & 0xc0) != 0x80) return false;
      code = (code << 6) | (next & 0x3f);
    }
    if ((count == 2 && code < 0x80) || (count == 3 && code < 0x800) ||
        (count == 4 && code < 0x10000) || code > 0x10ffff ||
        (code >= 0xd800 && code <= 0xdfff) || code == 0xfffe ||
        code == 0xffff || code < 0x20 || code == 0x7f)
      return false;
    index += count;
  }
  return true;
}

bool unhex(std::string_view value, std::string& result,
           std::size_t maximum) {
  if (value.size() % 2 || value.size() / 2 > maximum) return false;
  result.clear();
  result.reserve(value.size() / 2);
  auto digit = [](char c) -> int {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    return -1;
  };
  for (std::size_t index = 0; index < value.size(); index += 2) {
    const int high = digit(value[index]);
    const int low = digit(value[index + 1]);
    if (high < 0 || low < 0) return false;
    result.push_back(static_cast<char>((high << 4) | low));
  }
  return validUtf8(result);
}

bool titleId(std::string_view value) {
  return value.size() == 9 &&
         (value.substr(0, 4) == "PPSA" || value.substr(0, 4) == "CUSA") &&
         std::all_of(value.begin() + 4, value.end(), [](char c) {
           return c >= '0' && c <= '9';
         });
}

bool version(std::string_view value) {
  int parts = 0;
  while (!value.empty()) {
    const auto dot = value.find('.');
    const auto part = value.substr(0, dot);
    if (part.empty() || part.size() > 3 ||
        !std::all_of(part.begin(), part.end(),
                     [](char c) { return c >= '0' && c <= '9'; }))
      return false;
    ++parts;
    if (dot == std::string_view::npos) break;
    value.remove_prefix(dot + 1);
  }
  return parts == 2 || parts == 3;
}

bool process(std::string_view value) {
  return !value.empty() && value.size() <= 128 &&
         std::all_of(value.begin(), value.end(), [](unsigned char c) {
           return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                  (c >= '0' && c <= '9') || c == '.' || c == '_' || c == '-';
         });
}

bool scalarType(std::string_view value) {
  return value == "U8" || value == "U16" || value == "U32" ||
         value == "U64" || value == "F32" || value == "F64";
}

bool bit(std::string_view value) { return value == "0" || value == "1"; }

std::string xml(std::string_view value) {
  std::string result;
  result.reserve(value.size() + 16);
  for (const char c : value) {
    switch (c) {
      case '&': result += "&amp;"; break;
      case '<': result += "&lt;"; break;
      case '>': result += "&gt;"; break;
      case '"': result += "&quot;"; break;
      default: result += c; break;
    }
  }
  return result;
}

}  // namespace

bool decodeCheatSession(std::string_view encoded, std::uint64_t nowMs,
                        CheatSession& result) noexcept {
  try {
    constexpr std::string_view prefix =
        "{\"schemaVersion\":1,\"session\":\"";
    constexpr std::string_view tokenKey = "\",\"token\":\"";
    constexpr std::string_view pidKey = "\",\"agentPid\":";
    constexpr std::string_view heartbeatKey = ",\"heartbeatAtUnixMs\":";
    if (encoded.size() > 4096 || encoded.substr(0, prefix.size()) != prefix)
      return false;
    encoded.remove_prefix(prefix.size());
    const auto sessionEnd = encoded.find(tokenKey);
    if (sessionEnd == std::string_view::npos) return false;
    CheatSession parsed;
    parsed.session = encoded.substr(0, sessionEnd);
    encoded.remove_prefix(sessionEnd + tokenKey.size());
    const auto tokenEnd = encoded.find(pidKey);
    if (tokenEnd == std::string_view::npos) return false;
    parsed.token = encoded.substr(0, tokenEnd);
    encoded.remove_prefix(tokenEnd + pidKey.size());
    const auto pidEnd = encoded.find(heartbeatKey);
    if (pidEnd == std::string_view::npos) return false;
    std::uint64_t pid = 0;
    if (!number(encoded.substr(0, pidEnd), pid) || pid == 0 ||
        pid > static_cast<std::uint64_t>(std::numeric_limits<int>::max()))
      return false;
    parsed.agentPid = static_cast<std::int64_t>(pid);
    encoded.remove_prefix(pidEnd + heartbeatKey.size());
    if (encoded.empty() || encoded.back() != '}') return false;
    encoded.remove_suffix(1);
    if (!number(encoded, parsed.heartbeatMs) ||
        !lowerHex(parsed.session, 32) || !lowerHex(parsed.token, 64) ||
        !fresh(parsed.heartbeatMs, nowMs))
      return false;
    result = std::move(parsed);
    return true;
  } catch (...) {
    return false;
  }
}

bool decodeCheatSnapshot(std::string_view encoded,
                         std::string_view expectedSession,
                         std::uint64_t nowMs,
                         CheatSnapshot& result) noexcept {
  try {
    if (encoded.empty() || encoded.size() > cheatSnapshotMaximumBytes ||
        encoded.back() != '\n' || !lowerHex(expectedSession, 32))
      return false;
    const auto headerEnd = encoded.find('\n');
    if (headerEnd == std::string_view::npos) return false;
    const auto header = fields(encoded.substr(0, headerEnd));
    if (header.size() != 5 || header[0] != "PS5LC1" ||
        header[1] != expectedSession ||
        (header[4] != "0" && header[4] != "1"))
      return false;
    std::uint64_t generated = 0, rowCount = 0;
    if (!number(header[2], generated) || !fresh(generated, nowMs) ||
        !number(header[3], rowCount) ||
        rowCount > cheatSnapshotMaximumRows)
      return false;

    CheatSnapshot parsed;
    parsed.session = std::string(header[1]);
    parsed.generatedMs = generated;
    parsed.available = true;
    parsed.truncated = header[4] == "1";
    encoded.remove_prefix(headerEnd + 1);
    bool memoryTargetSeen = false, memoryScanSeen = false;
    while (!encoded.empty()) {
      const auto end = encoded.find('\n');
      if (end == std::string_view::npos) return false;
      const auto row = fields(encoded.substr(0, end));
      encoded.remove_prefix(end + 1);
      if (row.empty()) return false;
      if (row[0] == "C") {
        if (row.size() != 13 || !lowerHex(row[1], 64) ||
            !lowerHex(row[2], 64) || !titleId(row[3]) || !version(row[4]) ||
            !token(row[6]) || !token(row[7]) || !bit(row[8]) ||
            !token(row[9]) || !bit(row[10]))
          return false;
        CheatRow item;
        item.profileId = row[1];
        item.entryId = row[2];
        item.titleId = row[3];
        item.version = row[4];
        item.validation = row[6];
        item.trust = row[7];
        item.installed = row[8] == "1";
        item.runtime = row[9];
        item.enabled = row[10] == "1";
        if (!unhex(row[5], item.process, 128) || !process(item.process) ||
            !unhex(row[11], item.name, 120) || item.name.empty() ||
            !unhex(row[12], item.description, 500))
          return false;
        parsed.rows.push_back(std::move(item));
        continue;
      }
      if (row[0] == "M") {
        if (memoryTargetSeen || row.size() != 7 || !bit(row[1]) ||
            !bit(row[2]) || !bit(row[3]))
          return false;
        memoryTargetSeen = true;
        parsed.memory.targetAvailable = row[1] == "1";
        parsed.memory.enabled = row[2] == "1";
        parsed.memory.writeEnabled = row[3] == "1";
        if (parsed.memory.writeEnabled && !parsed.memory.enabled) return false;
        if (parsed.memory.targetAvailable) {
          parsed.memory.titleId = row[4];
          parsed.memory.version = row[5];
          if (!titleId(row[4]) || !version(row[5]) ||
              !unhex(row[6], parsed.memory.process, 128) ||
              !process(parsed.memory.process))
            return false;
        } else if (!row[4].empty() || !row[5].empty() || !row[6].empty()) {
          return false;
        }
        continue;
      }
      if (row[0] == "S") {
        if (!memoryTargetSeen || !parsed.memory.targetAvailable ||
            memoryScanSeen || row.size() != 9 || !lowerHex(row[1], 32) ||
            row[2] != parsed.memory.titleId || row[3] != parsed.memory.version ||
            !scalarType(row[5]) || !token(row[6]) || !bit(row[8]))
          return false;
        std::string scanProcess;
        std::uint64_t candidateCount = 0;
        if (!unhex(row[4], scanProcess, 128) ||
            scanProcess != parsed.memory.process ||
            !number(row[7], candidateCount))
          return false;
        memoryScanSeen = true;
        parsed.memory.scanId = row[1];
        parsed.memory.valueType = row[5];
        parsed.memory.state = row[6];
        parsed.memory.matchCount = candidateCount;
        parsed.memory.truncated = row[8] == "1";
        continue;
      }
      if (row[0] == "R") {
        if (!memoryScanSeen || row.size() != 7 ||
            parsed.memory.results.size() >= 256 || !lowerHex(row[1], 32) ||
            !memoryScalarValue(row[2]) || !bit(row[3]) || !bit(row[4]) ||
            !bit(row[5]) || !bit(row[6]))
          return false;
        parsed.memory.results.push_back(
            {std::string(row[1]), std::string(row[2]), row[3] == "1",
             row[4] == "1", row[5] == "1", row[6] == "1"});
        continue;
      }
      return false;
    }
    if (parsed.rows.size() != rowCount) return false;
    result = std::move(parsed);
    return true;
  } catch (...) {
    return false;
  }
}

std::string buildCheatPage(const CheatSnapshot& snapshot) {
  std::string page =
      "<?xml version=\"1.0\" encoding=\"UTF-8\" ?>\n"
      "<system_settings version=\"1.0\" plugin=\"debug_settings_plugin\">\n"
      "<setting_list id=\"id_ps5library_cheats\" title=\"PS5Library "
      "Cheats\" restorable=\"true\">\n";
  if (!snapshot.available) {
    page += "<label id=\"id_ps5library_unavailable\" title=\"PS5Library "
            "Agent unavailable\" description=\"Start the agent and reopen "
            "this page.\" style=\"center\"/>\n";
  } else if (snapshot.rows.empty()) {
    page += "<label id=\"id_ps5library_empty\" title=\"No compatible cheats "
            "available\" style=\"center\"/>\n";
  }
  for (std::size_t index = 0; index < snapshot.rows.size(); ++index) {
    const auto& row = snapshot.rows[index];
    const auto id = std::to_string(index);
    const auto details = row.titleId + "  " + row.version +
                         (row.description.empty() ? "" : " — " + row.description);
    if (cheatRowActionable(row)) {
      page += "<toggle_switch id=\"id_ps5library_cheat_" + id +
              "\" title=\"" + xml(row.name) + "\" description=\"" +
              xml(details) + "\" value=\"" + (row.enabled ? "1" : "0") +
              "\"";
      if (row.trust == "UNVERIFIED")
        page += " confirm=\"This local cheat profile is unverified. Enable "
                "only if you trust its source.\"";
      page += "/>\n";
    } else {
      page += "<label id=\"id_ps5library_info_" + id + "\" title=\"" +
              xml(row.name) + "\" description=\"" + xml(details + " — " +
              row.validation + " / " + row.runtime) + "\"/>\n";
    }
  }
  if (snapshot.truncated)
    page += "<label id=\"id_ps5library_truncated\" title=\"More cheats are "
            "available in PS5Library\" style=\"center\"/>\n";
#if defined(PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER)
  const auto& memory = snapshot.memory;
  page += "<label id=\"id_ps5library_memory_warning\" title=\"Experimental memory scanner\" description=\"Running title only. Values are read from live game memory; writes require confirmation and can crash the game.\"/>\n";
  if (!memory.enabled) {
    page += "<label id=\"id_ps5library_memory_disabled\" title=\"Memory scanner unavailable\" description=\"Requires supported firmware and private scanner build.\"/>\n";
  } else if (!memory.targetAvailable) {
    page += "<label id=\"id_ps5library_memory_no_target\" title=\"No running game detected\" description=\"Start a supported title, then reopen this page.\"/>\n";
  } else {
    page += "<label id=\"id_ps5library_memory_target\" title=\"" + xml(memory.titleId + "  " + memory.version) + "\" description=\"" + xml(memory.process + " - writable module memory only") + "\"/>\n";
    const char* types[] = {"U8", "U16", "U32", "U64", "F32", "F64"};
    std::size_t selected = 2;
    for (std::size_t index = 0; index < 6; ++index)
      if (memory.valueType == types[index]) selected = index;
    page += "<list id=\"id_ps5library_memory_type\" title=\"Value type\" value=\"" + std::to_string(selected) + "\">\n";
    for (std::size_t index = 0; index < 6; ++index)
      page += "<list_item id=\"id_ps5library_memory_type_" + std::to_string(index) + "\" title=\"" + types[index] + "\" value=\"" + std::to_string(index) + "\"/>\n";
    page += "</list>\n";
    if (memory.scanId.empty()) {
      page += "<text_field id=\"id_ps5library_memory_start\" title=\"Exact value scan\" description=\"Enter the value currently shown in the game.\" keyboard_type=\"basic_latin\" min_length=\"1\" max_length=\"32\" value=\"0\"/>\n";
      page += "<button id=\"id_ps5library_memory_unknown\" title=\"Unknown initial value\" description=\"Create a bounded baseline of the running title's main module.\" confirm=\"Unknown scans can take longer and use up to 32 MiB of agent memory. Continue?\"/>\n";
    } else {
      page += "<label id=\"id_ps5library_memory_status\" title=\"" + xml(memory.state.empty() ? "Scan ready" : memory.state) + "\" description=\"" + std::to_string(memory.matchCount) + " candidates" + (memory.truncated ? " - first results shown" : "") + "\"/>\n";
      page += "<text_field id=\"id_ps5library_memory_refine_exact\" title=\"Refine to exact value\" keyboard_type=\"basic_latin\" min_length=\"1\" max_length=\"32\" value=\"0\"/>\n";
      for (const auto* mode : {"CHANGED", "UNCHANGED", "INCREASED", "DECREASED"}) {
        std::string lower(mode);
        std::transform(lower.begin(), lower.end(), lower.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
        page += "<button id=\"id_ps5library_memory_" + lower + "\" title=\"Refine: " + lower + "\"/>\n";
      }
      page += "<button id=\"id_ps5library_memory_refresh\" title=\"Refresh live values\"/>\n";
      for (std::size_t index = 0; index < memory.results.size(); ++index) {
        const auto& result = memory.results[index];
        const auto id = std::to_string(index);
        const auto title = "Result " + std::to_string(index + 1);
        if (memory.writeEnabled && result.writable) {
          page += "<text_field id=\"id_ps5library_memory_result_" + id + "\" title=\"New value for " + title + "\" second_title=\"" + xml(result.value) + "\" keyboard_type=\"basic_latin\" min_length=\"1\" max_length=\"32\" value=\"" + xml(result.value) + "\"/>\n";
          page += "<button id=\"id_ps5library_memory_write_" + id + "\" title=\"Apply result " + std::to_string(index + 1) + "\" confirm=\"Change this live value? The game may become unstable.\"/>\n";
          page += "<button id=\"id_ps5library_memory_freeze_" + id + "\" title=\"" + (result.frozen ? "Unfreeze" : "Freeze") + " result " + std::to_string(index + 1) + "\" confirm=\"Repeated writes can crash the game. Continue?\"/>\n";
          if (result.modified)
            page += "<button id=\"id_ps5library_memory_restore_" + id + "\" title=\"Restore result " + std::to_string(index + 1) + "\" confirm=\"Restore the original value for this result?\"/>\n";
        } else {
          page += "<label id=\"id_ps5library_memory_result_" + id + "\" title=\"" + title + "\" second_title=\"" + xml(result.value) + "\" description=\"Read only\"/>\n";
        }
      }
      page += "<button id=\"id_ps5library_memory_clear\" title=\"Close memory scan\" confirm=\"Modified values must be restored before the scan can close.\"/>\n";
    }
  }
#endif
  page += "</setting_list>\n</system_settings>\n";
  return page;
}

bool cheatRowActionable(const CheatRow& row) noexcept {
  return row.validation == "VALID" && row.installed &&
         row.runtime == "READY" &&
         row.trust != "SERVER_APPROVED_UNVERIFIED_TARGET";
}

std::optional<std::size_t> cheatRowIndex(std::string_view id,
                                         std::size_t rowCount) noexcept {
  constexpr std::string_view prefix = "id_ps5library_cheat_";
  if (id.substr(0, prefix.size()) != prefix) return std::nullopt;
  id.remove_prefix(prefix.size());
  if (id.empty() || (id.size() > 1 && id.front() == '0')) return std::nullopt;
  std::size_t index = 0;
  const auto parsed = std::from_chars(id.data(), id.data() + id.size(), index);
  if (parsed.ec != std::errc{} || parsed.ptr != id.data() + id.size() ||
      index >= rowCount)
    return std::nullopt;
  return index;
}

std::optional<std::size_t> memoryResultIndex(std::string_view id,
                                             std::size_t rowCount) noexcept {
  constexpr std::string_view prefix = "id_ps5library_memory_result_";
  if (id.substr(0, prefix.size()) != prefix) return std::nullopt;
  id.remove_prefix(prefix.size());
  if (id.empty() || (id.size() > 1 && id.front() == '0')) return std::nullopt;
  std::size_t index = 0;
  const auto parsed = std::from_chars(id.data(), id.data() + id.size(), index);
  return parsed.ec == std::errc{} && parsed.ptr == id.data() + id.size() &&
                 index < rowCount
             ? std::optional<std::size_t>(index)
             : std::nullopt;
}

bool memoryScalarValue(std::string_view value) noexcept {
  if (value.empty() || value.size() > 32) return false;
  std::size_t index = value.front() == '-' ? 1 : 0;
  if (index == value.size()) return false;
  bool digits = false, dot = false, exponent = false, exponentDigits = false;
  for (; index < value.size(); ++index) {
    const char c = value[index];
    if (c >= '0' && c <= '9') {
      digits = true;
      if (exponent) exponentDigits = true;
    } else if (c == '.' && !dot && !exponent && digits) {
      dot = true;
      digits = false;
    } else if ((c == 'e' || c == 'E') && !exponent && digits) {
      exponent = true;
      exponentDigits = false;
      if (index + 1 < value.size() &&
          (value[index + 1] == '+' || value[index + 1] == '-'))
        ++index;
    } else {
      return false;
    }
  }
  return digits && (!exponent || exponentDigits);
}

namespace {
std::string memoryRequest(const CheatSession& session, std::string_view method,
                          const std::string& path,
                          std::string_view approval = {}) {
  if (!lowerHex(session.token, 64) || path.empty())
    throw std::invalid_argument("Invalid memory scan request");
  auto request = std::string(method) + " " + path +
                 " HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer " +
                 session.token + "\r\n";
  if (!approval.empty()) {
    if (!lowerHex(approval, 32))
      throw std::invalid_argument("Invalid memory scan approval");
    request += "X-PS5Library-Memory-Approval: " + std::string(approval) +
               "\r\n";
  }
  return request + "Connection: close\r\nContent-Length: 0\r\n\r\n";
}

bool memoryType(std::string_view value) {
  return value == "U8" || value == "U16" || value == "U32" ||
         value == "U64" || value == "F32" || value == "F64";
}

void validMemoryView(const MemoryScanView& view, bool requireScan) {
  if (!view.targetAvailable || !titleId(view.titleId) ||
      !version(view.version) || !process(view.process) ||
      (requireScan && !lowerHex(view.scanId, 32)))
    throw std::invalid_argument("Invalid memory scan target");
}
}  // namespace

std::string buildMemoryTargetRequest(const CheatSession& session) {
  return memoryRequest(session, "GET", "/api/v1/agent/memory-scans/target");
}

std::string buildMemoryStartRequest(const CheatSession& session,
                                    const MemoryScanView& view,
                                    std::string_view type, bool unknown,
                                    std::string_view value) {
  validMemoryView(view, false);
  if (!memoryType(type) || (!unknown && !memoryScalarValue(value)) ||
      (unknown && !value.empty()))
    throw std::invalid_argument("Invalid memory scan value");
  auto path = "/api/v1/agent/memory-scans/start/" + view.titleId + "/" +
              view.version + "/" + std::string(type) +
              (unknown ? "/UNKNOWN" : "/EXACT/" + std::string(value));
  return memoryRequest(session, "POST", path);
}

std::string buildMemoryRefineRequest(const CheatSession& session,
                                     const MemoryScanView& view,
                                     std::string_view mode,
                                     std::string_view value) {
  validMemoryView(view, true);
  const bool exact = mode == "EXACT";
  const bool comparison = mode == "CHANGED" || mode == "UNCHANGED" ||
                          mode == "INCREASED" || mode == "DECREASED";
  if ((!exact && !comparison) || (exact != memoryScalarValue(value)) ||
      (comparison && !value.empty()))
    throw std::invalid_argument("Invalid memory scan refinement");
  auto path = "/api/v1/agent/memory-scans/" + view.scanId + "/refine/" +
              std::string(mode) + (exact ? "/" + std::string(value) : "");
  return memoryRequest(session, "POST", path);
}

std::string buildMemoryWatchRequest(const CheatSession& session,
                                    const MemoryScanView& view) {
  validMemoryView(view, true);
  return memoryRequest(session, "GET",
                       "/api/v1/agent/memory-scans/" + view.scanId);
}

std::string buildMemoryWriteRequest(const CheatSession& session,
                                    const MemoryScanView& view,
                                    const MemoryScanResult& result,
                                    std::string_view value, bool freeze) {
  validMemoryView(view, true);
  if (!view.writeEnabled || !result.writable ||
      !lowerHex(result.resultId, 32) || !memoryScalarValue(value))
    throw std::invalid_argument("Invalid memory write");
  const auto action = freeze ? "freeze" : "write";
  return memoryRequest(session, "POST",
                       "/api/v1/agent/memory-scans/" + view.scanId +
                           "/results/" + result.resultId + "/" + action +
                           "/" + std::string(value),
                       view.scanId);
}

std::string buildMemoryRestoreRequest(const CheatSession& session,
                                      const MemoryScanView& view,
                                      const MemoryScanResult& result) {
  validMemoryView(view, true);
  if (!view.writeEnabled || !result.modified ||
      !lowerHex(result.resultId, 32))
    throw std::invalid_argument("Invalid memory restore");
  return memoryRequest(session, "POST",
                       "/api/v1/agent/memory-scans/" + view.scanId +
                           "/results/" + result.resultId + "/restore",
                       view.scanId);
}

std::string buildMemoryClearRequest(const CheatSession& session) {
  return memoryRequest(session, "POST", "/api/v1/agent/memory-scans/clear");
}

std::string buildCheatRequest(const CheatSession& session,
                              const CheatRow& row, bool enabled,
                              bool approveUnverified) {
  if (!lowerHex(session.token, 64) || !lowerHex(row.profileId, 64) ||
      !lowerHex(row.entryId, 64))
    throw std::invalid_argument("Invalid cheat request");
  std::string request =
      "POST /api/v1/agent/cheats/" + row.profileId + "/" + row.entryId +
      (enabled ? "/enable" : "/disable") +
      " HTTP/1.1\r\nHost: 127.0.0.1\r\nAuthorization: Bearer " +
      session.token + "\r\n";
  if (enabled && approveUnverified && row.trust == "UNVERIFIED")
    request += "X-PS5Library-Cheat-Approval: " + row.profileId + "\r\n";
  return request + "Connection: close\r\nContent-Length: 0\r\n\r\n";
}

}  // namespace ps5library::shell_indicator
