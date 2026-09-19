#include "../frontend/lifecycle.hpp"
#include <cassert>
int main(){
  storefront::Visibility visibility;assert(visibility.active());SDL_Event event{};
  event.type=SDL_APP_WILLENTERBACKGROUND;visibility.event(event);assert(!visibility.active());
  event.type=SDL_CONTROLLERBUTTONDOWN;visibility.event(event);assert(!visibility.active());
  event.type=SDL_APP_WILLENTERFOREGROUND;visibility.event(event);assert(!visibility.active());
  event.type=SDL_APP_DIDENTERFOREGROUND;visibility.event(event);assert(visibility.active());
  event.type=SDL_APP_DIDENTERBACKGROUND;visibility.event(event);assert(!visibility.active());
  event.type=SDL_WINDOWEVENT;event.window.event=SDL_WINDOWEVENT_FOCUS_GAINED;visibility.event(event);assert(!visibility.active());
  event.type=SDL_APP_DIDENTERFOREGROUND;visibility.event(event);assert(visibility.active());
  event.type=SDL_WINDOWEVENT;event.window.event=SDL_WINDOWEVENT_FOCUS_LOST;visibility.event(event);assert(!visibility.active());
  event.window.event=SDL_WINDOWEVENT_FOCUS_GAINED;visibility.event(event);assert(visibility.active());
}
