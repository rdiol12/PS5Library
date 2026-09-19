// Isolated display-ownership experiment. No ShellUI hooks, registration or system-file writes.
#include <SDL.h>
#include <SDL_ttf.h>
#include <cstdio>
#include <cstring>
#include <array>
#include <algorithm>
#include <unistd.h>
static FILE* logFile=nullptr;
static bool localUser=false;
// Experimental source declaration: SharpProspero 9220876, SystemService.cs.
// Additional storage guards against larger writes; no production lifecycle decisions use it.
struct SystemStatus { int events;unsigned char overlay,background,reserved[128]; };
static_assert(sizeof(SystemStatus)==136);
extern "C" {
int sceUserServiceInitialize(const void*);
int sceUserServiceGetInitialUser(int*);
int sceUserServiceGetForegroundUser(unsigned*);
int sceSystemServiceGetStatus(SystemStatus*);
int sceSystemServiceNavigateToGoHome();
int __real_sceVideoOutOpen(int,int,int,const void*);
int __wrap_sceVideoOutOpen(int,int bus,int index,const void* params){
  int user=255;
  if(localUser){
    int initial=-1;unsigned foreground=~0u;int result=sceUserServiceGetInitialUser(&initial);
    if(!result&&initial>=0&&initial!=255)user=initial;
    else {int fallback=sceUserServiceGetForegroundUser(&foreground);if(logFile)fprintf(logFile,"user initial=%#x foreground=%#x\n",result,fallback);if(fallback||foreground>=0x80000000u||foreground==255)return -1;user=static_cast<int>(foreground);}
  }
  int handle=__real_sceVideoOutOpen(user,bus,index,params);
  if(logFile){fprintf(logFile,"video route=%s result=%#x\n",localUser?"LOCAL":"SYSTEM",handle);fflush(logFile);}return handle;
}
}
int main(int argc,char** argv){
  bool requestHome=false;
  alarm(330);for(int i=1;i<argc;i++){if(std::strcmp(argv[i],"--local-user")==0)localUser=true;if(std::strcmp(argv[i],"--go-home")==0)requestHome=true;}
  logFile=fopen("/data/ps5library/display-check.log","w");
  if(!logFile)return 1;
  fprintf(logFile,"Arguments: %d; requested route: %s\n",argc,localUser?"LOCAL":"SYSTEM");
  fprintf(logFile,"User initialize: %#x; pid=%d\n",sceUserServiceInitialize(nullptr),getpid());fflush(logFile);
  int result=SDL_Init(SDL_INIT_VIDEO);
  fprintf(logFile,"Display initialization: %d %s\n",result,SDL_GetError());fflush(logFile);
  if(result){fclose(logFile);return 1;}
  auto* window=SDL_CreateWindow("PS5Library display check",0,0,1920,1080,SDL_WINDOW_SHOWN);
  auto* renderer=SDL_CreateRenderer(window,-1,SDL_RENDERER_SOFTWARE);
  TTF_Init();auto* font=TTF_OpenFont("/data/ps5library/Inter-Regular.otf",40);
  SDL_Texture* caption=nullptr;int captionWidth=0,captionHeight=0;Uint32 lastSecond=~0u;
  fprintf(logFile,"Renderer: %s\n",renderer?"ready":"failed");fflush(logFile);
  auto start=SDL_GetTicks();Uint32 nextSample=0;
  while(renderer&&SDL_GetTicks()-start<300000){
    auto elapsed=SDL_GetTicks()-start;
    if(requestHome&&elapsed>=5000){requestHome=false;fprintf(logFile,"NavigateToGoHome: %#x\n",sceSystemServiceNavigateToGoHome());fflush(logFile);}
    if(elapsed>=nextSample){
      struct {SystemStatus status;std::array<unsigned char,16384-sizeof(SystemStatus)> guard;} sample{};
      sample.guard.fill(0xa5);int statusResult=sceSystemServiceGetStatus(&sample.status);
      bool intact=std::all_of(sample.guard.begin(),sample.guard.end(),[](unsigned char c){return c==0xa5;});
      fprintf(logFile,"status ms=%u result=%#x events=%d raw4=%u raw5=%u guard=%d\n",elapsed,statusResult,sample.status.events,sample.status.overlay,sample.status.background,intact);fflush(logFile);
      if(!intact)break;nextSample=elapsed+500;
    }
    SDL_Event event;while(SDL_PollEvent(&event)){}
    const auto remaining=(300000-elapsed+999)/1000;
    if(font&&remaining!=lastSecond){char text[160];std::snprintf(text,sizeof(text),"Home test - press PS, then Home. Closes in %u:%02u",remaining/60,remaining%60);auto* surface=TTF_RenderUTF8_Blended(font,text,{240,246,255,255});if(surface){SDL_DestroyTexture(caption);caption=SDL_CreateTextureFromSurface(renderer,surface);captionWidth=surface->w;captionHeight=surface->h;SDL_FreeSurface(surface);}lastSecond=remaining;}
    SDL_SetRenderDrawColor(renderer,12,35,62,255);SDL_RenderClear(renderer);SDL_SetRenderDrawColor(renderer,130,188,255,255);SDL_Rect stripe{150,550,static_cast<int>(1620*remaining/300),18};SDL_RenderFillRect(renderer,&stripe);
    if(caption){SDL_Rect text{150,440,captionWidth,captionHeight};SDL_RenderCopy(renderer,caption,nullptr,&text);}SDL_RenderPresent(renderer);
  }
  SDL_DestroyTexture(caption);if(font)TTF_CloseFont(font);TTF_Quit();SDL_DestroyRenderer(renderer);SDL_DestroyWindow(window);SDL_Quit();fprintf(logFile,"Display released.\n");fclose(logFile);return renderer?0:1;
}
