#pragma once
#include <SDL.h>
#include <array>
#include <vector>
#include <cmath>
#include <algorithm>
namespace storefront {
enum class Cue {Move,Select,Back};
class UiAudio {
  SDL_AudioDeviceID device_=0;bool initialized_=false,enabled_,preview_=false;unsigned played_=0;
  std::array<std::vector<Sint16>,3> cues_;
  bool music_=false;const std::vector<Sint16>* overlay_=nullptr;size_t overlayOffset_=0,fadeSamples_=0;
public:
  explicit UiAudio(bool enabled):enabled_(enabled){
    if(SDL_InitSubSystem(SDL_INIT_AUDIO)!=0)return;initialized_=true;
    SDL_AudioSpec wanted{};wanted.freq=48000;wanted.format=AUDIO_S16LSB;wanted.channels=2;wanted.samples=512;
    device_=SDL_OpenAudioDevice(nullptr,0,&wanted,nullptr,0);if(!device_)return;
    // Original, quiet PCM cues; generated once, with short attack/release ramps to avoid clicks.
    for(size_t kind=0;kind<cues_.size();kind++){
      const int frames=kind==0?1440:kind==1?4320:3360;auto& samples=cues_[kind];samples.reserve(frames*2);double phase=0;
      for(int i=0;i<frames;i++){
        double t=double(i)/(frames-1),hz=kind==0?760:kind==1?620+310*t:610-230*t;
        phase+=6.283185307179586*hz/48000;
        double envelope=std::min(1.,i/144.)*std::pow(1-t,2);
        auto value=static_cast<Sint16>(std::sin(phase)*envelope*1450);samples.push_back(value);samples.push_back(value);
      }
    }
    SDL_PauseAudioDevice(device_,0);
  }
  ~UiAudio(){if(device_)SDL_CloseAudioDevice(device_);if(initialized_)SDL_QuitSubSystem(SDL_INIT_AUDIO);}
  bool available()const{return device_!=0;}
  bool enabled()const{return enabled_;}
  unsigned played()const{return played_;}
  void setEnabled(bool value){enabled_=value;if(!value&&!preview_&&device_)SDL_ClearQueuedAudio(device_);}
  void preview(bool active,bool music=false){if(preview_!=active||music_!=music){clear();preview_=active;music_=music;overlay_=nullptr;fadeSamples_=0;}}
  void clear(){if(device_)SDL_ClearQueuedAudio(device_);}
  void suspend(bool paused){if(device_){if(paused)clear();SDL_PauseAudioDevice(device_,paused?1:0);}}
  Uint32 queued()const{return device_?SDL_GetQueuedAudioSize(device_):0;}
  bool pcm(const Sint16* samples,size_t count){
    if(!device_||!preview_||queued()>=48000||count>32768)return false;
    if(!music_)return SDL_QueueAudio(device_,samples,static_cast<Uint32>(count*sizeof(Sint16)))==0;
    std::vector<Sint16> mixed(count);
    for(size_t i=0;i<count;i++){
      int sample=static_cast<int>(samples[i]*.45*std::min(1.,fadeSamples_/11520.));if(fadeSamples_<11520)fadeSamples_++;
      if(overlay_&&enabled_){sample+=(*overlay_)[overlayOffset_++];if(overlayOffset_==overlay_->size())overlay_=nullptr;}
      mixed[i]=static_cast<Sint16>(std::clamp(sample,-32768,32767));
    }
    return SDL_QueueAudio(device_,mixed.data(),static_cast<Uint32>(count*sizeof(Sint16)))==0;
  }
  bool play(Cue cue){
    if(!device_||!enabled_||(preview_&&!music_)||SDL_GetQueuedAudioSize(device_)>24000)return false;
    const auto& samples=cues_.at(static_cast<size_t>(cue));
    if(preview_&&music_){overlay_=&samples;overlayOffset_=0;played_++;return true;}
    if(SDL_QueueAudio(device_,samples.data(),static_cast<Uint32>(samples.size()*sizeof(Sint16))))return false;
    played_++;return true;
  }
};
}
