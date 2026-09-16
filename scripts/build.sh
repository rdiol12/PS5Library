#!/usr/bin/env bash
set -euo pipefail
cmake -S ps5 -B ps5/build/host -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_C_COMPILER=clang-18 -DCMAKE_CXX_COMPILER=clang++-18
cmake --build ps5/build/host --parallel 4
SDL_VIDEODRIVER=dummy SDL_AUDIODRIVER=dummy ctest --test-dir ps5/build/host --output-on-failure
cmake -S ps5 -B ps5/build/ps5 -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_TOOLCHAIN_FILE="$PS5_PAYLOAD_SDK/toolchain/prospero.cmake"
cmake --build ps5/build/ps5 --target ps5library-install --parallel 4
mkdir -p dist
cp ps5/build/ps5/ps5library.elf ps5/build/ps5/ps5library-install.elf \
  ps5/build/ps5/ps5library-install.elf.json dist/
python3 scripts/check-release.py dist
