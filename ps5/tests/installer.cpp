#include "../installer/files.hpp"
#include <cassert>
int main(){using namespace install;auto root=fs::temp_directory_path()/("ps5library-install-"+std::to_string(getpid()));fs::create_directory(root);auto target=root/"BREW05001";const unsigned char first[]={1,2,3},second[]={4,5,6,7};int registrations=0;
  publish(target,{{"eboot.elf",first,sizeof(first)}},[&]{registrations++;});assert(owned(target)&&registrations==1&&fs::file_size(target/"eboot.elf")==3);
  bool rejected=false;try{publish(target,{{"eboot.elf",second,sizeof(second)}},[]{throw std::runtime_error("registration failed");});}catch(...){rejected=true;}assert(rejected&&owned(target)&&fs::file_size(target/"eboot.elf")==3);
  rejected=false;try{publish(target,{{"../escape",first,sizeof(first)}},[]{});}catch(...){rejected=true;}assert(rejected&&!fs::exists(root/"escape"));
  auto foreign=root/"OTHER0000";fs::create_directory(foreign);rejected=false;try{publish(foreign,{{"eboot.elf",first,sizeof(first)}},[]{});}catch(...){rejected=true;}assert(rejected&&fs::is_empty(foreign));
  fs::create_directory_symlink(target,root/"alias");rejected=false;try{publish(root/"alias",{{"eboot.elf",first,sizeof(first)}},[]{});}catch(...){rejected=true;}assert(rejected);
  publish(target,{{"eboot.elf",second,sizeof(second)}},[]{},true);assert(fs::exists(root/".ps5library-previous/eboot.elf"));
  rollback(target);assert(fs::file_size(target/"eboot.elf")==3&&!fs::exists(root/".ps5library-previous"));
  install::write(target/"foreign.txt",first,sizeof(first));rejected=false;try{removeOwned(target);}catch(...){rejected=true;}assert(rejected&&owned(target)&&fs::file_size(target/"foreign.txt")==3&&fs::file_size(target/"eboot.elf")==3);fs::remove(target/"foreign.txt");
  fs::create_directory_symlink(foreign,target/"sce_sys");rejected=false;try{removeOwned(target);}catch(...){rejected=true;}assert(rejected&&owned(target)&&fs::exists(foreign));fs::remove(target/"sce_sys");
  publish(target,{{"eboot.elf",second,sizeof(second)},{"sce_sys/icon0.png",first,sizeof(first)},{"sce_sys/pic0.png",first,sizeof(first)},{"sce_sys/pic0.dds",first,sizeof(first)},{"sce_sys/pic1.png",first,sizeof(first)},{"sce_sys/pic1.dds",first,sizeof(first)},{"sce_sys/param.json",first,sizeof(first)},{"launch.html",first,sizeof(first)}},[]{});
  removeOwned(target);assert(!fs::exists(target));
  fs::remove_all(root);return 0;
}
