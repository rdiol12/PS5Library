#pragma once
#include <algorithm>
#include <cmath>
#include <limits>
#include <string>
#include <unordered_map>
#include <vector>
namespace storefront {
enum class Direction { Up,Down,Left,Right };
struct FocusRect { float x,y,w,h; };
class Focus {
public:
  struct Entry { std::string id; int row; FocusRect rect; };
private:
  std::vector<Entry> entries_; std::string selected_;
  std::unordered_map<int,std::string> memory_;
public:
  void clear(){entries_.clear();}
  void add(std::string id,int row,FocusRect rect){entries_.push_back({std::move(id),row,rect});}
  const Entry* current()const { for(const auto& e:entries_)if(e.id==selected_)return &e;return nullptr; }
  void select(const std::string& id){selected_=id; if(auto* e=current())memory_[e->row]=id;}
  const std::string& id()const{return selected_;}
  void ensure(){if(!current()&&!entries_.empty()){auto content=std::find_if(entries_.begin(),entries_.end(),[](const Entry& e){return e.row>0;});select(content==entries_.end()?entries_.front().id:content->id);}}
  void move(Direction direction){
    ensure(); auto* from=current(); if(!from)return;
    const bool horizontal=direction==Direction::Left||direction==Direction::Right;
    const int sign=direction==Direction::Left||direction==Direction::Up?-1:1;
    int targetRow=from->row; float best=std::numeric_limits<float>::max(); const Entry* target=nullptr;
    if(!horizontal){int distance=100000;for(const auto& e:entries_){int d=(e.row-from->row)*sign;if(d>0&&d<distance){distance=d;targetRow=e.row;}}if(targetRow==from->row)return;
      if(auto found=memory_.find(targetRow);found!=memory_.end())for(const auto& e:entries_)if(e.row==targetRow&&e.id==found->second){select(e.id);return;}}
    for(const auto& e:entries_){if(e.id==from->id||e.row!=targetRow)continue;
      auto dx=(e.rect.x+e.rect.w/2)-(from->rect.x+from->rect.w/2);
      if(horizontal&&dx*sign<=0)continue; float score=std::abs(dx);
      if(score<best){best=score;target=&e;}}
    if(target)select(target->id);
  }
};
}
