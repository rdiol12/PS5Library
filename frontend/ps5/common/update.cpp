#include "update.hpp"
#include "update-key.hpp"
#include <openssl/pem.h>
#include <memory>
#include <regex>
#include <fstream>
namespace ps5library {
const char* updatePublicKey(){return updateTrustKey;}
Json verifyUpdate(const Json& envelope,const std::string& trustedKey,int64_t minimumBuild){
  const auto payload=envelope["payload"].string(),signature=envelope["signature"].string();
  if(payload.empty()||payload.size()>4096||!std::regex_match(signature,std::regex("[a-f0-9]{128}")))throw std::runtime_error("Invalid update manifest");
  std::unique_ptr<BIO,decltype(&BIO_free)> bio(BIO_new_mem_buf(trustedKey.data(),static_cast<int>(trustedKey.size())),BIO_free);
  std::unique_ptr<EVP_PKEY,decltype(&EVP_PKEY_free)> key(bio?PEM_read_bio_PUBKEY(bio.get(),nullptr,nullptr,nullptr):nullptr,EVP_PKEY_free);
  std::unique_ptr<EVP_MD_CTX,decltype(&EVP_MD_CTX_free)> ctx(EVP_MD_CTX_new(),EVP_MD_CTX_free);
  unsigned char bytes[64];for(size_t i=0;i<64;i++)bytes[i]=static_cast<unsigned char>(std::stoul(signature.substr(i*2,2),nullptr,16));
  if(!key||!ctx||EVP_PKEY_base_id(key.get())!=EVP_PKEY_ED25519||EVP_DigestVerifyInit(ctx.get(),nullptr,nullptr,nullptr,key.get())!=1||EVP_DigestVerify(ctx.get(),bytes,sizeof(bytes),reinterpret_cast<const unsigned char*>(payload.data()),payload.size())!=1)throw std::runtime_error("Update signature is not trusted");
  auto manifest=Json::parse(payload);
  if(manifest["schemaVersion"].number()!=1||manifest["product"].string()!="PS5Library"||!std::regex_match(manifest["version"].string(),std::regex("[0-9]{1,6}\\.[0-9]{1,6}\\.[0-9]{1,6}"))||manifest["size"].number()<4||manifest["size"].number()>96*1024*1024||!std::regex_match(manifest["sha256"].string(),std::regex("[a-f0-9]{64}"))||manifest["build"].number()<=0||manifest["build"].number()>9007199254740991LL)throw std::runtime_error("Invalid update manifest");
  if(manifest["build"].number()<=minimumBuild)throw std::runtime_error("Update must be newer than this app");
  return manifest;
}
fs::path downloadUpdate(Client& client,const fs::path& root,const Json& manifest,const std::function<void(int64_t,int64_t)>& progress){
  const auto hash=manifest["sha256"].string();const auto size=manifest["size"].number();
  if(!std::regex_match(hash,std::regex("[a-f0-9]{64}"))||size<4||size>96*1024*1024)throw std::runtime_error("Invalid update download");
  fs::create_directories(root);auto part=beneath(root,hash+".part"),ready=beneath(root,hash+".elf");
  if(fs::exists(ready)&&static_cast<int64_t>(fs::file_size(ready))==size&&fileHash(ready,client.cancelled)==hash){progress(size,0);return ready;}
  if(fs::exists(part)&&static_cast<int64_t>(fs::file_size(part))>=size)fs::remove(part);
  auto offset=fs::exists(part)?static_cast<int64_t>(fs::file_size(part)):0;
  if(fs::space(root).available<static_cast<uintmax_t>(size-offset+128*1024*1024))throw std::runtime_error("Not enough space for the app update");
  try{client.download("/api/v1/device/updates/"+hash,part,size,hash,progress);}catch(const std::exception& e){if(std::string(e.what())=="CORRUPT_INPUT")fs::remove(part);throw;}
  char magic[4]{};std::ifstream input(part,std::ios::binary);input.read(magic,4);if(std::string(magic,4)!=std::string("\177ELF",4)){fs::remove(part);throw std::runtime_error("Update is not an ELF installer");}
  fs::rename(part,ready);return ready;
}
void loaderRequest(const std::string& launcherUrl,const std::string& query){
  if(query.rfind("/elfldr?",0)!=0&&query.rfind("/hbldr?",0)!=0&&!std::regex_match(query,std::regex("/launch\\?titleId=(PPSA|CUSA)[0-9]{5}")))throw std::runtime_error("Invalid loader request");
  std::unique_ptr<CURL,decltype(&curl_easy_cleanup)> curl(curl_easy_init(),curl_easy_cleanup);if(!curl)throw std::runtime_error("Loader connection unavailable");
  auto url=normalizeServerUrl(launcherUrl,true)+query;curl_easy_setopt(curl.get(),CURLOPT_URL,url.c_str());curl_easy_setopt(curl.get(),CURLOPT_PROXY,"");curl_easy_setopt(curl.get(),CURLOPT_FOLLOWLOCATION,0L);curl_easy_setopt(curl.get(),CURLOPT_NOSIGNAL,1L);curl_easy_setopt(curl.get(),CURLOPT_TIMEOUT,10L);
  curl_easy_setopt(curl.get(),CURLOPT_WRITEFUNCTION,+[](char*,size_t a,size_t b,void*)->size_t{return a*b;});
  auto error=curl_easy_perform(curl.get());long status=0;curl_easy_getinfo(curl.get(),CURLINFO_RESPONSE_CODE,&status);
  if(error!=CURLE_OK||status!=200)throw std::runtime_error("Start the compatible Homebrew Launcher and retry");
}
}
