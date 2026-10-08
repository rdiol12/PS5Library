#pragma once
#include <SDL.h>
#include <cstdint>
#include <string>
#include <string_view>
namespace storefront {
inline bool heroCrossfade(Uint32 rendererFlags){return (rendererFlags&SDL_RENDERER_ACCELERATED)!=0;}
inline char backdropMode(std::string_view page){return page=="My Library"?'B':page=="Game"?'G':'L';}
class BackdropRequestGate {
  std::string pending_;uint64_t since_=0;
public:
  bool requestable(std::string_view key,bool cached,uint64_t now,uint64_t delay=180){if(cached){pending_=key;since_=now;return true;}if(key!=pending_){pending_=key;since_=now;return false;}return now-since_>=delay;}
  void reset(){pending_.clear();since_=0;}
};
// Measured from the user's Desktop/storefront.png (1672 x 941), normalized to 1080p.
struct Tokens {
  static constexpr float width=1920,height=1080,safe=56,gap=18,header=112;
  static constexpr float heroBottom=507,railTitle=26,cardWidth=216,cardHeight=204,railGap=27;
  static constexpr float libraryStripY=802,libraryTileWidth=338,libraryTileHeight=154;
  static constexpr float downloadQueueWidth=1240,downloadSummaryWidth=520,downloadRowHeight=190;
  static constexpr float profileFactsY=454,profileRailY=720;
  static constexpr float radius=8,pillRadius=32,focusScale=1.012f,focusSeconds=.16f,fadeSeconds=.28f;
  static constexpr int caption=19,control=22,body=24,heading=26,title=54,compactTitle=36,brand=39;
  static constexpr SDL_Color white{244,246,250,255},muted{185,197,213,255},accent{143,199,255,255};
  static constexpr SDL_Color success{115,215,174,255},warning{255,188,92,255},danger{255,129,120,255};
  static constexpr SDL_Color background{7,11,17,255},surface{25,36,51,224},surfaceActive{35,52,73,232},disabled{25,32,42,190},focus{174,217,255,255};
};
struct Rect { float x=0,y=0,w=0,h=0; float cx()const{return x+w/2;} float cy()const{return y+h/2;} SDL_FRect sdl()const{return{x,y,w,h};} };
}
