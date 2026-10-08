#include "../agent/local.hpp"
#include "../shell-indicator/cheat_page.hpp"

#include <cassert>
#include <string>

using namespace ps5library;
using namespace ps5library::shell_indicator;

namespace {

std::string request(std::string method, std::string path,
                    const std::string& bearer,
                    const std::string& session = {},
                    const std::string& approval = {}) {
  auto value = std::move(method) + " " + std::move(path) +
               " HTTP/1.1\r\nAuthorization: Bearer " + bearer + "\r\n";
  if (!session.empty())
    value += "X-PS5Library-Cheat-Session: " + session + "\r\n";
  if (!approval.empty())
    value += "X-PS5Library-Memory-Approval: " + approval + "\r\n";
  return value + "\r\n";
}

void parserChecks() {
  const std::string bearer(64, 'a'), session(64, 'b'), scan(32, 'c'),
      result(32, 'd');
  auto parse = [&](std::string method, std::string path,
                   std::string approval = {}) {
    return parseLocalAgentRequest(
        request(std::move(method), std::move(path), bearer, {}, approval), {},
        bearer, true);
  };

  assert(parse("GET", "/api/v1/agent/memory-scans/target").action ==
         LocalAgentAction::MemoryScanTarget);
  auto start = parse("POST", "/api/v1/agent/memory-scans/start/PPSA12345/1.02/U32/EXACT/42");
  assert(start.action == LocalAgentAction::MemoryScanStart &&
         start.titleId == "PPSA12345" && start.version == "1.02" &&
         start.valueType == "U32" && start.scanMode == "EXACT" &&
         start.scalarValue == "42");
  auto unknown = parse(
      "POST", "/api/v1/agent/memory-scans/start/PPSA12345/1.02/F32/UNKNOWN");
  assert(unknown.action == LocalAgentAction::MemoryScanStart &&
         unknown.scanMode == "UNKNOWN" && unknown.scalarValue.empty());
  auto refine = parse("POST", "/api/v1/agent/memory-scans/" + scan +
                                  "/refine/DECREASED");
  assert(refine.action == LocalAgentAction::MemoryScanRefine &&
         refine.scanId == scan && refine.scanMode == "DECREASED");
  auto exact = parse("POST", "/api/v1/agent/memory-scans/" + scan +
                                 "/refine/EXACT/-1.5e2");
  assert(exact.action == LocalAgentAction::MemoryScanRefine &&
         exact.scalarValue == "-1.5e2");
  assert(parse("GET", "/api/v1/agent/memory-scans/" + scan).action ==
         LocalAgentAction::MemoryScanWatch);
  auto write = parse("POST", "/api/v1/agent/memory-scans/" + scan +
                                 "/results/" + result + "/write/99",
                     scan);
  assert(write.action == LocalAgentAction::MemoryScanWrite &&
         write.scanId == scan && write.resultId == result &&
         write.scalarValue == "99" && write.explicitApproval && !write.freeze);
  auto freeze = parse("POST", "/api/v1/agent/memory-scans/" + scan +
                                  "/results/" + result + "/freeze/99", scan);
  assert(freeze.action == LocalAgentAction::MemoryScanWrite && freeze.freeze &&
         freeze.explicitApproval);
  auto restore = parse("POST", "/api/v1/agent/memory-scans/" + scan +
                                   "/results/" + result + "/restore", scan);
  assert(restore.action == LocalAgentAction::MemoryScanRestore &&
         restore.resultId == result && restore.explicitApproval);
  auto unapprovedRestore = parse(
      "POST", "/api/v1/agent/memory-scans/" + scan + "/results/" +
                  result + "/restore");
  assert(unapprovedRestore.action == LocalAgentAction::MemoryScanRestore &&
         !unapprovedRestore.explicitApproval);
  assert(parse("POST", "/api/v1/agent/memory-scans/clear").action ==
         LocalAgentAction::MemoryScanClear);

  assert(parse("POST", "/api/v1/agent/memory-scans/start/PPSA12345/1.02/AOB/EXACT/90").action ==
         LocalAgentAction::Invalid);
  assert(parse("POST", "/api/v1/agent/memory-scans/start/PPSA12345/1.02/F32/EXACT/nan").action ==
         LocalAgentAction::Invalid);
  assert(parse("POST", "/api/v1/agent/memory-scans/" + scan +
                             "/results/0000000000001000/write/1",
               scan)
             .action == LocalAgentAction::Invalid);
  auto unapproved = parse("POST", "/api/v1/agent/memory-scans/" + scan +
                                      "/results/" + result + "/write/1");
  assert(unapproved.action == LocalAgentAction::MemoryScanWrite &&
         !unapproved.explicitApproval);
  assert(parseLocalAgentRequest(
             request("GET", "/api/v1/agent/memory-scans/target",
                     localAgentCredential, session),
             std::string(64, 'e'))
             .action == LocalAgentAction::Invalid);
}

void snapshotChecks() {
  const std::string session(32, 'a'), scan(32, 'c'), resultId(32, 'd');
  const auto encoded = "PS5LC1\t" + session + "\t1000\t0\t0\n" +
      "M\t1\t1\t1\tPPSA12345\t1.02\t65626f6f742e62696e\n" +
      "S\t" + scan +
      "\tPPSA12345\t1.02\t65626f6f742e62696e\tU32\tREADY\t1\t0\n" +
      "R\t" + resultId + "\t42\t0\t1\t0\t0\n";
  CheatSnapshot snapshot;
  assert(decodeCheatSnapshot(encoded, session, 1000, snapshot));
  assert(snapshot.memory.targetAvailable && snapshot.memory.enabled &&
         snapshot.memory.writeEnabled && snapshot.memory.titleId == "PPSA12345" &&
         snapshot.memory.process == "eboot.bin" && snapshot.memory.scanId == scan &&
         snapshot.memory.matchCount == 1 && snapshot.memory.results.size() == 1 &&
         snapshot.memory.results[0].resultId == resultId &&
         snapshot.memory.results[0].writable);
  auto invalid = encoded;
  invalid.replace(invalid.find(resultId), resultId.size(), "0000000000001000");
  assert(!decodeCheatSnapshot(invalid, session, 1000, snapshot));
}

void pageChecks() {
  MemoryScanView view;
  view.targetAvailable = true;
  view.enabled = true;
  view.writeEnabled = true;
  view.titleId = "PPSA12345";
  view.version = "1.02";
  view.process = "eboot.bin";
  view.scanId = std::string(32, 'c');
  view.valueType = "U32";
  view.state = "READY";
  view.matchCount = 1;
  view.results.push_back({std::string(32, 'd'), "42", false, true, true, false});
  CheatSnapshot cheats;
  cheats.available = true;
  auto startView = view;
  startView.scanId.clear();
  startView.results.clear();
  cheats.memory = startView;
  const auto startPage = buildCheatPage(cheats);
  assert(startPage.find("Experimental memory scanner") != std::string::npos);
  assert(startPage.find("Running title only") != std::string::npos);
  assert(startPage.find("id_ps5library_memory_start") != std::string::npos);
  cheats.memory = view;
  const auto page = buildCheatPage(cheats);
  assert(page.find("id_ps5library_memory_result_0") != std::string::npos);
  assert(page.find(view.scanId) == std::string::npos);
  assert(page.find(view.results[0].resultId) == std::string::npos);
  assert(page.find("address") == std::string::npos);
  assert(memoryResultIndex("id_ps5library_memory_result_0", 1) == 0);
  assert(!memoryResultIndex("id_ps5library_memory_result_01", 2));

  CheatSession session{std::string(32, 'a'), std::string(64, 'b'), 1, 1};
  const auto start = buildMemoryStartRequest(session, view, "F32", false, "-1.5");
  assert(start.find("/F32/EXACT/-1.5 HTTP/1.1") != std::string::npos);
  assert(buildMemoryStartRequest(session, view, "U64", true)
             .find("/U64/UNKNOWN HTTP/1.1") != std::string::npos);
  const auto changed = buildMemoryRefineRequest(session, view, "CHANGED");
  assert(changed.find("/refine/CHANGED HTTP/1.1") != std::string::npos);
  assert(buildMemoryRefineRequest(session, view, "EXACT", "17")
             .find("/refine/EXACT/17 HTTP/1.1") != std::string::npos);
  assert(buildMemoryWatchRequest(session, view)
             .find("/memory-scans/" + view.scanId + " HTTP/1.1") !=
         std::string::npos);
  assert(buildMemoryWriteRequest(session, view, view.results[0], "98", false)
             .find("/write/98 HTTP/1.1") != std::string::npos);
  const auto write = buildMemoryWriteRequest(session, view, view.results[0], "99", true);
  assert(write.find("/freeze/99 HTTP/1.1") != std::string::npos);
  assert(write.find("X-PS5Library-Memory-Approval: " + view.scanId) !=
         std::string::npos);
  const auto restoreRequest =
      buildMemoryRestoreRequest(session, view, view.results[0]);
  assert(restoreRequest.find("/restore HTTP/1.1") != std::string::npos &&
         restoreRequest.find("X-PS5Library-Memory-Approval: " + view.scanId) !=
             std::string::npos);
  assert(page.find("id_ps5library_memory_write_0") != std::string::npos);
  assert(buildMemoryClearRequest(session)
             .find("/memory-scans/clear HTTP/1.1") != std::string::npos);
  auto readOnly = view;
  readOnly.writeEnabled = false;
  cheats.memory = readOnly;
  const auto readOnlyPage = buildCheatPage(cheats);
  assert(readOnlyPage.find("description=\"Read only\"") != std::string::npos);
  assert(readOnlyPage.find("id_ps5library_memory_freeze_0") ==
         std::string::npos);
  cheats.memory = {};
  const auto disabledPage = buildCheatPage(cheats);
  assert(disabledPage.find("supported firmware and private scanner build") !=
         std::string::npos);
  assert(memoryScalarValue("-1.5e2") && !memoryScalarValue("nan") &&
         !memoryScalarValue("1.2.3"));
}

}  // namespace

int main() {
  parserChecks();
  snapshotChecks();
  pageChecks();
}
