#pragma once
#include <atomic>
#include <chrono>
#include <memory>
#include <stdexcept>
#include <string>
#include <thread>
#include <utility>
#include "../common/json.hpp"

namespace storefront {
class AsyncWorker {
  struct State {
    std::atomic<bool> ready{false};
    std::string value;
  };
public:
  enum class Status { ready, timeout };
  class Result {
    friend class AsyncWorker;
    std::unique_ptr<State> state_;
    std::thread thread_;
    explicit Result(std::unique_ptr<State> state,std::thread thread):state_(std::move(state)),thread_(std::move(thread)){}
    std::string get(void(*checkpoint)(int)=nullptr){
      wait(checkpoint);
      auto state=std::move(state_);
      if(checkpoint)checkpoint(1013313);
      auto value=std::move(state->value);if(checkpoint)checkpoint(1013314);return value;
    }
  public:
    Result()=default;
    Result(Result&&)=default;
    Result& operator=(Result&& other)noexcept{if(this!=&other){if(thread_.joinable())thread_.join();state_=std::move(other.state_);thread_=std::move(other.thread_);}return *this;}
    Result(const Result&)=delete;
    Result& operator=(const Result&)=delete;
    ~Result(){if(thread_.joinable())thread_.join();}
    bool valid()const{return static_cast<bool>(state_);}
    void wait(void(*checkpoint)(int)=nullptr){
      if(!state_)throw std::logic_error("invalid asynchronous result");
      if(checkpoint)checkpoint(1013311);
      if(thread_.joinable())thread_.join();
      if(checkpoint)checkpoint(1013312);
    }
    template<class Rep,class Period>Status wait_for(const std::chrono::duration<Rep,Period>& timeout)const{
      if(!state_)throw std::logic_error("invalid asynchronous result");
      if(state_->ready.load(std::memory_order_acquire))return Status::ready;
      if(timeout<=timeout.zero())return Status::timeout;
      const auto deadline=std::chrono::steady_clock::now()+timeout;
      do{std::this_thread::yield();if(state_->ready.load(std::memory_order_acquire))return Status::ready;}while(std::chrono::steady_clock::now()<deadline);
      return Status::timeout;
    }
  };
public:
  template<class Function>Result submit(Function&& function){
    auto state=std::make_unique<State>();auto* pending=state.get();
    std::thread thread([pending,function=std::forward<Function>(function)]()mutable{
      try{pending->value=function().dump();}
      catch(const std::exception& error){pending->value=Json::object({{"error",error.what()[0]?error.what():"asynchronous task failed"}}).dump();}
      catch(...){pending->value=Json::object({{"error","asynchronous task failed"}}).dump();}
      pending->ready.store(true,std::memory_order_release);
    });
    return Result(std::move(state),std::move(thread));
  }
  static Json take(Result& result,void(*checkpoint)(int)=nullptr){
    if(checkpoint)checkpoint(101331);auto text=result.get(checkpoint);
    if(checkpoint)checkpoint(101332);auto value=Json::parse(text);
    if(checkpoint)checkpoint(101333);
    if(checkpoint)checkpoint(101334);return value;
  }
};
}
