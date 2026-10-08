#include "../common/update.hpp"
#include <openssl/pem.h>
#include <cassert>
#include <iostream>
#include <fstream>
using namespace ps5library;
int main(int argc,char** argv){
  if(argc==4&&std::string(argv[1])=="--launch"){loaderRequest(argv[2],argv[3]);return 0;}
  if(argc==6&&std::string(argv[1])=="--download"){Client client(Json::object({{"serverUrl",argv[2]},{"allowInsecureLan",true}}));client.credential=argv[3];auto envelope=client.request("GET","/api/v1/device/updates");std::ifstream keyFile(argv[4]);std::string key((std::istreambuf_iterator<char>(keyFile)),{});auto manifest=verifyUpdate(envelope,key,0);auto file=downloadUpdate(client,argv[5],manifest,[](int64_t,int64_t){});assert(fileHash(file)==manifest["sha256"].string());std::cout<<file.string()<<'\n';return 0;}
  auto* context=EVP_PKEY_CTX_new_id(EVP_PKEY_ED25519,nullptr);EVP_PKEY_keygen_init(context);EVP_PKEY* key=nullptr;EVP_PKEY_keygen(context,&key);EVP_PKEY_CTX_free(context);
  auto* bio=BIO_new(BIO_s_mem());PEM_write_bio_PUBKEY(bio,key);char* buffer=nullptr;auto size=BIO_get_mem_data(bio,&buffer);std::string publicKey(buffer,size);BIO_free(bio);
  auto payload=Json::object({{"schemaVersion",1},{"product","PS5Library"},{"version","0.2.1"},{"build",int64_t(2026091602)},{"size",int64_t(100)},{"sha256",std::string(64,'a')}}).dump();
  auto envelope=[&](const std::string& value){auto* ctx=EVP_MD_CTX_new();EVP_DigestSignInit(ctx,nullptr,nullptr,nullptr,key);unsigned char bytes[64];size_t n=sizeof(bytes);assert(EVP_DigestSign(ctx,bytes,&n,reinterpret_cast<const unsigned char*>(value.data()),value.size())==1);EVP_MD_CTX_free(ctx);std::string signature;for(size_t i=0;i<n;i++){signature+="0123456789abcdef"[bytes[i]>>4];signature+="0123456789abcdef"[bytes[i]&15];}return Json::object({{"payload",value},{"signature",signature}});};
  auto signedRelease=envelope(payload);assert(verifyUpdate(signedRelease,publicKey,2026091601)["version"].string()=="0.2.1");
  auto reject=[&](const Json& input,const std::string& trusted,int64_t minimum){bool rejected=false;try{verifyUpdate(input,trusted,minimum);}catch(...){rejected=true;}assert(rejected);};
  auto changed=Json::parse(signedRelease.dump());changed.set("payload",payload+" ");reject(changed,publicKey,0);
  changed=Json::parse(signedRelease.dump());changed.set("signature",std::string(128,'0'));reject(changed,publicKey,0);
  reject(signedRelease,"untrusted key",0);reject(signedRelease,publicKey,2026091602);
  auto invalid=Json::parse(payload);invalid.set("size",int64_t(1024)*1024*1024);reject(envelope(invalid.dump()),publicKey,0);
  invalid=Json::parse(payload);invalid.set("sha256","../../escape");reject(envelope(invalid.dump()),publicKey,0);
  EVP_PKEY_free(key);return 0;
}
