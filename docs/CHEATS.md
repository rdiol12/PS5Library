# PS5Library cheat profiles

Research verified on 2026-09-30. This feature is for local, user-authorized
single-player modification. PS5Library does not expose arbitrary process IDs,
addresses, reads, or writes over the network.

## VERIFIED

### Upstream runtime references

- [notmaj0r/CheatRunner](https://github.com/notmaj0r/CheatRunner), reviewed at
  commit `89095e4b8a7d06897c7a9f37a794e737b94b04a1` (GPL-3.0).
  - `src/cr_game_monitor.c`, `cr_game_monitor_get_game`: obtains the running
    BigApp ID, walks the process table, verifies app ownership with
    `sceKernelGetAppInfo`, resolves the process name, and gets module zero's
    base.
  - `src/cr_memory.c`, `cr_memory_read`, `cr_memory_write`, and
    `cr_memory_get_module_base`: wrap bounded mdbg reads/writes and module
    lookup.
  - `src/cr_cheats.c`, `cr_cheats_apply`, `cr_cheats_remove`, and the
    target/session helpers: gate patches by the active game, enforce limits,
    verify bytes, read back writes, and attempt rollback.
- [aydencharles/onionHEN](https://github.com/aydencharles/onionHEN), reviewed at
  commit `b23ffe674b2de9f62fe634944c9230ff149d593a` (GPL-3.0-or-later).
  - `source/util/source/util_platform.c`, `util_get_running_bigapp`:
    combines `sceSystemServiceGetAppIdOfRunningBigApp`, the process table,
    `sceKernelGetAppInfo`, and `sceKernelGetProcessName`.
  - The same file's `util_resolve_game_version` reads PS5 `param.json` or
    PS4 `param.sfo`; `util_find_module` resolves the requested module.
  - `source/util/source/cheats/memory_backends.cpp`,
    `MemoryBackendFactory::create`: chooses mdbg below firmware 8.40 and a
    direct kernel backend at or above it.
  - `source/util/source/cheats/cheat_applier.cpp`,
    `CheatApplier::toggle`: resolves a module-relative address, tracks active
    ranges, reads originals, verifies writes, and rolls back a failed group.
- [etaHEN/etaHEN](https://github.com/etaHEN/etaHEN), release 2.5B commit
  `5061a85312eb1d2da811269bcb9061e4b01302a1` and reviewed main commit
  `dafa13b562ddb137a4b4a97b9aaa287c0c57cc9c` (GPL-3.0).
  `Source Code/util/source/CheatManager.cpp` verifies the established JSON
  shape and title/version/process filename convention. PS5Library does not
  call etaHEN or write into etaHEN directories.
- [etaHEN/PS5_Cheats](https://github.com/etaHEN/PS5_Cheats), reviewed at
  commit `ef295511ea4252474b16325618ffaafd3afb3cbb` (GPL-3.0), provides
  real-world JSON, MC4, and SHN examples. Its README describes the collection
  as work in progress.
- [ps5-payload-dev/sdk](https://github.com/ps5-payload-dev/sdk), reviewed main
  commit `f7fd02e6e195902a449b5e664917be8c01888b34`; the pinned v0.43 build image
  uses commit `d9c9519116944a7f1c22d262012c53b80b3520b7`
  (GPL-3.0-or-later).
  - `crt/kernel.c` contains firmware 4.50/4.51 kernel-offset support and the
    process/dynlib helpers already linked by the agent.
  - `crt/mdbg.c`, `mdbg_copyout` and `mdbg_copyin`, temporarily change
    the caller's coredump identity/capabilities while copying target memory.
  - `crt/crt.c` and `crt/kernel.c` require working kernel read/write startup
    arguments. A normal sandboxed application does not gain this access by
    linking the functions.

### Process maps and value scans

- [Cheat Engine](https://github.com/cheat-engine/cheat-engine) public release
  7.5 is the verified desktop reference for the requested workflow. Its
  [official memory-scanning guide](https://wiki.cheatengine.org/index.php?title=Cheat_Engine%3AMemory_Scanning)
  documents exact, bigger, smaller, between, and unknown first scans; exact,
  comparison-by-value, increased/decreased, changed/unchanged, and
  first/saved-result next scans; binary, 1/2/4/8-byte integer, float, double,
  string, array-of-byte, all, and grouped value types; aligned scans, live
  values, and module/protection filters. The official
  [MemScan API](https://wiki.cheatengine.org/index.php?title=Lua%3AClass%3AMemScan)
  also exposes scan progress and saved-result comparisons. PS5Library
  implements only the bounded subset stated below; it does not claim Cheat
  Engine feature parity.
- [seregonwar/MemDBG](https://github.com/seregonwar/MemDBG), reviewed at
  commit `6e493c92bba99a68a0229b02ec25793ce7d185e5` (GPL-3.0), is current
  evidence for complete PS5 VM-map enumeration. Its README lists firmware
  4.50/4.51. `src/pal/pal_process.c`, `pal_process_maps`, calls
  `sysctl({CTL_KERN, KERN_PROC, KERN_PROC_VMMAP, pid})`; it serializes the
  two-call snapshot, retries `ENOMEM`, caps the raw result at 64 MiB, advances
  by each record's `kve_structsize`, bounds every field access, and maps
  `KVME_PROT_READ`, `WRITE`, and `EXEC` to bits 1, 2, and 4.
- The pinned SDK's `include/freebsd/sys/user.h` declares a maximum
  `kinfo_vmentry` size of 1,160 bytes, places `kve_path` at byte 136, and says
  that the record is truncated before sysctl copyout. A retail-PS5 trace by
  [psxdev](https://gist.github.com/psxdev/f7a935d82bea88db75d6430d757f5099)
  shows the same MIB returning mostly 144-byte records and longer records when
  a pathname is present. Those sizes are consistent with the SDK's
  variable-record ABI; code must not step by `sizeof(kinfo_vmentry)` or assume
  that the path array is present. The trace also contains map type 9, which is
  not named by the SDK's FreeBSD constants, so PS5Library must treat it as an
  unclassified Sony extension.
- MemDBG's `include/memdbg/core/memdbg_protocol.h` defines process maps
  `0x0101`, memory read `0x0200`, memory write `0x0201`, and versioned unknown
  scan `0x0306`. `src/scanner/scan/api.c` filters maps by protection, clips
  address bounds, limits scan bytes/results, and skips failed reads. These are
  verified design references, not an API dependency.
- [OpenSourcereR-dev/ps5debug-NG](https://github.com/OpenSourcereR-dev/ps5debug-NG),
  reviewed at commit `938d1a735018073844dc2d8f69fea25f2a8aaa4b`
  (GPL-3.0), independently lists 4.51 as verified. It obtains maps by walking
  kernel `vmspace` in `debugger/source/scan.c`, `sys_proc_vm_map`, and uses
  mdbg operations `0x12`/`0x13` in `common/source/sys_proc_rw.c`. That direct
  kernel layout is more firmware-sensitive than the sysctl ABI.
- Neither debug service is safe to expose through PS5Library. MemDBG's console
  daemon binds all interfaces by default and its `AUTH_KEY` command is a
  compatibility no-op; ps5debug-NG uses global/static scan authorization and
  does not auth-gate ordinary memory reads/writes. PS5Library may reuse the
  documented concepts but must keep maps, PIDs, addresses, and bytes inside
  the agent and expose only opaque scan/result handles.

### Profile observations

The reviewed PS5_Cheats snapshot contains 1,351 JSON files. Every root uses
`name`, `id`, `version`, `process`, `mods`, and `credits`.
Checkbox entries dominate, but the data is not clean enough to trust blindly:
154 entries have different on/off lengths, 26 have odd-length off strings, and
two files disagree with their internal version. Only two of the 15 PPSA JSON
profiles contain a real PPSA ID; the others use a blank ID. PS5Library rejects
these mismatches instead of guessing.

### Current PS5Library slice

The local server owns catalog and delivery; the PS5 agent owns the inbox and
runtime state.

- `038_cheat_profiles.sql` stores supplied bytes, SHA-256, provenance,
  approval, test state, exact title ID/version/process, and optional exact
  Content ID/executable hash. Imports never fetch a URL.
- `039_cheat_deliveries.sql` persists per-console delivery and reversal
  receipts.
- `040_cheat_delivery_targets.sql` gives each console/title/version/process
  target one delivery namespace. A second profile cannot silently replace a
  different profile for the same target.
- Only approved, non-failed JSON profiles can be queued, and the console
  library must have an exact `READY_ON_PS5` title/version/Content-ID match.
- Every server-to-agent delivery requires a declared target-executable
  SHA-256. Profiles without one remain catalog records and cannot be queued.
- Server delivery and manual FTP upload both land in
  `/data/ps5library/cheats/inbox/`. A file in the inbox is inert.
- The agent accepts strict `TITLEID_version[_process].json` names. MC4 and SHN
  are inventoried as `UNSUPPORTED_FORMAT`.
- The initial parser accepts only named checkbox entries with section-zero,
  module-relative writes; at most 128 entries, 64 writes per entry, 4 KiB per
  write, 64 KiB total patched bytes, and 1 MiB profile files.
- Server files carry a content-hash-bound receipt. Manual files stay
  `UNVERIFIED` until the local user explicitly approves a named enable action;
  scanning or listing a file never creates that approval.
- Placement uses a regular-file/no-symlink check, containment, a temporary
  file, fsync, and atomic rename. Delete removes only a matching agent-managed
  copy and its receipt. The managed inbox file is published before its
  approval receipt; a receipt failure removes only a file created by that
  delivery, so a pre-existing manual file is never deleted accidentally.
- The engine verifies every declared off/preimage before the first write,
  refuses overlapping active ranges, rechecks target identity, reads back
  writes, retains actual originals, restores in reverse order, and journals
  enabled/disabled/failure/process-exit state.
- The profile runtime exposes these authenticated local operations:
  - `GET /api/v1/agent/cheats`
  - `POST /api/v1/agent/cheats/{profileSha256}/{entryId}/enable`
  - `POST /api/v1/agent/cheats/{profileSha256}/{entryId}/disable`
- Successful toggles return `profileId`, `entryId`, `enabled`, `state`,
  and `changedAtUnixMs` immediately. Failures return the same identity,
  `state: ERROR`, the requested state, timestamp, and a bounded error code.
  Native ShellUI controls own their normal selection/open/close motion; the
  memory engine never waits for animation.
- The storefront's memory-changing calls require its ordinary local bearer
  plus a random 256-bit token stored in its active sandbox. The token rotates
  whenever that frontend session ends or its listener is rebuilt.
- ShellUI uses a separate loopback-only listener on `127.0.0.1:37953`. Its
  random bearer is published atomically in mode `0600` at
  `/system_tmp/ps5library/cheat-shell-session`, is bound to the agent PID and
  session, refreshes every five seconds, and is removed on a clean stop. That
  listener normally parses only named enable/disable routes; scanner builds
  add only the bounded, named scanner operations described below.
- ShellUI's display-only file is
  `/system_tmp/ps5library/cheats.snapshot.v1`. It is atomic, mode `0600`, no
  larger than 64 KiB, and contains at most 128 profile rows. Scanner builds
  reserve 32 KiB for scanner state and at most 256 result rows. The header
  carries the matching session, generation time, profile-row count, and
  truncation flag; rows contain identifiers, match/trust/runtime states,
  enabled state, and hex-encoded display text. It contains no addresses or
  patch bytes. The consumer must reject a malformed file, a session mismatch,
  or state older than 15 seconds.
- Cheat synchronization has its own error boundary in the agent tick. A bad
  profile or unreachable cheat route cannot stop saves, transfers, or the
  normal heartbeat.

No route accepts a PID, address, byte string, URL, or repository location.

### Bounded value scanner

The implemented scanner is a small, single-session scalar value/refinement
workflow. These are source, host-test, and cross-build facts; PS5 hardware
behavior remains under the experimental gate below.

- Supported types are unsigned `U8`, `U16`, `U32`, and `U64`, plus finite
  `F32` and `F64`. Initial modes are `EXACT` and `UNKNOWN`. Refinement modes
  are `EXACT`, `CHANGED`, `UNCHANGED`, `INCREASED`, and `DECREASED`.
- Its literal scope is `MODULE_WRITABLE`: the scanner selects only the running
  `eboot.bin`, binds its exact title, version, process identity/start token and
  loader-reported main-module span, and scans only aligned sections marked
  readable and writable. It does not scan the heap, another module, another
  process, or a whole process address space.
- The readable-and-writable module-section budget is 32 MiB and reads are
  chunked to at most 256 KiB. An exact scan rejects a 65,537th match. An
  unknown scan keeps its bounded baseline unmaterialized until at most 65,536
  active slots remain. Watch responses expose at most 256 rows, and no more
  than 16 rows may be modified or frozen at once.
- Scan and result identifiers are opaque 128-bit values. Responses contain no
  PID, address, map, module offset, or raw byte sequence. Signed integer,
  string/AOB, pointer, heap/process-wide, and debugger scans are not
  implemented.
- `PS5LIBRARY_EXPERIMENTAL_MEMORY_SCANNER` and
  `PS5LIBRARY_EXPERIMENTAL_MEMORY_WRITES` are separate CMake options and both
  default to `ON` for firmware 4.50/4.51. The scanner requires the existing Shell
  cheat page; writes require the scanner. A scanner-on/writes-off build can
  read and refine but cannot edit, freeze, or restore a value.
- On 2026-09-30, all 28 host checks passed, including
  `bounded-memory-scanner`, `memory-scanner-local-api`,
  `shell-indicator-profile`, and `cheat-profile-safety`. Release PS5
  cross-builds with the scanner `ON` and writes both `OFF` and `ON` passed the
  agent/helper loader-prerequisite checks and injected-helper ABI verifier;
  the default build also passed. These receipts prove bounded logic and build
  shape, not operation on a console.
- Graceful agent replacement and normal shutdown run verified restore-all:
  every modified row is attempted, successful restores are read back and
  cleared, failed rows remain retryable, reload aborts on any failure, and a
  final shutdown failure is logged and returns nonzero. Freeze reconciliation
  runs immediately once, then at most every 500 ms to bound repeated process
  discovery while retaining the 16-row modification ceiling.

## LIKELY

- On firmware 4.50/4.51, the SDK's mdbg backend can read a separately running
  BigApp after the payload CRT receives valid kernel read/write primitives.
  CheatRunner and OnionHEN both use this family of APIs. PS5Library now
  compiles a flag-gated read adapter and bounded scanner with stricter checks
  than the SDK wrapper. Whether that path works in PS5Library's long-lived
  agent remains an inference until the hardware validation below.

## UNKNOWN

- Whether `KERN_PROC_VMMAP` returns a stable, complete map for a running game
  from PS5Library's long-lived agent on a supported firmware 4.50/4.51 runtime.
  MemDBG's support table and the retail trace are upstream evidence, not a
  PS5Library hardware receipt.
- The meaning and safe scan policy for Sony-specific VM-map type 9. The current
  bounded scanner avoids that unknown ABI entirely: it scans only writable,
  readable sections reported for the selected main module. This also means it
  cannot scan heap values.
- Whether PS5Library's long-lived agent retains the exact mdbg authorization
  needed for another BigApp on firmware 4.50/4.51 after every rest/resume path.
- Which process is the correct target for every multi-process title.
- Whether the on-disk eboot bytes, a loaded executable segment, or another
  canonical representation should define `targetExecutableSha256` across
  FSELF and backported content. The hash field remains a required exact
  constraint when supplied; PS5Library does not substitute a different hash.
- Whether a write to every relevant executable mapping remains valid without a
  protection transition or instruction-cache action.
- Runtime interaction with kstuff-lite and ShadowMountPlus on the supported
  firmware set.
- Whether ShellUI can read the agent-owned mode-`0600` session and snapshot
  files under the user's firmware/runtime authorization context.
- There is no verified public signal that distinguishes an etaHEN process
  with inactive cheats from one actively changing the same target. Ordinary
  etaHEN presence is therefore not treated as proof of a conflict. A separately
  running CheatRunner can be detected and must block PS5Library writes once a
  runtime adapter exists.

## EXPERIMENTAL / hardware gate

The firmware-4.50/4.51 production/default build keeps both memory options
`ON`. Runtime capability still stays false unless the supported firmware,
target discovery, exact profile, authorization and write-safety checks pass.

- **Verified on hardware:** the console reports firmware `4.50`. A
  scanner-on/writes-off candidate ran stably as PID 119, but its target request
  failed closed with `CHEAT_RUNTIME_FIRMWARE_UNVERIFIED` before discovery or
  any memory read/write. The normal agent was restored as PID 120 and its image
  matched the original pre-test hash.
- **Fixed and verified off hardware:** unsupported firmware now reports the
  scanner as disabled instead of leaving its capability/snapshot blank. The
  firmware-support regression and the default, read-only, and write-enabled
  PS5 cross-builds pass; this corrected reporting has not been retested on the
  console.
- **Built, not run:** `memory-discovery-probe.elf` is a one-shot, read-only
  4.50/4.51 target-discovery probe. It reports bounded title/version/process and
  module-section totals without calling the memory read/write backend. The
  14,257,232-byte ELF has SHA-256
  `fd1828ea0ba24bdf1aeea69d9624180c1cacd358b85c0f72abc5a7e3628c626c`
  and passes the loader-prerequisite check. PS5 developer services went offline
  before upload, so it has not executed on hardware.

The current all-feature candidate enables the scanner runtime on firmware
4.50/4.51. Its target-discovery code is also available to the isolated
read-only probe. It:

- obtains the current BigApp ID;
- walks the bounded `KERN_PROC_PROC` table and validates every record length;
- requires `sceKernelGetAppInfo` to bind the selected process to that BigApp;
- requires an exact requested process name;
- reads exact title/version/Content-ID metadata from fixed installed-metadata
  roots;
- resolves the requested module with bounded `SYS_dl_get_list` /
  `SYS_dl_get_info_2` results and records the complete section span;
- binds process identity to PID plus process start time;
- hashes a regular, non-symlink `eboot.bin` from a known native-install root
  when one is available, with file-identity checks before and after hashing;
- refuses the discovery when a `CheatRunner.elf` process is present.

The adapter is gated to firmware `4.50` and `4.51`. Scanner reads are bounded to 256 KiB;
ordinary profile reads and writes remain bounded to 4 KiB. The backend rejects
every range outside the discovered module sections, requires complete
transfers, rechecks process identity before and after each operation,
serializes caller credential changes, and restores and verifies the original
authorization and capabilities on every exit. A failed credential restore
terminates the agent rather than leave it elevated. The scanner flag alone
makes `canRead()` true while `canWrite()` remains false; the separate write
flag is required for edit, freeze, and restore. `CheatEngine` still checks
`canWrite()` before profile target reads. A successful discovery is reported as
`TARGET_DISCOVERED_UNVERIFIED`; it is evidence for the hardware test, not a
permission to patch memory. ShadowMount and other non-native executable paths
may currently report no executable hash and therefore cannot satisfy a remote
hash-bound profile.

Hardware validation must use a purpose-built homebrew fixture, never a
commercial title:

1. Restore PS5 developer services, run the one-shot discovery probe against a
   purpose-built fixture, and confirm title, version, process, module-section
   totals, and on-disk executable-hash availability without reading memory.
2. On firmware 4.50 or 4.51, use a scanner-on/writes-off build to scan known scalar
   markers in a writable `eboot.bin` section with both exact and unknown starts,
   exercise every refinement mode, and confirm bounds, opaque results, and
   failure behavior.
3. Validate the Settings page, scalar entry, confirmation flow, refresh
   behavior, scan duration, and agent responsiveness on the console.
4. In a separate write-enabled build, perform one same-value write and one
   reversible value change, then verify freeze, unfreeze, readback, restore,
   process-exit, rest/resume, reload, and agent-stop cleanup.
5. Only after those receipts pass may either experimental option be considered
   for a production build; `cheatRuntime` remains false until profile writes
   independently pass their own hardware gate.

ShellUI integration must reuse the existing single PS5Library helper. A second
hotkey/input hook is excluded because current HEN projects document hangs and
power-offs when multiple ShellUI hotkey injectors run together.

## License boundary

The reviewed reference projects and the PS5 payload SDK are GPL-licensed.
PS5Library's implementation is original and does not copy their profile
database or source files. Because the agent already links the GPLv3+ SDK,
public agent binaries need the corresponding license notices, source, and
reproducible build instructions before release.
