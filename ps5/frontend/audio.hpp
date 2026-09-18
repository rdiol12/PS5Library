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
  bool music_=false,ambient_=false;const std::vector<Sint16>* overlay_=nullptr;size_t overlayOffset_=0,fadeSamples_=0;uint64_t ambientFrame_=0;std::vector<Sint16> ambientChunk_;
  void queueAmbient(){constexpr double tau=6.283185307179586;constexpr double chords[4][3]={{130.81,196.00,246.94},{110.00,164.81,196.00},{87.31,130.81,164.81},{98.00,146.83,196.00}},sparkles[]={523.25,659.25,783.99,659.25,587.33,698.46,880.00,698.46};ambientChunk_.resize(4096);
    for(size_t frame=0;frame<2048;frame++,ambientFrame_++){double t=ambientFrame_/48000.,within=std::fmod(t,4.),padEnvelope=std::min(1.,std::min(within,4.-within)*2.),sample=0;int chord=static_cast<int>(t/4.)%4;for(double frequency:chords[chord])sample+=std::sin(tau*frequency*t)*170*padEnvelope;double pulse=std::fmod(t,1.5),sparkle=std::sin(tau*sparkles[static_cast<int>(t/1.5)%8]*pulse)*std::exp(-pulse*4.2)*620;sample+=sparkle+std::sin(tau*65.4*t)*85;
      for(int channel=0;channel<2;channel++){int mixed=static_cast<int>(sample*(.92+(channel?1:-1)*.08*std::sin(tau*t/9.)));if(overlay_&&enabled_){mixed+=(*overlay_)[overlayOffset_++];if(overlayOffset_==overlay_->size())overlay_=nullptr;}ambientChunk_[frame*2+channel]=static_cast<Sint16>(std::clamp(mixed,-32768,32767));}}
    SDL_QueueAudio(device_,ambientChunk_.data(),static_cast<Uint32>(ambientChunk_.size()*sizeof(Sint16)));
  }
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
  void ambient(bool active){if(ambient_!=active){ambient_=active;if(!active&&!preview_)clear();}if(!device_||!ambient_||preview_)return;for(int i=0;i<3&&queued()<16384;i++)queueAmbient();}
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
    if((preview_&&music_)||ambient_){overlay_=&samples;overlayOffset_=0;played_++;return true;}
    if(SDL_QueueAudio(device_,samples.data(),static_cast<Uint32>(samples.size()*sizeof(Sint16))))return false;
    played_++;return true;
  }
};
}
