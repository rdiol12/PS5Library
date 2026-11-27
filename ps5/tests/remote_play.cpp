#include <cassert>
#include <cstdint>
#include <string>
namespace ps5library {
std::string remotePlayAccountId(uint64_t value);
std::string remotePlayPin(uint32_t value);
std::string foregroundLocalUserId(int (*initialize)(void *),
                                  int (*foreground)(int *));
int enableRemotePlayRegistry(unsigned userId, int (*get)(int, int *),
                             int (*set)(int, int));
} // namespace ps5library
namespace {
int sequence = 0;
int initialize(void *) {
  assert(sequence++ == 0);
  return -1;
}
int foreground(int *user) {
  assert(sequence++ == 1);
  *user = 0x12345678;
  return 0;
}
int unavailable(int *) { return -1; }
int globalRemotePlay = 0, userRemotePlay = 0;
int registryGet(int key, int *value) {
  if (key == 0x41810000) {
    *value = globalRemotePlay;
    return 0;
  }
  if (key == 0x07800100 + 2 * 0x10000) {
    *value = 0x12345678;
    return 0;
  }
  if (key == 0x07807801 + 2 * 0x10000) {
    *value = userRemotePlay;
    return 0;
  }
  return -1;
}
int registrySet(int key, int value) {
  if (key == 0x41810000)
    globalRemotePlay = value;
  else if (key == 0x07807801 + 2 * 0x10000)
    userRemotePlay = value;
  else
    return -1;
  return 0;
}
} // namespace
int main() {
  assert(ps5library::remotePlayAccountId(0x0807060504030201ULL) ==
         "AQIDBAUGBwg=");
  assert(ps5library::remotePlayAccountId(0) == "AAAAAAAAAAA=");
  assert(ps5library::remotePlayPin(42) == "00000042");
  assert(ps5library::remotePlayPin(99999999) == "99999999");
  assert(ps5library::remotePlayPin(100000000).empty());
  assert(ps5library::foregroundLocalUserId(initialize, foreground) ==
         "12345678");
  assert(sequence == 2);
  sequence = 0;
  assert(ps5library::foregroundLocalUserId(initialize, unavailable).empty());
  globalRemotePlay = userRemotePlay = 0;
  assert(ps5library::enableRemotePlayRegistry(0x12345678, registryGet,
                                              registrySet) == 0);
  assert(globalRemotePlay == 1 && userRemotePlay == 1);
  assert(ps5library::enableRemotePlayRegistry(0x12345678, registryGet,
                                              registrySet) == 0);
  assert(globalRemotePlay == 1 && userRemotePlay == 1);
  assert(ps5library::enableRemotePlayRegistry(0x87654321, registryGet,
                                              registrySet) != 0);
}
