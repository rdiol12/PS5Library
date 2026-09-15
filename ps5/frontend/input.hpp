#pragma once
#include <SDL.h>
#include <cstdlib>
#include <string>
namespace storefront {
inline void eraseLastCharacter(std::string& value){if(value.empty())return;auto start=value.size()-1;while(start>0&&(static_cast<unsigned char>(value[start])&0xc0)==0x80)--start;value.erase(start);}
enum class Action { None,Up,Down,Left,Right,Select,Back,Search,Context,PreviousTab,NextTab,Settings,Quit };
class Input {
  Uint32 lastAxis_=0; int axisDirection_=0; SDL_GameController* controller_=nullptr;
public:
  Input(){open();} ~Input(){if(controller_)SDL_GameControllerClose(controller_);}
  void open(){if(controller_)return;for(int i=0;i<SDL_NumJoysticks();i++)if(SDL_IsGameController(i)){controller_=SDL_GameControllerOpen(i);break;}}
  Action read(const SDL_Event& event){
    if(event.type==SDL_QUIT)return Action::Quit;
    if(event.type==SDL_CONTROLLERDEVICEADDED){open();return Action::None;}
    if(event.type==SDL_CONTROLLERDEVICEREMOVED){if(controller_){SDL_GameControllerClose(controller_);controller_=nullptr;}open();}
    if(event.type==SDL_KEYDOWN){switch(event.key.keysym.sym){case SDLK_UP:return Action::Up;case SDLK_DOWN:return Action::Down;case SDLK_LEFT:return Action::Left;case SDLK_RIGHT:return Action::Right;case SDLK_RETURN:return Action::Select;case SDLK_ESCAPE:return Action::Back;case SDLK_SLASH:case SDLK_F3:return Action::Search;case SDLK_TAB:return event.key.keysym.mod&KMOD_SHIFT?Action::PreviousTab:Action::NextTab;case SDLK_F2:return Action::Settings;case SDLK_F4:return Action::Context;default:break;}}
    // Verified: SDL PS5 driver maps Cross->A, Circle->B, Square->X, Triangle->Y.
    if(event.type==SDL_CONTROLLERBUTTONDOWN){switch(event.cbutton.button){case SDL_CONTROLLER_BUTTON_A:return Action::Select;case SDL_CONTROLLER_BUTTON_B:return Action::Back;case SDL_CONTROLLER_BUTTON_X:return Action::Search;case SDL_CONTROLLER_BUTTON_Y:return Action::Context;case SDL_CONTROLLER_BUTTON_LEFTSHOULDER:return Action::PreviousTab;case SDL_CONTROLLER_BUTTON_RIGHTSHOULDER:return Action::NextTab;case SDL_CONTROLLER_BUTTON_START:return Action::Settings;case SDL_CONTROLLER_BUTTON_DPAD_UP:return Action::Up;case SDL_CONTROLLER_BUTTON_DPAD_DOWN:return Action::Down;case SDL_CONTROLLER_BUTTON_DPAD_LEFT:return Action::Left;case SDL_CONTROLLER_BUTTON_DPAD_RIGHT:return Action::Right;default:break;}}
    return Action::None;
  }
  Action analog(){if(!controller_)return Action::None;auto x=SDL_GameControllerGetAxis(controller_,SDL_CONTROLLER_AXIS_LEFTX),y=SDL_GameControllerGetAxis(controller_,SDL_CONTROLLER_AXIS_LEFTY);int direction=0;if(std::abs(x)>16000||std::abs(y)>16000)direction=std::abs(x)>std::abs(y)?(x>0?4:3):(y>0?2:1);if(!direction){axisDirection_=0;return Action::None;}auto now=SDL_GetTicks();if(direction==axisDirection_&&now-lastAxis_<150)return Action::None;axisDirection_=direction;lastAxis_=now;return static_cast<Action>(direction);}
};
}
