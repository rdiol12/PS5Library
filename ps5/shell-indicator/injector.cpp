/*
 * Adapter around pinned OnionHEN libNineS/libonion_elfldr sources.
 * GPL-3.0-or-later. See LICENSE.GPL-3.0.
 */
#include "injector.hpp"

extern "C" {
#include "upstream/nines/include/injector.h"
}

namespace ps5library::shell_indicator {

bool injectHelper(pid_t shellUiPid, std::uint8_t* elf,
                  std::size_t elfSize) noexcept {
  if (shellUiPid <= 1 || !elf ||
      elfldr_sanity_check(elf, elfSize) != 0)
    return false;
  proc target{};
  target.pid = shellUiPid;
  return inject_elf(&target, elf) != 0;
}

}  // namespace ps5library::shell_indicator
