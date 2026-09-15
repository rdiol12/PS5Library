# PS5 system integration

Research date: 2026-09-15. **No physical-console execution has been performed.** VERIFIED below means inspected source, not verified on every firmware.

## How the home entry can work

`PS5 home icon → PS5Library launch page on the console → existing homebrew loader → native SDL PS5Library ELF → our server`

The launch page is a small local bootstrap. The store itself is the compiled C++/SDL application. Sony accounts and PSN services are not part of this flow.

| Layer | Evidence | State |
| --- | --- | --- |
| Native storefront | Our SDL frontend cross-links against payload SDK v0.43 and ports v0.40.2. Controller mapping was checked in the PS5 SDL driver. | VERIFIED build; console rendering UNKNOWN |
| Home-menu entry | [ftpsrv install-ps5.c](https://github.com/ps5-payload-dev/ftpsrv/blob/70f7b8614d3f36f6ceda0a37d6189b675f9d3f29/install-ps5.c), `install_app`, writes title metadata/icon under `/user/app`, initializes AppInstUtil and resolves title-directory registration. `assets/param.json` uses a loopback websrv deeplink. | VERIFIED source; our integration EXPERIMENTAL |
| Foreground native launch | [websrv websrv.c](https://github.com/ps5-payload-dev/websrv/blob/1afd476c5044d68df4e45dc773769e5de3b2cdd6/src/websrv.c), `hbldr_request`: `/hbldr?path=...&cwd=...&args=...&daemon=0`. `src/ps5/sys.c`, `sys_launch_homebrew`, calls `hbldr_launch`. | VERIFIED source; depends on compatible, running websrv and homebrew bootstrap |
| Notifications | SDK notification sample, used by our agent behind a configured capability. | VERIFIED source/build; hardware UNKNOWN |
| Persistent background agent | Separate agent ELF exists; foreground storefront also runs the same agent with a process lock. | VERIFIED host build; runtime survival, game coexistence and reboot autostart UNKNOWN |
| Installed game registration | ShadowMountPlus owns mount/registration. We request its documented manual workflow and wait for status plus inventory. | VERIFIED source/build; hardware UNKNOWN |
| ShellUI hooks | etaHEN injects code into SceShellUI and hooks managed UI methods. | VERIFIED research; PS5Library does not enable these hooks |

## Important loader behavior

### Payload Manager launch attempt

The user reported sending `ps5library.elf` through **pldmgr** on firmware 4.51 and remaining on the PS5 home screen. This is an unsuccessful/uncertain launch attempt, not evidence that the storefront rendered or that a home entry was installed.

In [pldmgr v0.5.1 source](https://github.com/itsPLK/ps5-payload-manager/blob/218f291d0ea1e97d7a21e308ecff794e63bedb4a/src/ps5_launcher.c), `ps5_launch_elf` streams the file to the local port-9021 payload loader. That launch path does not invoke the foreground homebrew loader used by this SDL frontend. **LIKELY:** the launch context explains the absent UI. **UNKNOWN:** the user's installed pldmgr version, whether execution reached our startup code, and the actual error without console logs. Inspect the existing foreground launcher and bootstrap before another launch; do not infer that pldmgr's own home icon provides that bootstrap.

The websrv homebrew menu expects `/data/homebrew/<app>/eboot.elf` and `<app>/sce_sys/icon0.png`; merely uploading the ELF into pldmgr's payload list does not add a homebrew-menu entry. The PS5Library home-menu installer is a separate path with the prerequisites below.

In the pinned websrv `src/ps5/hbldr.c`, `hbldr_launch` first ensures the generic `FAKE00000` bootstrap exists. Its fallback can remount `/system_ex` and create that bootstrap. It then stops the currently running BigApp before launching the requested homebrew. Therefore:

- A PS5Library installer must require an already configured Homebrew Launcher bootstrap. Creating one is not silently bundled into our installation.
- Opening PS5Library through this loader can close the foreground game. It is not an overlay that can be opened over a running game.
- websrv must be running after the jailbreak. A persistent icon does not imply the jailbreak or websrv survives a reboot.
- `/elfldr` launches a daemon; it is not interchangeable with `/hbldr` for an SDL foreground application.
- Upstream reports that launching another homebrew while one is running can crash. This needs testing with the user's exact runtime.

## Registration differences

ftpsrv resolves `sceAppInstUtilAppInstallTitleDir` using NID `Wudg3Xe3heE`, then falls back to `sceAppInstUtilAppInstallAll`. ShadowMountPlus's `sm_install.c` deliberately avoids the title-directory function on firmware major 12 and newer. The broad install-all fallback can affect other titles; it must not run automatically in our installer. A missing exact-title registration API is an explicit unsupported result until that runtime is tested.

The SDK `samples/install_app` also writes a fake application's `/system_ex/app` structure. That example is not a universal drop-in installer for our current payload ELF.

## Deeper ShellUI integration

[etaHEN](https://github.com/etaHEN/etaHEN/tree/dafa13b562ddb137a4b4a97b9aaa287c0c57cc9c/Source%20Code/shellui) contains Mono UI manipulation and method hooks in `src/HookFunctions.cpp`, `src/prx.cpp` and `src/MonoUtils.cpp`; the daemon locates SceShellUI and injects its toolbox. This is runtime-specific internal integration, not a stable general plugin API.

**UNKNOWN:** a supported way for PS5Library to publish its own byte progress into Sony's system Downloads surface, add an in-shell store tab, or show an always-available store overlay. These are not advertised as capabilities.

**EXPERIMENTAL alternative:** [ps5link-sdk](https://github.com/Rufidj/ps5link-sdk/tree/ea771e535378740b6a058b8e5419eb8a0e0e0ec8) can construct real title binaries with SCE import tables. Its README reports a tested C toolchain on firmware 9.00; C++ and parts of TLS/libc remain limitations. Packaging our existing SDL payload as fake SELF alone does not turn it into a working independent title. A matching user-supplied module may be required; system libraries are not redistributed by this project.

## Recovery requirements

The production frontend keeps `shellIntegration=false`. Any later ShellUI experiment must have an exact firmware/runtime allowlist, manual opt-in, an external disable flag checked before injection, original-byte restoration, a watchdog that disables the experiment after a failed boot, and a tested recovery entry point. Rebooting without the optional payload must leave the ordinary shell usable. Do not patch system files or edit app databases to implement a visual store tab.

For a home-entry installation, keep the previous PS5Library-owned title folder until registration succeeds, refuse to replace another application's title ID, preserve server configuration and paired credentials, and provide exact-title uninstall. No experiment is marked TESTED until install, launch, exit, reboot, upgrade and rollback have been exercised on the target console.

### Current installer and interrupted-file recovery

The built `ps5library-install.elf` embeds the current storefront and original icon. It owns only `/user/app/BREW05001`, identified by `.ps5library-owner` containing `PS5Library home entry v1` followed by a newline. `--uninstall` requests exact-title removal and preserves `/data/ps5library` configuration and device credentials. Registration failure restores the previous owned files in host checks; system registration behavior still needs console tests.

If a crash leaves `/user/app/.ps5library-previous`, the installer stops instead of overwriting recovery data. With PS5Library stopped, inspect this folder and `/user/app/BREW05001` through your trusted local console file manager. Both existing folders must have the exact ownership marker. Preserve the current owned title folder under a separate recovery name, then restore `.ps5library-previous` to `BREW05001`; keep `/data/ps5library` intact. Do not move/delete a folder with a missing or different marker. Re-run exact-title installation only after the runtime/loader is available. Filesystem restoration does not guarantee that interrupted OS registration has recovered; do not edit `app.db` to conceal a registration failure.
