#include "../frontend/audio.hpp"
#include <cassert>
int main(){
  SDL_setenv("SDL_AUDIODRIVER","dummy",1);
  {
    storefront::UiAudio audio(true);assert(audio.available());
    assert(audio.play(storefront::Cue::Move));assert(audio.played()==1);
    audio.setEnabled(false);assert(!audio.play(storefront::Cue::Select));assert(audio.played()==1);
    audio.setEnabled(true);assert(audio.play(storefront::Cue::Back));assert(audio.played()==2);
    audio.preview(true,true);assert(audio.play(storefront::Cue::Select));assert(audio.played()==3);
    std::array<Sint16,2048> music{};music.fill(1000);assert(audio.pcm(music.data(),music.size()));
    audio.preview(true,false);assert(!audio.play(storefront::Cue::Move));
    audio.preview(false);assert(audio.play(storefront::Cue::Move));
  }
  SDL_Quit();SDL_setenv("SDL_AUDIODRIVER","unavailable-test-driver",1);
  {storefront::UiAudio unavailable(true);assert(!unavailable.available());assert(!unavailable.play(storefront::Cue::Move));}
  SDL_Quit();return 0;
}
