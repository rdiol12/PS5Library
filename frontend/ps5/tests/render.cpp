#include "../frontend/render.hpp"
#include "../frontend/artwork.hpp"
#include <cassert>
#include <cstdio>
#include <vector>
int main(){
  SDL_setenv("SDL_VIDEODRIVER","dummy",1);assert(SDL_Init(SDL_INIT_VIDEO)==0);assert(TTF_Init()==0);
  auto* surface=SDL_CreateRGBSurfaceWithFormat(0,640,360,32,SDL_PIXELFORMAT_ARGB8888);
  auto* renderer=SDL_CreateSoftwareRenderer(surface);assert(renderer);
  SDL_RendererInfo rendererInfo{};assert(SDL_GetRendererInfo(renderer,&rendererInfo)==0);
  assert(!storefront::heroCrossfade(rendererInfo.flags));
  assert(storefront::heroCrossfade(SDL_RENDERER_ACCELERATED));
  assert(storefront::backdropMode("My Library")!=storefront::backdropMode("Game"));
  assert(storefront::backdropMode("My Library")!=storefront::backdropMode("Downloads"));
  assert(storefront::backdropMode("Downloads")==storefront::backdropMode("My PS5"));
  assert(storefront::Tokens::libraryStripY>storefront::Tokens::heroBottom);
  assert(storefront::Tokens::downloadQueueWidth+storefront::Tokens::downloadSummaryWidth+48==storefront::Tokens::width-storefront::Tokens::safe*2);
  assert(storefront::Tokens::profileRailY>storefront::Tokens::profileFactsY);
  storefront::BackdropRequestGate gate;assert(!gate.requestable("hero-a",false,0));assert(!gate.requestable("hero-b",false,150));assert(!gate.requestable("hero-c",false,300));assert(!gate.requestable("hero-c",false,479));assert(gate.requestable("hero-c",false,480));assert(gate.requestable("hero-cached",true,481));
  const auto heroNeed=storefront::backdropArtworkNeed("hero",3840,2160,1920,1080);assert(heroNeed.width==1920&&heroNeed.height==1080&&heroNeed.pixelLimit==size_t(1920)*1080);const auto cardNeed=storefront::foregroundArtworkNeed("cover",96,130);assert(cardNeed.width>96&&cardNeed.height>130);
  auto* croppedHero=SDL_CreateRGBSurfaceWithFormat(0,3840,2160,32,SDL_PIXELFORMAT_ARGB8888);assert(croppedHero&&storefront::prepareArtworkSurface(croppedHero,heroNeed.width,heroNeed.height,heroNeed.cropWidth,heroNeed.cropHeight,heroNeed.pixelLimit));assert(static_cast<size_t>(croppedHero->w)*croppedHero->h<=heroNeed.pixelLimit);SDL_FreeSurface(croppedHero);
  auto* rgb=SDL_CreateRGBSurfaceWithFormat(0,32,32,24,SDL_PIXELFORMAT_RGB24);assert(rgb);
  auto* uploaded=storefront::uploadArtworkSurface(renderer,rgb);SDL_FreeSurface(rgb);assert(uploaded);
  Uint32 uploadedFormat=0;assert(SDL_QueryTexture(uploaded,&uploadedFormat,nullptr,nullptr,nullptr)==0);assert(uploadedFormat==SDL_PIXELFORMAT_ARGB8888);SDL_DestroyTexture(uploaded);
  auto* alpha=SDL_CreateRGBSurfaceWithFormat(0,2,2,32,SDL_PIXELFORMAT_ARGB8888);assert(alpha);SDL_FillRect(alpha,nullptr,SDL_MapRGBA(alpha->format,200,100,50,128));assert(storefront::prepareArtworkSurface(alpha,1,1));SDL_Color alphaPixel{};SDL_GetRGBA(*static_cast<Uint32*>(alpha->pixels),alpha->format,&alphaPixel.r,&alphaPixel.g,&alphaPixel.b,&alphaPixel.a);assert(alphaPixel.r>=199&&alphaPixel.g>=99&&alphaPixel.b>=49&&alphaPixel.a==128);SDL_FreeSurface(alpha);
  auto* oversized=SDL_CreateRGBSurfaceWithFormat(0,3840,2160,32,SDL_PIXELFORMAT_ARGB8888);assert(oversized);
  assert(storefront::prepareArtworkSurface(oversized,1920,1080));
  assert(oversized->w==1920&&oversized->h==1080&&oversized->format->format==SDL_PIXELFORMAT_ARGB8888);
  std::printf("Artwork upload reduced from %zu to %zu bytes\n",size_t(3840)*2160*4,size_t(oversized->w)*oversized->h*4);
  SDL_FreeSurface(oversized);
  auto* portrait=SDL_CreateRGBSurfaceWithFormat(0,2000,6000,32,SDL_PIXELFORMAT_ARGB8888);assert(portrait&&storefront::prepareArtworkSurface(portrait,1920,1080));
  assert(static_cast<size_t>(portrait->w)*portrait->h<=storefront::artworkTexturePixelLimit&&portrait->format->format==SDL_PIXELFORMAT_ARGB8888);SDL_FreeSurface(portrait);
  auto mapped=storefront::scaleArtworkCrop({384,216,1920,1080},3840,2160,1920,1080);assert(mapped.x==192&&mapped.y==108&&mapped.w==960&&mapped.h==540);
  mapped=storefront::scaleArtworkCrop({3839,2159,2,2},3840,2160,1920,1080);assert(mapped.x==1919&&mapped.y==1079&&mapped.w==1&&mapped.h==1&&mapped.x+mapped.w<=1920&&mapped.y+mapped.h<=1080);
  const storefront::ArtworkNeed full{"hero",160,90,0,0},same{"hero",160,90,0,0},tighter{"hero",160,90,960,540};assert(!storefront::artworkDemandExceeds(full,same,1920,1080));assert(storefront::artworkDemandExceeds(full,tighter,1920,1080));
  auto* tightCrop=SDL_CreateRGBSurfaceWithFormat(0,256,256,32,SDL_PIXELFORMAT_ARGB8888);assert(tightCrop&&storefront::prepareArtworkSurface(tightCrop,80,80,100,100));mapped=storefront::scaleArtworkCrop({50,50,100,100},256,256,tightCrop->w,tightCrop->h);assert(mapped.w>=80&&mapped.h>=80);SDL_FreeSurface(tightCrop);
  assert(storefront::artworkTexturePixelLimit*4*2<storefront::artworkTextureCacheBytes);
  {
    storefront::Canvas canvas(renderer,"/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf");
    auto* source=SDL_CreateRGBSurfaceWithFormat(0,200,100,32,SDL_PIXELFORMAT_ARGB8888);
    SDL_FillRect(source,nullptr,SDL_MapRGBA(source->format,200,100,50,255));auto* texture=SDL_CreateTextureFromSurface(renderer,source);SDL_FreeSurface(source);
    canvas.fill({0,0,640,360},{0,0,0,255});canvas.cover(texture,{20,20,200,100},nullptr,128,16);
    canvas.rounded({240,20,100,100},{100,200,100,128},50);canvas.rounded({360,20,40,20},{255,255,255,255},0);
    SDL_RenderFlush(renderer);
    auto pixel=[&](int x,int y){SDL_Color c;SDL_GetRGBA(static_cast<Uint32*>(surface->pixels)[y*surface->pitch/4+x],surface->format,&c.r,&c.g,&c.b,&c.a);return c;};
    assert(pixel(20,20).r==0&&pixel(240,20).g==0);assert(pixel(100,60).r>=99&&pixel(100,60).r<=101);
    assert(pixel(40,25).r==pixel(100,60).r&&pixel(100,110).r==pixel(100,60).r); // No gaps/double blending between corner and body.
    assert(pixel(290,70).g>=99&&pixel(290,70).g<=101);assert(pixel(370,25).r==255);
    // A focus stroke must preserve artwork visible through a translucent control.
    canvas.fill({420,30,180,100},{80,120,160,255});
    canvas.outline({430,40,160,80},1,24);SDL_RenderFlush(renderer);
    assert(pixel(500,80).r==80&&pixel(500,80).g==120&&pixel(500,80).b==160);
    assert(canvas.textHeight("A title",24,400,2)<canvas.textHeight("A title long enough to wrap",24,160,2));
    // Fractional modal coordinates must not leave seams through a filled pill.
    canvas.rounded({47.2f,180.8f,525.6f,67},{220,220,220,255},33.5f);SDL_RenderFlush(renderer);
    for(int row=182;row<244;row++)for(int column=82;column<541;column++){if(pixel(column,row).r!=220)std::fprintf(stderr,"Pill seam at %d,%d: %u\n",column,row,pixel(column,row).r);assert(pixel(column,row).r==220);}
    SDL_RenderSetLogicalSize(renderer,1280,720);SDL_Rect clip{80,80,80,80};SDL_RenderSetClipRect(renderer,&clip);
    canvas.cover(texture,{40,40,400,200},nullptr,255,32);SDL_RenderFlush(renderer);assert(pixel(50,50).r==200&&pixel(100,60).r<=101);
    SDL_RenderSetClipRect(renderer,nullptr);SDL_RenderSetLogicalSize(renderer,640,360);
    SDL_RenderSetLogicalSize(renderer,960,540); // The same 2/3 scale used by a 720p store.
    canvas.rounded({56,400,260,58},{200,200,200,128},29);SDL_RenderFlush(renderer);
    for(int row=277;row<297;row++)for(int column=45;column<203;column++)assert(pixel(column,row).r>=99&&pixel(column,row).r<=101);
    SDL_RenderSetLogicalSize(renderer,640,360);
    std::vector<double> timings;for(int i=0;i<60;i++){auto start=SDL_GetPerformanceCounter();canvas.cover(texture,{20,20,200,200},nullptr,255,9);SDL_RenderFlush(renderer);timings.push_back((SDL_GetPerformanceCounter()-start)*1e6/SDL_GetPerformanceFrequency());}
    std::sort(timings.begin(),timings.end());std::printf("Rounded cover median: %.1f us\n",timings[timings.size()/2]);
    SDL_DestroyTexture(texture);
  }
  SDL_DestroyRenderer(renderer);SDL_FreeSurface(surface);TTF_Quit();SDL_Quit();
}
