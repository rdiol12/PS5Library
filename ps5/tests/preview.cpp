#include "../frontend/video.hpp"
#include <cassert>
extern "C" {
#include <libavcodec/codec_id.h>
}
int main(){storefront::PreviewDelay delay;assert(!delay.ready("a",100));assert(!delay.ready("a",4099));assert(delay.ready("a",4100));assert(!delay.ready("a",7000));assert(!delay.ready("b",7000));assert(!delay.ready("",12000));assert(!delay.ready("a",13000));assert(!delay.ready("a",16999));assert(delay.ready("a",17000));assert(storefront::musicCodecSupported(AV_CODEC_ID_AAC));assert(storefront::musicCodecSupported(AV_CODEC_ID_ATRAC9));assert(!storefront::musicCodecSupported(AV_CODEC_ID_H264));assert(storefront::mediaDurationLimit(false)==181);assert(storefront::mediaDurationLimit(true)>=189);}
