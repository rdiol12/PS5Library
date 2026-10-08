#pragma once

#include <cstddef>
#include <cstdint>
#include <sys/types.h>

namespace ps5library::shell_indicator {

bool injectHelper(pid_t shellUiPid, std::uint8_t* elf,
                  std::size_t elfSize) noexcept;

}  // namespace ps5library::shell_indicator
