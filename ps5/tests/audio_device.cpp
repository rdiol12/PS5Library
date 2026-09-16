// Bounded physical diagnostic: no display ownership, title registration or system-file changes.
#include "../common/client.hpp"
#include <array>
#include <cmath>
extern "C" {
int sceUserServiceInitialize(const void*);
int sceUserServiceGetInitialUser(int*);
int sceUserServiceGetForegroundUser(unsigned*);
int sceAudioOutInit();
int sceAudioOutOpen(int,int,int,unsigned,unsigned,unsigned);
int sceAudioOutSetVolume(int,int,int*);
int sceAudioOutOutput(int,const void*);
int sceAudioOutClose(int);
}
int main(){
  using namespace ps5library;
  auto report=Json::object();report.set("userInit",sceUserServiceInitialize(nullptr));
  int initial=-1;unsigned foreground=~0u;
  report.set("initialResult",sceUserServiceGetInitialUser(&initial));report.set("initialIsSystem",initial==255);
  report.set("foregroundResult",sceUserServiceGetForegroundUser(&foreground));report.set("foregroundIsSystem",foreground==255);report.set("foregroundValid",foreground!=~0u&&foreground!=255);
  report.set("audioInit",sceAudioOutInit());auto attempts=Json::array();
  for(int user:{255,static_cast<int>(foreground)}){
    if(user<0||(attempts.size()&&user==255))continue;
    auto trial=Json::object({{"route",user==255?"SYSTEM":"FOREGROUND"}});int port=sceAudioOutOpen(user,0,0,512,48000,1);trial.set("open",port);
    if(port>0){int volume[2]={32768,32768};trial.set("volume",sceAudioOutSetVolume(port,3,volume));int errors=0,last=0;
      std::array<int16_t,1024> pcm{};
      for(int block=0;block<80;block++){
        for(int frame=0;frame<512;frame++){int sample=block*512+frame;double envelope=std::min(1.,sample/480.)*std::min(1.,(80*512-sample)/480.);auto value=static_cast<int16_t>(std::sin(sample*(user==255?660.:880.)*6.283185307179586/48000.)*6500*envelope);pcm[frame*2]=pcm[frame*2+1]=value;}
        int result=sceAudioOutOutput(port,pcm.data());if(result<0){errors++;last=result;break;}
      }
      pcm.fill(0);sceAudioOutOutput(port,pcm.data());trial.set("errors",errors);trial.set("lastError",last);trial.set("close",sceAudioOutClose(port));
    }
    attempts.add(trial);report.set("attempts",attempts);atomicJson("/data/ps5library/audio-device-check.json",report);
  }
  atomicJson("/data/ps5library/audio-device-check.json",report);
}
