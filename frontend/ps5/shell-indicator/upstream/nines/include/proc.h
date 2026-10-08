#pragma once
#include <string.h>
#include <sys/types.h>
struct proc { pid_t pid; };
typedef struct module_info module_info_t;
module_info_t* get_module_info(pid_t pid, const char* module_name);
