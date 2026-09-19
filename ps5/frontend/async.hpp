#pragma once
#include <condition_variable>
#include <deque>
#include <future>
#include <mutex>
#include <string>
#include <thread>
#include <utility>

namespace storefront {
class AsyncWorker {
  std::mutex mutex_;std::condition_variable wake_;std::deque<std::packaged_task<std::string()>> tasks_;bool stopping_=false;std::thread thread_;
  void run(){for(;;){std::packaged_task<std::string()> task;{std::unique_lock lock(mutex_);wake_.wait(lock,[this]{return stopping_||!tasks_.empty();});if(stopping_&&tasks_.empty())return;task=std::move(tasks_.front());tasks_.pop_front();}task();}}
public:
  AsyncWorker():thread_([this]{run();}){}
  ~AsyncWorker(){{std::lock_guard lock(mutex_);stopping_=true;}wake_.notify_one();if(thread_.joinable())thread_.join();}
  AsyncWorker(const AsyncWorker&)=delete;AsyncWorker& operator=(const AsyncWorker&)=delete;
  template<class Function>std::future<std::string> submit(Function&& function){std::packaged_task<std::string()> task(std::forward<Function>(function));auto result=task.get_future();{std::lock_guard lock(mutex_);tasks_.push_back(std::move(task));}wake_.notify_one();return result;}
};
}
