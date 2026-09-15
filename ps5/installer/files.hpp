#pragma once
#include <filesystem>
#include <fstream>
#include <functional>
#include <stdexcept>
#include <string>
#include <vector>
#include <fcntl.h>
#include <unistd.h>
namespace install {
namespace fs=std::filesystem;
constexpr auto marker="PS5Library home entry v1\n";
struct File {std::string name;const unsigned char* data;size_t size;};
inline bool owned(const fs::path& dir){if(fs::is_symlink(dir)||fs::is_symlink(dir/".ps5library-owner"))return false;std::ifstream input(dir/".ps5library-owner");std::string text((std::istreambuf_iterator<char>(input)),{});return text==marker;}
inline void write(const fs::path& file,const unsigned char* data,size_t size){int fd=open(file.c_str(),O_WRONLY|O_CREAT|O_EXCL,0644);if(fd<0)throw std::runtime_error("Cannot create installation file");size_t offset=0;while(offset<size){auto n=::write(fd,data+offset,size-offset);if(n<=0){close(fd);throw std::runtime_error("Incomplete installation write");}offset+=static_cast<size_t>(n);}int result=fsync(fd);close(fd);if(result)throw std::runtime_error("Cannot flush installation file");}
inline void removeOwned(const fs::path& dir){if(!fs::exists(dir))return;if(!owned(dir))throw std::runtime_error("Refusing to remove an unowned title folder");fs::remove_all(dir);}
inline void publish(const fs::path& target,const std::vector<File>& files,const std::function<void()>& registerTitle){
  if(fs::is_symlink(target)||fs::is_symlink(target.parent_path()))throw std::runtime_error("Symlink installation target");
  if(fs::exists(target)&&!owned(target))throw std::runtime_error("Title ID belongs to another application");
  auto stage=target.parent_path()/".ps5library-stage",previous=target.parent_path()/".ps5library-previous";
  if(fs::exists(previous))throw std::runtime_error("Previous installation awaits recovery; see PS5_SYSTEM_INTEGRATION.md");
  size_t bytes=0;for(const auto& file:files){fs::path relative(file.name);if(relative.is_absolute()||file.name.empty())throw std::runtime_error("Invalid bundle path");for(const auto& part:relative)if(part==".."||part==".")throw std::runtime_error("Invalid bundle path");bytes+=file.size;}
  if(fs::space(target.parent_path()).available<bytes+64*1024*1024)throw std::runtime_error("Insufficient installation space");
  removeOwned(stage);fs::create_directory(stage);
  write(stage/".ps5library-owner",reinterpret_cast<const unsigned char*>(marker),std::string(marker).size());
  try{for(const auto& file:files){auto destination=stage/file.name;fs::create_directories(destination.parent_path());write(destination,file.data,file.size);}if(fs::exists(target))fs::rename(target,previous);fs::rename(stage,target);
    try{registerTitle();}catch(...){removeOwned(target);if(fs::exists(previous))fs::rename(previous,target);throw;}
    removeOwned(previous);
  }catch(...){removeOwned(stage);throw;}
}
}
