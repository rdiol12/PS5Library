#include "storefront.hpp"

#if defined(PS5LIBRARY_NATIVE) && defined(PS5)
extern "C" void native_error(const char *);
extern "C" int ps5library_native_launch(const char *);
#endif

int main(int argc, char **argv) {
  try {
    Options options;
    for (int i = 1; i < argc; i++) {
      std::string value = argv[i];
      if (value == "--preview")
        options.preview = true;
      else if (value.rfind("--frames=", 0) == 0)
        options.frames = std::stoi(value.substr(9));
      else if (value.rfind("--capture=", 0) == 0)
        options.capture = value.substr(10);
      else if (value.rfind("--screen=", 0) == 0)
        options.screen = value.substr(9);
      else if (value.rfind("--script=", 0) == 0)
        options.script = value.substr(9);
      else if (value.rfind("--size=", 0) == 0) {
        auto split = value.find('x');
        options.width = std::stoi(value.substr(7, split - 7));
        options.height = std::stoi(value.substr(split + 1));
      } else
        options.config = value;
    }
    options.config = fs::absolute(options.config);
    std::string launch;
    {
      Storefront app(options);
      app.run();
      launch = app.launchTitle();
    }
    if (!launch.empty()) {
#if defined(PS5LIBRARY_NATIVE) && defined(PS5)
      if (ps5library_native_launch(launch.c_str()) < 0)
        throw std::runtime_error("Native title launch failed");
#elif !defined(PS5LIBRARY_NATIVE)
      loaderRequest(readConfig(options.config)["launcherUrl"].string(),
                    "/launch?titleId=" + launch);
#endif
    }
    return 0;
  } catch (const std::exception &e) {
#if defined(PS5LIBRARY_NATIVE) && defined(PS5)
    native_error(e.what());
#endif
    std::fprintf(stderr, "Storefront: %s\n", e.what());
    return 1;
  }
}
