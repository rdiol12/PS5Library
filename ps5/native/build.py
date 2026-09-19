"""Build the actual storefront as an isolated native candidate (not an update).

Run in the PS5 build container after its normal payload build. Supply an unmodified
checkout of the pinned public ProsperoTV source; no vendored binary is consumed.
The output contains no server address, device credential, dump, or private log.
"""
import argparse
import hashlib
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import json
from verify import verify_readback

ROOT = Path(__file__).resolve().parents[2]
PIN = "fdee81e746308f7f2b27f7914a84eab678088fb6"
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--upstream", required=True, type=Path)
parser.add_argument("--payload-build", type=Path, default=ROOT / "ps5/build/ps5")
parser.add_argument("--json-c", type=Path, help="patched json-c archive (defaults to the native build image copy)")
parser.add_argument("--mode", choices=("probe", "app"), default="probe")
parser.add_argument("--output", type=Path)
parser.add_argument("--tab-stress", action="store_true", help="cycle storefront tabs for the hardware soak test")
args = parser.parse_args()
upstream, payload = args.upstream.resolve(), args.payload_build.resolve()
work = (args.output or ROOT / ("ps5/build/native-app" if args.mode == "app" else "ps5/build/native")).resolve()
probe = args.mode == "probe"
sdk = Path(os.environ["PS5_PAYLOAD_SDK"]).resolve()
json_c = (args.json_c or sdk / "target/user/homebrew/lib/libjson-c.a").resolve()
native = upstream / "tooling/native"
assert subprocess.check_output(["git", "-C", str(upstream), "rev-parse", "HEAD"], text=True).strip() == PIN
assert not subprocess.check_output(["git", "-C", str(upstream), "status", "--porcelain", "--", "tooling/native"], text=True).strip(), "Native tool sources changed"
assert (payload / "CMakeFiles/ps5library.dir/link.txt").is_file(), "Build the regular PS5 frontend first"
assert json_c.is_file(), "Supply the patched json-c static library"
work.mkdir(parents=True, exist_ok=True)

def run(*command):
    subprocess.run([str(part) for part in command], cwd=payload, check=True)

tool = work / "ps5-native-tool"
run("clang++-18", "-std=c++20", "-O2", "-Wall", "-Wextra", "-Werror",
    *[native / name for name in ("native_app_builder.cpp", "self_container.cpp", "elf_object.cpp", "sce_module_writer.cpp")],
    "-lz", "-o", tool)
crt = (native / "app_crt.cpp").read_text()
if probe:
    crt = crt.replace("    void _init_env", "    void native_trace(int);\n    void _init_env")
    crt = crt.replace("    _init_env(process_parameters);", "    native_trace(1);\n    _init_env(process_parameters);\n    native_trace(2);")
    crt = crt.replace("    _init();", "    _init();\n    native_trace(3);")
(work / "app_crt.cpp").write_text(crt)
runtime = (native / "app_cpp_runtime.cpp").read_text()
runtime = runtime.replace("#include <cstdint>", "#include <cstdint>\n#include <cstdarg>")
threshold = "constexpr std::size_t kDirectMapThreshold = 4 * 1024 * 1024;"
assert runtime.count(threshold) == 1
# Response and JSON buffers live longer than the small UI allocations around
# them. Return page-sized buffers to the OS instead of fragmenting 32 MiB pools.
runtime = runtime.replace(threshold, "constexpr std::size_t kDirectMapThreshold = kPageSize;")
free_list = "AllocationHeader *g_free_list = nullptr;"
assert runtime.count(free_list) == 1
runtime = runtime.replace(free_list, "constexpr std::size_t kFreeListCount = kDirectMapThreshold / kDefaultAlignment;\nAllocationHeader *g_free_lists[kFreeListCount]{};")
first_fit = """    AllocationHeader **link = &g_free_list;
    while (*link)
    {
        AllocationHeader *header = *link;
        void *payload = header + 1;
        if (header->magic == kFreeMagic && header->capacity >= size &&
            reinterpret_cast<std::uintptr_t>(payload) % alignment == 0)
        {
            *link = header->next_free;
            header->magic = kAllocatedMagic;
            header->requested = size;
            header->next_free = nullptr;
            unlock_allocator();
            return payload;
        }
        link = &header->next_free;
    }
"""
binned_fit = """    const std::size_t first_bin = capacity / kDefaultAlignment - 1;
    for (std::size_t bin = first_bin; bin < kFreeListCount; ++bin)
    {
        AllocationHeader **link = &g_free_lists[bin];
        while (*link)
        {
            AllocationHeader *header = *link;
            void *payload = header + 1;
            if (header->magic == kFreeMagic &&
                reinterpret_cast<std::uintptr_t>(payload) % alignment == 0)
            {
                *link = header->next_free;
                header->magic = kAllocatedMagic;
                header->requested = size;
                header->next_free = nullptr;
                unlock_allocator();
                return payload;
            }
            link = &header->next_free;
        }
    }
"""
assert runtime.count(first_fit) == 1
runtime = runtime.replace(first_fit, binned_fit)
free_block = """    lock_allocator();
    header->magic = kFreeMagic;
    header->next_free = g_free_list;
    g_free_list = header;
    unlock_allocator();
"""
binned_free = """    lock_allocator();
    header->magic = kFreeMagic;
    const std::size_t bin = header->capacity / kDefaultAlignment - 1;
    header->next_free = g_free_lists[bin];
    g_free_lists[bin] = header;
    unlock_allocator();
"""
assert runtime.count(free_block) == 1
runtime = runtime.replace(free_block, binned_free)
runtime += """
extern "C" char *strdup(const char *source) noexcept
{
    if (!source) return nullptr;
    std::size_t size = 1;
    while (source[size - 1]) ++size;
    auto *copy = static_cast<char *>(allocate_storage(size, kDefaultAlignment));
    if (!copy) return nullptr;
    for (std::size_t index = 0; index < size; ++index) copy[index] = source[index];
    return copy;
}

extern "C" int vsnprintf(char *, std::size_t, const char *, va_list);
extern "C" int vasprintf(char **output, const char *format, va_list arguments) noexcept
{
    if (!output || !format) return -1;
    *output = nullptr;
    va_list measure;
    va_copy(measure, arguments);
    const int length = vsnprintf(nullptr, 0, format, measure);
    va_end(measure);
    if (length < 0) return -1;
    auto *buffer = static_cast<char *>(allocate_storage(static_cast<std::size_t>(length) + 1, kDefaultAlignment));
    if (!buffer) return -1;
    va_list render;
    va_copy(render, arguments);
    const int written = vsnprintf(buffer, static_cast<std::size_t>(length) + 1, format, render);
    va_end(render);
    if (written < 0 || written > length) { deallocate_storage(buffer); return -1; }
    *output = buffer;
    return written;
}
"""
(work / "app_cpp_runtime.cpp").write_text(runtime)
for name, source in (("app_crt", work / "app_crt.cpp"), ("app_cpp_runtime", work / "app_cpp_runtime.cpp")):
    run(sdk / "bin/prospero-clang++", "-std=c++20", "-Os", "-fno-exceptions", "-fno-rtti",
        "-ffunction-sections", "-fdata-sections", "-c", source, "-o", work / (name + ".o"))
run(sdk / "bin/prospero-clang++", "-std=c++17", "-Os", "-ffunction-sections", "-fdata-sections",
    "-DPS5", "-DPS5LIBRARY_NATIVE", "-Dmain=storefront_main",
    "-isystem", sdk / "target/user/homebrew/include", "-isystem", sdk / "target/user/homebrew/include/SDL2",
    "-c", ROOT / "ps5/frontend/main.cpp", "-o", work / "main.o")
run(sdk / "bin/prospero-clang++", "-std=c++17", "-Os", "-DPS5LIBRARY_NATIVE_TARGET", "-isystem", sdk / "target/user/homebrew/include/SDL2",
    *(["-DPS5LIBRARY_NATIVE_PROBE"] if probe else []),
    *(["-DPS5LIBRARY_TAB_STRESS"] if args.tab_stress else []),
    "-c", ROOT / "ps5/native/main.cpp", "-o", work / "native-main.o")
# SDK v0.43 lacks this import declaration. Use the pinned upstream link-only
# facade; the final title imports the real console module and ships no stub.
run(sdk / "bin/prospero-clang++", "-std=c++20", "-O2", "-fPIC", "-c",
    native / "ps5_radio_import_stub_common_dialog.cpp", "-o", work / "common-dialog.o")
run(sdk / "bin/prospero-lld", "--shared", "-soname", "libSceCommonDialog.sprx",
    "-o", work / "libSceCommonDialog.so", work / "common-dialog.o")

layout = (native / "ps5-pie.ld").read_text()
for section in ("eh_frame_hdr", "eh_frame"):
    marker = "KEEP(*(." + section + "))"
    assert layout.count(marker) == 1
    layout = layout.replace(marker, "__" + section + "_start = .; " + marker + " __" + section + "_end = .;")
(work / "native.ld").write_text(layout)
original = shlex.split((payload / "CMakeFiles/ps5library.dir/link.txt").read_text())
inputs = [item for item in original if item.endswith((".a", ".o")) or item.startswith("-l")]
inputs = [str(work / "main.o") if item == "CMakeFiles/ps5library.dir/frontend/main.cpp.o" else
          str(json_c) if item == "-ljson-c" else
          "-lkernel" if item == "-lkernel_sys" else item for item in inputs]
# Unresolved optional ELF hooks have null addresses. Preserve that meaning instead
# of emitting native imports for symbols that no system module provides.
weak_hooks = ("ZSTD_trace_decompress_begin", "ZSTD_trace_decompress_end", "__dlopen", "__dlsym", "__dladdr", "__dlclose", "__dlerror")
run(sdk / "bin/prospero-lld", "-T", work / "native.ld", "--eh-frame-hdr", "--gc-sections",
    "--version-script", native / "app-symbols.map", "--exclude-libs=ALL",
    *["--wrap=" + name for name in ("sceAudioOutOpen", "sceAudioOutOutput", "sceUserServiceInitialize", "sceKeyboardInit", "sceKeyboardOpen", "sceImeDialogInit", "sceImeDialogGetStatus", "SDL_PollEvent", "fcntl")],
    *(["--wrap=SDL_RenderPresent"] if probe else []),
    *["--defsym=" + name + "=0" for name in weak_hooks],
    "-L" + str(sdk / "target/user/homebrew/lib"), "-L" + str(sdk / "target/lib"),
    "-e", "_start", "-o", work / "llvm-pie.elf", work / "app_crt.o", work / "app_cpp_runtime.o", work / "native-main.o",
    "--start-group", *inputs, "-lc++abi", "-lunwind", "-lc", "--end-group", "--as-needed", "-lSceLibcInternal", "-lSceNet", work / "libSceCommonDialog.so")
symbols = subprocess.check_output(["nm", "-C", str(work / "llvm-pie.elf")], text=True)
assert " U strdup" not in symbols and " U vasprintf" not in symbols, "C allocation helpers must use the executable allocator"
assert "ps5library::Agent::tick()" not in symbols, "Sandboxed UI must not report console-wide inventory"
assert "kernel_get_fw_version" not in symbols, "Native title must not use the payload CRT"
assert "__eh_frame_hdr_start" in symbols and "__eh_frame_end" in symbols
assert " U sceCommonDialogInitialize" in symbols, "CommonDialog must remain a real console import"
if not probe:
    assert "sceSystemServiceNavigateToGoHome" not in symbols, "App must not issue an automatic Home request"
    assert " U sceSystemServiceLaunchApp" in symbols, "Native Play must import the real title launcher"
    assert " U sceNetInit" in symbols, "Native storefront must initialize networking"
    assert " U sceNetPoolCreate" in symbols and " U sceNetPoolDestroy" in symbols, "Native storefront must own a network pool"
    assert "__wrap_fcntl" in symbols, "Native storefront must ignore unsupported close-on-exec socket flags"
    assert " T catchReturnFromMain" not in symbols, "App exit must not wait for diagnostic cleanup"
run(tool, "link", "--in", work / "llvm-pie.elf", "--out", work / "eboot.elf",
    "--stub-dir", sdk / "target/lib", "--stub", work / "libSceCommonDialog.so",
    "--module-sdk", "0x02000009", "--companion-sdk", "0x08050001", "--file-name", "eboot.elf")

dist = work / "dist/PPSA99051"
for directory in ("sce_sys", "sce_module", "assets"):
    (dist / directory).mkdir(parents=True, exist_ok=True)
run(tool, "self", "--sign", "--in", work / "eboot.elf", "--out", dist / "eboot.bin", "--magic", "0x1D3D154F")
run(tool, "self", "--extract", "--file", dist / "eboot.bin", "--out", work / "readback.elf")
verify_readback((work / "eboot.elf").read_bytes(), (work / "readback.elf").read_bytes())
run("clang++-18", "-std=c++20", "-O2", native / "libc_builder.cpp", "-o", work / "libc-builder")
run(work / "libc-builder", native / "runtime/api-surface.txt", native / "runtime/imports.txt", work / "libc.raw.elf")
assert hashlib.sha256((work / "libc.raw.elf").read_bytes()).hexdigest() == "8ee6e124993e1af26420cb455890fd002f5d6c7e78883c860ce45734e7d002bb"
run(tool, "self", "--sign", "--in", work / "libc.raw.elf", "--out", dist / "sce_module/libc.prx")
assert hashlib.sha256((dist / "sce_module/libc.prx").read_bytes()).hexdigest() == "e6ff45d16adf687855cc3b33b0c8a4132b6504360b221e0a34c7e99fb3ba0036"
param = {
    "titleId": "PPSA99051", "conceptId": "99051", "contentId": "UP9000-PPSA99051_00-PS5LIBRARYHOMETE",
    "contentVersion": "01.000.000", "masterVersion": "01.00", "applicationCategoryType": 0,
    "applicationDrmType": "free", "contentBadgeType": 1, "downloadDataSize": 256,
    "attribute": 0, "attribute2": 0, "attribute3": 0, "ageLevel": {"default": 0},
    "requiredSystemSoftwareVersion": "0x0000000000000000", "sdkVersion": "0x0000000000000000",
    "gameIntent": {"permittedIntents": [{"intentType": "launchActivity"}]},
    "localizedParameters": {"defaultLanguage": "en-US", "en-US": {"titleName": "PS5Library Native Test" if probe else "PS5Library"}},
    "versionFileUri": ""
}
(dist / "sce_sys/param.json").write_text(json.dumps(param, indent=2) + "\n")
shutil.copyfile(ROOT / "ps5/assets/icon0.png", dist / "sce_sys/icon0.png")
for name in ("pic0.dds", "pic1.dds"):
    shutil.copyfile(ROOT / "ps5/assets" / name, dist / "sce_sys" / name)
(dist / "assets/banner.txt").write_text("PS5Library native storefront experiment\n")
manifest = {"mode": args.mode, "upstream": PIN, "fselfSha256": hashlib.sha256((dist / "eboot.bin").read_bytes()).hexdigest(), "releaseReady": False, "tabStress": args.tab_stress}
if not probe:
    agent = payload / "ps5library-agent.elf"
    assert agent.is_file(), "Build the standalone agent before packaging the native app"
    assert agent.read_bytes()[:6] == b"\x7fELF\x02\x01", "Invalid standalone agent"
    shutil.copyfile(agent, work / "dist/ps5library-agent.elf")
    manifest["agentSha256"] = hashlib.sha256(agent.read_bytes()).hexdigest()
(work / "build.json").write_text(json.dumps(manifest, indent=2) + "\n")
print("Native storefront " + args.mode + " built; hardware startup and lifecycle must be verified before release.")
