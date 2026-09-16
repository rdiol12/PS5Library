#include "../common/client.hpp"
#include <fstream>
#include <regex>
#include <set>
#include <vector>
namespace ps5library {
static uint64_t integer(const std::string& data,size_t offset,size_t width,bool big=false){
  if(offset>data.size()||width>data.size()-offset)throw std::runtime_error("CORRUPT_INPUT");
  uint64_t value=0;for(size_t i=0;i<width;i++)value|=uint64_t(static_cast<unsigned char>(data[offset+i]))<<((big?width-1-i:i)*8);return value;
}
static std::string packageResource(const fs::path& file,uint32_t id,size_t limit){
  if(fs::is_symlink(file)||!fs::is_regular_file(file))throw std::runtime_error("UNSUPPORTED_INPUT");
  const auto size=fs::file_size(file);std::ifstream input(file,std::ios::binary);
  auto read=[&](uint64_t offset,uint64_t count){
    if(count>limit||offset>size||count>size-offset)throw std::runtime_error("CORRUPT_INPUT");
    std::string data(count,'\0');input.seekg(offset);input.read(data.data(),count);if(!input)throw std::runtime_error("INCOMPLETE_INPUT");return data;
  };
  auto header=read(0,0x440);if(integer(header,0,4,true)!=0x7f434e54)throw std::runtime_error("UNSUPPORTED_INPUT");
  if(integer(header,0x430,8,true)!=size)throw std::runtime_error("INCOMPLETE_INPUT");
  auto count=integer(header,0x10,4,true);if(!count||count>4096)throw std::runtime_error("CORRUPT_INPUT");
  auto table=read(integer(header,0x18,4,true),count*32);
  for(size_t i=0;i<count;i++)if(integer(table,i*32,4,true)==id)return read(integer(table,i*32+16,4,true),integer(table,i*32+20,4,true));
  throw std::runtime_error("UNSUPPORTED_INPUT");
}
Json inspectPs4Package(const fs::path& file){
  auto data=packageResource(file,0x1000,128*1024);
  if(integer(data,0,4)!=0x46535000||integer(data,4,4)!=0x101)throw std::runtime_error("UNSUPPORTED_INPUT");
  auto keys=integer(data,8,4),values=integer(data,12,4),count=integer(data,16,4);
  if(count>256||keys<20+count*16||keys>=values||values>data.size())throw std::runtime_error("CORRUPT_INPUT");
  auto stringAt=[&](uint64_t offset,uint64_t end){if(offset>=end||end>data.size())throw std::runtime_error("CORRUPT_INPUT");auto zero=data.find('\0',offset);if(zero==std::string::npos||zero>=end)throw std::runtime_error("CORRUPT_INPUT");return data.substr(offset,zero-offset);};
  auto fields=Json::object();
  for(size_t i=0;i<count;i++){
    const auto e=20+i*16,key=keys+integer(data,e,2),offset=values+integer(data,e+12,4),length=integer(data,e+4,4),capacity=integer(data,e+8,4);
    auto name=stringAt(key,values);
    if(length>capacity||offset>data.size()||capacity>data.size()-offset)throw std::runtime_error("CORRUPT_INPUT");
    if(integer(data,e+2,2)==0x0204)fields.set(name,stringAt(offset,offset+length));
  }
  auto title=fields["TITLE"].string(),id=fields["TITLE_ID"].string(),content=fields["CONTENT_ID"].string(),version=fields["APP_VER"].string(),category=fields["CATEGORY"].string();
  if(!std::regex_match(id,std::regex("CUSA[0-9]{5}"))||content.size()>80||content.size()<20||content.substr(7,9)!=id||!std::regex_match(version,std::regex("[0-9]{2}\\.[0-9]{2}"))||title.empty()||title.size()>200||(category!="gd"&&category!="gp"))throw std::runtime_error("UNSUPPORTED_INPUT");
  return Json::object({{"title",title},{"titleId",id},{"contentId",content},{"version",version},{"platform","PS4"},{"category",category},{"size",static_cast<int64_t>(fs::file_size(file))}});
}
Json Agent::discoverInstalled(const Json& volumes){
  Json result=Json::array();size_t scanned=0;std::set<std::string> seen;
  for(size_t v=0;v<volumes.size();v++)for(const auto* apps:{"app","user/app"})try{
    auto volume=volumes[v];const fs::path root=volume["path"].string();auto directory=beneath(root,apps);if(!fs::is_directory(directory))continue;
    for(const auto& entry:fs::directory_iterator(directory)){
      if((client.cancelled&&client.cancelled())||++scanned>4096){inventoryComplete_=false;return result;}
      auto id=entry.path().filename().string();if(entry.is_symlink()||!std::regex_match(id,std::regex("CUSA[0-9]{5}")))continue;
      try{
        auto relative=std::string(apps)+"/"+id+"/app.pkg";auto file=beneath(root,relative);if(!fs::is_regular_file(file)||!seen.insert(file.string()).second)continue;
        auto item=inspectPs4Package(file);if(item["titleId"].string()!=id||item["category"].string()!="gd")throw std::runtime_error("METADATA_MISMATCH");
        int64_t size=item["size"].number();std::set<std::string> patches;
        for(size_t p=0;p<volumes.size();p++)for(const auto* patchRoot:{"patch","user/patch"}){
          auto patch=beneath(volumes[p]["path"].string(),std::string(patchRoot)+"/"+id+"/patch.pkg");
          if(!fs::is_regular_file(patch)){patch=patch.parent_path()/"app.pkg";if(!fs::is_regular_file(patch))continue;}
          if(!patches.insert(patch.string()).second)continue;
          auto updated=inspectPs4Package(patch);
          if(updated["contentId"].string()!=item["contentId"].string()||updated["category"].string()!="gp")throw std::runtime_error("METADATA_MISMATCH");
          size+=updated["size"].number();if(updated["version"].string()>item["version"].string())item.set("version",updated["version"]);
        }
        item.set("size",size);item.set("storageId",volume["storageId"]);item.set("relativePath",relative);item.set("source","INSTALLED_TITLE");item.set("sha256",Json());item.set("available",true);item.set("registered",false);
        fs::path artwork;
        for(size_t p=0;p<volumes.size();p++)for(const auto* meta:{"appmeta","user/appmeta"}){auto candidate=beneath(volumes[p]["path"].string(),std::string(meta)+"/"+id);if(fs::is_regular_file(candidate/"icon0.png"))artwork=candidate;}
        if(artwork.empty())try{
          artwork=beneath(statePath_.parent_path(),"inventory-artwork/"+id+"/"+item["version"].string());
          if(!fs::is_regular_file(artwork/"icon0.png"))atomicBytes(artwork/"icon0.png",packageResource(file,0x1200,16*1024*1024));
        }catch(const std::exception&){/* Metadata remains useful when artwork is absent. */}
        item.set("_artworkRoot",artwork.string());result.add(item);
      }catch(const std::exception& e){inventoryComplete_=false;std::fprintf(stderr,"Installed title %s: %s\n",id.c_str(),e.what());}
    }
  }catch(const std::exception&){inventoryComplete_=false;}
  return result;
}
}
