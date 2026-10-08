#pragma once
#include "design.hpp"
#include <SDL_ttf.h>
#include <algorithm>
#include <cmath>
#include <map>
#include <string>
#include <stdexcept>
#include <unordered_map>
namespace storefront {
class Canvas {
  struct Text { SDL_Texture* texture; int width,height; Uint64 seen; size_t bytes; };
  std::map<int,TTF_Font*> fonts_; std::unordered_map<std::string,Text> labels_;
  SDL_Texture *horizontal_{},*vertical_{};size_t labelBytes_=0,labelCreates_=0,labelDestroys_=0;
  Text* text(const std::string& value,int size,int width,int lines){
    if(value.empty())return nullptr;auto key=std::to_string(size)+":"+std::to_string(width)+":"+std::to_string(lines)+":"+value;auto found=labels_.find(key);
    if(found==labels_.end()){auto* surface=TTF_RenderUTF8_Blended_Wrapped(fonts_.at(size),value.c_str(),{255,255,255,255},static_cast<Uint32>(std::max(1,width)));if(!surface)return nullptr;auto* texture=SDL_CreateTextureFromSurface(renderer,surface);const size_t bytes=texture?static_cast<size_t>(surface->pitch)*surface->h:0;Text t{texture,surface->w,std::min(surface->h,TTF_FontLineSkip(fonts_.at(size))*lines),frame,bytes};SDL_FreeSurface(surface);found=labels_.emplace(key,t).first;labelBytes_+=bytes;labelCreates_++;}
    found->second.seen=frame;return &found->second;
  }
  SDL_Texture* gradient(bool horizontal){auto* surface=SDL_CreateRGBSurfaceWithFormat(0,horizontal?256:1,horizontal?1:256,32,SDL_PIXELFORMAT_RGBA32);auto* pixels=static_cast<Uint32*>(surface->pixels);for(int i=0;i<256;i++)pixels[i]=SDL_MapRGBA(surface->format,Tokens::background.r,Tokens::background.g,Tokens::background.b,static_cast<Uint8>(i));auto* texture=SDL_CreateTextureFromSurface(renderer,surface);SDL_FreeSurface(surface);SDL_SetTextureBlendMode(texture,SDL_BLENDMODE_BLEND);return texture;}
public:
  SDL_Renderer* renderer; Uint64 frame=0;
  Canvas(SDL_Renderer* r,const std::string& font,const std::string& headingFont=""):renderer(r){for(int size:{Tokens::caption,Tokens::control,Tokens::body,Tokens::heading,Tokens::title,Tokens::compactTitle,Tokens::brand}){bool heading=size==Tokens::title||size==Tokens::compactTitle||size==Tokens::heading||size==Tokens::brand;auto* f=TTF_OpenFont((heading&&!headingFont.empty()?headingFont:font).c_str(),size);if(!f)throw std::runtime_error("Configured font is unavailable");if(heading&&headingFont.empty())TTF_SetFontStyle(f,TTF_STYLE_BOLD);fonts_[size]=f;}horizontal_=gradient(true);vertical_=gradient(false);SDL_SetRenderDrawBlendMode(r,SDL_BLENDMODE_BLEND);}
  ~Canvas(){for(auto& [k,t]:labels_)SDL_DestroyTexture(t.texture);for(auto [s,f]:fonts_)TTF_CloseFont(f);SDL_DestroyTexture(horizontal_);SDL_DestroyTexture(vertical_);}
  void fill(Rect rect,SDL_Color color){SDL_SetRenderDrawColor(renderer,color.r,color.g,color.b,color.a);auto dst=rect.sdl();SDL_RenderFillRectF(renderer,&dst);}
  void ring(float x,float y,float radius,SDL_Color color){SDL_Vertex vertices[80];int indices[240];for(int i=0;i<40;i++){float a=i*6.2831853f/40;for(int edge=0;edge<2;edge++){float r=radius-edge*1.8f;vertices[i*2+edge]={{x+std::cos(a)*r,y+std::sin(a)*r},color,{0,0}};}int next=(i+1)%40*2;int* triangle=indices+i*6;triangle[0]=i*2;triangle[1]=next;triangle[2]=i*2+1;triangle[3]=i*2+1;triangle[4]=next;triangle[5]=next+1;}SDL_RenderGeometry(renderer,nullptr,vertices,80,indices,240);}
  void vibrantRing(float x,float y,float radius,float phase){
    constexpr SDL_Color colors[]={{95,219,255,245},{112,120,255,245},{218,93,255,245},{255,103,158,245}};SDL_Vertex vertices[96];int indices[288];
    for(int i=0;i<48;i++){float angle=i*6.2831853f/48,t=std::fmod(i/48.f+phase,1.f)*4;int first=static_cast<int>(t)%4,nextColor=(first+1)%4;float mix=t-std::floor(t);SDL_Color color{static_cast<Uint8>(colors[first].r+(colors[nextColor].r-colors[first].r)*mix),static_cast<Uint8>(colors[first].g+(colors[nextColor].g-colors[first].g)*mix),static_cast<Uint8>(colors[first].b+(colors[nextColor].b-colors[first].b)*mix),245};
      for(int edge=0;edge<2;edge++){float r=radius-edge*2.2f;vertices[i*2+edge]={{x+std::cos(angle)*r,y+std::sin(angle)*r},color,{0,0}};}int next=(i+1)%48*2,*triangle=indices+i*6;triangle[0]=i*2;triangle[1]=next;triangle[2]=i*2+1;triangle[3]=i*2+1;triangle[4]=next;triangle[5]=next+1;
    }SDL_RenderGeometry(renderer,nullptr,vertices,96,indices,288);
  }
  void stroke(float x1,float y1,float x2,float y2,SDL_Color color,float width=2){float length=std::hypot(x2-x1,y2-y1);if(length<=0)return;float dx=(y2-y1)/length*width/2,dy=(x1-x2)/length*width/2;SDL_Vertex v[]={{{x1+dx,y1+dy},color,{}},{{x2+dx,y2+dy},color,{}},{{x2-dx,y2-dy},color,{}},{{x1-dx,y1-dy},color,{}}};int indices[]={0,1,2,0,2,3};SDL_RenderGeometry(renderer,nullptr,v,4,indices,6);}
  void lineStrip(const SDL_FPoint* points,int count,SDL_Color color){SDL_SetRenderDrawColor(renderer,color.r,color.g,color.b,color.a);SDL_RenderDrawLinesF(renderer,points,count);}
  void icon(const std::string& kind,float x,float y,SDL_Color color=Tokens::white){
    if(kind=="search"){ring(x-3,y-3,11,color);stroke(x+5,y+5,x+16,y+16,color,2.4f);}
    else if(kind=="settings"){ring(x,y,5,color);for(int i=0;i<32;i++){auto point=[&](int n){float a=n*6.2831853f/32,r=(n%4==1||n%4==2)?16.f:12.5f;return SDL_FPoint{x+std::cos(a)*r,y+std::sin(a)*r};};auto a=point(i),b=point(i+1);stroke(a.x,a.y,b.x,b.y,color,2);}}
    else if(kind=="cross"){stroke(x-6,y-6,x+6,y+6,color,2.3f);stroke(x+6,y-6,x-6,y+6,color,2.3f);}
    else if(kind=="circle")ring(x,y,8,color);
    else if(kind=="triangle"){stroke(x,y-9,x-10,y+8,color);stroke(x-10,y+8,x+10,y+8,color);stroke(x+10,y+8,x,y-9,color);}
    else if(kind=="heart"){SDL_FPoint p[]={{0,11},{-11,0},{-11,-6},{-7,-10},{-3,-10},{0,-6},{3,-10},{7,-10},{11,-6},{11,0},{0,11}};for(int i=0;i<10;i++)stroke(x+p[i].x,y+p[i].y,x+p[i+1].x,y+p[i+1].y,color,2.2f);}
    else if(kind=="chevron"){stroke(x-3,y-8,x+5,y,color);stroke(x+5,y,x-3,y+8,color);}
    else if(kind=="controller"){rounded({x-21,y-14,42,27},color,12);rounded({x-25,y-6,16,27},color,8);rounded({x+9,y-6,16,27},color,8);fill({x-15,y-5,12,3},Tokens::background);fill({x-10.5f,y-9.5f,3,12},Tokens::background);rounded({x+6,y-9,4,4},Tokens::accent,2);rounded({x+12,y-3,4,4},Tokens::accent,2);}
    else{ring(x,y-6,6,color);rounded({x-11,y+4,22,12},color,6);}
  }
  void geometry(SDL_Texture* texture,Rect rect,float radius,SDL_Color color,SDL_FRect uv={0,0,1,1}){
    if(rect.w<=0||rect.h<=0)return;radius=std::clamp(radius,0.f,std::min(rect.w,rect.h)/2);
    int width=0,height=0;if(texture){SDL_QueryTexture(texture,nullptr,nullptr,&width,&height);SDL_SetTextureColorMod(texture,color.r,color.g,color.b);SDL_SetTextureAlphaMod(texture,color.a);}
    // Snap both ends of each blit to the same pixel grid as its adjoining corner.
    float scaleX=1,scaleY=1;SDL_RenderGetScale(renderer,&scaleX,&scaleY);
    auto body=[&](float x,float y,float w,float h){if(w<=0||h<=0)return;float leftPixel=std::floor((rect.x+x)*scaleX),topPixel=std::floor((rect.y+y)*scaleY);Rect box{leftPixel/scaleX,topPixel/scaleY,(std::floor((rect.x+x+w)*scaleX)-leftPixel)/scaleX,(std::floor((rect.y+y+h)*scaleY)-topPixel)/scaleY};if(!texture){fill(box,color);return;}
      int left=std::lround((uv.x+x/rect.w*uv.w)*width),top=std::lround((uv.y+y/rect.h*uv.h)*height);
      SDL_Rect src{left,top,static_cast<int>(std::lround((uv.x+(x+w)/rect.w*uv.w)*width))-left,static_cast<int>(std::lround((uv.y+(y+h)/rect.h*uv.h)*height))-top};auto dst=box.sdl();SDL_RenderCopyF(renderer,texture,&src,&dst);};
    body(radius,0,rect.w-2*radius,rect.h);body(0,radius,radius,rect.h-2*radius);body(rect.w-radius,radius,radius,rect.h-2*radius);
    if(texture){SDL_SetTextureColorMod(texture,255,255,255);SDL_SetTextureAlphaMod(texture,255);}
    if(radius<=0)return;
    SDL_Vertex vertices[40];int indices[96];auto vertex=[&](float x,float y){return SDL_Vertex{{rect.x+x,rect.y+y},color,{uv.x+x/rect.w*uv.w,uv.y+y/rect.h*uv.h}};};
    for(int corner=0;corner<4;corner++){int base=corner*10;float cx=corner<2?rect.w-radius:radius,cy=corner==0||corner==3?radius:rect.h-radius;vertices[base]=vertex(cx,cy);
      for(int i=0;i<9;i++){float angle=(corner*90+i*90.f/8-90)*.017453293f;vertices[base+i+1]=vertex(cx+std::cos(angle)*radius,cy+std::sin(angle)*radius);if(i<8){int n=(corner*8+i)*3;indices[n]=base;indices[n+1]=base+i+1;indices[n+2]=base+i+2;}}}
    SDL_RenderGeometry(renderer,texture,vertices,40,indices,96);
  }
  void rounded(Rect rect,SDL_Color color,float radius=Tokens::radius){geometry(nullptr,rect,radius,color);}
  void edge(Rect rect,SDL_Color color,float radius=Tokens::radius,float thickness=1.5f){
    SDL_Vertex vertices[72];int indices[216];
    for(int corner=0;corner<4;corner++)for(int i=0;i<9;i++){int n=corner*9+i;float angle=(corner*90+i*90.f/8-90)*.017453293f;
      for(int edge=0;edge<2;edge++){float inset=edge*thickness,r=std::max(0.f,radius-inset);Rect box{rect.x+inset,rect.y+inset,rect.w-inset*2,rect.h-inset*2};float x=(corner<2?box.w-r:r)+std::cos(angle)*r,y=(corner==0||corner==3?r:box.h-r)+std::sin(angle)*r;vertices[n*2+edge]={{box.x+x,box.y+y},color,{0,0}};}
      int next=(n+1)%36*2;int* t=indices+n*6;t[0]=n*2;t[1]=next;t[2]=n*2+1;t[3]=n*2+1;t[4]=next;t[5]=next+1;
    }SDL_RenderGeometry(renderer,nullptr,vertices,72,indices,216);
  }
  void outline(Rect rect,float strength=1,float radius=Tokens::radius){
    // Draw only the border; repainting a full large card for every glow layer wastes fill time.
    for(int layer=6;layer>=0;layer--){SDL_Vertex vertices[72];int indices[216];auto alpha=static_cast<Uint8>((layer==0?235:22-layer*2)*strength);SDL_Color color{Tokens::focus.r,Tokens::focus.g,Tokens::focus.b,alpha};
      for(int corner=0;corner<4;corner++)for(int i=0;i<9;i++){int n=corner*9+i;float angle=(corner*90+i*90.f/8-90)*.017453293f;for(int edge=0;edge<2;edge++){float offset=layer-edge*1.2f,r=radius+offset;Rect box{rect.x-offset,rect.y-offset,rect.w+offset*2,rect.h+offset*2};float x=(corner<2?box.w-r:r)+std::cos(angle)*r,y=(corner==0||corner==3?r:box.h-r)+std::sin(angle)*r;vertices[n*2+edge]={{box.x+x,box.y+y},color,{0,0}};}int next=(n+1)%36*2;int* triangle=indices+n*6;triangle[0]=n*2;triangle[1]=next;triangle[2]=n*2+1;triangle[3]=n*2+1;triangle[4]=next;triangle[5]=next+1;}
      SDL_RenderGeometry(renderer,nullptr,vertices,72,indices,216);
    }
  }
  int textHeight(const std::string& value,int size,int width,int lines=1){auto* t=text(value,size,width,lines);return t?t->height:0;}
  void label(const std::string& value,float x,float y,int size=Tokens::body,SDL_Color color=Tokens::white,int width=1600,int lines=1){auto* t=text(value,size,width,lines);if(!t||!t->texture)return;
    SDL_SetTextureColorMod(t->texture,color.r,color.g,color.b);SDL_SetTextureAlphaMod(t->texture,color.a);SDL_Rect src{0,0,t->width,t->height};SDL_FRect dest{x,y,static_cast<float>(t->width),static_cast<float>(t->height)};SDL_RenderCopyF(renderer,t->texture,&src,&dest);
  }
  int measure(const std::string& value,int size=Tokens::body){auto key="measure:"+std::to_string(size)+":"+value;auto found=labels_.find(key);if(found==labels_.end()){int width=0;TTF_SizeUTF8(fonts_.at(size),value.c_str(),&width,nullptr);found=labels_.emplace(key,Text{nullptr,width,0,frame,0}).first;}found->second.seen=frame;return found->second.width;}
  void fade(Rect rect,bool horizontal,bool reverse=false,Uint8 opacity=255){auto* texture=horizontal?horizontal_:vertical_;SDL_SetTextureAlphaMod(texture,opacity);auto dst=rect.sdl();SDL_RenderCopyExF(renderer,texture,nullptr,&dst,0,nullptr,reverse?(horizontal?SDL_FLIP_HORIZONTAL:SDL_FLIP_VERTICAL):SDL_FLIP_NONE);}
  void cover(SDL_Texture* texture,Rect rect,const SDL_Rect* crop=nullptr,Uint8 alpha=255,float radius=0){if(!texture){rounded(rect,{24,34,47,255});rounded({rect.x+rect.w*.2f,rect.y+rect.h*.3f,rect.w*.6f,rect.h*.4f},{34,51,70,255},18);label("PS5Library",rect.x+15,rect.y+rect.h*.75f,Tokens::caption,Tokens::muted,static_cast<int>(rect.w-30));return;}int w,h;SDL_QueryTexture(texture,nullptr,nullptr,&w,&h);SDL_Rect src=crop?*crop:SDL_Rect{0,0,w,h};float aspect=rect.w/rect.h;if(src.w/static_cast<float>(src.h)>aspect){int target=static_cast<int>(src.h*aspect);src.x+=(src.w-target)/2;src.w=target;}else{int target=static_cast<int>(src.w/aspect);src.y+=(src.h-target)/2;src.h=target;}
    if(radius>0)geometry(texture,rect,radius,{255,255,255,alpha},{static_cast<float>(src.x)/w,static_cast<float>(src.y)/h,static_cast<float>(src.w)/w,static_cast<float>(src.h)/h});
    else{SDL_SetTextureAlphaMod(texture,alpha);auto dst=rect.sdl();SDL_RenderCopyF(renderer,texture,&src,&dst);SDL_SetTextureAlphaMod(texture,255);}}
  void bar(Rect rect,int64_t done,int64_t total){rounded(rect,{45,57,73,220},rect.h/2);if(total>0)rounded({rect.x,rect.y,rect.w*std::clamp(done/static_cast<float>(total),0.f,1.f),rect.h},Tokens::accent,rect.h/2);else{float x=static_cast<float>((SDL_GetTicks()%1400)/1400.0);rounded({rect.x+(rect.w-80)*x,rect.y,80,rect.h},Tokens::accent,rect.h/2);}}
  size_t labelBytes()const{return labelBytes_;}size_t labelEntries()const{return labels_.size();}size_t labelCreates()const{return labelCreates_;}size_t labelDestroys()const{return labelDestroys_;}
  void end(){frame++;if(labels_.size()>320)for(auto i=labels_.begin();i!=labels_.end();){if(frame-i->second.seen>120){labelBytes_-=i->second.bytes;SDL_DestroyTexture(i->second.texture);labelDestroys_++;i=labels_.erase(i);}else ++i;}}
};
}
