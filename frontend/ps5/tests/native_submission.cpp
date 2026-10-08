#include "../common/client.hpp"
#include <cassert>

int main(){using namespace ps5library;
  const auto root=fs::temp_directory_path()/randomHex(8),marker=root/"native.json";
  const std::string hash(64,'a'),server="https://library.example",console="console-1";

  // Crash after persisting intent but before recording acceptance.
  beginNativeSubmission(marker,hash,server,console);
  assert(inspectNativeSubmission(marker,hash,server,console,false)==NativeSubmissionDecision::Uncertain);

  // A definite synchronous rejection is safe to clear.
  resetNativeSubmission(marker);
  assert(inspectNativeSubmission(marker,hash,server,console,false)==NativeSubmissionDecision::Submit);

  // Restart after acceptance observes the native job instead of duplicating it.
  beginNativeSubmission(marker,hash,server,console);
  acceptNativeSubmission(marker,hash,server,console);
  assert(inspectNativeSubmission(marker,hash,server,console,false)==NativeSubmissionDecision::Monitor);

  // Only the owner's explicit retry resets an existing marker.
  assert(inspectNativeSubmission(marker,hash,server,console,true)==NativeSubmissionDecision::Submit);
  assert(!fs::exists(marker));
  fs::remove_all(root);
}
