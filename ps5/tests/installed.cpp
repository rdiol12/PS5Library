#include "../common/client.hpp"
#include <algorithm>
#include <cstdio>
#include <fstream>
#include <vector>
#include <unistd.h>

using Bytes=std::vector<unsigned char>;
static void put(Bytes& data,size_t offset,uint64_t value,size_t width,bool big=false) {
  for(size_t i=0;i<width;i++)data.at(offset+i)=static_cast<unsigned char>(value>>((big?width-1-i:i)*8));
}

int main() {
  using namespace ps5library;
#ifdef PS5
  const fs::path base="/data/ps5library";
#else
  const auto base=fs::temp_directory_path();
#endif
  const auto root=base/("ps5library-installed-check-"+std::to_string(getpid())),file=root/"app.pkg";
  try {
    if(!fs::create_directory(root))throw std::runtime_error("Refusing to reuse an existing test directory");
    const std::string title="Synthetic PS4 package",titleId="CUSA99997",contentId="IV0000-CUSA99997_00-PS4LIBRARYDEMO00";
    const std::vector<std::pair<std::string,std::string>> fields={{"APP_VER","01.00"},{"CATEGORY","gd"},{"CONTENT_ID",contentId},{"TITLE",title},{"TITLE_ID",titleId}};
    const size_t keys=20+16*fields.size();Bytes sfo(keys);
    put(sfo,0,0x46535000,4);put(sfo,4,0x101,4);put(sfo,8,keys,4);put(sfo,16,fields.size(),4);
    for(size_t i=0;i<fields.size();i++) {
      put(sfo,20+i*16,sfo.size()-keys,2);put(sfo,22+i*16,0x0204,2);
      sfo.insert(sfo.end(),fields[i].first.begin(),fields[i].first.end());sfo.push_back(0);
    }
    sfo.resize((sfo.size()+3)&~size_t(3));const auto values=sfo.size();put(sfo,12,values,4);
    for(size_t i=0;i<fields.size();i++) {
      const auto length=fields[i].second.size()+1,capacity=(length+3)&~size_t(3),start=sfo.size();
      put(sfo,24+i*16,length,4);put(sfo,28+i*16,capacity,4);put(sfo,32+i*16,start-values,4);
      sfo.resize(start+capacity);std::copy(fields[i].second.begin(),fields[i].second.end(),sfo.begin()+start);
    }
    // Layout verified against ezremote-client installer.h and sfo.h; no commercial content.
    constexpr size_t table=0x1000,sfoOffset=0x1100;Bytes pkg(0x2000);
    put(pkg,0,0x7f434e54,4,true);put(pkg,4,1,4,true);put(pkg,0xc,1,4,true);put(pkg,0x10,1,4,true);put(pkg,0x16,1,2,true);put(pkg,0x18,table,4,true);
    put(pkg,0x74,0x1a,4,true);put(pkg,0x430,pkg.size(),8,true);std::copy(contentId.begin(),contentId.end(),pkg.begin()+0x40);
    put(pkg,table,0x1000,4,true);put(pkg,table+0x10,sfoOffset,4,true);put(pkg,table+0x14,sfo.size(),4,true);std::copy(sfo.begin(),sfo.end(),pkg.begin()+sfoOffset);
    auto save=[&](const Bytes& data){std::ofstream output(file,std::ios::binary|std::ios::trunc);output.write(reinterpret_cast<const char*>(data.data()),data.size());output.close();if(!output)throw std::runtime_error("Cannot write synthetic package");};
    save(pkg);const auto parsed=inspectPs4Package(file);
    if(parsed["title"].string()!=title||parsed["titleId"].string()!=titleId||parsed["contentId"].string()!=contentId||parsed["version"].string()!="01.00"||parsed["size"].number()!=static_cast<int64_t>(pkg.size()))throw std::runtime_error("Valid synthetic package metadata did not round-trip: "+parsed.dump());
    auto reject=[&](const Bytes& data,const char* reason){save(data);bool rejected=false;try{rejected=inspectPs4Package(file).null();}catch(const std::exception&){rejected=true;}if(!rejected)throw std::runtime_error(std::string("Accepted invalid package: ")+reason);};
    auto bad=pkg;bad.resize(0x100);reject(bad,"truncated package header");
    bad=pkg;put(bad,0x430,pkg.size()+1,8,true);reject(bad,"declared package size differs from file size");
    bad=pkg;put(bad,0x10,0xffffffff,4,true);reject(bad,"entry count overflows the table bounds");
    bad=pkg;put(bad,0x18,0xfffffff0,4,true);reject(bad,"table offset and length exceed the package");
    bad=pkg;put(bad,table+0x10,0xfffffff0,4,true);reject(bad,"SFO offset and length exceed the package");
    bad=pkg;put(bad,table+0x14,0xffffffff,4,true);reject(bad,"SFO size overflows the package bounds");
    bad=pkg;put(bad,sfoOffset+16,0xffffffff,4);reject(bad,"SFO entry count overflows its entry table");
    bad=pkg;put(bad,sfoOffset+8,0xfffffff0,4);reject(bad,"invalid SFO key table offset");
    bad=pkg;put(bad,sfoOffset+12,0xfffffff0,4);reject(bad,"invalid SFO value table offset");
    bad=pkg;put(bad,sfoOffset+20,0xffff,2);reject(bad,"entry key offset lies outside the key table");
    bad=pkg;put(bad,sfoOffset+32,0xfffffff0,4);reject(bad,"entry value offset lies outside the value table");
    bad=pkg;put(bad,sfoOffset+24,0xffffffff,4);reject(bad,"entry value length overflows the value table");
    fs::remove(file);fs::remove(root);std::puts("PASS: PS4 package metadata and malformed bounds");return 0;
  }catch(const std::exception& error){std::fprintf(stderr,"FAIL: %s\nTest path: %s\n",error.what(),root.c_str());return 1;}
}
