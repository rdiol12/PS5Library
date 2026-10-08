#include "../include/ucred.h"
#include <ps5/kernel.h>
#include <unistd.h>

#define PTRACE_AUTHID 0x4800000000010003ULL

uintptr_t set_ucred_to_ptrace(void) {
  const uintptr_t previous = kernel_get_ucred_authid(getpid());
  if (!previous || kernel_set_ucred_authid(getpid(), PTRACE_AUTHID)) return 0;
  return previous;
}
