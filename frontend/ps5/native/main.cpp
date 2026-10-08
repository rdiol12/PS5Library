#include <cstdint>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
#include <string>
#include <stdexcept>
#include <thread>
#include <vector>
#include <csignal>
#include <cerrno>
#include <array>
#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <SDL.h>
#ifdef PS5LIBRARY_NATIVE_TARGET
#include <pthread.h>
#include <ucontext.h>
static pthread_t nativeMainThread{};
#endif

extern "C" long _write(int, const void*, unsigned long);
static volatile sig_atomic_t nativeStage = 0;
#ifdef PS5LIBRARY_NATIVE_DIAGNOSTIC
#ifndef PS5LIBRARY_NATIVE_DIAGNOSTIC_ROOT
#define PS5LIBRARY_NATIVE_DIAGNOSTIC_ROOT "/download0"
#endif
static constexpr char nativeTracePath[] = PS5LIBRARY_NATIVE_DIAGNOSTIC_ROOT "/ps5library-native-stage.bin";
static constexpr char nativeFaultPath[] = PS5LIBRARY_NATIVE_DIAGNOSTIC_ROOT "/ps5library-native-fault.bin";
static constexpr std::uint32_t nativeTraceMagic = 0x354c504e;
static constexpr std::size_t nativeTraceCapacity = 8192;
struct NativeTraceRecord { std::uint32_t magic;std::int32_t stage;std::uint64_t sequence,checksum; };
static_assert(sizeof(NativeTraceRecord)==24);
static volatile sig_atomic_t nativeTraceDescriptor = -1;
static std::uint64_t nativeTraceSequence = 0;
static unsigned nativeTraceFrames = 0;
static constexpr std::uint64_t nativeTraceChecksum(std::int32_t stage,std::uint64_t sequence) {
    return 0x71545350354c4942ULL ^ (static_cast<std::uint64_t>(static_cast<std::uint32_t>(stage)) << 32) ^ sequence;
}
static bool nativeTraceWrite(int descriptor,const void* data,std::size_t size) {
    return _write(descriptor,data,size)==static_cast<long>(size);
}
static void nativeTraceOpen() {
    if(nativeTraceDescriptor>=0)return;
    nativeTraceDescriptor=open(nativeTracePath,O_CREAT|O_WRONLY|O_APPEND,0644);
}
static void nativeTraceSync(){const int descriptor=nativeTraceDescriptor;if(descriptor>=0)fsync(descriptor);}
static void nativeTraceClose(){const int descriptor=nativeTraceDescriptor;nativeTraceDescriptor=-1;if(descriptor>=0){fsync(descriptor);close(descriptor);}}
static void nativeTraceRecord(int stage) {
    nativeTraceOpen();
    if(nativeTraceSequence>=nativeTraceCapacity){nativeTraceClose();if(unlink(nativeTracePath)!=0&&errno!=ENOENT)return;nativeTraceSequence=0;nativeTraceOpen();}
    const int descriptor=nativeTraceDescriptor;if(descriptor<0)return;
    const auto sequence=nativeTraceSequence+1;const NativeTraceRecord record{nativeTraceMagic,stage,sequence,nativeTraceChecksum(stage,sequence)};
    if(nativeTraceWrite(descriptor,&record,sizeof(record)))nativeTraceSequence=sequence;else nativeTraceClose();
    if(stage==181&&++nativeTraceFrames==15){nativeTraceFrames=0;nativeTraceSync();}
}
#endif
extern "C" void native_stage(int stage) {
    nativeStage = stage;
#ifdef PS5LIBRARY_NATIVE_DIAGNOSTIC
    nativeTraceRecord(stage);
#endif
}
extern "C" void native_error(const char* message) {
#if defined(PS5LIBRARY_NATIVE_PROBE) || defined(PS5LIBRARY_NATIVE_DIAGNOSTIC)
    constexpr mode_t permissions=0644;
#else
    constexpr mode_t permissions=0600;
#endif
    const int fd = open("/download0/ps5library-native-error.txt", O_CREAT|O_TRUNC|O_WRONLY|O_NOFOLLOW, permissions);
    if (fd < 0) return;
    fchmod(fd, permissions);
    unsigned long size = 0;
    while (size < 4096 && message[size]) ++size;
    _write(fd, message, size);
    close(fd);
}
extern "C" void native_trace(int stage) {
#ifdef PS5LIBRARY_NATIVE_PROBE
    const int fd = open("/download0/ps5library-native-stage.bin", O_CREAT|O_APPEND|O_WRONLY, 0644);
    if (fd < 0) return;
    fchmod(fd, 0644);
    const std::uint32_t entry[] = {0x354c504e, static_cast<std::uint32_t>(stage)};
    _write(fd, entry, sizeof(entry));
    close(fd);
#else
    (void)stage;
#endif
}

int storefront_main(int, char**);
struct NativeLaunchContext { std::uint32_t size,user,options;std::uint64_t crashReport;std::uint32_t checkFlag; };
static_assert(sizeof(NativeLaunchContext)==32);
extern "C" int sceUserServiceGetForegroundUser(std::uint32_t*);
extern "C" int sceSystemServiceLaunchApp(const char*,char**,NativeLaunchContext*);
extern "C" int sceSystemServiceNavigateToGoHome();
extern "C" int ps5library_native_launch(const char* title) {
    const std::string id=title?title:"";
    if(id.size()!=9||(id.compare(0,4,"PPSA")&&id.compare(0,4,"CUSA"))||
       !std::all_of(id.begin()+4,id.end(),[](char value){return value>='0'&&value<='9';})) return -EINVAL;
    NativeLaunchContext context{};context.size=sizeof(context);
    const int user=sceUserServiceGetForegroundUser(&context.user);if(user)return user;
    char* arguments[]={nullptr};return sceSystemServiceLaunchApp(id.c_str(),arguments,&context);
}
extern "C" int __real_sceUserServiceInitialize(const void*);
extern "C" int __wrap_sceUserServiceInitialize(const void* value) {
    native_trace(20);
    const int result = __real_sceUserServiceInitialize(value);
    native_trace(21); native_trace(result);
    return result;
}
extern "C" int __wrap_sceKeyboardInit() {
    native_trace(30);
    // This optional USB-keyboard initializer faults in this native 4.51 title.
    // Report it unavailable; SDL's controller and IME paths remain separate.
    errno = ENOSYS;
    const int result = -1;
    native_trace(31); native_trace(result);
    return result;
}
extern "C" int __wrap_sceKeyboardOpen(int, int, int, void*) {
    errno = ENOSYS;
    return -1;
}
extern "C" int __real_sceImeDialogInit(const void*, void*);
extern "C" int __real_sceImeDialogGetStatus();
extern "C" int sceImeDialogAbort();
extern "C" int sceCommonDialogInitialize();
extern "C" int sceSysmoduleLoadModule(std::uint16_t);
static int prepareDialog() {
    static int result = [] {
        // Pinned ProsperoTV src/iptv_ime.c::iptv_ime_init.
        native_trace(50);
        int status = sceCommonDialogInitialize();
        native_trace(51); native_trace(status);
        if (status < 0 && static_cast<std::uint32_t>(status) != 0x80b80002u) return status;
        status = sceSysmoduleLoadModule(0x0096);
        native_trace(52); native_trace(status);
        return status;
    }();
    return result;
}
extern "C" int __wrap_sceImeDialogInit(const void* parameter, void* reserved) {
    native_trace(40);
    const int prepared = prepareDialog();
    if (prepared < 0) return prepared;
    const int result = __real_sceImeDialogInit(parameter, reserved);
    native_trace(41); native_trace(result);
    return result;
}
extern "C" int __wrap_sceImeDialogGetStatus() {
    static bool first = true;
    if (first) native_trace(42);
    if (prepareDialog() < 0) return 0; // No dialog exists when its module is unavailable.
    const int result = __real_sceImeDialogGetStatus();
    if (first) { native_trace(43); native_trace(result); first = false; }
    return result;
}
extern "C" int sceSystemServiceGetStatus(void*);
extern "C" int sceNetInit();
extern "C" int sceNetPoolCreate(const char*, int, int);
extern "C" int sceNetPoolDestroy(int);
extern "C" int __real_fcntl(int, int, ...);
extern "C" int __wrap_fcntl(int descriptor, int command, ...) {
    if (command == F_SETFD) {
        va_list arguments; va_start(arguments, command);
        const int flags = va_arg(arguments, int); va_end(arguments);
        if (flags == FD_CLOEXEC) return 0;
        return __real_fcntl(descriptor, command, flags);
    }
    if (command == F_SETFL) {
        va_list arguments; va_start(arguments, command);
        const int flags = va_arg(arguments, int); va_end(arguments);
        return __real_fcntl(descriptor, command, flags);
    }
    return __real_fcntl(descriptor, command);
}
extern "C" int __real_SDL_PollEvent(SDL_Event*);
#ifdef PS5LIBRARY_NATIVE_PROBE
extern "C" void __real_SDL_RenderPresent(SDL_Renderer*);
static std::uint64_t presented = 0;
static Uint32 lifecycleStart = 0;
static void lifecycleRecord(unsigned event, int result, unsigned state) {
    const std::uint64_t entry[] = {0x4e4c5053, event, SDL_GetTicks() - lifecycleStart,
        presented, static_cast<std::uint32_t>(result), state};
    const int fd = open("/download0/ps5library-native-lifecycle.bin", O_CREAT|O_APPEND|O_WRONLY, 0644);
    if (fd < 0) return;
    fchmod(fd, 0644); _write(fd, entry, sizeof(entry)); close(fd);
}
extern "C" void __wrap_SDL_RenderPresent(SDL_Renderer* renderer) {
    __real_SDL_RenderPresent(renderer);
    ++presented;
}
#endif
extern "C" int __wrap_SDL_PollEvent(SDL_Event* event) {
#ifdef PS5LIBRARY_NATIVE_PROBE
    static bool background = false;
    static Uint32 lastSample = 0;
    const auto now = SDL_GetTicks();
    static bool started = false, homeSent = false;
    if (!started) { lifecycleStart = now; started = true; }
    if (!homeSent && now - lifecycleStart >= 2000) {
        // Dismiss only this app's input dialog before the bounded Home test.
        if (prepareDialog() >= 0 && __real_sceImeDialogGetStatus() > 0)
            lifecycleRecord(3, sceImeDialogAbort(), 0);
        lifecycleRecord(2, sceSystemServiceNavigateToGoHome(), 0);
        homeSent = true;
    }
    if (!lastSample || now - lastSample >= 100) {
        lastSample = now;
        // Experimental 4.51 ABI: ignore unknown samples because this optional
        // lifecycle hint must never terminate the storefront.
        alignas(8) std::array<unsigned char, 16384> status{};
        std::fill(status.begin() + 136, status.end(), 0xa5);
        const int result = sceSystemServiceGetStatus(status.data());
        const bool intact = std::all_of(status.begin() + 136, status.end(), [](auto byte) { return byte == 0xa5; });
#ifdef PS5LIBRARY_NATIVE_PROBE
        lifecycleRecord(1, result, status[4] | (status[5] << 8));
#endif
        if (intact && result == 0 && status[5] <= 1 && background != (status[5] != 0)) {
            background = status[5] != 0;
            SDL_Event changed{};
            changed.type = background ? SDL_APP_DIDENTERBACKGROUND : SDL_APP_DIDENTERFOREGROUND;
            SDL_PushEvent(&changed);
        }
    }
#endif
    return __real_SDL_PollEvent(event);
}
#ifdef PS5LIBRARY_NATIVE_PROBE
static void fault(int signal) {
    native_trace(9000 + signal);
    for (;;) usleep(100000);
}
#else
#ifdef PS5LIBRARY_NATIVE_TARGET
static void fault(int signal, siginfo_t *info, void *raw_context) {
    const auto *context = static_cast<const ucontext_t *>(raw_context);
    // Sony's FreeBSD signal frame prefixes the exposed mcontext storage with
    // 48 bytes. Reading uc_mcontext directly returns the prefix, not registers.
    const auto *machine = context ? reinterpret_cast<const mcontext_t *>(
        reinterpret_cast<const char *>(&context->uc_mcontext) + 48) : nullptr;
    struct FaultRecord {
        std::uint32_t magic, signal, stage, pid, code, trap;
        std::uint64_t rip, rax, address, handler, thread, mainThread;
    } record{0x544c4650, static_cast<std::uint32_t>(signal), static_cast<std::uint32_t>(nativeStage),
             static_cast<std::uint32_t>(getpid()), static_cast<std::uint32_t>(info ? info->si_code : 0),
             machine ? machine->mc_trapno : 0,
             machine ? static_cast<std::uint64_t>(machine->mc_rip) : 0,
             machine ? static_cast<std::uint64_t>(machine->mc_rax) : 0,
             info ? reinterpret_cast<std::uint64_t>(info->si_addr) : 0,
             reinterpret_cast<std::uint64_t>(&fault),
             reinterpret_cast<std::uint64_t>(pthread_self()),
             reinterpret_cast<std::uint64_t>(nativeMainThread)};
    static_assert(sizeof(FaultRecord)==72);
#ifdef PS5LIBRARY_NATIVE_DIAGNOSTIC
    static volatile sig_atomic_t handling = 0;if(handling)_exit(128+signal);handling=1;
    nativeTraceSync();
    const int descriptor=open(nativeFaultPath,O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW,0644);
    if(descriptor>=0){fchmod(descriptor,0644);_write(descriptor,&record,sizeof(record));fsync(descriptor);close(descriptor);}
    timespec delay{0,300000000};while(nanosleep(&delay,&delay)<0&&errno==EINTR){}
    _exit(128+signal);
#else
    const int fd = open("/download0/ps5library-native-fault.bin", O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW, 0644);
    if (fd >= 0) { fchmod(fd, 0644); _write(fd, &record, sizeof(record)); close(fd); }
    _exit(128 + signal);
#endif
}
#else
static void fault(int signal) {
    const int fd = open("/download0/ps5library-native-fault.bin", O_CREAT|O_EXCL|O_WRONLY|O_NOFOLLOW, 0644);
    if (fd >= 0) {
        fchmod(fd, 0644);
        const std::uint32_t record[] = {0x544c4650, static_cast<std::uint32_t>(signal), static_cast<std::uint32_t>(nativeStage), static_cast<std::uint32_t>(getpid())};
        _write(fd, record, sizeof(record));
        close(fd);
    }
    _exit(128 + signal);
}
#endif
#endif
int main() {
#ifdef PS5LIBRARY_NATIVE_TARGET
    nativeMainThread=pthread_self();
#endif
#ifdef PS5LIBRARY_NATIVE_PROBE
    native_trace(10);
    std::vector<std::string> values(4, "PS5Library native runtime");
    if (values.at(3) != values.at(0)) return 1;
    native_trace(11);
    try { throw std::runtime_error("native exception check"); }
    catch (const std::exception& error) {
        if (std::string(error.what()) != "native exception check") return 2;
    }
    native_trace(12);
    int threaded = 0;
    std::thread worker([&] { threaded = 1; });
    worker.join();
    if (threaded != 1) return 3;
    native_trace(13);
    std::signal(SIGSEGV, fault);
    char name[] = "ps5library";
    char config[] = "/download0/ps5library/config.json";
    char frames[] = "--frames=180";
    char capture[] = "--capture=/download0/ps5library-storefront.bmp";
    char script[] = "--script=back";
    char* args[] = {name, config, frames, capture, script, nullptr};
    const int result = storefront_main(5, args);
    lifecycleRecord(4, result, 0);
    native_trace(100 + result);
    return result;
#else
#ifdef PS5LIBRARY_NATIVE_DIAGNOSTIC
    unlink(nativeFaultPath);unlink(nativeTracePath);nativeTraceSequence=0;nativeTraceOpen();native_stage(0);nativeTraceSync();
#else
    unlink("/download0/ps5library-native-fault.bin");
#endif
#ifdef PS5LIBRARY_NATIVE_TARGET
    struct sigaction action{}; action.sa_sigaction = fault; action.sa_flags = SA_SIGINFO; sigemptyset(&action.sa_mask);
    for (int signal : {SIGSEGV, SIGABRT, SIGBUS, SIGILL, SIGFPE, SIGSYS}) sigaction(signal, &action, nullptr);
#else
    for (int signal : {SIGSEGV, SIGABRT, SIGBUS, SIGILL, SIGFPE, SIGSYS}) std::signal(signal, fault);
#endif
    native_error("");
    const int network = sceNetInit();
    if (network < 0) {
        char error[96];
        std::snprintf(error, sizeof(error), "Native network initialization failed: %#x", network);
        native_error(error);
    }
    const int networkPool = network < 0 ? network : sceNetPoolCreate("PS5Library", 5 * 1024 * 1024, 0);
    if (networkPool < 0) {
        char error[96];
        std::snprintf(error, sizeof(error), "Native network pool failed: %#x", networkPool);
        native_error(error);
    }
    char name[] = "ps5library";
#ifdef PS5LIBRARY_TAB_STRESS
    std::string script = "--script=next";
    for (int i = 1; i < 1800; ++i) script += ",next";
    char* args[] = {name, script.data(), nullptr};
    const int result = storefront_main(2, args);
#else
    char* args[] = {name, nullptr};
    const int result = storefront_main(1, args);
#endif
    if (networkPool >= 0) sceNetPoolDestroy(networkPool);
#ifdef PS5LIBRARY_NATIVE_DIAGNOSTIC
    nativeTraceClose();
#endif
    return result;
#endif
}

#ifdef PS5LIBRARY_NATIVE_PROBE
extern "C" void catchReturnFromMain(int status) {
    native_trace(200 + status);
    // Bounded deployment helper closes this exact test title and restores the
    // released storefront. Preserve the native process for receipt collection.
    for (;;) usleep(100000);
}
#endif
