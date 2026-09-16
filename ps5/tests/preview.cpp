#include "../frontend/video.hpp"
#include <cassert>
int main(){storefront::PreviewDelay delay;assert(!delay.ready("a",100));assert(!delay.ready("a",5099));assert(delay.ready("a",5100));assert(!delay.ready("a",7000));assert(!delay.ready("b",7000));assert(!delay.ready("",12000));assert(!delay.ready("a",13000));assert(!delay.ready("a",17999));assert(delay.ready("a",18000));}
