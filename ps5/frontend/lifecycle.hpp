#pragma once
#include <SDL.h>
namespace storefront {
// Platform notifications own visibility. Losing focus must never mean closing the app.
class Visibility {
  bool active_=true;
public:
  bool active()const{return active_;}
  void event(const SDL_Event& e){
    if(e.type==SDL_APP_WILLENTERBACKGROUND||e.type==SDL_APP_DIDENTERBACKGROUND)active_=false;
    if(e.type==SDL_APP_DIDENTERFOREGROUND)active_=true;
    if(e.type==SDL_WINDOWEVENT){
      if(e.window.event==SDL_WINDOWEVENT_FOCUS_LOST||e.window.event==SDL_WINDOWEVENT_MINIMIZED)active_=false;
      if(e.window.event==SDL_WINDOWEVENT_FOCUS_GAINED||e.window.event==SDL_WINDOWEVENT_RESTORED)active_=true;
    }
  }
};
}
