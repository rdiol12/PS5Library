#include "../installer/files.hpp"
#include <cstdio>

int main() {
  using namespace install;
#ifdef PS5
  const fs::path base="/data/ps5library";
#else
  const auto base=fs::temp_directory_path();
#endif
  const auto root=base/("cleanup-check-"+std::to_string(getpid()));
  const auto target=root/"fixture";
  bool created=false;
  try {
    if(!fs::create_directory(root))throw std::runtime_error("Test directory already exists; refusing to reuse it");
    created=true;
    install::write(root/".ps5library-owner",reinterpret_cast<const unsigned char*>(marker),std::string(marker).size());
    const unsigned char executable[]={1,2,3};
    publish(target,{{"eboot.elf",executable,sizeof(executable)}},[]{});
    if(!owned(target)||fs::file_size(target/"eboot.elf")!=sizeof(executable))throw std::runtime_error("Test installation was not published correctly");
    std::printf("Cleanup test: removing owned fixture %s\n",target.c_str());
    std::fflush(stdout);
    removeOwned(target);
    if(fs::exists(target))throw std::runtime_error("Fixture still exists after removeOwned returned");
    removeOwned(root);
    if(fs::exists(root))throw std::runtime_error("Owned test directory still exists after cleanup");
    std::puts("PASS: owned fixture and isolated test directory were removed");
    return 0;
  } catch(const std::exception& error) {
    std::fprintf(stderr,"FAIL: %s\n%s: %s\n",error.what(),created?"Test directory retained for inspection":"Test directory was not created",root.c_str());
    return 1;
  }
}
