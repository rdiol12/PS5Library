# PS5 system integration

## Agent-mediated native title transition - 2026-09-27

**VERIFIED HARDWARE:** normal return from the installed `PPSA99051` storefront is reported as a crash by the current firmware/runtime. The working transition is owned by the already-running agent: an authenticated local request carries one exact inventory-backed title ID, the agent verifies the active BigApp resolves to `PPSA99051`, calls `sceSystemServiceKillApp`, waits until the BigApp slot is empty, then calls `sceSystemServiceLaunchApp` with the current foreground user and a 32-byte initialized context. The user confirmed the game opened. The durable receipt records `PPSA99783`, `ACCEPTED`, user result 0 and launch result 16407; the target process remained alive. No ShellUI hook, system-file change or database edit is involved.

The same exact-title close operation backs Circle on a root storefront page. `sceSystemServiceNavigateToGoHome` remains banned because it failed prior hardware tests. The agent processes an accepted transition before potentially blocking network work. AppInst/launcher/uninstall/move calls share one mutex and a 200 ms post-call settle period, matching the verified upstream concurrency rule; a busy initializer delays the transition instead of overlapping system stubs. Host parser, native-download, application-lifecycle and release-boundary checks pass. The race-hardened agent is deployed; a second visible launch and root-Circle close remain physical confirmation items.

## Direct storefront-agent channel - 2026-09-26

**VERIFIED HARDWARE:** the installed title's attempt to connect to an agent-owned Unix socket in PPSA99051's live mount fails with `EPERM`; mode and path changes cannot bypass that sandbox policy. The agent now initializes `SceNetCtl`, binds TCP only to the console's exact private IPv4 address and rejects an accepted peer before request parsing unless its source IPv4 equals that same address. A separate LAN machine can complete the TCP handshake but receives no response. Every accepted request still requires the local bearer and bounded route parser.

**VERIFIED END TO END:** content `01.036.000` reaches agent 0.2.46 through this same-console endpoint. A fresh launch authorizes the saved Library Node, completes pairing with a separate agent credential and exposes the agent's 21-title inventory, kstuff runtime, storage, ShadowMountPlus 1.7beta2 and local artwork/music routes. The title mount carries only `frontend.lock` for lifecycle discovery; the rejected mutable snapshot/control bridge is absent. Host checks cover responses larger than 8 KiB and hashed Range media, while both PS5 cross-builds and loader gates pass.

## Direct native title launch - 2026-09-18

**IMPLEMENTED / HOST VERIFIED:** the isolated native storefront no longer requires WebSrv to launch a game. Play is offered only for an exact `PPSA#####` or `CUSA#####` title whose non-DLC release is `READY_ON_PS5` and registered or reported as an installed title. After the storefront releases its SDL resources, the native bridge obtains the foreground user and calls `sceSystemServiceLaunchApp` with an empty argument list. The payload build keeps its existing validated `/launch?titleId=` route.

The bridge rejects malformed IDs before any native call and propagates foreground-user and launch failures. Its runnable boundary check covers invalid IDs, both PS5 and PS4 IDs, user lookup failure and exact argument forwarding. The native app build asserts that `sceSystemServiceLaunchApp` remains a real unresolved system import; the built FSELF is 34,367,794 bytes with SHA-256 `e547d54db7a296536de3a745f0d6db844c33ffe26f90325326376482e81d82fe`.

**HARDWARE UNKNOWN:** source-backed ABI and a successful link do not prove that an arbitrary installed game launches on firmware 4.51. The native storefront package itself must first pass the corrected kstuff-lite mount/startup retest. Then Play must be checked with one already inventoried title, including visible handoff and return behavior. No ShellUI hook, system-file change or Sony service emulation is involved.

## Native FPKG runtime handoff - 2026-09-18

The isolated native package now crosses the installer boundary: AppInst returned success, title/appmeta records appeared, and the installed mount-image bytes matched the source package. Launch stopped at PPR verification with `0x80020060` and an EICV `verifyImage` kernel record, before the app executable ran. The package installer is therefore no longer the current blocker.

The loaded original kstuff handles the older `verifySuperBlock` path. Current kstuff-lite adds a 4.51-specific `verifyImage` path for a strictly marked plaintext outer PPR. PS5Library now builds that profile and verifies its FIH geometry, PFS fields, marker, identity and complete inner-file readback. The matching kstuff-lite ELF and package have passed console readback and are staged under distinct diagnostic paths. The previous `PPSA99051` registration was cleanly uninstalled; released `BREW05001` was not changed.

**HARDWARE RESULT PENDING:** a running kernel payload cannot be safely exchanged. Payload Manager autoload is temporarily disabled through `/set_config`; its prior enabled state and unchanged list are saved for restoration. Reboot, rerun the exploit, start Payload Manager, and load the staged `ps5librarykstufflite451.elf`. Only then install and launch the staged diagnostic package. Success requires the title to mount, reach native `EXEC`, render, and produce its app receipt; an installer return alone is insufficient.

## Cold-boot jailbreak research - 2026-09-17

**CURRENT RESULT: NO COLD-BOOT EXPLOIT.** The 4.51 console has a one-click offline WebKit/umtx2 launcher and Payload Manager autoload after that launcher is selected. This is post-boot execution and does not make the jailbreak run automatically when power is applied.

**VERIFIED HARDWARE:** the accessible OS exposes secure-loader and flash device nodes, but no PSP BootROM file/device. We used the already reviewed ftpsrv process credential in one-shot read-only helpers to identify the Sony SFlash master block and inspect only its four small firmware partitions. Current `ps5-wee-tools` identifies them as two EMC IPL banks and two USB PDC banks. The EMC containers are byte-identical but their main payload is still opaque; the differing PDC banks contain ordinary Thumb USB-controller code. None is the on-chip ROM. No flash, OTP, firmware-update, system-title or database write occurred. Temporary console research files and payload files were removed and the 0.2.10 storefront plus core jailbreak processes remained running.

**VERIFIED PRIMARY RESEARCH:** the [39C3 pAMDora talk](https://media.ccc.de/v/39c3-opening-pamdora-s-box-and-unleashing-a-thousand-paths-on-the-journey-to-play-beatsaber-custom-songs) distinguishes the immutable PSP ROM from the authenticated off-chip bootloader. Its ROM extraction required hardware DMA/reset work on a desktop board with the same SoC, and the talk says the findings do not all transfer to the console. Current [ps5-uart](https://github.com/symbrkrs/ps5-uart/tree/dba2c9c3201f7eee21b75e8913ee356a70ce4a37) likewise requires opening the console and attaching UART/Pico hardware. It publishes a Salina/EMC ROM-dump routine, while its README says other boot-ROM/key extraction methods are omitted. This is a physical research path, not an always-on software jailbreak.

**VERIFIED UPDATE PATH:** decrypted 4.51 SysCore, ShellCore, PupUtil Server (`NPXS40091`) and `libSceUpdateService` expose the authenticated boot/update control flow. PupUtil validates PUP signatures/segments, writes standby SFlash banks and switches the EMC bank; ShellCore verifies signed root parameters and coordinates VSH/system-ex bank switching. The supplied system PUP matches the published 4.51 hashes. A private hardened `ps5-pup-decrypt` build ran on the already-jailbroken 4.51 console and invoked only its six PUP verification/decryption ioctls. It temporarily gave its own process the live updater credential, left the updater process unchanged, decrypted the bounded 26-segment image with result 0, restored its original credential with result 0, and exited. No flash, update-install, bank-switch, OTP, reboot or system-database operation exists in that build.

**VERIFIED OUTPUT / PROTECTION BOUNDARY:** the result is 913,931,916 bytes with SHA-256 `8c2e9ec06b53c26deade7058e3c4f89809dbaa45be3d0edc3707f2637bd74715`. Its PUP header, all 26 ranges and seven direct boot-related ranges pass independent bounds and whole-file integrity checks. Current upstream maps them to update-mode, MBR, kernel, Floyd, USB-PDC and Oberon secure-loader records. The 21,757,952-byte kernel and the two Oberon records remain opaque high-entropy data with no ELF/SELF header; the record labelled `updatemode.self` begins a second valid PUP; one USB-PDC payload exactly matches the console's installed bank. Large system/system-ex/WLAN and compressed records are not independently unpacked. This is an authenticated update image, not the on-chip ROM or a cold-start execution primitive.

**VERIFIED AUTOMATIC POST-KERNEL BOUNDARY:** signed system service `SceSpZeroConf` (`NPXS40112`) is running and exposes an unauthenticated Mongoose HTTP listener on TCP 41800 plus mDNS handling. Its `/spConn?action=getInfo` path answered an ordinary read-only request. Static fingerprints identify Mongoose 4.0/4.1-family code and a Sony mDNSResponder 320-era fork with selected later changes. The published CVE-2015-7987/7988 function set begins in upstream 379.27 and is absent from this ELF, so that known remote-code-execution lead does not apply on current evidence. The original process remained running and unchanged after read-only extraction.

**NEXT SOFTWARE TARGET:** exercise the matching HTTP parser only in an offline sanitizer harness and map the remaining compiled mDNS packet functions before any malformed console traffic. Treat every candidate as unverified until a reproducible flaw exists. A service flaw would provide post-boot userland execution, not bypass kernel protection; a complete automatic jailbreak still needs a kernel-stage vulnerability and chain. Repeating extraction will not bypass the protected kernel/Oberon layers. Raw flash writes, OTP access, update installation and system-state mutations remain excluded from software experiments.

## Continuous native candidate - 2026-09-17

**VERIFIED HOST:** `ps5/native/main.cpp` now has separate app and diagnostic compilation modes. The app mode calls the real storefront without a frame limit, capture script or automatic Home request, and returns to the source-built CRT's normal exit path. Only probe mode records repeated lifecycle traces and holds a failed/finished test process for collection. App errors are bounded, owner-readable local files. Both modes retain the source-verified keyboard/IME setup and experimental guarded native-status bridge.

The shared visibility handler now tracks application state separately from window focus. A focus-gained/restored event cannot resume rendering or input while the application remains backgrounded. The new checks reproduced both the incorrect focus override and the diagnostic-only entry before the changes. All 16 host CTests pass, including the actual native wrapper's no-auto-Home behavior, background/foreground transitions, transient status failures and malformed ABI rejection. These mock system calls do not establish physical Home or exit behavior.

Build with `--mode app` for the continuous candidate under `ps5/build/native-app`, or `--mode probe` for the bounded diagnostic under `ps5/build/native`. The diagnostic remains the default for compatibility with the recovery runner. Both use the isolated test title PPSA99051 and cannot be installed together. Each output records its mode and hash in `build.json`; the private staging helper rejects an app build when collecting bounded diagnostics. Neither output is a released update.

App mode also includes `dist/ps5library-agent.elf`, with its hash in the build record. The agent uses the already registered private configuration at `/data/ps5library/config.json`, runs without a window and uses the existing agent lock. Native UI pairing does not supply this privileged credential. First-time agent provisioning, confirmed startup through the user's loader, normal application install/update/recovery and persistence still require integration/console tests. No autoload settings are enabled by the build.

Current verified build outputs: app FSELF `b96ed50ea2e488bbbb08581185290472ccef8a6be88dbc9dc198ff5dd3c4dc0f` (34,390,946 bytes); standalone agent `b68d29f3b3470c5e548099e57e42098eb7d5886bed3c527be7b1b5f31aa996bc`; bounded probe FSELF `39a84cb9d598539ed668a39bcee1371d65bd7e16ff826ed0b12bed62474d009e`. Both native builds pass readback/runtime checks. The ordinary app/agent cross-build also passes its loader-dependency checks. The app FSELF is installed inside the owned PPSA99051 test package; this run did not install or alter the standalone agent or bounded probe.

## Actual storefront native startup - 2026-09-17

**VERIFIED HOST:** `ps5/native/build.py` links the existing storefront and dependencies with native startup code from pinned ProsperoTV source. It produces an isolated PPSA99051 FSELF; it is not the public updater artifact. `python ps5/native/verify.py` checks exact round-trip data preservation, allowing only the pinned format's omitted non-mapped build-ID note. Runtime generation matches the expected hash. Native UI data uses `/download0/ps5library`; embedded privileged inventory/transfer work is excluded. The server-mediated agent connection is described below.

**VERIFIED HARDWARE:** the complete executable reaches native main and passes allocations/strings, exceptions and thread creation/join. Its first SIGSEGV was localized by stages and symbolized kernel stack to SDL's `sceKeyboardInit`. UserService returned 0 immediately before that call. The native-only probe reports optional USB-keyboard initialization/open unavailable. The next caught error was a legacy font path; resolving it relative to the actual data directory fixed the failure. A further signal was localized to `sceImeDialogInit`; CommonDialog initialization and loading IME module `0x0096`, following pinned ProsperoTV source, fixed it. CommonDialog, module loading and IME initialization all returned 0.

**VERIFIED NATIVE RENDERING:** capture `capture-1789635493` completes 180 real storefront frames, returns 0 from the application, and preserves an 8,294,522-byte 1920x1080 BMP. Visual inspection confirms the actual branded connection UI, not a test pattern. FSELF SHA-256: `308c7921e306125db6960420890c1239cba5c4dd36885d4b917daaf02ca36c93`. The full-store Home/resume test follows this startup milestone; controller input, HDMI sound, authenticated server access and other firmware remain unverified in this target.

**VERIFIED FPKG STARTUP / 2026-09-19:** the continuous storefront build was packaged through Publishing Tools 2.79's plaintext profile and installed with AppInst on firmware 4.51. Installed image size/hash are 44,433,408 bytes / `e48f3fc77b947e9d58c5616314da45553710c1918a5dac78e1eb415e63646f1f`. The native process is alive as PID 135 with 228.6 MiB resident memory; its isolated `/download0/ps5library` data directory was created and `performance-live.json` continues to update. This verifies the real storefront executable reached its loop. The user's visual confirmation, pairing and Home/resume are the next physical checks.

**BUILT / NOT HARDWARE TESTED:** the next experimental probe maps the guarded native status's background byte into the existing SDL visibility events. Its bounded test requests Home, records real presentation counts while hidden, then checks that the exact same title resumes rendering. It first aborts its own active input dialog. The collector requires sustained background state with an unchanged frame count, later resumed presentation, and successful completion of all 180 frames. FSELF SHA-256: `6ca287365a460c309dc48a217c97c96dfb1a5f03f93e6a4d3b2c9ca16fa95d39`. A second build in the checked-in Dockerfile's clean `ps5library-native-build:0.2` image reproduces this hash and the expected runtime hash. This automated probe must never be substituted for the released app.

**CURRENT RECOVERY POINT:** `capture-1789635968` ended before staging the lifecycle candidate. Preflight had verified the test title paths absent. After closing the known, advancing 0.2.10 process, the manager's process-list request timed out; subsequent manager/websrv reads failed and a single read-only PS5 discovery request timed out. No native launch or title installation occurred in this attempt. The installed app/update are unchanged, but reopening the store could not be verified. The console may have entered power saving (earlier logs repeatedly reported its idle timer expired), but this is not established by a timeout. Both service connectivity and the console's actual state need checking before another launch. The uploaded diagnostic helper remains at its own `ps5librarynativehometestinstall` payload path, with hash retained in the local build. Server catalog query confirms zero PPSA99051 entries.

The private runner now writes its baseline before closing the store and keeps closure inside the recovery `try/finally`. A partial stage receipt marks the source as staged even if the following scan request fails; a lost connection records recovery pending. A proposed native signal-context dump was discarded because the SDK context fields did not provide a trustworthy stack pointer; initialization boundaries supply the evidence instead.

### Native app and agent account connection

**VERIFIED HOST:** migration 023 distinguishes `FRONTEND` and `AGENT` credentials. `pairFrontend` in `ps5/common/client.cpp` persists a random app identity, requests `/api/v1/frontend/pairings`, polls the existing short-lived handoff and saves the credential before its first authenticated request acknowledges delivery. The owner enters the code in the companion and selects an already registered PS5. Cross-owner selection is denied; the app does not register a second console or overwrite its saved firmware. Browser and SwiftUI source expose this selection; the iOS change still requires Xcode validation.

The native UI runs pairing/networking on its existing asynchronous request worker. Its credential may browse the owner's catalog/profile/consoles and request installations, refreshes or confirmed removals. A central route allowlist denies physical-state reports, transfer tasks, native download grants, notification acknowledgment and the payload updater. An agent heartbeat cannot consume the app's pending credential. Revoking the app credential leaves the agent intact; native OS download grants additionally require an active **agent** credential.

The storefront also polls an owner-scoped job-event cursor once per second on its own worker and requests a full model refresh only after a new event. The five-second refresh remains as recovery if an event is missed. Browser/iPhone WebSockets remain unchanged; the pinned host and PS5 libcurl builds do not advertise `ws`/`wss`, so native WebSocket calls would fail before reaching the server.

Runnable checks: `server/tests/integration/frontend-pairing.test.ts` uses isolated PostgreSQL/Redis state to verify ownership, persistence and denied authority. `server/tests/native/frontend.test.ts` runs the actual C++ UI with the native branch enabled, checks pending/expired/claimed codes, account data and restart persistence, and rejects agent/updater requests. `server/tests/native/agent.test.ts` sends an installation request with a frontend credential, then verifies the separate C++ agent's checksum-checked delivery and inventory in host simulation. It does not prove native PS5 network access or installation APIs.

**EXPERIMENTAL / NOT DEPLOYED:** the preceding pairing-only native probe FSELF was `362a9c5c3683481691de2b35fcf1c72f117322d9f1463eb3fb8279d586bd5c09` (34,371,970 bytes). Its raw native ELF is `1b211427c4eb6a42e909bbbbe71ef57a5f6000fccc5eecb680aa4c5a7c34c0be`. Readback, source runtime and no-embedded-agent link assertions pass. The installed 0.2.10 payload remains unchanged; no production server migration or app update was deployed for this work. Launching the separate persistent agent alongside a native title, authenticated requests from the sandbox, Home/resume and a native installer/updater still need console validation. The automatic Home probe is a diagnostic, never a production entry point.

### Reproduce the experimental build

First complete the normal PS5 cross-build described in the main README. Use an unmodified ProsperoTV checkout at `fdee81e746308f7f2b27f7914a84eab678088fb6` under `upstream/ProsperoTV`.

```powershell
docker build -f docker/ps5-native-build.Dockerfile -t ps5library-native-build:0.2 docker
docker run --rm --network none -v "${PWD}:/workspace" -w /workspace ps5library-native-build:0.2 python3 ps5/native/build.py --upstream upstream/ProsperoTV
docker run --rm --network none -v "${PWD}:/workspace" -w /workspace ps5library-native-build:0.2 python3 ps5/native/build.py --upstream upstream/ProsperoTV --mode app
python ps5/native/verify.py
```

Output is the isolated test title under `ps5/build/native/dist/PPSA99051`. The build consumes no copied system module, user credentials or dump. CommonDialog's source-built stub is used only for import metadata and is not shipped. Deployment still requires a mounted source, executable permissions on `eboot.bin`/`sce_module/libc.prx`, exact-title recovery and a reachable console. The host-tested pairing flow still needs a separately running agent and physical console validation; this is not a distributable store replacement yet.

The collector now atomically replaces its previous private evidence file; exclusive-create semantics had prevented one follow-up capture. Each attempt uses hash-verified source, the separate test title and exact-title removal, then verifies a fresh released 0.2.10 startup with at least 300 frames. No production frontend, launcher, system file or runtime version was replaced. Detailed receipts and kernel captures remain private under `data/console-setup/home-0.2.9/native-title/`.

**RUNTIME RECOVERY:** ShadowMountPlus had logged sleep entry on a shutdown flag and stopped its API. A read-only flag probe later reported WORKING and a cleared shutdown bit. Its own source-verified graceful restart path, using the same installed payload, restored the API. No system event flags were changed. The suspected missed cancelled-shutdown transition remains an inference.

## Native Home state round trip - 2026-09-17

**VERIFIED HARDWARE TELEMETRY:** the separate PPSA99051 native test now records entry, first submitted frame/vblank return, and 30 guarded status samples. On the user-reported 4.51 console with ShadowMountPlus `1.7alpha13fix1-11-g2424c9`, `sceSystemServiceNavigateToGoHome()` returned 0 at about five seconds; raw status byte 5 changed from 0 to 1 on the next 500 ms sample. The status calls all returned 0 and all trailing memory guards remained intact. ShellUI logged `AppScreen -> Render.NPXS40002`. The native process remained alive.

A second bounded test requested that exact, still-running title through `sceSystemServiceLaunchApp` at about ten seconds. The call returned **`0x8094000c`**, while the same process's uninterrupted receipt showed byte 5 changing back to 0 and ShellUI logged `Render.NPXS40002 -> AppScreen`. Do not treat that nonzero code as proof that no foreground action occurred. Native PID 455 had one recorded `EXEC`; this was not a fresh application start. Native close subsequently returned 0.

**LIMITS:** these correlated state/scene transitions support a native background/foreground path for this small, single-frame test. No person observed the display during these runs. A background-only capture also contains a ShellUI unobserved-task exception with code `0x80960009`; its cause is unclassified and it is not evidence of a clean visual transition. Continuous storefront rendering, controller input after resume, audio, and other firmware remain unverified. The full 0.2.10 store still uses its existing payload launcher and its Home issue is unresolved. Next: a native frontend build with its real C/C++ dependencies, then lifecycle-driven render/input/audio suspension and physical resume verification.

The native test's 0600 receipt initially denied the daemon collector (`EACCES`); the diagnostic-only file now uses 0644, explicitly applied to its open descriptor. Fixed binary records avoid depending on the template's incomplete C formatting runtime. No user credentials are in these records. The final receipts contain exactly 33 records / 924 bytes. Evidence: `capture-1789629013` (background) and `capture-1789629172` (background/foreground), under the private native-title evidence directory. Native test FSELF SHA-256: `650f03fd3b4889698311b8245918d14f39a16a6a3f52e8bcf8b7720c5b9f2b87`.

One immediate uninstall request failed after the resume test. Its owned source was restored by the rollback path; a later exact-title retry succeeded. All test source/title/appmeta paths returned 404, its temporary catalog inventory entry was removed, and the installed 0.2.10 store recovered with a fresh receipt and 300 frames. Experimental native-title files and logs are not part of the public release.

## Native title comparison - 2026-09-17

**VERIFIED HARDWARE / STARTUP CORRECTION:** immediate capture narrowed the mounted failure to `sceLncUtilLaunchApp` return `0x80aa001a`, `errno=13` (`EACCES`). The bundle publisher had written `eboot.bin` as 0644. Changing it to 0755 allowed native `EXEC`, but the runtime loader then rejected `/app0/sce_module/libc.prx` with a mount/attribute error and `PRX_SCE_MODULE_LOAD_ERROR` (`0xa0020102`); the user saw a corrupt-data error. That PRX also requires execute permission. Both known executable files now publish as 0755, with failing-before/passing-after installer regressions. The final mounted reproduction (`capture-1789626350`) returned `0x4017`, reached native `EXEC` with no earlier loader fatal error in the immediate capture, and `sceSystemServiceKillApp` returned 0. The user subsequently reports startup without an error. The exact owned test was removed and 0.2.9 recovered with a fresh receipt and at least 300 frames. A listed process alone is insufficient evidence: the previous crashed process remained suspended in the process list.

**UNKNOWN:** visible Home/resume and continued storefront rendering. The later native state round trip is recorded above; the user is away from the console and visual confirmation is unavailable. This small test is not a complete native PS5Library build. Earlier failures below describe the diagnostic sequence, superseded for startup by the permission correction above.

**VERIFIED HOST:** built pinned native-app boilerplate `722f2227a8bb6fa2229120546995b6562552c752` as the separate title **PPSA99051 / PS5Library Home Test**, without porting or replacing the storefront. The generated runtime reproduces SHA-256 `e6ff45d16adf687855cc3b33b0c8a4132b6504360b221e0a34c7e99fb3ba0036`. Its eight host checks pass; our installer bundle/rollback checks and 14-test host suite pass. ELF dependency-order verification passes for the diagnostic installer.

**VERIFIED HARDWARE FAILURE:** direct registration of the title folder returned 0 and all five deployed files passed SHA-256 readback. The single native launch returned HTTP 503, no `eboot.bin` survived the 20-second observation, and the user reported "Can't start the game or app" without a recorded error code. The exact test title was uninstalled successfully; its `/user/app` and `/user/appmeta` directories were confirmed absent. A recovery-script keyword collision initially prevented automatic restoration; that local script was corrected and the explicit recovery then confirmed a new 0.2.9 startup with 60 rendered frames.

**VERIFIED SOURCE:** the template's `docs/DEPLOYMENT.md` requires a loader such as ShadowMountPlus and a mounted application folder. ShadowMountPlus `sm_install.c::mount_and_install` mounts the source with `mount_title_nullfs` and writes `mount.lnk`; plain AppInstUtil registration does neither. Direct registration failure therefore did not establish that the native runtime was incompatible with 4.51. The running local API reports `1.7alpha13fix1-11-g2424c9` and supports scan, inventory and uninstall; configured scan roots are empty (upstream defaults apply).

**VERIFIED HARDWARE FAILURE / MOUNTED COMPARISON:** the same native build was atomically published under the separate source `/data/homebrew/PPSA99051`; all five files again passed readback hashes. ShadowMount reported successful registration, mounted the source at `/system_ex/app/PPSA99051`, and recorded launch-mount/sandbox readiness at 10:04:20 and 10:04:22 console log time. The user reports the same launch error, and no native process remained. The diagnostic hid only its owned source, requested exact-title uninstall through the local API, and removed the verified bundle. Source, quarantine, title and appmeta paths all returned 404. Store version 0.2.9 subsequently had 300, then 5100 live frames. Mounting alone does not solve the failure. The later bounded kernel-log read retained cleanup but no launch error; immediate capture was added to the diagnostic for the next reproduction.

The test draws one static frame and stays alive. Even successful Home behavior would establish only this small native title's behavior, not continuous storefront rendering, audio, resume or all jailbreakable firmware. App FSELF SHA-256: `d791f65c5a62aec4d70c4e9c6b8b0baeeefbf51a41dd774287e1353f66af2966`. Private evidence: `data/console-setup/home-0.2.9/native-title/`. Published version remains 0.2.9.

## Physical Home investigation — 2026-09-17

- **VERIFIED:** the user confirms 0.2.9 opens normally, but PS → Home leaves the storefront visible. A separate minimal SDL test, with a visible five-minute countdown and no controller/audio/storefront initialization, reproduces that failure while it is still running. The earlier two-minute test was inconclusive because the user could not distinguish Home from its automatic exit.
- **VERIFIED OBSERVATION:** guarded app-local `sceSystemServiceGetStatus` calls return success. Raw byte 4 changes between 0 and 1 during the interaction; raw byte 5 stays 0. No write beyond the source-declared 136-byte status was observed. This is evidence from this launcher/firmware session, not a portable suspension contract. The daemon's cross-process state query returns `0x80020001` and cannot supply a replacement signal.
- **VERIFIED OBSERVATION:** using the initial-user query fails with `0x80960006`; the foreground-user query succeeds, but `sceVideoOutOpen` with that user returns `0x80290001`. The SYSTEM (`0xff`) route opens successfully. The local route was tested after correcting the diagnostic's argument scan: this launcher supplies three arguments, with the option after the supplied executable name.
- **EXPERIMENTAL / NO FIX:** an isolated copy of pinned websrv's loader explicitly sets its launch-context size to 32. It launches the probe but produces the same local-user lookup/display failures. It does not replace websrv or register a title; it refuses to run if the existing fake application's files are absent.
- **VERIFIED OBSERVATION / NO FIX:** the source-declared `sceSystemServiceNavigateToGoHome()` returns 0 in the foreground probe, while the process stays alive and the raw background byte remains 0. The user confirms the blue countdown remains visible, including on a repeated automatic test. API success does not establish Home or resume support. The installed 0.2.9 store was subsequently restored and produced a fresh 60-frame startup receipt.

Diagnostics are private, source-built and bounded. The display probe automatically closes after five minutes (330-second watchdog); the app-state probe takes 120 samples and exits. Production app/launcher files and the published 0.2.9 update are unchanged. Evidence is retained privately under `data/console-setup/home-0.2.9/`. Current display-probe SHA-256: `ab0ca8a28c2668f082397feda160d5d25f107db4f9e25cc5889397c0ba960fc2`; app-state-probe SHA-256: `b03facf2eb60827501dcc5700718880df20883ca4e576ecccde62288ba2166a7`.

## Research protocol (2026-09-16)

This protocol covers the missing native application/system UI integration. It is an experimental work plan, not a declaration of supported firmware or completed features. The console remains unavailable on the local network; this research pass only read source, inspected our existing probes and checked a local binary hash. Research pins and limitations are recorded in [RESEARCH.md](RESEARCH.md#native-ui-research-follow-up-2026-09-16).

### Evidence required

- **VERIFIED SOURCE:** exact repository commit, file, function, argument/structure layout and observed source behavior. An exported function name alone does not establish its calling contract.
- **VERIFIED HOST:** a reproducible build or test, its artifact hash and actual output. Stubbed OS calls do not establish console behavior.
- **VERIFIED HARDWARE:** exact firmware, runtime/loader versions, app build/hash, process context, return codes, timestamped observation and recovery result. Scope a result to that tested combination.
- **LIKELY:** a hypothesis with a named observation that could disprove it. Current example: the shared BigApp/display ownership may contribute to Home failure; the cause remains unproved.
- **UNKNOWN / EXPERIMENTAL:** missing evidence or an unvalidated change. These remain distinct from a successful feature.

### Ordered experiments

| Order / gap | Work available on the development PC | Controlled console experiment / acceptance |
| --- | --- | --- |
| 1. Exact baseline and Home failure | Review `tests/system_ui.cpp`, SDL `PS5_PumpEvents`, websrv BigApp startup and the log-observation reference. Establish a small set of correlated signals; do not infer foreground from a process merely existing. | Record actual firmware/runtime/loader and app hash. Observe store -> Control Center -> Home -> return, with monotonic timestamps, app ID/PID and raw state. Opening Control Center must be distinguishable from backgrounding. Repeat with a working title as a control. The existing probe does not yet collect kernel lifecycle logs. |
| 2. Direct native launch and persistent app data | Compare boilerplate/ProsperoTV startup, import tables and native FSELF construction with our payload CRT. Audit libc++, exceptions, TLS, threads, filesystem, curl/OpenSSL, SDL and FFmpeg dependencies. Prepare a minimal separately identified native title before porting the storefront. | The test title launches from its own home entry, draws, receives input, exits and relaunches without the browser loader. Verify a bounded test record survives relaunch in the supported app data mount. Then verify pairing/settings migration; never infer `/data` permissions from payload behavior. This native test title is not built yet. |
| 3. Home/background/resume | Use observed lifecycle evidence to establish the correct native event ABI and display/audio ownership. Reuse our existing `Visibility` handling once a real event source is verified. Preserve focus, screen and job state. | Ten Home/return cycles preserve the same process when suspension is claimed, stop drawing/audio while hidden and restore controller focus. Explicit Close terminates cleanly. Test rest/resume separately. A restarted app restoring saved state does not count as suspension. |
| 4. HDMI audio, trailers and home presentation | Reuse `tests/audio_device.cpp` and the current audio counters. Compare a known generated PCM tone through SYSTEM and foreground-user routes, then decoded media through the same sink. Inspect icon/background/selection-audio assets independently of in-app music. | Confirm actual audible tone at modest TV volume, record which route worked and API errors, then test navigation/music/trailer handoff and Home mute/resume. Confirm the tile icon, selected background and launch presentation visually. Successful AudioOut calls alone do not pass. |
| 5. Native notifications and keyboard | Check SDK sample structures against our helper and retain capability gating. Test keyboard accept/cancel/focus restoration separately from notification calls. | A uniquely labelled diagnostic notification appears while foreground/background without duplicates. Verified-ready notifications require completed installation/inventory. Keyboard accept/cancel returns control to the correct field; native helper invocation is not proof of visible delivery. |
| 6. Native FPKG Downloads and completion | Compare the existing URL adapter with singleDPI/etaHEN and the conflicting ps5upload status reports. Verify ABI sizes, privileges, initialization context and supported content types. Retain exact file/metadata/inventory completion checks. | Install a small owned homebrew base package with a unique identity. Observe the actual native queue, progress, cancellation, failure and completion, then launch it. Close the storefront during download and reopen to reconcile state. Test update, DLC and external destinations as separate cases after the base route passes. Status polling remains disabled pending evidence; initialization alone cannot enable a verified capability claim. |
| 7. Background service, launch and storage operations | Trace agent lifetime separately from frontend lifetime and OS-owned download tasks. Reuse owner-scoped jobs, receipts and inventory reconciliation. Prepare small owned artifacts for ShadowMount and installed-package paths. | Determine whether each task continues when the UI is hidden, suspended, closed or the console enters rest. Verify ShadowMount overlay placement and rollback, Play, actual installed title/version, missing-content reconciliation and targeted test-content removal. Network threads in a suspended process are not evidence of a persistent agent. |
| 8. Deeper ShellUI and firmware coverage | Study etaHEN hook call sites only after native app/service boundaries are understood. List exact module/function signatures and a recovery mechanism for each proposed experiment. Maintain a firmware x runtime x loader x capability test matrix. | Any hook experiment has an exact matching module, saved original state, explicit experimental enablement and verified restore/disable path. Start with 4.50. Validate other combinations independently before advertising them; do not extrapolate from the native template's 6.02/12.70 or singleDPI's 5.50 results. |

### First console session

1. Save an environment receipt and verify the chosen diagnostic binary hash. Existing `ps5/build/ps5/system-ui-check.elf` is 9,453,512 bytes, SHA-256 `a29a3f2768c279edbdc00fb4a45b0302a5744f32ef1d6247e0caf9f4bf22ae61` as inspected on 2026-09-16. Its `firmwareSdk` field is the SDK baseline, not an exact system-firmware measurement.
2. With the store running, start that one-minute probe through the separate payload-loader path. Record a short baseline, Control Center, Home and return with action timestamps. It writes `/data/ps5library/system-ui-probe.json`, exits automatically and changes no title registration or ShellUI hooks. Do not interpret an absent sample or unexplained raw state as successful suspension.
3. Compare the recorded app state with the screen observation. If more evidence is needed, extend the owned probe with bounded, timestamped, title-correlated observations; avoid publishing unrelated system log contents.
4. Run the separate bounded audio test, then notification/keyboard checks. Native installation and title-port tests follow after their build and environment prerequisites pass. Stop on an unexpected crash and preserve the receipt instead of automatically repeating the operation.
5. Change one variable between comparisons. Reproduce a failure, apply the smallest justified fix, rerun that failure and the relevant regression checks, then update the capability matrix and STATUS.md.

No new native title, event bridge, background service, ShellUI hook or physical result was produced by this documentation/research pass. Existing public app version remains 0.2.7.

## Native download integration ? 0.2.7

**VERIFIED SOURCE / CROSS-BUILD:** `ps5/agent/native.cpp` calls the documented AppInstUtil package-URL entry point. It is a native download/install service request, not a custom progress window styled like ShellUI. Only initialized adapters advertise nativeDownloads/fpkgInstall. No ShellUI hooks or system-file modifications were added.

**UNKNOWN ON HARDWARE:** native queue appearance, package acceptance on this user's 4.50 runtime, external storage behavior and final installation/launch. The source boundary test checks URL origin binding, initialization once, package identity and native error propagation using the OS-call test boundary. It is not a console test. `sceAppInstUtilGetInstallStatus` is deliberately not called because pinned ps5upload source reports process crashes. Completion uses exact installed-file/metadata/inventory checks instead.

**FIRMWARE:** the SDK `kernel_get_fw_version` reads `sdk_ps5_ver` from libc's process parameter, which can be 4.50 on a 4.51 system. Registration now reads `sceKernelGetProsperoSystemSwVersion` using the structure present in etaHEN. A conservative cross-check accepts a system version only in the library's minor family and at/above its baseline; disagreement becomes UNKNOWN. That cross-check is local policy, not a universal firmware-detection guarantee. It runs on registration/explicit refresh and persists, not on every heartbeat or download.


## Direct native title: 2026-09-16 investigation

**VERIFIED SOURCE:** The current store is a C++/SDL payload ELF. Its home tile uses `sce_sys/param.json::deeplinkUri` to open our `launch.html`, which calls websrv `/hbldr`. That browser dialog is separate from the storefront. In websrv `1afd476c5044d68df4e45dc773769e5de3b2cdd6`, `hbldr_launch` starts/replaces a shared BigApp process. SDK `crt/crt.c::payload_init` expects loader-supplied payload arguments. An ELF rename or package wrapper does not replace this startup contract.

There is a current source-based route to a native title:

| Upstream | Verified files / behavior | Limits |
| --- | --- | --- |
| [PS5 Native App Boilerplate](https://github.com/blackbearreloaded/ps5-native-app-boilerplate/tree/722f2227a8bb6fa2229120546995b6562552c752) | `tooling/native/app_crt.cpp::_start`, `native_app_builder.cpp`, `self_container.cpp`, `docs/NATIVE_TOOLING.md`: native process startup, SCE dynamic imports, FSELF and a source-built runtime companion. | Upstream reports hardware validation on **6.02 and 12.70**, not 4.51. The basic template excludes exceptions, full libc++, filesystem and streams. It is not a drop-in replacement for our runtime. |
| [ProsperoLight](https://github.com/blackbearreloaded/ProsperoLight/tree/05816b67837c550e138f839aada4328523bf2a3d) | `tooling/native/app_crt.cpp`, `docs/GETTING_STARTED.md`, `docs/RUNTIME_SHIM.md`: an actual native C++ application, including additional library/runtime integration beyond the small template. Current head rechecked. | Its application and dependencies differ from our SDL/curl/FFmpeg/agent stack. Its runtime shim explicitly does not implement every libc export fully. |
| SDK `samples/install_app` | `eboot.c::_start`, `eboot.x`, `make_fself.py`: minimal syscall-only installed application sample. | This sample logs and exits; its deployment recipe writes `/system_ex`. We did not run that recipe or use it as evidence that the full store can launch directly. |

**Implementation still required:** validate the storefront's C++/filesystem/threading, graphics, controller and audio dependencies; separate or initialize payload-only agent operations correctly; preserve pairing/settings in native writable app storage; and validate launch/exit/background on 4.50. Keep the existing layout and API. Native packaging alone does not prove every Home/background path is fixed.

### Interim launch-window change in 2026091608

`launch.html` now reads the previous boot receipt, requests launch, then waits for a different per-process `launchId` after the frontend has drawn 60 frames. It calls standard [`window.close()`](https://developer.mozilla.org/en-US/docs/Web/API/Window/close) only after that confirmation. Loader errors, stale receipts and failed receipt reads leave the page open. URLs remain relative to the existing launcher origin.

**VERIFIED HOST:** the actual page script passes fresh/stale/error tests; the built frontend produces a different launch ID each run. **EXPERIMENTAL PS5:** the native browser can reject script-driven dismissal. No verified PS5-specific close-browser API was found in the inspected loader source. The update still uses the browser launch path, and physical automatic dismissal remains untested while the console is unavailable. It does not inject controller input or patch ShellUI.

## Current investigation: 2026-09-16, build 2026091607

**Home/background is not fixed or hardware-verified.** The console is currently unreachable because the user is away from its local network. The following source/build findings supersede the older session notes below.

| Interaction | Evidence | Current result |
| --- | --- | --- |
| PS-button Control Center / Home | The current pinned SDL port's `PS5_PumpEvents` calls only its keyboard pump. Its device setup supplies no hide/minimize/restore handlers; VideoOut is opened as SYSTEM `0xff`. | VERIFIED source limitation; exact cause of the physical Home failure remains UNKNOWN. |
| Background/resume handling | `frontend/lifecycle.hpp` recognizes SDL application/window visibility events. The app stops media, pauses audio, stops drawing and ignores navigation while hidden; network/job processing remains alive. Focus and UI state are retained. | Host checks pass. A verified PS5 notification bridge is still required; adding handlers alone does not make the current port emit those events. |
| HDMI audio | Initial-user lookup failed on the previous physical build. SDL's own keyboard backend already uses `sceUserServiceGetForegroundUser`; the new audio wrapper tries this fallback and records the result, PCM peak and nonzero output blocks. | Build/host checks pass. Audible output remains UNKNOWN until tested on the TV. |
| App home background | Separate 3840x2160 BC7 `pic0.dds` selection and `pic1.dds` launch frames are bundled with the owned home entry and native title. The shell supplies the crossfade. | Both installers build; `PPSA99051` registration and seven-file console readback pass. TV presentation remains unverified. No verified package-local hover-video field exists. |
| Native keyboard | `SDL_ps5keyboard.c::PS5_ImeDialog_PumpEvents` and the existing frontend input path use the system IME. | Existing integration; this is a system surface we can reuse without ShellUI hooks. |
| Notifications | SDK `sceNotificationSend`, called by `common/client.cpp::notify` with a logged `ToastTemplateB` payload, `Downloads` channel and installed PS5Library icon. The user-facing path has no debug-notification fallback. | Source/build verified; physical presentation and sound remain UNKNOWN. |
| Title launch / storage | Existing websrv title launch and ShadowMount API adapters. | Source and host behavior verified; individual physical actions still require device confirmation. |

### Prepared read-only diagnostic

`ps5/build/ps5/system-ui-check.elf` is built from `ps5/tests/system_ui.cpp`. It polls the running BigApp ID and raw `sceKernelGetAppState` values for one minute, then exits. These function declarations are present in pinned websrv/Nativehbl source. It writes only `/data/ps5library/system-ui-probe.json` and does not send input, change title registration, modify ShellUI, or redirect network traffic. It records short prefixes of two exports in its own loaded SystemService module so their unknown ABI can be checked before invoking them; it does **not** call those unverified functions.

When local console access returns: run PS5Library, launch this diagnostic through the separate payload-loader path, select Control Center > Home, and then return to PS5Library if possible. Compare the actual state changes and process lifetime with the audio report. Raw status values are not interpreted as suspend/resume flags until verified. The diagnostic exits automatically; removal of its own report is sufficient cleanup. No ShellUI recovery patch is needed because it installs no hooks.

### Native ShellUI findings

The public [etaHEN ShellUI code](https://github.com/etaHEN/etaHEN/tree/dafa13b562ddb137a4b4a97b9aaa287c0c57cc9c/Source%20Code/shellui) already demonstrates native UI research: `HookFunctions.cpp` stores original Mono handlers (`OnPress`, `OnPreCreate`, `CxmlUri`, `UpdateImposeStatusFlag`, and title-launch handlers), while `prx.cpp` installs runtime-specific hooks. This is evidence that native interaction is possible in some contexts, not a portable API for our app or evidence that those hooks fix Home on 4.51.

The current [ps5link-sdk](https://github.com/Rufidj/ps5link-sdk/tree/ea771e535378740b6a058b8e5419eb8a0e0e0ec8) constructs native title imports; its README limits hardware evidence to firmware 9.00 and says C++ is untested. The current [Nativehbl](https://github.com/Rufidj/Nativehbl/tree/e9488102399de9546d13dd496694c74142abe49f) still uses the shared BigApp homebrew bootstrap. Neither establishes a working suspend/resume conversion of this C++/SDL app on 4.51.

#### PS5 Home Down panel / Game Hub

| Classification | Finding |
| --- | --- |
| **VERIFIED HARDWARE** | Firmware 4.51 logs show that pressing Down on an installed title starts Sony's separate `NPXS40033` process, with `GameHubRoot` and `RNPS.rnps-game-hub.NPXS40033` components. PS5Library's SDL process does not render this surface. |
| **VERIFIED PACKAGE** | The native package already declares application category `0`, content badge `1`, and the permitted `launchActivity` game intent. Package-local assets supply the title, icon, selection/launch backgrounds and optional selection audio; no supported field for an account name, recent-games rail or trophy cards was found. |
| **VERIFIED OWNED CONTENT** | Every inspected `sce_sys/uds/uds00.ucp` contained only `enum_definition.json`, `events_definition.json`, `stats_definition.json` and `stats_extraction.json`. These describe event/stat extraction and an NP communication ID; they contain no Game Hub card copy, artwork or layout. |
| **VERIFIED SOURCE** | LibProsperoPKG parses/builds UCP archives and recognizes `launchActivity`; the public SDK exposes only Game Intent module symbols. etaHEN's public ShellUI hooks modify known managed handlers/settings, while kstuff-lite's ShellUI patch only changes trophy-server availability. None publishes custom `NPXS40033` cards. |
| **UNKNOWN** | The private UAM/Game Hub response schema, authentication/trust path and a supported local provider contract on firmware 4.50 remain unknown. |
| **EXPERIMENTAL / DISABLED** | A firmware-specific hook into `NPXS40033` could theoretically replace its data layer, but no exact 4.50 bundle ABI, recovery-tested patch or stable provider contract has been verified. PS5Library does not install such a hook. |

**CURRENT RESULT:** the requested dynamic username, recent games and trophies are implemented in PS5Library's controller-first Profile page. They cannot be added to the native PS5 Home Down panel through the verified app/package interfaces. That system panel remains explicitly unsupported until the exact 4.50 `NPXS40033` bundle and UAM protocol can be captured and reproduced with a reversible recovery path.

First resolve display ownership and the native visibility notification. Any later ShellUI experiment needs an exact firmware/module match, saved original bytes, a bounded enable switch and a verified recovery route. Native social/network replacement remains the separate, unimplemented work in [NATIVE_NETWORK.md](NATIVE_NETWORK.md).

## Registered-title launch, build 2026091605

VERIFIED SOURCE / HOST TESTED: websrv [1afd476c](https://github.com/ps5-payload-dev/websrv/tree/1afd476c5044d68df4e45dc773769e5de3b2cdd6) exposes GET /launch?titleId through src/websrv.c::launch_request and src/ps5/sys.c::sys_launch_title. PLAY is offered only for an inventory-confirmed installed/registered title on the paired local console. PS5Library releases its display/audio/agent thread before calling the configured launcher, using a validated PPSA/CUSA identifier. Physical launch remains pending. This does not solve PS-button Home/background suspension.

The remaining sections retain dated findings from onboarding on 2026-09-15. Later successful launch and installation observations supersede the early failures; none implies support on every firmware.

## How the home entry can work

`PS5 home icon → PS5Library launch page on the console → existing homebrew loader → native SDL PS5Library ELF → our server`

The launch page is a small local bootstrap. The store itself is the compiled C++/SDL application. Sony accounts and PSN services are not part of this flow.

| Layer | Evidence | State |
| --- | --- | --- |
| Native storefront | Our SDL frontend cross-links against payload SDK v0.43 and ports v0.40.2. Controller mapping was checked in the PS5 SDL driver. | VERIFIED build; console rendering UNKNOWN |
| Home-menu entry | [ftpsrv install-ps5.c](https://github.com/ps5-payload-dev/ftpsrv/blob/70f7b8614d3f36f6ceda0a37d6189b675f9d3f29/install-ps5.c), `install_app`, writes title metadata/icon under `/user/app`, initializes AppInstUtil and resolves title-directory registration. `assets/param.json` uses a loopback websrv deeplink. | VERIFIED source; our integration EXPERIMENTAL |
| Foreground native launch | [websrv websrv.c](https://github.com/ps5-payload-dev/websrv/blob/1afd476c5044d68df4e45dc773769e5de3b2cdd6/src/websrv.c), `hbldr_request`: `/hbldr?path=...&cwd=...&args=...&daemon=0`. `src/ps5/sys.c`, `sys_launch_homebrew`, calls `hbldr_launch`. | VERIFIED source; depends on compatible, running websrv and homebrew bootstrap |
| Notifications | The agent uses the SDK rich `sceNotificationSend` service behind its advertised capability; debug notifications are excluded from user-facing delivery. | VERIFIED source/build; presentation and sound UNKNOWN |
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

The prepared diagnostic ELF was re-hashed locally as `5702a52f67ec42b82fc93f0c72da6124e015f8d11bca43fe081d27c9ca6143ac`. Its patch records startup logs and disables `install_launcher`. Automatic approval review rejected the attempted transmission before the command executed, reporting only "blocked by policy". Read-only follow-up confirmed no new payload process. The user explicitly approved this diagnostic launch; a second attempt was rejected before execution with the same reason. No alternate automated execution route was attempted. This is a tool approval blocker, not evidence that the helper failed again on the fresh runtime. A byte-identical, hash-verified local copy is ready for manual loading in pldmgr. It is the launcher diagnostic, not the storefront or home-icon installer. The restart baseline is saved in ignored `data/console-setup/restart-baseline.json`.

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

### Home save-sync action

**VERIFIED:** Sony's documented **Check Sync Status of Saved Data** command opens PlayStation Plus cloud-save status. Current title metadata exposes no supported URI/provider field comparable to `versionFileUri` for native app updates. Redirecting that command at the network layer would require reproducing Sony cloud authentication and protocol, which PS5Library does not do.

etaHEN commit `dafa13b` demonstrates a different route: its firmware-specific `createJson_hook` intercepts internal game-options construction, recognizes `MENU_ID_SAVE_DATA_MANAGEMENT_PS4_MANUAL` and `MENU_ID_SAVE_DATA_MANAGEMENT_PS5_MANUAL`, and substitutes an etaHEN action URL. This proves menu substitution is possible under an injected ShellUI hook; it does not provide a stable extension API or redirect the Sony sync client.

**CURRENT RESULT:** PS5Library's safe route is a distinct **Sync with PS5Library** action backed by its existing agent/server save pipeline. Adding it to the native Home options menu remains experimental until an exact-firmware allowlist, external disable switch, watchdog and recovery-tested original behavior are in place. The Sony-labeled action is left unchanged.

### Display/Home diagnostic, 2026-09-16

The user reports that PS-button Quick Menu → Home does not background the SDL storefront. The pinned SDL port opens VideoOut with system user `0xff` and has no verified hide/minimize/suspension callbacks. A separate diagnostic tried the actual logged-in user and failed with `sceVideoOutOpen: Resource temporarily unavailable` (return -1); evidence is in `/data/ps5library/display-check.log`. It did not establish a working background path. The previous foreground app was closed and the normal Home screen returned. Explicit app exit works; native Home/background support remains UNKNOWN and must not be advertised as fixed.

[etaHEN](https://github.com/etaHEN/etaHEN/tree/dafa13b562ddb137a4b4a97b9aaa287c0c57cc9c/Source%20Code/shellui) contains Mono UI manipulation and method hooks in `src/HookFunctions.cpp`, `src/prx.cpp` and `src/MonoUtils.cpp`; the daemon locates SceShellUI and injects its toolbox. This is runtime-specific internal integration, not a stable general plugin API.

**UNKNOWN:** a supported way for PS5Library to publish its own byte progress into Sony's system Downloads surface, add an in-shell store tab, or show an always-available store overlay. These are not advertised as capabilities.

**EXPERIMENTAL alternative:** [ps5link-sdk](https://github.com/Rufidj/ps5link-sdk/tree/ea771e535378740b6a058b8e5419eb8a0e0e0ec8) can construct real title binaries with SCE import tables. Its README reports a tested C toolchain on firmware 9.00; C++ and parts of TLS/libc remain limitations. Packaging our existing SDL payload as fake SELF alone does not turn it into a working independent title. A matching user-supplied module may be required; system libraries are not redistributed by this project.

## Recovery requirements

The production frontend keeps `shellIntegration=false`. Any later ShellUI experiment must have an exact firmware/runtime allowlist, manual opt-in, an external disable flag checked before injection, original-byte restoration, a watchdog that disables the experiment after a failed boot, and a tested recovery entry point. Rebooting without the optional payload must leave the ordinary shell usable. Do not patch system files or edit app databases to implement a visual store tab.

For a home-entry installation, keep the previous PS5Library-owned title folder until registration succeeds, refuse to replace another application's title ID, preserve server configuration and paired credentials, and provide exact-title uninstall. No experiment is marked TESTED until install, launch, exit, reboot, upgrade and rollback have been exercised on the target console.

### Current installer and interrupted-file recovery

The built `ps5library-install.elf` embeds the current storefront and original icon. It owns only `/user/app/BREW05001`, identified by `.ps5library-owner` containing `PS5Library home entry v1` followed by a newline. `--uninstall` requests exact-title removal and preserves `/data/ps5library` configuration and device credentials. Registration failure restores the previous owned files in host checks; system registration behavior still needs console tests.

If a crash leaves `/user/app/.ps5library-previous`, the installer stops instead of overwriting recovery data. With PS5Library stopped, inspect this folder and `/user/app/BREW05001` through your trusted local console file manager. Both existing folders must have the exact ownership marker. Preserve the current owned title folder under a separate recovery name, then restore `.ps5library-previous` to `BREW05001`; keep `/data/ps5library` intact. Do not move/delete a folder with a missing or different marker. Re-run exact-title installation only after the runtime/loader is available. Filesystem restoration does not guarantee that interrupted OS registration has recovered; do not edit `app.db` to conceal a registration failure.
