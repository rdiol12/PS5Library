#pragma once
#include "../common/client.hpp"
#include <SDL_image.h>
#include <openssl/evp.h>
#include <algorithm>
#include <atomic>
#include <condition_variable>
#include <deque>
#include <fstream>
#include <mutex>
#include <set>
#include <thread>
#include <unordered_map>
namespace storefront {
inline SDL_Texture* uploadArtworkSurface(SDL_Renderer* renderer,SDL_Surface* source){
  if(!source)return nullptr;
  SDL_Surface* converted=source->format->format==SDL_PIXELFORMAT_ARGB8888?source:SDL_ConvertSurfaceFormat(source,SDL_PIXELFORMAT_ARGB8888,0);
  if(!converted)return nullptr;
  auto* texture=SDL_CreateTexture(renderer,SDL_PIXELFORMAT_ARGB8888,SDL_TEXTUREACCESS_STATIC,converted->w,converted->h);
  if(texture&&SDL_UpdateTexture(texture,nullptr,converted->pixels,converted->pitch)!=0){SDL_DestroyTexture(texture);texture=nullptr;}
  if(texture)SDL_SetTextureBlendMode(texture,SDL_BLENDMODE_BLEND);
  if(converted!=source)SDL_FreeSurface(converted);
  return texture;
}
class Artwork {
  struct Decoded {std::string url;SDL_Surface* surface;};
  struct Texture {SDL_Texture* value;size_t bytes;Uint64 seen;Uint32 retryAt;};
  ps5library::fs::path root_;std::string config_,credential_;bool preview_;
  mutable std::mutex mutex_;std::condition_variable wake_;std::vector<std::thread> workers_;
  std::deque<std::string> requests_;std::deque<Decoded> decoded_;std::set<std::string> wanted_,pending_;
  std::unordered_map<std::string,Texture> textures_;std::unordered_map<std::string,std::string> localFiles_,localKeys_;std::atomic<bool> stopping_{false},offline_{false};size_t bytes_=0,loads_=0,failures_=0;Uint64 frame_=0;std::string lastError_;
  std::string cacheName(const std::string& text){unsigned char hash[32];unsigned length=0;EVP_Digest(text.data(),text.size(),hash,&length,EVP_sha256(),nullptr);std::string key;for(unsigned i=0;i<length;i++){key+="0123456789abcdef"[hash[i]>>4];key+="0123456789abcdef"[hash[i]&15];}return key;}
  static bool localAgentUrl(const std::string& url){return url.rfind("/api/v1/agent/media/",0)==0;}
  bool cancelled(const std::string& url){return stopping_||(offline_&&!localAgentUrl(url));}
  void trimDisk(){std::vector<ps5library::fs::directory_entry> files;uintmax_t total=0;for(const auto& e:ps5library::fs::directory_iterator(root_))if(e.is_regular_file()&&e.path().extension()==".img"){files.push_back(e);total+=e.file_size();}std::sort(files.begin(),files.end(),[](const auto&a,const auto&b){return a.last_write_time()<b.last_write_time();});for(const auto& e:files){if(total<=256*1024*1024)break;total-=e.file_size();ps5library::fs::remove(e.path());ps5library::fs::remove(e.path().string()+".json");}}
  void worker(){for(;;){std::string url,token,local;{std::unique_lock lock(mutex_);wake_.wait(lock,[&]{return stopping_||!requests_.empty();});if(stopping_)return;url=requests_.front();requests_.pop_front();token=credential_;if(auto found=localFiles_.find(url);found!=localFiles_.end())local=found->second;}
      SDL_Surface* surface=nullptr;std::string error;
      try{if(!local.empty())surface=IMG_Load(local.c_str());else if(preview_)surface=IMG_Load(url.c_str());else{
        const bool localAgent=localAgentUrl(url);auto connection=localAgent?Json::object({{"serverUrl",ps5library::localAgentUrl()},{"allowInsecureLan",true}}):Json::parse(config_);ps5library::Client client(connection);client.credential=localAgent?ps5library::localAgentCredential:token;auto file=root_/(cacheName(connection.dump()+client.credential+url)+".img");
        if(ps5library::fs::exists(file))surface=IMG_Load(file.c_str());
        // Catalog artwork URLs carry their content revision, so a decoded cache hit is final.
        if(!surface&&offline_&&!localAgent)throw std::runtime_error("Artwork is not cached for offline use");
        if(!surface&&!cancelled(url))try{auto response=client.artwork(url,"",[&]{return cancelled(url);});auto* fresh=IMG_Load_RW(SDL_RWFromConstMem(response.data.data(),static_cast<int>(response.data.size())),1);if(!fresh)throw std::runtime_error(std::string("Artwork decode failed: ")+IMG_GetError());if(fresh->w>8192||fresh->h>8192||int64_t(fresh->w)*fresh->h>16000000){SDL_FreeSurface(fresh);throw std::runtime_error("Artwork dimensions exceed the client limit");}surface=fresh;auto temp=file.string()+".tmp";{std::ofstream output(temp,std::ios::binary);output.write(response.data.data(),response.data.size());if(!output)throw std::runtime_error("Cache write failed");}ps5library::fs::rename(temp,file);}catch(...){if(!surface)throw;}
      }if(surface&&(surface->w>8192||surface->h>8192||int64_t(surface->w)*surface->h>16000000)){SDL_FreeSurface(surface);surface=nullptr;throw std::runtime_error("Artwork dimensions exceed the client limit");}}catch(const std::exception& e){error=e.what();}catch(...){error="Unknown artwork worker failure";}
      std::unique_lock lock(mutex_);wake_.wait(lock,[&]{return stopping_||decoded_.size()<4;});if(stopping_){if(surface)SDL_FreeSurface(surface);return;}if(surface)loads_++;else{failures_++;lastError_=error.empty()?"Artwork decoder returned no surface":error;}decoded_.push_back({url,surface});
    }}
public:
  Artwork(const Json& config,const ps5library::fs::path& root,bool preview):root_(root),config_(config.dump()),preview_(preview){ps5library::fs::create_directories(root_);try{trimDisk();}catch(...){ }for(int i=0;i<2;i++)workers_.emplace_back([this]{worker();});}
  void stop(){stopping_=true;wake_.notify_all();for(auto& thread:workers_)if(thread.joinable())thread.join();}
  ~Artwork(){stop();for(auto& result:decoded_)if(result.surface)SDL_FreeSurface(result.surface);for(auto& [url,texture]:textures_)SDL_DestroyTexture(texture.value);}
  void credentials(const std::string& token){std::lock_guard lock(mutex_);credential_=token;}
  void offline(bool value){offline_=value;wake_.notify_all();}
  std::string local(const ps5library::fs::path& file){const auto path=file.string();std::lock_guard lock(mutex_);if(auto found=localKeys_.find(path);found!=localKeys_.end())return found->second;auto key="local:"+cacheName(path);localKeys_[path]=key;localFiles_[key]=path;return key;}
  void desire(const std::vector<std::string>& urls){std::lock_guard lock(mutex_);wanted_=std::set<std::string>(urls.begin(),urls.end());for(const auto& url:urls){auto found=textures_.find(url);bool needed=found==textures_.end()||(!found->second.value&&SDL_TICKS_PASSED(SDL_GetTicks(),found->second.retryAt));if(!url.empty()&&url.find("v=missing")==std::string::npos&&needed&&!pending_.count(url)&&requests_.size()<30){pending_.insert(url);requests_.push_back(url);}}requests_.erase(std::remove_if(requests_.begin(),requests_.end(),[&](const std::string& url){if(wanted_.count(url))return false;pending_.erase(url);return true;}),requests_.end());wake_.notify_all();}
  void upload(SDL_Renderer* renderer){frame_++;for(int i=0;i<2;i++){Decoded next;{std::lock_guard lock(mutex_);if(decoded_.empty())break;next=decoded_.front();decoded_.pop_front();pending_.erase(next.url);}wake_.notify_all();auto* texture=uploadArtworkSurface(renderer,next.surface);size_t bytes=texture?static_cast<size_t>(next.surface->w)*next.surface->h*4:0;if(next.surface)SDL_FreeSurface(next.surface);auto old=textures_.find(next.url);if(old!=textures_.end()){bytes_-=old->second.bytes;SDL_DestroyTexture(old->second.value);}textures_[next.url]={texture,bytes,frame_,SDL_GetTicks()+5000};bytes_+=bytes;}
    while(bytes_>64*1024*1024||textures_.size()>96){auto victim=textures_.end();for(auto it=textures_.begin();it!=textures_.end();++it)if(it->second.seen+2<frame_&&(victim==textures_.end()||it->second.seen<victim->second.seen))victim=it;if(victim==textures_.end())break;bytes_-=victim->second.bytes;SDL_DestroyTexture(victim->second.value);textures_.erase(victim);}}
  SDL_Texture* get(const std::string& url){auto item=textures_.find(url);if(item==textures_.end())return nullptr;item->second.seen=frame_;return item->second.value;}
  size_t textureBytes()const{return bytes_;}
  size_t loads()const{std::lock_guard lock(mutex_);return loads_;}size_t failures()const{std::lock_guard lock(mutex_);return failures_;}std::string lastError()const{std::lock_guard lock(mutex_);return lastError_;}
};
}
