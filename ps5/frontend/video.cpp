#include "video.hpp"
#include "../common/version.hpp"
#include <algorithm>
#include <cstring>
#include <curl/curl.h>
#include <regex>
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavformat/avformat.h>
#include <libswresample/swresample.h>
}
namespace storefront {
using namespace ps5library;
bool musicCodecSupported(int codec) {
  return codec == AV_CODEC_ID_AAC || codec == AV_CODEC_ID_ATRAC9;
}
namespace {
struct Decoder {
  AVFormatContext *format = nullptr;
  AVCodecContext *video = nullptr, *audio = nullptr;
  AVPacket *packet = av_packet_alloc();
  AVFrame *frame = av_frame_alloc();
  SwrContext *resampler = nullptr;
  ~Decoder() {
    swr_free(&resampler);
    av_frame_free(&frame);
    av_packet_free(&packet);
    avcodec_free_context(&audio);
    avcodec_free_context(&video);
    avformat_close_input(&format);
  }
};
void check(int result) {
  if (result < 0)
    throw std::runtime_error("Trailer decode failed");
}
bool streamAddress(const std::string &url) {
  static const std::regex allowed(
      R"(^https://[a-z0-9-]+(\.[a-z0-9-]+)*\.googlevideo\.com/[^\s]*$)");
  return url.size() < 8192 && std::regex_match(url, allowed);
}
// Seekable reader over one remote media address. Data is fetched in ranges as the demuxer asks
// for it and held only in memory.
class HttpSource {
  static constexpr int64_t chunkBytes = 2 * 1024 * 1024, totalLimit = 768LL * 1024 * 1024;
  std::string url_, ca_;
  std::function<bool()> abort_;
  std::vector<uint8_t> chunk_;
  int64_t chunkStart_ = 0, position_ = 0, size_ = -1, fetched_ = 0;
  void fetch(int64_t start) {
    if (fetched_ > totalLimit)
      throw std::runtime_error("Trailer stream too large");
    chunk_.clear();
    chunkStart_ = start;
    for (int hop = 0; hop < 4; hop++) {
      if (!streamAddress(url_))
        throw std::runtime_error("Unexpected trailer stream host");
      std::unique_ptr<CURL, void (*)(CURL *)> curl(curl_easy_init(), curl_easy_cleanup);
      if (!curl)
        throw std::bad_alloc();
      const auto range = std::to_string(start) + "-" + std::to_string(start + chunkBytes - 1);
      std::string contentRange;
      curl_easy_setopt(curl.get(), CURLOPT_URL, url_.c_str());
      curl_easy_setopt(curl.get(), CURLOPT_RANGE, range.c_str());
      curl_easy_setopt(curl.get(), CURLOPT_PROTOCOLS_STR, "https");
      curl_easy_setopt(curl.get(), CURLOPT_FOLLOWLOCATION, 0L);
      curl_easy_setopt(curl.get(), CURLOPT_CONNECTTIMEOUT, 10L);
      curl_easy_setopt(curl.get(), CURLOPT_LOW_SPEED_LIMIT, 4096L);
      curl_easy_setopt(curl.get(), CURLOPT_LOW_SPEED_TIME, 15L);
      curl_easy_setopt(curl.get(), CURLOPT_SSL_VERIFYPEER, 1L);
      curl_easy_setopt(curl.get(), CURLOPT_SSL_VERIFYHOST, 2L);
      curl_easy_setopt(curl.get(), CURLOPT_NOSIGNAL, 1L);
      curl_easy_setopt(curl.get(), CURLOPT_USERAGENT,
                       ("PS5Library/" + std::string(appVersion)).c_str());
      if (!ca_.empty())
        curl_easy_setopt(curl.get(), CURLOPT_CAINFO, ca_.c_str());
      curl_easy_setopt(curl.get(), CURLOPT_WRITEDATA, &chunk_);
      curl_easy_setopt(
          curl.get(), CURLOPT_WRITEFUNCTION,
          +[](char *data, size_t size, size_t count, void *target) -> size_t {
            auto &chunk = *static_cast<std::vector<uint8_t> *>(target);
            if (chunk.size() + size * count > static_cast<size_t>(chunkBytes))
              return 0;
            chunk.insert(chunk.end(), data, data + size * count);
            return size * count;
          });
      curl_easy_setopt(curl.get(), CURLOPT_HEADERDATA, &contentRange);
      curl_easy_setopt(
          curl.get(), CURLOPT_HEADERFUNCTION,
          +[](char *data, size_t size, size_t count, void *target) -> size_t {
            std::string line(data, size * count);
            std::string name = line.substr(0, 14);
            std::transform(name.begin(), name.end(), name.begin(), ::tolower);
            if (name == "content-range:")
              *static_cast<std::string *>(target) = line.substr(14);
            return size * count;
          });
      curl_easy_setopt(curl.get(), CURLOPT_NOPROGRESS, 0L);
      curl_easy_setopt(curl.get(), CURLOPT_XFERINFODATA, this);
      curl_easy_setopt(
          curl.get(), CURLOPT_XFERINFOFUNCTION,
          +[](void *data, curl_off_t, curl_off_t, curl_off_t, curl_off_t) -> int {
            return static_cast<HttpSource *>(data)->abort_() ? 1 : 0;
          });
      const auto result = curl_easy_perform(curl.get());
      long status = 0;
      curl_easy_getinfo(curl.get(), CURLINFO_RESPONSE_CODE, &status);
      if (result != CURLE_OK)
        throw std::runtime_error(abort_() ? "Request aborted" : "Trailer stream unavailable");
      if (status == 301 || status == 302 || status == 303 || status == 307 || status == 308) {
        char *next = nullptr;
        curl_easy_getinfo(curl.get(), CURLINFO_REDIRECT_URL, &next);
        if (!next)
          throw std::runtime_error("Trailer stream unavailable");
        url_ = next;
        chunk_.clear();
        continue;
      }
      if (status == 416) {
        chunk_.clear();
        return;
      }
      if (status != 206 && !(status == 200 && start == 0))
        throw std::runtime_error("Trailer stream refused (" + std::to_string(status) + ")");
      const auto slash = contentRange.rfind('/');
      if (slash != std::string::npos)
        size_ = std::strtoll(contentRange.c_str() + slash + 1, nullptr, 10);
      else if (status == 200)
        size_ = static_cast<int64_t>(chunk_.size());
      fetched_ += static_cast<int64_t>(chunk_.size());
      return;
    }
    throw std::runtime_error("Too many trailer stream redirects");
  }
  int read(uint8_t *buffer, int count) {
    if (size_ >= 0 && position_ >= size_)
      return AVERROR_EOF;
    if (chunk_.empty() || position_ < chunkStart_ ||
        position_ >= chunkStart_ + static_cast<int64_t>(chunk_.size()))
      fetch(position_);
    if (chunk_.empty())
      return AVERROR_EOF;
    const auto take =
        std::min<int64_t>(count, chunkStart_ + static_cast<int64_t>(chunk_.size()) - position_);
    std::memcpy(buffer, chunk_.data() + (position_ - chunkStart_), static_cast<size_t>(take));
    position_ += take;
    return static_cast<int>(take);
  }
  int64_t seek(int64_t offset, int whence) {
    if (whence & AVSEEK_SIZE) {
      if (size_ < 0)
        fetch(position_);
      return size_ >= 0 ? size_ : AVERROR(ENOSYS);
    }
    whence &= ~AVSEEK_FORCE;
    int64_t target = -1;
    if (whence == SEEK_SET)
      target = offset;
    else if (whence == SEEK_CUR)
      target = position_ + offset;
    else if (whence == SEEK_END && size_ >= 0)
      target = size_ + offset;
    if (target < 0)
      return AVERROR(EINVAL);
    return position_ = target;
  }

public:
  std::string error;
  void assign(std::string url, std::string ca, std::function<bool()> abort) {
    url_ = std::move(url);
    ca_ = std::move(ca);
    abort_ = std::move(abort);
  }
  // libav calls these from C; an exception must never cross that boundary.
  static int readCallback(void *opaque, uint8_t *buffer, int count) {
    auto *source = static_cast<HttpSource *>(opaque);
    try {
      return source->read(buffer, count);
    } catch (const std::exception &e) {
      source->error = e.what();
    } catch (...) {
      source->error = "Trailer stream failed";
    }
    return AVERROR(EIO);
  }
  static int64_t seekCallback(void *opaque, int64_t offset, int whence) {
    auto *source = static_cast<HttpSource *>(opaque);
    try {
      return source->seek(offset, whence);
    } catch (const std::exception &e) {
      source->error = e.what();
    } catch (...) {
      source->error = "Trailer stream failed";
    }
    return AVERROR(EIO);
  }
};
// One remote elementary stream: its reader, demuxer and decoder.
struct StreamInput {
  HttpSource source;
  AVIOContext *io = nullptr;
  AVFormatContext *format = nullptr;
  AVCodecContext *codec = nullptr;
  int index = -1;
  double time = 0;
  bool ended = false;
  [[noreturn]] void fail(const char *fallback) const {
    throw std::runtime_error(source.error.empty() ? fallback : source.error);
  }
  void open(const std::string &url, const std::string &ca, std::function<bool()> abort,
            AVMediaType type, int threads) {
    source.assign(url, ca, std::move(abort));
    auto *buffer = static_cast<unsigned char *>(av_malloc(65536));
    if (!buffer)
      throw std::bad_alloc();
    io = avio_alloc_context(buffer, 65536, 0, &source, HttpSource::readCallback, nullptr,
                            HttpSource::seekCallback);
    if (!io) {
      av_free(buffer);
      throw std::bad_alloc();
    }
    format = avformat_alloc_context();
    if (!format)
      throw std::bad_alloc();
    format->pb = io;
    format->flags |= AVFMT_FLAG_CUSTOM_IO;
    AVDictionary *options = nullptr;
    av_dict_set(&options, "enable_drefs", "0", 0);
    av_dict_set(&options, "probesize", "1048576", 0);
    av_dict_set(&options, "analyzeduration", "5000000", 0);
    const int opened = avformat_open_input(&format, nullptr, av_find_input_format("mov"), &options);
    av_dict_free(&options);
    if (opened < 0 || avformat_find_stream_info(format, nullptr) < 0)
      fail("Trailer stream could not be opened");
    index = av_find_best_stream(format, type, -1, -1, nullptr, 0);
    if (index < 0)
      fail("Trailer stream has no usable track");
    const auto *params = format->streams[index]->codecpar;
    const auto *decoder = avcodec_find_decoder(params->codec_id);
    if (!decoder)
      throw std::runtime_error("Missing decoder");
    codec = avcodec_alloc_context3(decoder);
    if (!codec)
      throw std::bad_alloc();
    check(avcodec_parameters_to_context(codec, params));
    codec->thread_count = threads;
    check(avcodec_open2(codec, decoder, nullptr));
  }
  ~StreamInput() {
    avcodec_free_context(&codec);
    avformat_close_input(&format);
    if (io) {
      av_freep(&io->buffer);
      avio_context_free(&io);
    }
  }
};
} // namespace
VideoPreview::VideoPreview(const fs::path &root, UiAudio &audio) : root_(root), audio_(audio) {
  fs::create_directories(root_);
  worker_ = std::thread([this] { worker(); });
}
VideoPreview::~VideoPreview() {
  stopping_ = true;
  generation_++;
  wake_.notify_all();
  if (worker_.joinable())
    worker_.join();
  audio_.preview(false);
  SDL_DestroyTexture(texture_);
}
void VideoPreview::stop() {
  if (!active_ && key_.empty())
    return;
  generation_++;
  wake_.notify_all();
  {
    std::lock_guard lock(mutex_);
    pending_ = false;
    pictures_.clear();
    sounds_.clear();
    ended_ = false;
  }
  active_ = clockStarted_ = false;
  key_.clear();
  audioEnd_ = 0;
  audio_.preview(false);
  SDL_DestroyTexture(texture_);
  texture_ = nullptr;
  width_ = height_ = 0;
}
void VideoPreview::start(const std::string &key, const Json &config, const std::string &token,
                         const Json &trailer, bool sound, bool music, bool offline,
                         const fs::path &local) {
  if (key == key_)
    return;
  stop();
  const auto hash = trailer["sha256"].string();
  auto size = trailer["size"].number();
  if (!local.empty() && !music)
    return;
  const auto url = trailer["url"].string();
  const bool agentMusic = music && url.rfind("/api/v1/agent/media/", 0) == 0;
  if (local.empty() &&
      (!std::regex_match(hash, std::regex("[a-f0-9]{64}")) || size <= 0 ||
       size > (music ? 8 : 128) * 1024 * 1024 ||
       (!agentMusic && url.rfind(music ? "/api/v1/music/" : "/api/v1/trailers/", 0) != 0)))
    return;
  key_ = key;
  active_ = true;
  sound_ = sound;
  music_ = music;
  if (music)
    musicStarts_++;
  else
    starts_++;
  {
    std::lock_guard lock(mutex_);
    error_.clear();
    request_ = {config.dump(), token,          trailer["url"].string(),
                hash,          local.string(), size,
                ++generation_, music,          offline};
    pending_ = true;
  }
  wake_.notify_all();
}
void VideoPreview::startStream(const std::string &key, const Json &config, const std::string &token,
                               const std::string &path, bool sound) {
  if (key == key_)
    return;
  stop();
  if (path.rfind("/api/v1/device/games/", 0) != 0)
    return;
  key_ = key;
  active_ = true;
  sound_ = sound;
  music_ = false;
  starts_++;
  {
    std::lock_guard lock(mutex_);
    error_.clear();
    request_ = {config.dump(), token, path, "", "", 0, ++generation_, false, false, true, sound};
    pending_ = true;
  }
  wake_.notify_all();
}
// Video and audio arrive as two separate remote streams. They are read alternately by timestamp,
// with audio kept slightly ahead so sound is already queued when its picture is shown.
void VideoPreview::decodeStream(const Request &request) {
  const auto abort = [this, generation = request.generation] { return cancelled(generation); };
  const auto config = Json::parse(request.config);
  Client client(config);
  client.credential = request.token;
  client.cancelled = abort;
  const auto info = client.request("GET", request.url);
  const auto videoUrl = info["video"]["url"].string(), audioUrl = info["audio"]["url"].string();
  if (!streamAddress(videoUrl) || (request.sound && !streamAddress(audioUrl)))
    throw std::runtime_error("Trailer stream unavailable");
  const auto ca = config["caBundle"].string();
  const auto limit = mediaDurationLimit(false);
  Decoder d;
  if (!d.frame || !d.packet)
    throw std::bad_alloc();
  StreamInput video, audio;
  video.open(videoUrl, ca, abort, AVMEDIA_TYPE_VIDEO, 4);
  const auto *vp = video.format->streams[video.index]->codecpar;
  if (vp->codec_id != AV_CODEC_ID_H264 || vp->width <= 0 || vp->height <= 0 || vp->width > 1920 ||
      vp->height > 1080 || vp->width % 2 || vp->height % 2 || video.format->duration <= 0 ||
      video.format->duration > limit * AV_TIME_BASE)
    throw std::runtime_error("Unsupported trailer stream (width=" + std::to_string(vp->width) +
                             ", height=" + std::to_string(vp->height) +
                             ", duration=" + std::to_string(video.format->duration) + ")");
  if (request.sound) {
    audio.open(audioUrl, ca, abort, AVMEDIA_TYPE_AUDIO, 1);
    const auto *ap = audio.format->streams[audio.index]->codecpar;
    if (ap->codec_id != AV_CODEC_ID_AAC || ap->sample_rate < 8000 || ap->sample_rate > 48000 ||
        ap->ch_layout.nb_channels != 2)
      throw std::runtime_error("Unsupported trailer stream audio");
    AVChannelLayout stereo = AV_CHANNEL_LAYOUT_STEREO;
    check(swr_alloc_set_opts2(&d.resampler, &stereo, AV_SAMPLE_FMT_S16, 48000,
                              &audio.codec->ch_layout, audio.codec->sample_fmt,
                              audio.codec->sample_rate, 0, nullptr));
    check(swr_init(d.resampler));
  } else {
    audio.ended = true;
  }
  const auto drain = [&](StreamInput &input, bool picture) {
    int result;
    while (!abort() && (result = avcodec_receive_frame(input.codec, d.frame)) >= 0) {
      auto *f = d.frame;
      const double pts =
          f->best_effort_timestamp == AV_NOPTS_VALUE
              ? input.time
              : std::max(0., f->best_effort_timestamp *
                                 av_q2d(input.format->streams[input.index]->time_base));
      if (pts > limit)
        throw std::runtime_error("Invalid media timestamp");
      if (picture) {
        if ((f->format != AV_PIX_FMT_YUV420P && f->format != AV_PIX_FMT_YUVJ420P) ||
            f->width != vp->width || f->height != vp->height)
          throw std::runtime_error("Unsupported trailer frame");
        Picture next{f->width, f->height, pts, std::vector<uint8_t>(f->width * f->height * 3 / 2)};
        size_t offset = 0;
        for (int plane = 0; plane < 3; plane++) {
          const int w = f->width / (plane ? 2 : 1), h = f->height / (plane ? 2 : 1);
          for (int y = 0; y < h; y++) {
            std::memcpy(next.pixels.data() + offset, f->data[plane] + y * f->linesize[plane], w);
            offset += w;
          }
        }
        std::unique_lock lock(mutex_);
        wake_.wait(lock, [&] { return abort() || pictures_.size() < 4; });
        if (abort())
          return;
        pictures_.push_back(std::move(next));
        decoded_++;
      } else {
        if (f->nb_samples <= 0 || f->nb_samples > 8192)
          throw std::runtime_error("Invalid audio frame");
        const int capacity = swr_get_out_samples(d.resampler, f->nb_samples) + 64;
        Sound sound{pts, std::vector<Sint16>(static_cast<size_t>(capacity) * 2)};
        uint8_t *output = reinterpret_cast<uint8_t *>(sound.samples.data());
        const int count =
            swr_convert(d.resampler, &output, capacity,
                        const_cast<const uint8_t **>(f->extended_data), f->nb_samples);
        check(count);
        sound.samples.resize(static_cast<size_t>(count) * 2);
        std::unique_lock lock(mutex_);
        wake_.wait(lock, [&] { return abort() || sounds_.size() < 32; });
        if (abort())
          return;
        sounds_.push_back(std::move(sound));
      }
      av_frame_unref(f);
    }
    if (!abort() && result != AVERROR(EAGAIN) && result != AVERROR_EOF)
      check(result);
  };
  while (!abort() && (!video.ended || !audio.ended)) {
    const bool picture = audio.ended || (!video.ended && video.time + .3 <= audio.time);
    auto &input = picture ? video : audio;
    if (av_read_frame(input.format, d.packet) < 0) {
      if (!input.source.error.empty())
        throw std::runtime_error(input.source.error);
      input.ended = true;
      check(avcodec_send_packet(input.codec, nullptr));
      drain(input, picture);
      continue;
    }
    if (d.packet->stream_index == input.index) {
      const auto stamp = d.packet->dts != AV_NOPTS_VALUE ? d.packet->dts : d.packet->pts;
      if (stamp != AV_NOPTS_VALUE)
        input.time =
            std::max(input.time, stamp * av_q2d(input.format->streams[input.index]->time_base));
      check(avcodec_send_packet(input.codec, d.packet));
      drain(input, picture);
    }
    av_packet_unref(d.packet);
  }
}
void VideoPreview::worker() {
  for (;;) {
    Request request;
    {
      std::unique_lock lock(mutex_);
      wake_.wait(lock, [&] { return stopping_ || pending_; });
      if (stopping_)
        return;
      request = request_;
      pending_ = false;
    }
    const auto local = !request.local.empty();
    const bool unsaved = local || request.stream;
    const fs::path file = request.stream ? fs::path()
                          : local        ? fs::path(request.local)
                                         : root_ / (request.hash + ".mp4"),
                   part = unsaved ? fs::path() : root_ / (request.hash + ".part");
    std::string error;
    try {
      // ponytail: PS5 native sandboxes support known files, not cache
      // enumeration or metadata mutation; add a persisted index only if cache
      // pressure becomes material.
      const auto abort = [&] { return cancelled(request.generation); };
      if (request.stream) {
        decodeStream(request);
      } else if (local) {
        auto status = fs::symlink_status(file);
        if (fs::is_symlink(status) || !fs::is_regular_file(status) || !fs::file_size(file) ||
            fs::file_size(file) > 8 * 1024 * 1024)
          throw std::runtime_error("Unsupported local game music");
      } else if (!fs::exists(file) || fs::file_size(file) != static_cast<uintmax_t>(request.size) ||
                 fileHash(file, abort) != request.hash) {
        fs::remove(file);
        const bool agent = request.url.rfind("/api/v1/agent/media/", 0) == 0;
        if (request.offline && !agent)
          throw std::runtime_error("Preview is not cached for offline use");
        Client client(
            agent ? Json::object({{"serverUrl", localAgentUrl()}, {"allowInsecureLan", true}})
                  : Json::parse(request.config));
        client.credential = agent ? localAgentCredential : request.token;
        client.cancelled = abort;
        client.download(request.url, part, request.size, request.hash, [](int64_t, int64_t) {});
        if (abort())
          continue;
        fs::rename(part, file);
      }
      if (!request.stream && !abort()) {
        double offset = 0;
        do {
          offset = decode(file, request.generation, request.music, offset);
        } while (request.music && !abort());
      }
    } catch (const std::exception &e) {
      error = e.what();
      if (!cancelled(request.generation) && !part.empty()) {
        std::error_code ignored;
        fs::remove(part, ignored);
      }
    } catch (...) {
      error = "Unknown preview error";
    }
    {
      std::lock_guard lock(mutex_);
      if (!cancelled(request.generation)) {
        ended_ = true;
        error_ = error;
      }
    }
    wake_.notify_all();
  }
}
double VideoPreview::decode(const fs::path &file, uint64_t generation, bool music, double offset) {
  Decoder d;
  if (!d.frame || !d.packet)
    throw std::bad_alloc();
  AVDictionary *options = nullptr;
  av_dict_set(&options, "protocol_whitelist", "file", 0);
  av_dict_set(&options, "enable_drefs", "0", 0);
  av_dict_set(&options, "probesize", "1048576", 0);
  av_dict_set(&options, "analyzeduration", "5000000", 0);
  int opened = avformat_open_input(&d.format, file.c_str(),
                                   music ? nullptr : av_find_input_format("mov"), &options);
  av_dict_free(&options);
  check(opened);
  check(avformat_find_stream_info(d.format, nullptr));
  const int vi = av_find_best_stream(d.format, AVMEDIA_TYPE_VIDEO, -1, -1, nullptr, 0),
            ai = av_find_best_stream(d.format, AVMEDIA_TYPE_AUDIO, -1, -1, nullptr, 0);
  if (music)
    check(ai);
  else
    check(vi);
  const auto *vp = vi >= 0 ? d.format->streams[vi]->codecpar : nullptr;
  const auto durationLimit = mediaDurationLimit(music);
  if ((music ? vi >= 0
             : vp->codec_id != AV_CODEC_ID_H264 || vp->width <= 0 || vp->height <= 0 ||
                   vp->width > 1280 || vp->height > 720 || vp->width % 2 || vp->height % 2) ||
      d.format->duration <= 0 || d.format->duration > durationLimit * AV_TIME_BASE)
    throw std::runtime_error("Unsupported media (music=" + std::to_string(music) +
                             ", video=" + std::to_string(vi) +
                             ", codec=" + std::to_string(vp ? vp->codec_id : -1) +
                             ", width=" + std::to_string(vp ? vp->width : 0) +
                             ", height=" + std::to_string(vp ? vp->height : 0) +
                             ", duration=" + std::to_string(d.format->duration) + ")");
  auto open = [&](int index, AVCodecContext *&context) {
    const auto *params = d.format->streams[index]->codecpar;
    auto *codec = avcodec_find_decoder(params->codec_id);
    if (!codec)
      throw std::runtime_error("Missing decoder");
    context = avcodec_alloc_context3(codec);
    if (!context)
      throw std::bad_alloc();
    check(avcodec_parameters_to_context(context, params));
    context->thread_count = 2;
    check(avcodec_open2(context, codec, nullptr));
  };
  if (vi >= 0)
    open(vi, d.video);
  double end = offset;
  if (ai >= 0) {
    auto *p = d.format->streams[ai]->codecpar;
    if ((music ? !musicCodecSupported(p->codec_id) : p->codec_id != AV_CODEC_ID_AAC) ||
        p->sample_rate != 48000 || p->ch_layout.nb_channels != 2)
      throw std::runtime_error("Unsupported preview audio");
    open(ai, d.audio);
    AVChannelLayout stereo = AV_CHANNEL_LAYOUT_STEREO;
    check(swr_alloc_set_opts2(&d.resampler, &stereo, AV_SAMPLE_FMT_S16, 48000, &d.audio->ch_layout,
                              d.audio->sample_fmt, d.audio->sample_rate, 0, nullptr));
    check(swr_init(d.resampler));
  }
  auto receive = [&](AVCodecContext *context, int index) {
    int result;
    while (!cancelled(generation) && (result = avcodec_receive_frame(context, d.frame)) >= 0) {
      auto *f = d.frame;
      double pts = f->best_effort_timestamp == AV_NOPTS_VALUE
                       ? 0
                       : std::max(0., f->best_effort_timestamp *
                                          av_q2d(d.format->streams[index]->time_base));
      if (pts > durationLimit)
        throw std::runtime_error("Invalid media timestamp");
      pts += offset;
      if (index == vi) {
        if (f->format != AV_PIX_FMT_YUV420P || f->width != vp->width || f->height != vp->height)
          throw std::runtime_error("Unsupported trailer frame");
        Picture picture{f->width, f->height, pts,
                        std::vector<uint8_t>(f->width * f->height * 3 / 2)};
        size_t offset = 0;
        for (int plane = 0; plane < 3; plane++) {
          int w = f->width / (plane ? 2 : 1), h = f->height / (plane ? 2 : 1);
          for (int y = 0; y < h; y++) {
            std::memcpy(picture.pixels.data() + offset, f->data[plane] + y * f->linesize[plane], w);
            offset += w;
          }
        }
        std::unique_lock lock(mutex_);
        wake_.wait(lock, [&] { return cancelled(generation) || pictures_.size() < 4; });
        if (cancelled(generation))
          return;
        pictures_.push_back(std::move(picture));
        decoded_++;
      } else {
        if (f->nb_samples <= 0 || f->nb_samples > 8192)
          throw std::runtime_error("Invalid audio frame");
        Sound sound{pts, std::vector<Sint16>((f->nb_samples + 256) * 2)};
        uint8_t *output = reinterpret_cast<uint8_t *>(sound.samples.data());
        int count = swr_convert(d.resampler, &output, static_cast<int>(sound.samples.size() / 2),
                                const_cast<const uint8_t **>(f->extended_data), f->nb_samples);
        check(count);
        sound.samples.resize(count * 2);
        end = std::max(end, pts + count / 48000.);
        std::unique_lock lock(mutex_);
        wake_.wait(lock, [&] { return cancelled(generation) || sounds_.size() < 32; });
        if (cancelled(generation))
          return;
        sounds_.push_back(std::move(sound));
      }
      av_frame_unref(f);
    }
    if (!cancelled(generation) && result != AVERROR(EAGAIN) && result != AVERROR_EOF)
      check(result);
  };
  while (!cancelled(generation) && av_read_frame(d.format, d.packet) >= 0) {
    auto *context = d.packet->stream_index == vi   ? d.video
                    : d.packet->stream_index == ai ? d.audio
                                                   : nullptr;
    if (context) {
      check(avcodec_send_packet(context, d.packet));
      receive(context, d.packet->stream_index);
    }
    av_packet_unref(d.packet);
  }
  if (!cancelled(generation)) {
    if (d.video) {
      check(avcodec_send_packet(d.video, nullptr));
      receive(d.video, vi);
    }
    if (d.audio) {
      check(avcodec_send_packet(d.audio, nullptr));
      receive(d.audio, ai);
    }
    if (music && end <= offset)
      throw std::runtime_error("Empty music");
  }
  return end;
}
SDL_Texture *VideoPreview::frame(SDL_Renderer *renderer) {
  if (!active_)
    return nullptr;
  std::unique_lock lock(mutex_);
  if (!clockStarted_ && (music_ ? !sounds_.empty() : !pictures_.empty())) {
    clockStarted_ = true;
    started_ = SDL_GetTicks64();
    lastPts_ = music_ ? sounds_.front().pts : pictures_.front().pts;
    audio_.preview(true, music_);
  }
  if (!clockStarted_) {
    if (ended_) {
      lock.unlock();
      stop();
    }
    return nullptr;
  }
  double elapsed = lastPts_ + (SDL_GetTicks64() - started_) / 1000.;
  // Audio consumption is the clock while samples are queued; wall time covers
  // silent clips and their tail.
  if (sound_ && audio_.queued())
    elapsed = std::max(0., audioEnd_ - audio_.queued() / 192000.);
  while (!sounds_.empty() && sounds_.front().pts <= elapsed + .15 && audio_.queued() < 24000) {
    auto sound = std::move(sounds_.front());
    sounds_.pop_front();
    if (sound_ && sound.pts + sound.samples.size() / 96000. >= elapsed - .1 &&
        audio_.pcm(sound.samples.data(), sound.samples.size())) {
      if (music_)
        musicBytes_ += sound.samples.size() * 2;
      else
        audioBytes_ += sound.samples.size() * 2;
      audioEnd_ = sound.pts + sound.samples.size() / 96000.;
    }
  }
  Picture picture{};
  bool ready = false;
  while (!pictures_.empty() && pictures_.front().pts <= elapsed + .015) {
    picture = std::move(pictures_.front());
    pictures_.pop_front();
    ready = true;
  }
  const bool finished = ended_ && pictures_.empty() && sounds_.empty() && !audio_.queued() &&
                        elapsed > audioEnd_ + .15;
  lock.unlock();
  wake_.notify_all();
  if (ready) {
    if (!texture_ || width_ != picture.width || height_ != picture.height) {
      SDL_DestroyTexture(texture_);
      width_ = picture.width;
      height_ = picture.height;
      texture_ = SDL_CreateTexture(renderer, SDL_PIXELFORMAT_IYUV, SDL_TEXTUREACCESS_STREAMING,
                                   width_, height_);
    }
    if (texture_) {
      auto *p = picture.pixels.data();
      SDL_UpdateYUVTexture(texture_, nullptr, p, width_, p + width_ * height_, width_ / 2,
                           p + width_ * height_ * 5 / 4, width_ / 2);
      displayed_++;
    }
  }
  if (finished) {
    stop();
    return nullptr;
  }
  return texture_;
}
} // namespace storefront
