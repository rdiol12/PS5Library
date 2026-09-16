#pragma once
#include <atomic>
namespace storefront {
struct AudioOutputStatus {
  std::atomic<unsigned> calls{0},errors{0};
  std::atomic<int> user{-1},openResult{0},volumeResult{0},lastError{0};
  std::atomic<int> initialUserResult{0},foregroundUserResult{0},localOpenResult{0},peak{0};
  std::atomic<unsigned> samples{0},nonzeroBlocks{0};
};
extern AudioOutputStatus audioOutput;
}
