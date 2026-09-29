#include "../agent/local.hpp"
#include <arpa/inet.h>
#include <atomic>
#include <cassert>
#include <sys/socket.h>
#include <thread>
#include <unistd.h>

int main(){using namespace ps5library;
  const std::string line="GET /api/v1/agent/home-update/PPSA99783/01.000.023 HTTP/1.1\r\nHost: console\r\n\r\n";
  auto request=parseNativeUpdateBridgeRequest(line);assert(request.action==LocalAgentAction::AppUpdate&&request.titleId=="PPSA99783"&&request.version=="01.000.023");
  assert(parseNativeUpdateBridgeRequest("GET /api/v1/agent/home-update/PPSA99999/01.000.023 HTTP/1.1\r\n\r\n").action==LocalAgentAction::Invalid);
  assert(parseNativeUpdateBridgeRequest("GET /api/v1/agent/home-update/PPSA99783/01.00x.023 HTTP/1.1\r\n\r\n").action==LocalAgentAction::Invalid);
  LocalAgentServer server(0,"127.0.0.1");std::atomic<int> queued{0};
  std::thread worker([&]{while(!server.poll([](const LocalAgentRequest&){return Json();},{},{},[&](const LocalAgentRequest& update){assert(update.titleId=="PPSA99783"&&update.version=="01.000.023");queued++;}))std::this_thread::yield();});
  int client=socket(AF_INET,SOCK_STREAM,0);assert(client>=0);sockaddr_in address{};address.sin_family=AF_INET;address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);address.sin_port=htons(server.port());assert(connect(client,reinterpret_cast<sockaddr*>(&address),sizeof(address))==0);assert(send(client,line.data(),line.size(),0)==static_cast<ssize_t>(line.size()));
  std::string response;char bytes[1024];for(ssize_t count;(count=recv(client,bytes,sizeof(bytes),0))>0;)response.append(bytes,static_cast<size_t>(count));close(client);worker.join();
  assert(response.find("HTTP/1.1 200 OK")!=std::string::npos&&response.find("application/xml")!=std::string::npos&&response.find("PPSA99783_00")!=std::string::npos&&response.find("OPENSTORYPS50000")!=std::string::npos&&response.find("<package")==std::string::npos&&queued==1);
}
