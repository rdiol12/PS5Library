# PS5 system integration

Research date: 2026-09-15. Physical-console onboarding has begun, but storefront rendering and home-entry installation have not succeeded. VERIFIED source findings and the limited hardware observations below are separate; neither implies support on every firmware.

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

In [pldmgr v0.5.1 source](https://github.com/itsPLK/ps5-payload-manager/blob/218f291d0ea1e97d7a21e308ecff794e63bedb4a/src/ps5_launcher.c), `ps5_launch_elf` streams the file to the local port-9021 payload loader. That launch path does not invoke the foreground homebrew loader used by this SDL frontend. **LIKELY:** the launch context explains the absent UI. Subsequent LAN inspection confirmed pldmgr 0.5.1 and PS5Library startup asset extraction. The exact point at which the storefront stopped remains **UNKNOWN**. Do not infer that pldmgr's own home icon provides the foreground bootstrap.

The websrv homebrew menu expects `/data/homebrew/<app>/eboot.elf` and `<app>/sce_sys/icon0.png`; merely uploading the ELF into pldmgr's payload list does not add a homebrew-menu entry. The PS5Library home-menu installer is a separate path with the prerequisites below.

In the pinned websrv `src/ps5/hbldr.c`, `hbldr_launch` first ensures the generic `FAKE00000` bootstrap exists. Its fallback can remount `/system_ex` and create that bootstrap. It then stops the currently running BigApp before launching the requested homebrew. Therefore:

- A PS5Library installer must require an already configured Homebrew Launcher bootstrap. Creating one is not silently bundled into our installation.
- Opening PS5Library through this loader can close the foreground game. It is not an overlay that can be opened over a running game.
- websrv must be running after the jailbreak. A persistent icon does not imply the jailbreak or websrv survives a reboot.
- `/elfldr` launches a daemon; it is not interchangeable with `/hbldr` for an SDL foreground application.
- Upstream reports that launching another homebrew while one is running can crash. This needs testing with the user's exact runtime.

**Additional startup side effect:** websrv v0.34 `src/ps5/sys.c`, `sys_init`, calls `install_launcher` after initializing AppInstUtil. This can create `/user/app/FAKE00000/sce_sys/param.json` and `icon0.png` and request registration; its `install_app` falls back to broad `sceAppInstUtilAppInstallAll`. This happens when starting the helper, independently of a later `/hbldr` request. It is distinct from the `/system_ex/app/FAKE00000` executable bootstrap. Starting unmodified websrv must not be described as read-only. Our diagnostic rebuild disabled this automatic registration; our PS5Library installer already excludes the broad fallback.

### Hardware session: 2026-09-15

**VERIFIED observations, not a working launch:**

- The console's pldmgr `/version` returned 0.5.1; its process list showed OnionHEN daemon/utility/loader, kstuff and ShadowMountPlus. The console owner reports firmware 4.51 and confirmed that home-screen controller navigation still responds during diagnosis. Running process names do not establish exact runtime versions or health.
- pldmgr logs record three sends of the 21,071,864-byte storefront, followed by deletion of that payload from its list. Existing `/data/ps5library/DejaVuSans.ttf`, license, CA bundle and artwork-cache directory establish that our startup ran. No pairing configuration or performance report was present. An existing 107.8 MiB `payload.elf` process could be the storefront, but its identity was not proven and it was not killed.
- Started the already-present ftpsrv v0.21.1 through pldmgr; FTP on port 2121 works. Staged our files under `/data/homebrew/PS5Library` using `.part` uploads, read-back verification and rename. The directory carries the exact marker `PS5Library homebrew v1\n`. Existing configuration/assets were preserved.

| Staged file | Bytes | Read-back SHA-256 |
| --- | ---: | --- |
| `eboot.elf` | 21,071,864 | `8a86f4327ec20755467c043c199a4c8060bce76dad374209ca6e1cfb277bd9fc` |
| `sce_sys/icon0.png` | 373,767 | `eb11262f81d226293a9a104bb1d5907bd481ac28f7ea70e5326c97ee6de0b763` |

- The official [websrv v0.34 release](https://github.com/ps5-payload-dev/websrv/releases/tag/v0.34), source commit `4d35610914273f8f4fc37af2b1d5bfb069dfba5b`, was downloaded and its published SHA-256 verified: `54730c867c6e1148536fdcb370e63a7762d989ea87b62488ad4caff64d43f263` (1,597,864 bytes). Sending it created a process but never opened port 8080. This is a failed helper launch, not a successful installation.
- A local rebuild from that tag disabled automatic launcher installation and logged at entry to `sys_init`. It also failed before creating that log. A separate minimal SDK v0.43 probe wrote its startup log and then blocked while loading `libSceSystemService.sprx`. A second probe loaded `libSceIpmi.sprx` successfully and then blocked at the same SystemService load. No guessed firmware patch was applied.
- The saved OnionHEN utility log shows repeated signal 11 reports beginning at its monotonic timestamp `21996.518`; its supervisor continues logging. **UNKNOWN:** whether the utility failure caused the loading hang, resulted from this session's payload activity, or has another cause. Do not call this a proven OnionHEN compatibility defect.
- Earlier websrv processes disappeared after exact-PID stop requests. The two minimal probe processes remained listed after successful kill-request responses. An accepted kill request is not confirmation that a process exited. No more payloads were sent after this finding.
- Final FTP inspection still found no `/user/app/FAKE00000`, `/user/appmeta/FAKE00000`, `/system_ex/app/FAKE00000` or `/user/app/BREW05001`. No `/hbldr` request, PS5Library installer, system remount or title-database edit was performed. The home icon is **not installed**.

Private LAN details, diagnostic source/build patches, logs and process snapshots are preserved locally under ignored `data/console-setup`. They are not bundled into releases. The foreground ELF itself was not changed during this session.

**Next check at that point:** restart the console normally and run the usual jailbreak, keeping PS5Library closed. Confirm that the utility log is healthy before another helper attempt. Establish a working foreground launcher and prepare explicit bootstrap/recovery steps before any system-partition setup. Server LAN access, first-account creation and console pairing still follow; an uploaded ELF does not perform those steps.

#### Restart follow-up

The user reported the restart complete. pldmgr still reports 0.5.1; its process list now contains kstuff, ShadowMountPlus and elfldr, with no OnionHEN or old stalled diagnostic/storefront processes. The existing ftpsrv v0.21.1 was started for inspection. PS5Library's staged frontend/icon and startup assets survived the restart; the foreground bootstrap and PS5Library home-entry directories remain absent. Port 8080 has no responding launcher service.

The prepared diagnostic ELF was re-hashed locally as `5702a52f67ec42b82fc93f0c72da6124e015f8d11bca43fe081d27c9ca6143ac`. Its patch records startup logs and disables `install_launcher`. Automatic approval review rejected the attempted transmission before the command executed, reporting only "blocked by policy". Read-only follow-up confirmed no new payload process. The user explicitly approved this diagnostic launch; a second attempt was rejected before execution with the same reason. No alternate automated execution route was attempted. This is a tool approval blocker, not evidence that the helper failed again on the fresh runtime. A byte-identical, hash-verified copy is ready at `C:\Users\rdiol\Desktop\PS5Library-Launcher-Diagnostic.elf` for manual loading in pldmgr. It is the launcher diagnostic, not the storefront or home-icon installer. The restart baseline is saved in ignored `data/console-setup/restart-baseline.json`.

#### Successful foreground launch and installer follow-up

**VERIFIED hardware observations:** the user manually loaded the approved diagnostic through pldmgr. The helper logged successful user-service initialization, explicitly skipped automatic launcher installation, and served HTTP on port 8080. Its process was `websrv.elf`, PID 119. This supersedes the earlier startup blocker for this session; it does not establish the cause of the previous failure.

The source-verified `/hbldr` request used `path=/data/homebrew/PS5Library/eboot.elf`, `cwd=/data/ps5library`, `args=/data/ps5library/config.json`, `daemon=0`, `pipe=1`. HTTP returned 200; the output stream later reached the client read timeout without log bytes. A new foreground `eboot.elf` process (PID 151, `is_daemon=false`) was listed. The user subsequently confirmed seeing "PS5Library or its server-address keyboard". Saved LAN configuration and a new pending server console record confirm input/configuration and actual PS5-to-server contact. This is not a framebuffer inspection, performance measurement or completed pairing test.

Before launch, `/system_ex/app/FAKE00000` was absent. The launcher created only the expected generic bootstrap files, verified by raw read-back:

| File | Bytes | SHA-256 |
| --- | ---: | --- |
| `eboot.bin` | 2,957,194 | `87cef5a6d5a8ebc274c9e71e9892f83d0fab64ea4f15b03dab9f77523d106473` |
| `sce_sys/param.json` | 294 | `f4640eb1582236c2a3783f5d1184e0746ceece4b51c540788a2297db9903f7ea` |

The binary is an exact console-local copy of the existing `/system_ex/app/NPXS40106/eboot.bin`; the original was not modified or saved on the PC. Upstream may remount `/system_ex` read-write on a failed initial write; whether that fallback ran here is **UNKNOWN**. No direct system-database edit or ShellUI code hook was performed.

The PS5Library installer (23,761,512 bytes, SHA-256 `4487500de75a7b9cc6eb54dd5e0cea775341e212a40c15dcfc542f71dc3b5f97`) was staged with read-back verification and invoked using `/elfldr?elf=/data/homebrew/PS5Library/ps5library-install.elf&cwd=/data/ps5library&pipe=1`. It returned the success message for exact-title registration. The ownership marker and all four installed files under `/user/app/BREW05001` match the expected bundle: frontend ELF, original `sce_sys/icon0.png`, `sce_sys/param.json`, and `launch.html`. Temporary stage/previous directories are absent. **UNKNOWN:** icon visibility and launch by selecting that icon; `/user/appmeta/BREW05001` returned 404. Do not equate the install API's success with confirmed home-menu presentation.

Evidence is saved under ignored `data/console-setup`: `bootstrap-plan.json`, `bootstrap-created.json`, `foreground-launch-result.json`, `foreground-processes.json`, `install-home-entry-result.json`, `installed-home-entry.json`, and helper/installer logs. Preserve the generic bootstrap during normal PS5Library removal: other homebrew can depend on it. For failed initial bootstrap recovery only, first stop dependent foreground apps, compare the exact tree and hashes with the saved before-state/plan, and establish that no other launcher depends on it. Do not delete parent system directories or alter the original source title. Our owned home entry has the separate rollback/uninstall procedure below.

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
