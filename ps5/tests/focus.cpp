#include "../frontend/focus.hpp"
#include "../frontend/input.hpp"
#include <cassert>
int main() {
  using namespace storefront;
  Focus focus; focus.add("tab",0,{0,0,180,50}); focus.add("a",1,{0,120,200,200}); focus.add("b",1,{220,120,200,200}); focus.add("c",2,{0,380,200,200});
  focus.select("removed-card"); focus.ensure(); assert(focus.id()=="a");
  focus.select("a"); focus.move(Direction::Right); assert(focus.id()=="b"); focus.move(Direction::Down); assert(focus.id()=="c");
  focus.move(Direction::Up); assert(focus.id()=="b"); focus.move(Direction::Up); assert(focus.id()=="tab");
  focus.move(Direction::Left); assert(focus.id()=="tab"); focus.clear(); focus.add("fallback",0,{0,0,10,10}); focus.ensure(); assert(focus.id()=="fallback");
  std::string text="caf\xc3\xa9";eraseLastCharacter(text);assert(text=="caf");text+="\xf0\x9f\x8e\xae";eraseLastCharacter(text);assert(text=="caf");text.clear();eraseLastCharacter(text);assert(text.empty());
}
