#pragma once
#include "../common/client.hpp"
#include "audio.hpp"
#include <atomic>
#include <condition_variable>
#include <deque>
#include <mutex>
#include <thread>

namespace storefront {
// One start per uninterrupted focus; returning to a cover starts a fresh countdown.
class PreviewDelay {
  std::string key_;uint64_t since_=0;bool started_=false;
public:
  bool ready(const std::string& key,uint64_t now,uint64_t delay=5000){if(key!=key_){key_=key;since_=now;started_=false;}if(key.empty()||started_||now-since_<delay)return false;started_=true;return true;}
};

class VideoPreview {
  struct Picture {int width,height;double pts;std::vector<uint8_t> pixels;};
  struct Sound {double pts;std::vector<Sint16> samples;};
  struct Request {std::string config,token,url,hash;int64_t size=0;uint64_t generation=0;bool music=false;};
  ps5library::fs::path root_;UiAudio& audio_;SDL_Texture* texture_=nullptr;
  std::mutex mutex_;std::condition_variable wake_;std::thread worker_;
  std::atomic<bool> stopping_{false};std::atomic<uint64_t> generation_{0};
  std::deque<Picture> pictures_;std::deque<Sound> sounds_;Request request_;bool pending_=false,ended_=false;std::string error_;
  std::string key_;bool active_=false,clockStarted_=false,sound_=true,music_=false;Uint64 started_=0;double lastPts_=0,audioEnd_=0;
  int width_=0,height_=0;uint64_t displayed_=0,audioBytes_=0,starts_=0;std::atomic<uint64_t> decoded_{0};
  uint64_t musicStarts_=0,musicBytes_=0;
  void worker();double decode(const ps5library::fs::path& file,uint64_t generation,bool music,double offset);
  bool cancelled(uint64_t generation)const{return stopping_||generation_!=generation;}
public:
  VideoPreview(const ps5library::fs::path& root,UiAudio& audio);
  ~VideoPreview();
  void stop();
  void start(const std::string& key,const Json& config,const std::string& token,const Json& trailer,bool sound,bool music=false);
  SDL_Texture* frame(SDL_Renderer* renderer);
  bool active()const{return active_;}
  bool music()const{return music_;}uint64_t musicStarts()const{return musicStarts_;}uint64_t musicBytes()const{return musicBytes_;}
  std::string error(){std::lock_guard lock(mutex_);return error_;}
  uint64_t displayed()const{return displayed_;}uint64_t decoded()const{return decoded_;}uint64_t audioBytes()const{return audioBytes_;}uint64_t starts()const{return starts_;}
};
}
