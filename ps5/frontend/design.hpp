#pragma once
#include <SDL.h>
namespace storefront {
// Measured from the user's Desktop/storefront.png (1672 x 941), normalized to 1080p.
struct Tokens {
  static constexpr float width=1920,height=1080,safe=56,gap=18,header=112;
  static constexpr float heroBottom=505,railTitle=26,cardWidth=210,cardHeight=204,railGap=23;
  static constexpr float radius=9,pillRadius=32,focusScale=1.025f,focusSeconds=.12f,fadeSeconds=.24f;
  static constexpr int caption=19,body=24,heading=28,title=54,brand=35;
  static constexpr SDL_Color white{239,243,249,255},muted{180,191,205,255},accent{130,188,255,255};
  static constexpr SDL_Color background{7,12,18,255},surface{26,35,47,220},focus{150,208,255,255};
};
struct Rect { float x=0,y=0,w=0,h=0; float cx()const{return x+w/2;} float cy()const{return y+h/2;} SDL_FRect sdl()const{return{x,y,w,h};} };
}
