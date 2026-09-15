#include "../common/client.hpp"
#include <chrono>
#include <thread>
#include <cstdio>
#include <csignal>
#include <fcntl.h>
#include <sys/file.h>
#include <unistd.h>
static volatile std::sig_atomic_t running=1;
int main(int argc,char** argv) {
  try {
    auto config=std::filesystem::absolute(argc>1?argv[1]:"/data/ps5library/config.json");
    int lock=open((config.parent_path()/"agent.lock").c_str(),O_CREAT|O_RDWR|O_NOFOLLOW,0600);
    if(lock<0 || flock(lock,LOCK_EX|LOCK_NB)!=0) throw std::runtime_error("An agent is already running or its configuration directory is unavailable");
    ps5library::Agent agent(config); std::signal(SIGINT,[](int){running=0;}); std::signal(SIGTERM,[](int){running=0;});
    agent.client.cancelled=[]{return !running;};
    while(running) { try { agent.tick(); } catch(const std::exception& e) { std::fprintf(stderr,"Agent: %s\n",e.what()); }
      if(argc>2 && std::string(argv[2])=="--once") break;
      for(int i=0;i<50 && running;i++) std::this_thread::sleep_for(std::chrono::milliseconds(100));
    } close(lock); return 0;
  } catch(const std::exception& e) { std::fprintf(stderr,"%s\n",e.what()); return 1; }
}
