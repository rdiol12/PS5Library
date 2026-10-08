#pragma once
#include "../common/client.hpp"
#include <SDL_image.h>
#include <openssl/evp.h>
#include <algorithm>
#include <atomic>
#include <cmath>
#include <condition_variable>
#include <deque>
#include <fstream>
#include <mutex>
#include <set>
#include <thread>
#include <unordered_map>
namespace storefront {
inline constexpr size_t artworkTexturePixelLimit=4*1024*1024;
inline constexpr size_t artworkTextureCacheBytes=64*1024*1024;
inline bool prepareArtworkSurface(SDL_Surface*& surface,int targetWidth,int targetHeight,int cropWidth=0,int cropHeight=0,size_t pixelLimit=artworkTexturePixelLimit){
  if(!surface||targetWidth<=0||targetHeight<=0)return false;
  const auto densityWidth=cropWidth>0?cropWidth:surface->w,densityHeight=cropHeight>0?cropHeight:surface->h;const double scale=std::min(1.,std::max(targetWidth/static_cast<double>(densityWidth),targetHeight/static_cast<double>(densityHeight)));
  int width=std::max(1,static_cast<int>(std::ceil(surface->w*scale))),height=std::max(1,static_cast<int>(std::ceil(surface->h*scale)));
  if(static_cast<size_t>(width)*height>pixelLimit){const auto limit=std::sqrt(pixelLimit/static_cast<double>(width)/height);width=std::max(1,static_cast<int>(std::floor(width*limit)));height=std::max(1,static_cast<int>(std::floor(height*limit)));}
  if(width==surface->w&&height==surface->h&&surface->format->format==SDL_PIXELFORMAT_ARGB8888)return true;
  auto* prepared=SDL_CreateRGBSurfaceWithFormat(0,width,height,32,SDL_PIXELFORMAT_ARGB8888);if(!prepared)return false;
  SDL_BlendMode blend=SDL_BLENDMODE_NONE;if(SDL_GetSurfaceBlendMode(surface,&blend)!=0||SDL_SetSurfaceBlendMode(surface,SDL_BLENDMODE_NONE)!=0){SDL_FreeSurface(prepared);return false;}SDL_Rect destination{0,0,width,height};const auto copied=SDL_BlitScaled(surface,nullptr,prepared,&destination);SDL_SetSurfaceBlendMode(surface,blend);if(copied!=0){SDL_FreeSurface(prepared);return false;}
  SDL_FreeSurface(surface);surface=prepared;return true;
}
struct ArtworkNeed {std::string url;int width=0,height=0,cropWidth=0,cropHeight=0;size_t pixelLimit=artworkTexturePixelLimit;};
inline ArtworkNeed foregroundArtworkNeed(std::string url,float width,float height,int cropWidth=0,int cropHeight=0){return {std::move(url),std::max(1,static_cast<int>(std::ceil(std::min(3840.f,width*2.02f)))),std::max(1,static_cast<int>(std::ceil(std::min(2160.f,height*2.02f)))),cropWidth,cropHeight,artworkTexturePixelLimit};}
inline ArtworkNeed backdropArtworkNeed(std::string url,float width,float height,int cropWidth=0,int cropHeight=0){return {std::move(url),std::max(1,static_cast<int>(std::ceil(std::min(1920.f,width)))),std::max(1,static_cast<int>(std::ceil(std::min(1080.f,height)))),cropWidth,cropHeight,1920*1080};}
inline double artworkDemandScale(const ArtworkNeed& need,int sourceWidth,int sourceHeight){return std::max(need.width/static_cast<double>(need.cropWidth>0?need.cropWidth:sourceWidth),need.height/static_cast<double>(need.cropHeight>0?need.cropHeight:sourceHeight));}
inline bool artworkDemandExceeds(const ArtworkNeed& current,const ArtworkNeed& next,int sourceWidth,int sourceHeight){return sourceWidth>0&&sourceHeight>0&&artworkDemandScale(next,sourceWidth,sourceHeight)>artworkDemandScale(current,sourceWidth,sourceHeight)+1e-6;}
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
inline SDL_Rect scaleArtworkCrop(SDL_Rect crop,int sourceWidth,int sourceHeight,int width,int height){if(sourceWidth<=0||sourceHeight<=0||width<=0||height<=0)return crop;auto range=[](int start,int extent,int source,int target){const auto first=std::clamp(static_cast<int64_t>(std::floor(start*target/static_cast<double>(source))),int64_t(0),static_cast<int64_t>(target));const auto last=std::clamp(static_cast<int64_t>(std::ceil((static_cast<double>(start)+extent)*target/source)),first,static_cast<int64_t>(target));return std::pair<int,int>{static_cast<int>(first),static_cast<int>(last-first)};};const auto x=range(crop.x,crop.w,sourceWidth,width),y=range(crop.y,crop.h,sourceHeight,height);return{x.first,y.first,x.second,y.second};}
class Artwork {
  struct Decoded {ArtworkNeed need;SDL_Surface* surface;int sourceWidth,sourceHeight;};
  struct Texture {SDL_Texture* value;size_t bytes;Uint64 seen;Uint32 retryAt;int sourceWidth,sourceHeight,width,height;ArtworkNeed requested;};
  ps5library::fs::path root_;std::string config_,credential_;bool preview_;
  mutable std::mutex mutex_;std::condition_variable wake_;std::vector<std::thread> workers_;
  std::deque<ArtworkNeed> requests_;std::deque<Decoded> decoded_;std::unordered_map<std::string,ArtworkNeed> wanted_;std::unordered_map<std::string,size_t> priority_;std::set<std::string> pending_;
  std::unordered_map<std::string,Texture> textures_;std::unordered_map<std::string,std::string> localFiles_,localKeys_;std::atomic<bool> stopping_{false},offline_{false};size_t bytes_=0,loads_=0,failures_=0;Uint64 frame_=0;std::string lastError_;
  std::string cacheName(const std::string& text){unsigned char hash[32];unsigned length=0;EVP_Digest(text.data(),text.size(),hash,&length,EVP_sha256(),nullptr);std::string key;for(unsigned i=0;i<length;i++){key+="0123456789abcdef"[hash[i]>>4];key+="0123456789abcdef"[hash[i]&15];}return key;}
  static bool localAgentUrl(const std::string& url){return url.rfind("/api/v1/agent/media/",0)==0;}
  bool cancelled(const std::string& url){std::lock_guard lock(mutex_);return stopping_||(offline_&&!localAgentUrl(url))||!wanted_.count(url);}
  void trimDisk(){std::vector<ps5library::fs::directory_entry> files;uintmax_t total=0;for(const auto& e:ps5library::fs::directory_iterator(root_))if(e.is_regular_file()&&e.path().extension()==".img"){files.push_back(e);total+=e.file_size();}std::sort(files.begin(),files.end(),[](const auto&a,const auto&b){return a.last_write_time()<b.last_write_time();});for(const auto& e:files){if(total<=256*1024*1024)break;total-=e.file_size();ps5library::fs::remove(e.path());ps5library::fs::remove(e.path().string()+".json");}}
  void worker(){for(;;){ArtworkNeed need;std::string token,local;{std::unique_lock lock(mutex_);wake_.wait(lock,[&]{return stopping_||!requests_.empty();});if(stopping_)return;need=requests_.front();requests_.pop_front();token=credential_;if(auto found=localFiles_.find(need.url);found!=localFiles_.end())local=found->second;}
      SDL_Surface* surface=nullptr;std::string error;int sourceWidth=0,sourceHeight=0;
      try{if(!local.empty())surface=IMG_Load(local.c_str());else if(preview_)surface=IMG_Load(need.url.c_str());else{
        const bool localAgent=localAgentUrl(need.url);auto connection=localAgent?Json::object({{"serverUrl",ps5library::localAgentUrl()},{"allowInsecureLan",true}}):Json::parse(config_);ps5library::Client client(connection);client.credential=localAgent?ps5library::localAgentCredential:token;auto file=root_/(cacheName(connection.dump()+client.credential+need.url)+".img");
        if(ps5library::fs::exists(file))surface=IMG_Load(file.c_str());
        // Catalog artwork URLs carry their content revision, so a decoded cache hit is final.
        if(!surface&&offline_&&!localAgent)throw std::runtime_error("Artwork is not cached for offline use");
        if(!surface&&!cancelled(need.url))try{auto response=client.artwork(need.url,"",[&]{return cancelled(need.url);});auto* fresh=IMG_Load_RW(SDL_RWFromConstMem(response.data.data(),static_cast<int>(response.data.size())),1);if(!fresh)throw std::runtime_error(std::string("Artwork decode failed: ")+IMG_GetError());if(fresh->w>8192||fresh->h>8192||int64_t(fresh->w)*fresh->h>16000000){SDL_FreeSurface(fresh);throw std::runtime_error("Artwork dimensions exceed the client limit");}surface=fresh;auto temp=file.string()+".tmp";{std::ofstream output(temp,std::ios::binary);output.write(response.data.data(),response.data.size());if(!output)throw std::runtime_error("Cache write failed");}ps5library::fs::rename(temp,file);}catch(...){if(!surface)throw;}
      }if(surface&&(surface->w>8192||surface->h>8192||int64_t(surface->w)*surface->h>16000000)){SDL_FreeSurface(surface);surface=nullptr;throw std::runtime_error("Artwork dimensions exceed the client limit");}if(surface){{std::lock_guard lock(mutex_);auto latest=wanted_.find(need.url);if(latest==wanted_.end()){SDL_FreeSurface(surface);pending_.erase(need.url);continue;}need=latest->second;}sourceWidth=surface->w;sourceHeight=surface->h;if(!prepareArtworkSurface(surface,need.width,need.height,need.cropWidth,need.cropHeight,need.pixelLimit)){SDL_FreeSurface(surface);surface=nullptr;throw std::runtime_error("Artwork preparation failed");}}}catch(const std::exception& e){error=e.what();}catch(...){error="Unknown artwork worker failure";}
      std::unique_lock lock(mutex_);wake_.wait(lock,[&]{return stopping_||decoded_.size()<4;});if(stopping_){if(surface)SDL_FreeSurface(surface);return;}if(surface)loads_++;else{failures_++;lastError_=error.empty()?"Artwork decoder returned no surface":error;}decoded_.push_back({need,surface,sourceWidth,sourceHeight});
    }}
public:
  Artwork(const Json& config,const ps5library::fs::path& root,bool preview):root_(root),config_(config.dump()),preview_(preview){ps5library::fs::create_directories(root_);try{trimDisk();}catch(...){ }for(int i=0;i<2;i++)workers_.emplace_back([this]{worker();});}
  void stop(){stopping_=true;wake_.notify_all();for(auto& thread:workers_)if(thread.joinable())thread.join();}
  ~Artwork(){stop();for(auto& result:decoded_)if(result.surface)SDL_FreeSurface(result.surface);for(auto& [url,texture]:textures_)SDL_DestroyTexture(texture.value);}
  void credentials(const std::string& token){std::lock_guard lock(mutex_);credential_=token;}
  void offline(bool value){offline_=value;wake_.notify_all();}
  std::string local(const ps5library::fs::path& file){const auto path=file.string();std::lock_guard lock(mutex_);if(auto found=localKeys_.find(path);found!=localKeys_.end())return found->second;auto key="local:"+cacheName(path);localKeys_[path]=key;localFiles_[key]=path;return key;}
  void desire(const std::vector<ArtworkNeed>& needs){std::lock_guard lock(mutex_);wanted_.clear();priority_.clear();std::vector<std::string> order;for(const auto& need:needs)if(!need.url.empty()&&need.width>0&&need.height>0){auto [found,inserted]=wanted_.emplace(need.url,need);if(inserted){priority_[need.url]=order.size();order.push_back(need.url);}else{found->second.width=std::max(found->second.width,need.width);found->second.height=std::max(found->second.height,need.height);found->second.pixelLimit=std::min(found->second.pixelLimit,need.pixelLimit);if(need.cropWidth>0)found->second.cropWidth=found->second.cropWidth>0?std::min(found->second.cropWidth,need.cropWidth):need.cropWidth;if(need.cropHeight>0)found->second.cropHeight=found->second.cropHeight>0?std::min(found->second.cropHeight,need.cropHeight):need.cropHeight;}}
    for(const auto& url:order){const auto& need=wanted_.at(url);auto found=textures_.find(url);const auto due=found==textures_.end()||SDL_TICKS_PASSED(SDL_GetTicks(),found->second.retryAt);const bool retry=found!=textures_.end()&&!found->second.value&&due,upgrade=found!=textures_.end()&&found->second.value&&due&&artworkDemandExceeds(found->second.requested,need,found->second.sourceWidth,found->second.sourceHeight);if(url.find("v=missing")!=std::string::npos||(!retry&&!upgrade&&found!=textures_.end()))continue;if(pending_.count(url)){for(auto& request:requests_)if(request.url==url){request=need;break;}continue;}if(requests_.size()<30){pending_.insert(url);requests_.push_back(need);}}
    requests_.erase(std::remove_if(requests_.begin(),requests_.end(),[&](const ArtworkNeed& request){if(wanted_.count(request.url))return false;pending_.erase(request.url);return true;}),requests_.end());std::stable_sort(requests_.begin(),requests_.end(),[&](const ArtworkNeed& a,const ArtworkNeed& b){return priority_.at(a.url)<priority_.at(b.url);});wake_.notify_all();}
  void upload(SDL_Renderer* renderer){frame_++;Decoded next{{},nullptr,0,0};bool ready=false;{std::lock_guard lock(mutex_);for(auto item=decoded_.begin();item!=decoded_.end();)if(!wanted_.count(item->need.url)){pending_.erase(item->need.url);if(item->surface)SDL_FreeSurface(item->surface);item=decoded_.erase(item);}else ++item;if(!decoded_.empty()){auto selected=std::min_element(decoded_.begin(),decoded_.end(),[&](const Decoded& a,const Decoded& b){return priority_.at(a.need.url)<priority_.at(b.need.url);});next=*selected;decoded_.erase(selected);pending_.erase(next.need.url);ready=true;}}wake_.notify_all();if(ready){auto old=textures_.find(next.need.url);if(!next.surface){if(old==textures_.end())textures_[next.need.url]={nullptr,0,frame_,SDL_GetTicks()+5000,0,0,0,0,next.need};else old->second.retryAt=SDL_GetTicks()+5000;}else{const int width=next.surface->w,height=next.surface->h;auto* texture=uploadArtworkSurface(renderer,next.surface);SDL_FreeSurface(next.surface);if(texture){if(old!=textures_.end()){bytes_-=old->second.bytes;SDL_DestroyTexture(old->second.value);}const auto bytes=static_cast<size_t>(width)*height*4;textures_[next.need.url]={texture,bytes,frame_,0,next.sourceWidth,next.sourceHeight,width,height,next.need};bytes_+=bytes;}else if(old==textures_.end())textures_[next.need.url]={nullptr,0,frame_,SDL_GetTicks()+5000,0,0,0,0,next.need};else old->second.retryAt=SDL_GetTicks()+5000;}}
    while(bytes_>artworkTextureCacheBytes||textures_.size()>96){auto victim=textures_.end();for(auto it=textures_.begin();it!=textures_.end();++it)if(!wanted_.count(it->first)&&it->second.seen+2<frame_&&(victim==textures_.end()||it->second.seen<victim->second.seen))victim=it;if(victim==textures_.end())break;bytes_-=victim->second.bytes;SDL_DestroyTexture(victim->second.value);textures_.erase(victim);}}
  SDL_Texture* get(const std::string& url){auto item=textures_.find(url);if(item==textures_.end())return nullptr;item->second.seen=frame_;return item->second.value;}
  uint64_t textureKey(const std::string& url)const{auto item=textures_.find(url);return item==textures_.end()?0:(static_cast<uint64_t>(static_cast<uint32_t>(item->second.width))<<32)|static_cast<uint32_t>(item->second.height);}
  SDL_Rect scaledCrop(const std::string& url,SDL_Rect crop)const{auto item=textures_.find(url);return item==textures_.end()?crop:scaleArtworkCrop(crop,item->second.sourceWidth,item->second.sourceHeight,item->second.width,item->second.height);}
  size_t textureBytes()const{return bytes_;}
  size_t loads()const{std::lock_guard lock(mutex_);return loads_;}size_t failures()const{std::lock_guard lock(mutex_);return failures_;}std::string lastError()const{std::lock_guard lock(mutex_);return lastError_;}
};
}
