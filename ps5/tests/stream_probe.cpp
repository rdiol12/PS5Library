// Developer probe, not part of ctest (it needs the network): plays a remote trailer stream through
// the real VideoPreview path with SDL's dummy drivers and reports what was decoded.
//   stream-probe <serverUrl> <path> [seconds] [compose]
#include "../frontend/video.hpp"
#include <cstdio>
#include <cstdlib>

int main(int argc, char **argv) {
  if (argc < 3) {
    std::fprintf(stderr, "usage: stream-probe <serverUrl> <path> [seconds]\n");
    return 2;
  }
  const int seconds = argc > 3 ? std::atoi(argv[3]) : 20;
  SDL_setenv("SDL_VIDEODRIVER", "dummy", 1);
  SDL_setenv("SDL_AUDIODRIVER", "dummy", 1);
  if (SDL_Init(SDL_INIT_VIDEO | SDL_INIT_AUDIO) != 0)
    return 3;
  auto *window = SDL_CreateWindow("probe", 0, 0, 1920, 1080, SDL_WINDOW_HIDDEN);
  auto *renderer = SDL_CreateRenderer(window, -1, SDL_RENDERER_SOFTWARE);
  if (!window || !renderer)
    return 3;
  int status = 1;
  {
    storefront::UiAudio audio(true);
    storefront::VideoPreview video(ps5library::fs::temp_directory_path() / "stream-probe", audio);
    const auto config = Json::object({{"serverUrl", argv[1]}, {"allowInsecureLan", true}});
    // An optional fifth argument bakes a half-dark test overlay into the frames.
    if (argc > 4) {
      std::vector<uint8_t> shade(static_cast<size_t>(1920) * 1080 * 4);
      for (size_t i = 0; i < shade.size(); i += 4)
        shade[i + 3] = 128;
      video.overlay(std::move(shade), 1920, 1080);
    }
    video.startStream("probe", config, "probe-token", argv[2], true);
    const auto started = SDL_GetTicks64();
    uint64_t lastReport = 0;
    while (video.active() && SDL_GetTicks64() - started < static_cast<uint64_t>(seconds) * 1000) {
      video.frame(renderer);
      SDL_Delay(5);
      const auto elapsed = (SDL_GetTicks64() - started) / 1000;
      if (elapsed != lastReport) {
        lastReport = elapsed;
        std::printf("t=%llus decoded=%llu displayed=%llu audioBytes=%llu\n",
                    static_cast<unsigned long long>(elapsed),
                    static_cast<unsigned long long>(video.decoded()),
                    static_cast<unsigned long long>(video.displayed()),
                    static_cast<unsigned long long>(video.audioBytes()));
        std::fflush(stdout);
      }
    }
    std::printf("composed=%d%c", video.composed() ? 1 : 0, 10);
    const auto error = video.error();
    std::printf("result: decoded=%llu displayed=%llu audioBytes=%llu error=\"%s\"\n",
                static_cast<unsigned long long>(video.decoded()),
                static_cast<unsigned long long>(video.displayed()),
                static_cast<unsigned long long>(video.audioBytes()), error.c_str());
    status = error.empty() && video.displayed() > 0 && video.audioBytes() > 0 ? 0 : 1;
    video.stop();
  }
  SDL_DestroyRenderer(renderer);
  SDL_DestroyWindow(window);
  SDL_Quit();
  return status;
}
