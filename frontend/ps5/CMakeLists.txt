cmake_minimum_required(VERSION 3.20)
project(PS5Library LANGUAGES C CXX)
option(PS5LIBRARY_EXPERIMENTAL_SHELL_INDICATOR
  "Build the firmware-4.50/4.51 ShellUI agent indicator heartbeat" ON)
option(PS5LIBRARY_EXPERIMENTAL_SHELL_INPUT_DIAGNOSTIC
  "Observe firmware-4.50/4.51 ShellUI Options transitions without consuming input" ON)
option(PS5LIBRARY_EXPERIMENTAL_SHELL_CHEAT_PAGE
  "Build the firmware-4.50/4.51 native Settings-hosted cheat page test entry" ON)
option(PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER
  "Build the firmware-4.50/4.51 bounded read-only module memory scanner" ON)
option(PS5LIBRARY_EXPERIMENTAL_MEMORY_WRITES
  "Enable bounded edit, freeze, and restore for selected scan results" ON)
if(PS5LIBRARY_EXPERIMENTAL_SHELL_INPUT_DIAGNOSTIC AND
   NOT PS5LIBRARY_EXPERIMENTAL_SHELL_INDICATOR)
  message(FATAL_ERROR "Shell input diagnostic requires the existing Shell indicator helper")
endif()
if(PS5LIBRARY_EXPERIMENTAL_SHELL_CHEAT_PAGE AND
   NOT PS5LIBRARY_EXPERIMENTAL_SHELL_INDICATOR)
  message(FATAL_ERROR "Shell cheat page requires the existing Shell indicator helper")
endif()
if(PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER AND
   NOT PS5LIBRARY_EXPERIMENTAL_SHELL_CHEAT_PAGE)
  message(FATAL_ERROR "Memory scanner requires the experimental Shell cheat page")
endif()
if(PS5LIBRARY_EXPERIMENTAL_MEMORY_WRITES AND
   NOT PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER)
  message(FATAL_ERROR "Memory writes require the experimental memory scanner")
endif()
if(NOT CMAKE_BUILD_TYPE AND NOT CMAKE_CONFIGURATION_TYPES)
  set(CMAKE_BUILD_TYPE Release CACHE STRING "Build type" FORCE)
endif()
set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
find_package(PkgConfig REQUIRED)
if(PS5)
  add_compile_definitions(PS5)
  include_directories(SYSTEM "$ENV{PS5_PAYLOAD_SDK}/target/user/homebrew/include" "$ENV{PS5_PAYLOAD_SDK}/target/user/homebrew/include/SDL2")
  link_directories("$ENV{PS5_PAYLOAD_SDK}/target/user/homebrew/lib")
  set(NETWORK_LIBS curl json-c ssl crypto psl zstd z iconv c++ pthread)
  set(SQLITE_LIBS sqlite3)
  set(VIDEO_LIBS avformat avcodec swresample avutil x264 lzma bz2)
  set(UI_LIBS SDL2_image SDL2_ttf SDL2 freetype harfbuzz png jpeg webpdemux webp samplerate bz2 SceVideoOut SceAudioOut ScePad SceKeyboard SceUserService SceSysmodule SceNotification SceSystemService SceImeDialog)
else()
  pkg_check_modules(NET REQUIRED IMPORTED_TARGET libcurl json-c openssl)
  pkg_check_modules(UI REQUIRED IMPORTED_TARGET sdl2 SDL2_image SDL2_ttf)
  set(NETWORK_LIBS PkgConfig::NET pthread)
  pkg_check_modules(SQLITE REQUIRED IMPORTED_TARGET sqlite3)
  set(SQLITE_LIBS PkgConfig::SQLITE)
  set(UI_LIBS PkgConfig::UI)
  pkg_check_modules(VIDEO REQUIRED IMPORTED_TARGET libavformat libavcodec libswresample libavutil)
  set(VIDEO_LIBS PkgConfig::VIDEO)
endif()
file(READ "${CMAKE_CURRENT_SOURCE_DIR}/assets/update-public-key.pem" UPDATE_KEY)
file(WRITE "${CMAKE_CURRENT_BINARY_DIR}/update-key.hpp" "#pragma once\ninline constexpr const char* updateTrustKey=R\"KEY(${UPDATE_KEY})KEY\";\n")
add_library(ps5library_client common/client.cpp common/update.cpp agent/agent.cpp agent/discovery.cpp agent/backport.cpp agent/native.cpp agent/storage_format.cpp agent/installed.cpp agent/trophies.cpp agent/saves.cpp agent/removals.cpp agent/remote_play.cpp agent/cheats.cpp agent/memory_scanner.cpp)
target_include_directories(ps5library_client PRIVATE "${CMAKE_CURRENT_BINARY_DIR}")
target_compile_options(ps5library_client PRIVATE -Wall -Wextra -Werror)
if(PS5 AND PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER)
  target_compile_definitions(ps5library_client PRIVATE
    PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER=1)
endif()
if(PS5 AND PS5LIBRARY_EXPERIMENTAL_MEMORY_WRITES)
  target_compile_definitions(ps5library_client PRIVATE
    PS5LIBRARY_EXPERIMENTAL_MEMORY_WRITES=1)
endif()
target_link_libraries(ps5library_client PUBLIC ${NETWORK_LIBS} PRIVATE ${SQLITE_LIBS})
add_executable(ps5library-agent agent/main.cpp)
target_link_libraries(ps5library-agent PRIVATE ps5library_client)
if(PS5)
  target_compile_options(ps5library_client PRIVATE
    -ffunction-sections -fdata-sections)
  target_compile_options(ps5library-agent PRIVATE
    -ffunction-sections -fdata-sections)
  target_link_options(ps5library-agent PRIVATE -Wl,--gc-sections)
endif()
if(PS5 AND PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER)
  target_compile_definitions(ps5library-agent PRIVATE
    PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER=1)
endif()
if(PS5 AND PS5LIBRARY_EXPERIMENTAL_MEMORY_WRITES)
  target_compile_definitions(ps5library-agent PRIVATE
    PS5LIBRARY_EXPERIMENTAL_MEMORY_WRITES=1)
endif()
if(PS5 AND PS5LIBRARY_EXPERIMENTAL_SHELL_INDICATOR)
  find_package(Python3 REQUIRED COMPONENTS Interpreter)
  set(SHELL_INDICATOR_ROOT "${CMAKE_CURRENT_SOURCE_DIR}/shell-indicator")
  set(SHELL_INDICATOR_UPSTREAM "${SHELL_INDICATOR_ROOT}/upstream")
  add_library(ps5library-onion-detour STATIC
    ${SHELL_INDICATOR_UPSTREAM}/onion_detour/source/detour.cpp
    ${SHELL_INDICATOR_UPSTREAM}/onion_detour/source/hde64.cpp
    ${SHELL_INDICATOR_UPSTREAM}/onion_detour/source/hotpatch.cpp
    ${SHELL_INDICATOR_UPSTREAM}/onion_detour/source/trampoline_arena.cpp
    ${SHELL_INDICATOR_UPSTREAM}/onion_detour/source/x64_relocator.cpp)
  target_include_directories(ps5library-onion-detour PUBLIC
    ${SHELL_INDICATOR_UPSTREAM}/onion_detour/include
    PRIVATE ${SHELL_INDICATOR_UPSTREAM}/compat/include)
  target_compile_options(ps5library-onion-detour PRIVATE
    -fPIC -ffunction-sections -fdata-sections)

  set(SHELL_INDICATOR_ICON_BUNDLE
    "${CMAKE_CURRENT_BINARY_DIR}/shell-indicator-icon.c")
  add_custom_command(OUTPUT "${SHELL_INDICATOR_ICON_BUNDLE}"
    COMMAND ${Python3_EXECUTABLE} "${SHELL_INDICATOR_ROOT}/embed.py"
      "${SHELL_INDICATOR_ICON_BUNDLE}"
      "${CMAKE_CURRENT_SOURCE_DIR}/assets/icon0.png"
      ps5library_shell_icon
    DEPENDS assets/icon0.png "${SHELL_INDICATOR_ROOT}/embed.py")
  add_executable(ps5library-shell-indicator-helper
    shell-indicator/helper.cpp shell-indicator/homeui_patch.cpp
    shell-indicator/lifecycle.cpp "${SHELL_INDICATOR_ICON_BUNDLE}")
  target_include_directories(ps5library-shell-indicator-helper PRIVATE
    ${SHELL_INDICATOR_UPSTREAM}/onion_detour/include
    ${SHELL_INDICATOR_UPSTREAM}/compat/include)
  target_compile_options(ps5library-shell-indicator-helper PRIVATE
    -fPIC -ffunction-sections -fdata-sections -Wall -Wextra -Werror)
  if(PS5LIBRARY_EXPERIMENTAL_SHELL_INPUT_DIAGNOSTIC)
    target_compile_definitions(ps5library-shell-indicator-helper PRIVATE
      PS5LIBRARY_EXPERIMENTAL_SHELL_INPUT_DIAGNOSTIC=1)
    set(SHELL_INPUT_VERIFY_ARG --input-diagnostic)
  endif()
  if(PS5LIBRARY_EXPERIMENTAL_SHELL_CHEAT_PAGE)
    target_sources(ps5library-shell-indicator-helper PRIVATE
      shell-indicator/cheat_page.cpp)
    target_compile_definitions(ps5library-shell-indicator-helper PRIVATE
      PS5LIBRARY_EXPERIMENTAL_SHELL_CHEAT_PAGE=1)
    if(PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER)
      target_compile_definitions(ps5library-shell-indicator-helper PRIVATE
        PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER=1)
    endif()
    if(PS5LIBRARY_EXPERIMENTAL_MEMORY_WRITES)
      target_compile_definitions(ps5library-shell-indicator-helper PRIVATE
        PS5LIBRARY_EXPERIMENTAL_MEMORY_WRITES=1)
    endif()
    set(SHELL_CHEAT_VERIFY_ARG --cheat-page)
  endif()
  target_link_options(ps5library-shell-indicator-helper PRIVATE
    -Wl,--gc-sections -Wl,--icf=safe)
  target_link_libraries(ps5library-shell-indicator-helper PRIVATE
    ps5library-onion-detour kernel_sys c++ pthread)
  set_target_properties(ps5library-shell-indicator-helper PROPERTIES SUFFIX ".elf")
  add_custom_command(TARGET ps5library-shell-indicator-helper POST_BUILD
    COMMAND ${Python3_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/elf_dependencies.py"
      "${CMAKE_READELF}" "$<TARGET_FILE:ps5library-shell-indicator-helper>"
    COMMAND ${Python3_EXECUTABLE} "${SHELL_INDICATOR_ROOT}/verify_helper.py"
      "${CMAKE_READELF}" "$<TARGET_FILE:ps5library-shell-indicator-helper>"
      ${SHELL_INPUT_VERIFY_ARG} ${SHELL_CHEAT_VERIFY_ARG})
  set_property(TARGET ps5library-shell-indicator-helper APPEND PROPERTY
    LINK_DEPENDS "${SHELL_INDICATOR_ROOT}/verify_helper.py")

  set(SHELL_INDICATOR_BUNDLE "${CMAKE_CURRENT_BINARY_DIR}/shell-indicator-elf.c")
  add_custom_command(OUTPUT "${SHELL_INDICATOR_BUNDLE}"
    COMMAND ${Python3_EXECUTABLE} "${SHELL_INDICATOR_ROOT}/embed.py"
      "${SHELL_INDICATOR_BUNDLE}"
      "$<TARGET_FILE:ps5library-shell-indicator-helper>"
      ps5library_shell_helper_elf
    DEPENDS ps5library-shell-indicator-helper "${SHELL_INDICATOR_ROOT}/embed.py")
  target_sources(ps5library-agent PRIVATE shell-indicator/lifecycle.cpp
    shell-indicator/agent_runtime.cpp shell-indicator/injector.cpp
    ${SHELL_INDICATOR_UPSTREAM}/nines/source/injector.c
    ${SHELL_INDICATOR_UPSTREAM}/nines/source/ucred_compat.c
    ${SHELL_INDICATOR_UPSTREAM}/onion_elfldr/source/elfldr.c
    ${SHELL_INDICATOR_UPSTREAM}/onion_elfldr/source/pt.c
    "${SHELL_INDICATOR_BUNDLE}")
  target_include_directories(ps5library-agent PRIVATE
    ${SHELL_INDICATOR_UPSTREAM}/nines/include
    ${SHELL_INDICATOR_UPSTREAM}/onion_elfldr/include
    ${SHELL_INDICATOR_UPSTREAM}/compat/include)
  target_compile_definitions(ps5library-agent PRIVATE
    PS5LIBRARY_EXPERIMENTAL_SHELL_INDICATOR=1)
endif()
add_library(ps5library_video frontend/video.cpp)
target_link_libraries(ps5library_video PUBLIC ${VIDEO_LIBS} ps5library_client ${UI_LIBS})
add_executable(ps5library frontend/main.cpp)
target_link_libraries(ps5library PRIVATE ps5library_video)
if(PS5)
  target_sources(ps5library PRIVATE frontend/ps5_audio.cpp)
  target_link_options(ps5library PRIVATE -Wl,--wrap=sceAudioOutOpen -Wl,--wrap=sceAudioOutOutput)
  add_executable(audio-device-check tests/audio_device.cpp)
  target_link_libraries(audio-device-check PRIVATE ps5library_client SceAudioOut SceUserService)
  set_target_properties(audio-device-check PROPERTIES SUFFIX ".elf")
  add_executable(system-ui-check tests/system_ui.cpp)
  target_link_libraries(system-ui-check PRIVATE ps5library_client SceIpmi SceSystemService SceUserService)
  set_target_properties(system-ui-check PROPERTIES SUFFIX ".elf")
  if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/developer/package_tool.c")
    add_executable(ps5library-package-tool developer/package_tool.c)
    target_compile_options(ps5library-package-tool PRIVATE -Wall -Wextra -Werror)
    target_link_libraries(ps5library-package-tool PRIVATE kernel_sys SceUserService SceSystemService SceIpmi SceAppInstUtil crypto)
    set_target_properties(ps5library-package-tool PROPERTIES SUFFIX ".elf")
  endif()
  if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/developer/memory_discovery.cpp")
    add_executable(memory-discovery-probe developer/memory_discovery.cpp)
    target_compile_options(memory-discovery-probe PRIVATE -Wall -Wextra -Werror)
    target_link_libraries(memory-discovery-probe PRIVATE ps5library_client)
    set_target_properties(memory-discovery-probe PROPERTIES SUFFIX ".elf")
  endif()
  add_executable(display-check tests/display.cpp)
  target_link_libraries(display-check PRIVATE ${UI_LIBS} c++ z iconv)
  target_link_options(display-check PRIVATE -Wl,--wrap=sceVideoOutOpen)
  set_target_properties(display-check PROPERTIES SUFFIX ".elf")
  # AppInstUtil needs Ipmi loaded first, including in the frontend (SDK issue 26).
  target_link_libraries(ps5library_client PUBLIC kernel_sys SceUserService SceIpmi SceAppInstUtil SceSystemService SceNotification SceNetCtl)
  set_target_properties(ps5library-agent ps5library PROPERTIES SUFFIX ".elf")
  find_package(Python3 REQUIRED COMPONENTS Interpreter)
  set(UI_FONT "${CMAKE_CURRENT_SOURCE_DIR}/assets/fonts/Inter-Regular.otf")
  set(UI_HEADING_FONT "${CMAKE_CURRENT_SOURCE_DIR}/assets/fonts/Inter-SemiBold.otf")
  set(UI_FONT_LICENSE "${CMAKE_CURRENT_SOURCE_DIR}/assets/fonts/OFL.txt")
  set(UI_BUNDLE "${CMAKE_CURRENT_BINARY_DIR}/ui-assets.c")
  add_custom_command(OUTPUT "${UI_BUNDLE}"
    COMMAND ${Python3_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/bundle-ps5.py" --ui "${UI_BUNDLE}" "${UI_FONT}" "${UI_HEADING_FONT}" "${UI_FONT_LICENSE}" /etc/ssl/certs/ca-certificates.crt
    DEPENDS ../scripts/bundle-ps5.py "${UI_FONT}" "${UI_HEADING_FONT}" "${UI_FONT_LICENSE}")
  target_sources(ps5library PRIVATE "${UI_BUNDLE}")
  set(BUNDLE "${CMAKE_CURRENT_BINARY_DIR}/bundle-assets.c")
  add_custom_command(OUTPUT "${BUNDLE}"
    COMMAND ${Python3_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/bundle-ps5.py" "${BUNDLE}" "$<TARGET_FILE:ps5library>" "${CMAKE_CURRENT_SOURCE_DIR}/assets" "${CMAKE_CURRENT_SOURCE_DIR}/config.example.json" "${UI_FONT}" "${UI_HEADING_FONT}" "${UI_FONT_LICENSE}" /etc/ssl/certs/ca-certificates.crt
    DEPENDS ps5library assets/icon0.png assets/icon0.dds assets/pic0.png assets/pic0.dds assets/pic1.png assets/pic1.dds assets/param.json assets/launch.html config.example.json ../scripts/bundle-ps5.py "${UI_FONT}" "${UI_HEADING_FONT}" "${UI_FONT_LICENSE}")
  add_executable(ps5library-install installer/main.cpp "${BUNDLE}")
  target_link_libraries(ps5library-install PRIVATE ps5library_client c++ SceIpmi SceAppInstUtil SceNotification kernel_sys)
  set_target_properties(ps5library-install PROPERTIES SUFFIX ".elf")
  add_custom_command(TARGET ps5library-install POST_BUILD
    COMMAND ${Python3_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/../scripts/bundle-ps5.py" --metadata "$<TARGET_FILE:ps5library-install>" "${CMAKE_CURRENT_SOURCE_DIR}/common/version.hpp" "${CMAKE_CURRENT_SOURCE_DIR}/assets/update-public-key.pem")
  foreach(app ps5library ps5library-agent ps5library-install ps5library-package-tool)
    if(TARGET ${app})
      add_custom_command(TARGET ${app} POST_BUILD
        COMMAND ${Python3_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/elf_dependencies.py" "${CMAKE_READELF}" "$<TARGET_FILE:${app}>")
      set_property(TARGET ${app} APPEND PROPERTY LINK_DEPENDS "${CMAKE_CURRENT_SOURCE_DIR}/tests/elf_dependencies.py")
    endif()
  endforeach()
endif()
enable_testing()
add_executable(cleanup-checks tests/cleanup.cpp)
if(PS5)
  target_link_libraries(cleanup-checks PRIVATE c++)
  set_target_properties(cleanup-checks PROPERTIES SUFFIX ".elf")
else()
  add_test(NAME owned-cleanup COMMAND cleanup-checks)
endif()
if(NOT PS5)
  add_executable(shell-indicator-checks tests/shell_indicator.cpp
    shell-indicator/homeui_patch.cpp shell-indicator/lifecycle.cpp
    shell-indicator/cheat_page.cpp)
  target_compile_options(shell-indicator-checks PRIVATE -UNDEBUG -Wall -Wextra -Werror)
  add_test(NAME shell-indicator-profile COMMAND shell-indicator-checks)
  add_executable(native-checks tests/checks.cpp)
  target_link_libraries(native-checks PRIVATE ps5library_client)
  target_link_options(native-checks PRIVATE -Wl,--wrap=curl_global_init -Wl,--wrap=curl_easy_perform)
  find_package(Python3 REQUIRED COMPONENTS Interpreter)
  add_test(NAME native-update-origin COMMAND ${Python3_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/native/build.py" --upstream "${CMAKE_CURRENT_SOURCE_DIR}" --mode app --content-version 01.025.000 --print-version-file-uri)
  set_tests_properties(native-update-origin PROPERTIES ENVIRONMENT "COMMUNITY_MASTER_URL=https://updates.example;PUBLIC_URL=https://node.example" PASS_REGULAR_EXPRESSION "https://updates.example/api/v1/native-updates/PPSA99051/from/01.025.000/version.xml")
  add_executable(ps5library-native-host frontend/main.cpp)
  target_compile_definitions(ps5library-native-host PRIVATE PS5LIBRARY_NATIVE)
  target_link_libraries(ps5library-native-host PRIVATE ps5library_video)
  add_test(NAME native-fself-readback COMMAND ${Python3_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/native/verify.py")
  add_test(NAME storefront-navigation COMMAND ${Python3_EXECUTABLE} "${CMAKE_CURRENT_SOURCE_DIR}/tests/storefront.py" "$<TARGET_FILE:ps5library>")
  add_executable(native-download-checks tests/native_download.cpp agent/native.cpp)
  target_compile_definitions(native-download-checks PRIVATE PS5)
  target_compile_options(native-download-checks PRIVATE -UNDEBUG)
  target_link_options(native-download-checks PRIVATE -Wl,--wrap=dlopen -Wl,--wrap=dlsym)
  target_link_libraries(native-download-checks PRIVATE ps5library_client)
  add_test(NAME native-download-api-boundary COMMAND native-download-checks)
  add_executable(native-update-bridge-checks tests/native_update_bridge.cpp)
  target_link_libraries(native-update-bridge-checks PRIVATE ps5library_client)
  add_test(NAME native-update-bridge COMMAND native-update-bridge-checks)
  add_executable(storage-format-checks tests/storage_format.cpp)
  target_link_libraries(storage-format-checks PRIVATE ps5library_client)
  add_test(NAME usb-format-confirmation COMMAND storage-format-checks)
  add_executable(native-submission-checks tests/native_submission.cpp)
  target_compile_options(native-submission-checks PRIVATE -UNDEBUG)
  target_link_libraries(native-submission-checks PRIVATE ps5library_client)
  add_test(NAME native-submission-recovery COMMAND native-submission-checks)
  if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/developer/package_tool.c")
    add_executable(package-tool-checks developer/package_tool.c)
    target_compile_definitions(package-tool-checks PRIVATE PACKAGE_TOOL_SELF_TEST)
    target_compile_options(package-tool-checks PRIVATE -UNDEBUG -Wall -Wextra -Werror)
    add_test(NAME package-tool-input-boundaries COMMAND package-tool-checks)
  endif()
  add_executable(lifecycle-checks tests/lifecycle.cpp)
  target_link_libraries(lifecycle-checks PRIVATE ${UI_LIBS})
  add_test(NAME visibility-lifecycle COMMAND lifecycle-checks)
  add_executable(native-runtime-checks tests/native_runtime.cpp)
  target_compile_options(native-runtime-checks PRIVATE -UNDEBUG -Wall -Wextra -Werror)
  target_link_libraries(native-runtime-checks PRIVATE ${UI_LIBS} ${NETWORK_LIBS})
  add_test(NAME native-application-lifecycle COMMAND native-runtime-checks)
  if(EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/developer/files.hpp")
    add_executable(developer-checks tests/developer.cpp)
    target_compile_options(developer-checks PRIVATE -UNDEBUG -Wall -Wextra -Werror)
    target_link_libraries(developer-checks PRIVATE ps5library_client)
    add_test(NAME developer-file-rollback COMMAND developer-checks)
  endif()
  add_executable(shadowmount-checks tests/shadowmount.cpp)
  target_link_libraries(shadowmount-checks PRIVATE ps5library_client)
  add_test(NAME shadowmount-local-api COMMAND shadowmount-checks)
  add_executable(audio-route-checks tests/audio_route.cpp)
  add_test(NAME local-user-audio COMMAND audio-route-checks)
  add_executable(render-checks tests/render.cpp)
  target_link_libraries(render-checks PRIVATE ${UI_LIBS})
  add_test(NAME rounded-rendering COMMAND render-checks)
  add_executable(preview-checks tests/preview.cpp)
  target_link_libraries(preview-checks PRIVATE ps5library_video)
  add_test(NAME trailer-countdown COMMAND preview-checks)
  add_executable(audio-checks tests/audio.cpp)
  target_link_libraries(audio-checks PRIVATE ${UI_LIBS})
  add_test(NAME navigation-audio COMMAND audio-checks)
  add_executable(installed-checks tests/installed.cpp)
  target_link_libraries(installed-checks PRIVATE ps5library_client ${SQLITE_LIBS})
  add_test(NAME ps4-package-inspection COMMAND installed-checks)
  add_executable(saves-checks tests/saves.cpp)
  target_link_libraries(saves-checks PRIVATE ps5library_client ${SQLITE_LIBS})
  add_test(NAME save-metadata COMMAND saves-checks)
  add_executable(update-checks tests/update.cpp)
  target_link_libraries(update-checks PRIVATE ps5library_client)
  add_test(NAME signed-updates COMMAND update-checks)
  add_executable(remote-play-checks tests/remote_play.cpp)
  target_link_libraries(remote-play-checks PRIVATE ps5library_client)
  add_test(NAME remote-play-format COMMAND remote-play-checks)
  add_executable(cheat-checks tests/cheats.cpp)
  target_compile_options(cheat-checks PRIVATE -UNDEBUG -Wall -Wextra -Werror)
  target_link_libraries(cheat-checks PRIVATE ps5library_client)
  add_test(NAME cheat-profile-safety COMMAND cheat-checks)
  add_executable(memory-scanner-checks tests/memory_scanner.cpp)
  target_compile_options(memory-scanner-checks PRIVATE -UNDEBUG -Wall -Wextra -Werror)
  target_link_libraries(memory-scanner-checks PRIVATE ps5library_client)
  add_test(NAME bounded-memory-scanner COMMAND memory-scanner-checks)
  add_executable(memory-scanner-api-checks tests/memory_scanner_api.cpp
    shell-indicator/cheat_page.cpp)
  target_compile_options(memory-scanner-api-checks PRIVATE -UNDEBUG -Wall -Wextra -Werror)
  target_compile_definitions(memory-scanner-api-checks PRIVATE
    PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER=1
    PS5LIBRARY_EXPERIMENTAL_MEMORY_WRITES=1)
  target_link_libraries(memory-scanner-api-checks PRIVATE ps5library_client)
  add_test(NAME memory-scanner-local-api COMMAND memory-scanner-api-checks)
  add_test(NAME native-boundaries COMMAND native-checks)
  add_executable(focus-checks tests/focus.cpp)
  target_link_libraries(focus-checks PRIVATE ${UI_LIBS})
  add_test(NAME controller-focus COMMAND focus-checks)
  add_executable(installer-checks tests/installer.cpp)
  add_test(NAME installer-rollback COMMAND installer-checks)
endif()
foreach(check cleanup-checks shell-indicator-checks native-checks native-update-bridge-checks storage-format-checks preview-checks audio-checks installed-checks saves-checks update-checks remote-play-checks cheat-checks memory-scanner-checks memory-scanner-api-checks focus-checks installer-checks render-checks audio-route-checks shadowmount-checks lifecycle-checks)
  if(TARGET ${check})
    target_compile_options(${check} PRIVATE -UNDEBUG)
  endif()
endforeach()
