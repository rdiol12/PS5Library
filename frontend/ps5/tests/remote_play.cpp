#include <cassert>
#include <cstdint>
#include <string>
namespace ps5library {
std::string remotePlayAccountId(uint64_t value);
std::string remotePlayPin(uint32_t value);
std::string foregroundLocalUserId(int(*initialize)(void*),int(*foreground)(int*));
}
namespace {
int sequence=0;
int initialize(void*){assert(sequence++==0);return -1;}
int foreground(int* user){assert(sequence++==1);*user=0x12345678;return 0;}
int unavailable(int*){return -1;}
}
int main(){
  assert(ps5library::remotePlayAccountId(0x0807060504030201ULL)=="AQIDBAUGBwg=");
  assert(ps5library::remotePlayAccountId(0)=="AAAAAAAAAAA=");
  assert(ps5library::remotePlayPin(42)=="00000042");
  assert(ps5library::remotePlayPin(99999999)=="99999999");
  assert(ps5library::remotePlayPin(100000000).empty());
  assert(ps5library::foregroundLocalUserId(initialize,foreground)=="12345678");
  assert(sequence==2);
  sequence=0;
  assert(ps5library::foregroundLocalUserId(initialize,unavailable).empty());
}
