#include "ps5_audio.hpp"
namespace storefront { AudioOutputStatus audioOutput; }
extern "C" {
int sceUserServiceInitialize(const void*);
int sceUserServiceGetInitialUser(int*);
int sceUserServiceGetForegroundUser(unsigned*);
int __real_sceAudioOutOpen(int,int,int,unsigned,unsigned,unsigned);
int __real_sceAudioOutOutput(int,const void*);
int sceAudioOutSetVolume(int,int,int*);
// SDL's PS5 backend opens SYSTEM audio and discards output errors. Keep SDL's queue/thread,
// but route MAIN output to the signed-in local user, as in ps5-moonlight's ar_init.
int __wrap_sceAudioOutOpen(int user,int type,int index,unsigned samples,unsigned frequency,unsigned format){
  sceUserServiceInitialize(nullptr);int local=-1;
  const int requested=user;int initial=sceUserServiceGetInitialUser(&local);storefront::audioOutput.initialUserResult=initial;
  if(type==0){if(initial==0&&local>=0&&local!=255)user=local;else{unsigned foreground=~0u;int result=sceUserServiceGetForegroundUser(&foreground);storefront::audioOutput.foregroundUserResult=result;if(result==0&&foreground<0x80000000u&&foreground!=255)user=static_cast<int>(foreground);}}
  int handle=__real_sceAudioOutOpen(user,type,index,samples,frequency,format);storefront::audioOutput.localOpenResult=handle;
  if(handle<1&&user!=requested){user=requested;handle=__real_sceAudioOutOpen(user,type,index,samples,frequency,format);}
  storefront::audioOutput.user=user;storefront::audioOutput.openResult=handle;
  storefront::audioOutput.samples=(format==1?samples*2:0);
  if(handle>0){int volume[8]={32768,32768,32768,32768,32768,32768,32768,32768};storefront::audioOutput.volumeResult=sceAudioOutSetVolume(handle,format==0||format==3?1:3,volume);}
  return handle;
}
int __wrap_sceAudioOutOutput(int handle,const void* samples){
  if(samples){auto* pcm=static_cast<const short*>(samples);int peak=0;for(unsigned i=0;i<storefront::audioOutput.samples.load();i++){int value=pcm[i];if(value<0)value=-value;if(value>peak)peak=value;}if(peak){storefront::audioOutput.nonzeroBlocks++;if(peak>storefront::audioOutput.peak.load())storefront::audioOutput.peak=peak;}}
  const int result=__real_sceAudioOutOutput(handle,samples);storefront::audioOutput.calls++;
  if(result<0){storefront::audioOutput.errors++;storefront::audioOutput.lastError=result;}
  return result;
}
}
