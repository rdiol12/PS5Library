#include "../frontend/ps5_audio.cpp"
#include <cassert>
static int userResult=0,foregroundResult=0,openResult=10,outputResult=0,openedUser=-1,volumeCalls=0;
extern "C" int sceUserServiceInitialize(const void*){return 0;}
extern "C" int sceUserServiceGetInitialUser(int* user){*user=42;return userResult;}
extern "C" int sceUserServiceGetForegroundUser(unsigned* user){*user=43;return foregroundResult;}
extern "C" int __real_sceAudioOutOpen(int user,int,int,unsigned,unsigned,unsigned){openedUser=user;return openResult;}
extern "C" int sceAudioOutSetVolume(int,int flags,int* values){assert(flags==3&&values[0]==32768&&values[1]==32768);volumeCalls++;return 0;}
extern "C" int __real_sceAudioOutOutput(int,const void*){return outputResult;}
int main(){
  assert(__wrap_sceAudioOutOpen(255,0,0,512,48000,1)==10);assert(openedUser==42&&volumeCalls==1);
  assert(__wrap_sceAudioOutOutput(10,nullptr)==0);assert(storefront::audioOutput.calls==1&&storefront::audioOutput.errors==0);
  outputResult=-7;assert(__wrap_sceAudioOutOutput(10,nullptr)==-7);assert(storefront::audioOutput.errors==1&&storefront::audioOutput.lastError==-7);
  userResult=-1;assert(__wrap_sceAudioOutOpen(255,0,0,512,48000,1)==10);assert(openedUser==43);
  foregroundResult=-1;openResult=-3;assert(__wrap_sceAudioOutOpen(255,0,0,512,48000,1)==-3);assert(openedUser==255&&volumeCalls==2);
}
