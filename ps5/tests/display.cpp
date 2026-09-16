// Isolated display-ownership experiment. No ShellUI hooks, registration or system-file writes.
#include <SDL.h>
#include <cstdio>
#include <unistd.h>
extern "C" {
int sceUserServiceInitialize(const void*);
int sceUserServiceGetInitialUser(int*);
int __real_sceVideoOutOpen(int,int,int,const void*);
int __wrap_sceVideoOutOpen(int,int bus,int index,const void* params){
  int user=-1;int result=sceUserServiceGetInitialUser(&user);if(result||user<0)return -1;
  return __real_sceVideoOutOpen(user,bus,index,params);
}
}
int main(){
  sceUserServiceInitialize(nullptr);int result=SDL_Init(SDL_INIT_VIDEO);
  FILE* log=fopen("/data/ps5library/display-check.log","w");
  if(log){fprintf(log,"Normal-user display initialization: %d %s\n",result,SDL_GetError());fflush(log);}
  if(result){if(log)fclose(log);return 1;}
  auto* window=SDL_CreateWindow("PS5Library display check",0,0,1920,1080,SDL_WINDOW_SHOWN);
  auto* renderer=SDL_CreateRenderer(window,-1,SDL_RENDERER_SOFTWARE);
  if(log){fprintf(log,"Renderer: %s\n",renderer?"ready":"failed");fflush(log);}
  auto start=SDL_GetTicks();while(renderer&&SDL_GetTicks()-start<120000){SDL_Event event;while(SDL_PollEvent(&event)){}SDL_SetRenderDrawColor(renderer,12,35,62,255);SDL_RenderClear(renderer);SDL_SetRenderDrawColor(renderer,130,188,255,255);SDL_Rect stripe{150,480,1620,120};SDL_RenderFillRect(renderer,&stripe);SDL_RenderPresent(renderer);SDL_Delay(16);}
  SDL_DestroyRenderer(renderer);SDL_DestroyWindow(window);SDL_Quit();if(log){fprintf(log,"Display released.\n");fclose(log);}return renderer?0:1;
}
