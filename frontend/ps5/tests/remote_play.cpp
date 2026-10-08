#include <cassert>
#include <cstdint>
#include <string>
namespace ps5library {
std::string remotePlayAccountId(uint64_t value);
std::string remotePlayPin(uint32_t value);
}
int main(){
  assert(ps5library::remotePlayAccountId(0x0807060504030201ULL)=="AQIDBAUGBwg=");
  assert(ps5library::remotePlayAccountId(0)=="AAAAAAAAAAA=");
  assert(ps5library::remotePlayPin(42)=="00000042");
  assert(ps5library::remotePlayPin(99999999)=="99999999");
  assert(ps5library::remotePlayPin(100000000).empty());
}
