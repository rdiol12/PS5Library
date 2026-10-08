/* Compatibility surface for pinned OnionHEN sources. GPL-3.0-or-later. */
#pragma once
#include <stdio.h>
#define LOG_DEBUG(...) do { fprintf(stderr, "[shell-indicator] "); fprintf(stderr, __VA_ARGS__); fputc('\n', stderr); } while (0)
#define LOG_INFO(...) LOG_DEBUG(__VA_ARGS__)
#define LOG_WARN(...) LOG_DEBUG(__VA_ARGS__)
#define LOG_ERROR(...) LOG_DEBUG(__VA_ARGS__)
