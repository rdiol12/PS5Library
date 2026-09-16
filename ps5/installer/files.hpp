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
inline bool bundlePath(const std::string& name){return name=="eboot.elf"||name=="launch.html"||name=="sce_sys/icon0.png"||name=="sce_sys/icon0.dds"||name=="sce_sys/pic0.png"||name=="sce_sys/pic0.dds"||name=="sce_sys/pic1.png"||name=="sce_sys/pic1.dds"||name=="sce_sys/param.json";}
inline void removeOwned(const fs::path& dir){
  if(fs::is_symlink(dir))throw std::runtime_error("Symlink installation target");
  if(!fs::exists(dir))return;
  if(!owned(dir))throw std::runtime_error("Refusing to remove an unowned title folder");
  std::vector<fs::path> files;
  auto check=[&](const fs::directory_entry& entry,const std::string& relative){
    if(entry.is_symlink()||!entry.is_regular_file()||!bundlePath(relative))throw std::runtime_error("Unexpected installation file; cleanup refused");
    files.push_back(entry.path());
  };
  // PS5 libc++ remove_all silently leaves the directory intact. Validate the finite bundle before POSIX deletion.
  bool system=false;
  for(const auto& entry:fs::directory_iterator(dir)){
    auto name=entry.path().filename().string();if(name==".ps5library-owner")continue;
    if(name=="sce_sys"&&!entry.is_symlink()&&entry.is_directory()){
      system=true;for(const auto& child:fs::directory_iterator(entry.path()))check(child,"sce_sys/"+child.path().filename().string());
    }else check(entry,name);
  }
  for(const auto& file:files)if(unlink(file.c_str()))throw std::runtime_error("Cannot remove installation file; ownership marker retained");
  if(system&&rmdir((dir/"sce_sys").c_str()))throw std::runtime_error("Cannot remove installation metadata folder");
  if(unlink((dir/".ps5library-owner").c_str()))throw std::runtime_error("Cannot remove installation marker");
  if(rmdir(dir.c_str())){
    write(dir/".ps5library-owner",reinterpret_cast<const unsigned char*>(marker),std::string(marker).size());
    throw std::runtime_error("Owned installation cleanup did not complete");
  }
}
inline void rollback(const fs::path& target){auto previous=target.parent_path()/".ps5library-previous";if(!owned(previous))throw std::runtime_error("No owned previous installation to restore");removeOwned(target);fs::rename(previous,target);}
inline void publish(const fs::path& target,const std::vector<File>& files,const std::function<void()>& registerTitle,bool keepPrevious=false){
  if(fs::is_symlink(target)||fs::is_symlink(target.parent_path()))throw std::runtime_error("Symlink installation target");
  if(fs::exists(target)&&!owned(target))throw std::runtime_error("Title ID belongs to another application");
  auto stage=target.parent_path()/".ps5library-stage",previous=target.parent_path()/".ps5library-previous";
  if(fs::exists(previous))throw std::runtime_error("Previous installation awaits recovery; see PS5_SYSTEM_INTEGRATION.md");
  size_t bytes=0;for(const auto& file:files){if(!bundlePath(file.name))throw std::runtime_error("Invalid bundle path");bytes+=file.size;}
  if(fs::space(target.parent_path()).available<bytes+64*1024*1024)throw std::runtime_error("Insufficient installation space");
  removeOwned(stage);fs::create_directory(stage);
  write(stage/".ps5library-owner",reinterpret_cast<const unsigned char*>(marker),std::string(marker).size());
  try{for(const auto& file:files){auto destination=stage/file.name;fs::create_directories(destination.parent_path());write(destination,file.data,file.size);}if(fs::exists(target))fs::rename(target,previous);fs::rename(stage,target);
    try{registerTitle();}catch(...){removeOwned(target);if(fs::exists(previous))fs::rename(previous,target);throw;}
    if(!keepPrevious)removeOwned(previous);
  }catch(...){removeOwned(stage);throw;}
}
}
