# Backporting and compatibility

## Automatic creator (Experimental) - 2026-10-19

**System & logs > Configuration > Automatic backport creation (Experimental)**
enables the standalone creator for subsequent FPKG builds. The worker checks the
actual game folder after archive extraction where applicable. Any existing
`backport` entry, regardless of case, skips creation. ShadowMount builds skip it.

When enabled and missing, the worker runs the configured creator, verifies and
places only its required files in the game's `backport` folder, registers the
exact generated profile, and embeds game replacements in the FPKG while keeping
runtime libraries external. The preparation timeline shows **Backport (Experimental)** with creation,
skip, disabled, not-required, or review/failure status. Unknown requirements stop
creation with a review report; generated profiles remain `UNTESTED` for 4.50.

Set `AUTO_CREATE_BACKPORT` for the startup default (false when absent). Configure
`BACKPORT_CREATOR_SCRIPT`, `BACKPORT_CREATOR_PYTHON` and
`BACKPORT_CREATOR_OUTPUT_ROOT` on the native package worker. Its persistent output
and source must share a drive; keep output outside watched game folders because
it retains reports and recovery originals. Runtime changes persist across restarts
and do not interrupt a creator already running. The local creator and its records
are in `A:\backport\creator`; its referenced library inputs must remain available.

## Current delivery model - 2026-10-20

For FPKG builds, the worker maps verified game replacements directly into the
package: executables, game modules and target metadata. It does not copy or alter
the source dump. Only required `fakelib`/`fakelib2` providers remain in the published
backport folder, with the existing runtime exclusions. The source `backport`
folder remains the complete recipe input for reproducible builds.

The FPKG cache key includes the embedded replacement hashes and target firmware.
Profiles with identical embedded files can reuse the package even when external
libraries or runtime differ. A clean or stale package cannot be paired with the
smaller overlay. If no external providers remain, the transfer is `INTEGRATED`.
ShadowMount image builds retain the clean image plus full external overlay.

Verified embedded SELF replacements also normalize their publisher SDK trailer to
the target SDK preset. That trailer is outside the executable's content segments;
leaving an old version there can make the publisher raise `param.json` back to the
original firmware floor. Both worker and server reject a completed FPKG whose
metadata still exceeds the profile target. Payload readback is checked separately
from these container metadata changes.

The worker still inspects and hashes the completed package. It compares source
path/size/modification-time stamps after building instead of rereading every source
byte. Fresh publication checks the verified output size and modification time;
older workers and existing cached outputs retain the full hash check.

**FAILED / REMOVED:** the package-local `nativePackage` experiment produced
structurally valid packages, but repeated firmware-4.50 launches failed because
the system loader continued resolving firmware modules instead of the packaged
providers. The experiment, generated profiles, cached artifacts and PS5 test
packages were retired. These results do not establish a native universal
backport method.

## PS5-Backport-Kit / FPKG Builder 1.4.3 evaluation - 2026-09-20

**VERIFIED LOCAL SOURCE:** the user-supplied FPKG Builder 1.4.3 folder contains `tools/backport/bp2_tool.py` SHA-256 `d26fb61d7192881a177c84f69a2a21d6696361116e626b5460f491df76723eed`, attributed to dnullptr/Bendod, plus a non-interactive wrapper. It edits recognized PS4/PS5 SDK records in unsigned ELF files and recreates Fake SELF files. The wrapper runs only on a temporary dump, requires at least one patched and one fake-signed output, and stops packaging on reported errors.

**VERIFIED PRESETS:** the supplied tool exposes PS5 presets 1.00-9.00. Current idlesauce SDK-downgrade source at pinned revision `4e8d85e7cde3782a80dfa1e16f1af0a04f1bd797` independently publishes complete PS5/PS4 pairs for 1-10. PS5Library uses these values as bounded data in its own worker:

| Firmware family | PS5 SDK | Companion PS4 SDK |
| --- | --- | --- |
| 1.x | `0x01000050` | `0x07590001` |
| 2.x | `0x02000009` | `0x08050001` |
| 3.x | `0x03000027` | `0x08540001` |
| 4.x | `0x04000031` | `0x09040001` |
| 5.x | `0x05000033` | `0x09590001` |
| 6.x | `0x06000038` | `0x10090001` |
| 7.x | `0x07000038` | `0x10590001` |
| 8.x | `0x08000041` | `0x11090001` |
| 9.x | `0x09000040` | `0x11590001` |
| 10.x | `0x10000040` | `0x12090001` |

The supplied 1.4.3 wrapper always writes PS4 `0x09040001`, and its nine-target fixture verifies only the PS5 word. PS5Library does not reproduce that incomplete assertion; it verifies both words for every family.

**LICENSE UNKNOWN / NOT INCORPORATED:** neither the supplied folder nor upstream `dnullptr/PS5-Backport-Kit` commit `d14b4e077aef673df291cba809dd429c190ea121` includes a license granting redistribution or modification of `bp2_tool.py`. Its code is not copied into the public PS5Library server. PS5Library implements the file-format operations independently from pinned LibProsperoPKG and the public SCE parameter layout; neither external Python script is bundled.

**LIMITATION:** SDK edits and Fake SELF creation do not provide missing firmware APIs, game-specific patches or required `fakelib`/`fakelib2` libraries, and do not prove a title works on 4.51. PS5Library continues to require exact title/version/input hashes, verified output hashes and a matching compatibility profile.

## Clean-room profile discovery - 2026-09-20

**IMPLEMENTED / LOCALLY VERIFIED:** `BackportDiscovery.Generate` scans an owned prepared folder without writing to it. `GenerateArchive` applies the same inspection after bounded safe extraction of ZIP, RAR or 7z input and binds the result to the complete archive/multipart digest. It recognizes bounded `.bin`, `.elf`, `.self`, `.prx` and `.sprx` inputs by actual ELF/SELF headers, reconstructs supported plaintext fake SELF files as ELF, walks SCE process/module program headers, edits both SDK words, recreates deterministic fake SELF output and calculates exact expected input/output SHA-256 values. Supplied `fakelib` or the exclusive `fakelib2` tree is bound by path and hash. Direct discovery verifies the source tree before and after scanning; scheduled discovery reuses the catalog's exact verified tree hash and the final build re-verifies the full source before publication, avoiding two redundant reads of unrelated bulk game data.

The admin-only `POST /api/v1/profiles/generate` endpoint resolves only an owned local prepared-folder/archive source. Automatic sources generate one exact profile for each distinct saved console firmware/runtime and capability-supported build method. FPKG and ShadowMount for the same target share one verified discovery/extraction result; packaging remains method-specific. The worker selects the matching pair for target firmware families 1.x-10.x; the API cannot supply arbitrary SDK words. Generated profiles are always `UNTESTED`, existing exact profiles are reused, changed sources are rejected before storage, and targets outside the verified table fail with `BACKPORT_TARGET_UNVERIFIED`.

If discovery finds no verified executable patch and no supplied compatibility library, it fails with `BACKPORT_FILES_MISSING`. Automatic scans retain that error and create a durable warning for each affected console. Lowering `param.json` alone never produces a profile.

Deterministic discovery failures are cached against the exact input hash, target firmware and runtime. Scheduled scans do not repeatedly hash or extract an unchanged unsupported, encrypted, incomplete, corrupt or patchless release. Changing the source hash or using the explicit admin generation endpoint performs a fresh attempt.

The supplied script changes bare unsigned ELF files in place, keeps temporary backups and then fake-signs them. PS5Library records an exact input/output recipe and applies it later to private staging. It also rejects encrypted SELF input, reparse points, unsafe paths, both library policies at once, more than 100 modules, and modules above 512 MiB.

### Retired package-local provider experiment - 2026-10-07

**VERIFIED:** firmware-4.50 `libkernel.sprx` routes `sceKernelDlsym` through syscall 591, so the final SCE symbol-acceptance logic is kernel-side. The userland image can map the request path but cannot prove the kernel's complete loader policy. RoadCraft's five supplied provider modules and the working package-local `tcmalloc_minimal.prx` make their canonical public owner exports reachable through the SCE SysV hash. Valid owner exports use both `STV_DEFAULT` and `STV_PROTECTED`; stock 4.50 `libkernel` and `libSceLibcInternal` also hash both kinds. A protected-only rewrite is therefore invalid.

**FAILED / REMOVED:** provider rewriting passed structural checks but did not make
the firmware loader select the packaged providers. RoadCraft continued to fail
with an unresolved function, so the rewriter and its package-local delivery path
were removed. The observations remain research evidence only.

PS5Library also avoids raising an already-older nonzero SDK record; zero/unknown fields receive the selected target and newer fields are lowered. After patching, both top-level package metadata fields use the package form of the selected SDK family, matching the supplied builder (`4.50`/`4.51` target -> `0x0400000000000000`). Backport cache generation `v5` prevents overlays created with the earlier metadata rule from being reused.

## Automatic patch application - 2026-09-16 server update

**VERIFIED locally:** a normal install request applies exact supplied BPS patches, optional ELF SDK edits and fake signing in private staging. FPKG output contains those changes. ShadowMount output keeps the reusable image clean and publishes the changed files in a separate full title overlay. Prepared overlays have their own profile-specific cache; original dumps, raw libraries and clean packages remain intact.

The operation order is: verify original SHA-256 (or recognize exact prepared output), decode supported plaintext SELF when needed, apply BPS, edit recognized SDK records, fake-sign when requested, verify output SHA-256, build, verify and publish. All three BPS CRC32 checks are enforced in addition to cryptographic hashes. The worker also detects package preparation changing selected library bytes after their hashes were verified.

### Recipe fields

Use the existing authenticated `POST /api/v1/profiles` API. Each `requiredPatches` entry retains `path`, `inputSha256` and `outputSha256`, and may include:

| Field | Meaning |
| --- | --- |
| `bps.data` | Canonical base64 contents of the supplied BPS patch |
| `bps.sha256` | SHA-256 of those decoded patch bytes |
| `sdk.ps5`, `sdk.ps4` | Explicit unsigned 32-bit SDK record values, not a console firmware string |
| `outputFormat` | `ELF` to decode/preserve ELF, `FSELF` to decode/patch/fake-sign; omitted for raw byte patching |

Patch data is saved in the existing PostgreSQL profile and job snapshot; retries need no external URL or executable. Paths, duplicate targets, patch hashes and bounds are validated. SDK edits require an explicit output format. Recipes without operation fields retain the earlier prepared-file verification behavior. Profiles still require exact title/content IDs, version, dump hash, target firmware, runtime and installation method.

The preset values describe record edits; they do not establish that a game works on any matching firmware. Profile authors must supply independently established input/output hashes and compatible patch/library data. Library recipes should produce the final fake SELF bytes listed in `requiredLibraries[].sha256`. Ordinary users do not configure patches for each download.

### Bounds and evidence

- BPS payloads: 64 KiB maximum. Profile JSON: 900,000 UTF-8 bytes maximum, at most 100 target files.
- Module input/output: 512 MiB hard cap, matching the server backport-file boundary. Growth: at most 64 KiB per module including signing overhead, reserved by the server quota and worker free-space checks. Raising the module cap requires file-backed processing; larger growth requires explicit output-size reservations.
- Patch SHA-256, SDK values and output format contribute to the cache/profile digest. Migration `022_patched_libraries.sql` separates prepared library caches and permits distinct profile builds while keeping identical active builds unique.
- Admin preparation progress reports patch stages/file counts, without fabricated byte percentages.
- Automated checks cover BPS actions/overlap/negative offsets, malformed patches, CRCs, input/output hashes, bounds, SDK structures, fake signing, real package/image contents, immutable sources, cached repeat preparation and normal install-request orchestration.

**UNKNOWN / not generated:** new game-specific fixes, missing replacement libraries, or a universally working 4.51 patch set. The inspected BackPork repository supplies 6xx/7xx patch folders; they are not relabelled for 4.51. These checks do not mark any real title TESTED. Physical installation and gameplay validation remain required.

## Historical external-overlay delivery - 0.2.7 / 2026091609

**VERIFIED by automated tests:** registration firmware is persisted in PostgreSQL and device state. Heartbeats cannot silently change it. An owner can request a fresh measurement in My PS5; an authenticated, single-use request updates the stored version. Pending transfers tied to the previous firmware/runtime are rejected. Existing physical consoles receive one refresh request when migrating from the older SDK-baseline detector.

The planner compares original required firmware with that saved version. Native-compatible consoles use the cached package without added libraries. Otherwise it matches exact title/content IDs, version, source hash, target firmware, runtime and installation method, then verifies the actual library files. Profiles owned by the shared game's publisher are usable by its authorized readers; console state, warnings and jobs remain private. A newer incomplete profile does not hide an older exact match whose files are available.

- FPKG: automated builds remain clean and use the exact external overlay through the supported ShadowMountPlus runtime. The retained `delivery=INTEGRATED` marker is only for an already-integrated artifact verified outside this worker; automatic discovery never creates one.
- ShadowMount: the worker copies every profile patch target, selected library and `sce_sys/param.json` into a separate overlay, applies patches and selected SDK-family metadata there, and leaves the image content clean. All exact profiles for the same input reuse one verified clean UFS image; only overlays vary by profile. The agent stages every manifest file, verifies the exact tree, then atomically publishes `<scanpath>/backports/<TITLE_ID>/` before image registration. Conflicting existing per-title directories are preserved and delivery stops. Inventory verifies the required overlay as well as the game.
- Initially `requiredPatches` accepted only already-patched files. The server update above adds optional verified recipes for automatic application. Packaging metadata is prepared only after exact profile/file checks, and a builder output still requiring newer firmware is rejected.
- `UNTESTED`/`PROFILE_AVAILABLE` matches remain labelled untested and show a warning at selection. They can be prepared after normal download confirmation. `UNKNOWN` profiles and absent/mismatched files cannot be used. No file folder alone establishes a target firmware or a tested state.
- Missing profiles/files, changed files and incompatible runtimes produce durable owner/console-scoped notifications. The PS5 can deliver these through the configured native notification API; the web companion displays the same warning. Native notifications can still be unavailable/disabled.

Use the existing authenticated `POST /api/v1/profiles` API to register the exact mapping and library SHA-256 values. Original dump libraries stay in the dump; the watcher/build keeps the separate cache automatically. Do not mark a profile TESTED without console evidence. No currently cached commercial title has been newly declared compatible by this change.

**EXPERIMENTAL on PS5:** actual launch with beta2 external overlays requires hardware verification. Read-back tests prove clean package and overlay contents, not game compatibility. Per-title overlay replacement with different files is deliberately blocked; it needs an explicit managed replacement/rollback flow before automatic replacement is enabled.


## VERIFIED distinctions

There is no verified universal “change minimum firmware and it works” operation. Compatibility can fail because of executable SDK records, imports/NIDs, libc behavior, required system modules or runtime patch assumptions. Title metadata alone cannot fix those failures.

1. A plaintext fake SELF can sometimes be reconstructed as ELF. LibProspero's parser exposes segment flags/offsets and digests; encrypted segments cannot be treated as plaintext. Our `Modules.ToElf` verifies the reconstructed digest and fails on lossy/incompatible input.
2. ELF changes require exact known offsets/sections and expected input bytes or hashes. The pinned [SDK downgrade script](https://gist.github.com/idlesauce/2ded24b7b5ff296f21792a8202542aaa/4e8d85e7cde3782a80dfa1e16f1af0a04f1bd797) edits SCE process/module SDK records, not general library compatibility.
3. `ProsperoFself.MakeFself` can wrap supported ELF for a fake-signing environment. This does not mean stock firmware accepts it.
4. [BackPork](https://github.com/BestPig/BackPork/tree/ebac9ffd79723d28658e9091ac55b1939ed1ee87), `main.c::patch_game`, applies runtime library overlays. Its available firmware-specific patches are not substitutes for a tested per-release profile.
5. ShadowMountPlus supports per-game `fakelib2`/`fakelib`, title-specific backport folders and a global fakelib directory. Global library replacement has a wider compatibility impact than a per-game overlay.

## Content modification versus runtime overlay

| Approach | FPKG installation | ShadowMount image |
| --- | --- | --- |
| Patch game content | Embed verified game replacements directly in the FPKG | Keep the image clean and mount the complete exact-title backport tree |
| Runtime library overlay | `1.7beta2` selects external exact-title `fakelib2`/`fakelib` for installed packages; launch needs hardware verification | Source-backed exact-title overlay path exists; exact profile/placement and hardware validation still required |
| Lower metadata minimum firmware | May change selection/registration metadata; does not prove executable compatibility | Same limitation |

The user's 4.50 console is the first requested hardware target. A profile for 6.xx or 7.xx is not automatically suitable for 4.50. kstuff and kstuff-lite provide runtime functionality but do not by themselves prove that a particular libc/NID mismatch is solved.

## Profile contract

### Per-dump libraries and per-console selection

Root `fakelib`/`fakelib2` are preserved separately. FPKGs embed selected game replacements and publish only runtime providers; ShadowMount images publish the full overlay. The source dump stays intact. `BackportArtifact` can hold an unclassified `SHADOWMOUNT_FOLDER` with null target firmware/profile, a tree hash, byte size, exact release and original input hash. Finding a folder is not evidence for TESTED status.

For each selected PS5, equal/newer firmware yields no overlay in its plan and zero backport transfer/storage bytes. Older firmware requires an exact matching profile. Unknown firmware never silently takes the native-compatible branch. Different consoles can therefore select the same cached game without sharing a compatibility decision. Source firmware is retained even if a builder lowers its output metadata; a raised output floor is also enforced.

ShadowMountPlus `1.7beta2` applies external title backports to managed folders/images and to installed PKG NSFS sandboxes. An FPKG-specific exact profile is still required before PS5Library prepares and delivers matching files. See [source evidence](SHADOWMOUNT.md) and [watch configuration](WATCH_FOLDER.md).

`CompatibilityProfile` includes Title ID, Content ID, exact version, accepted input hashes, target firmware, runtime, installation method, required libraries/patches, packaging options, notes and `UNKNOWN | PROFILE_AVAILABLE | PREPARED | UNTESTED | TESTED` state. Matching requires all identity/runtime constraints. A friendly title is never a sufficient key.

`BackportArtifact` records game/release IDs, Title ID/version, target firmware, type/source, SHA-256, size, profile ID, tested flag and time. A tested profile without a verified matching artifact is not an installable backport.

The planner displays native firmware eligibility, matching tested backport, untested match or no match. Standalone BackPork plus conflicting ShadowMount fakelib is rejected. The transfer route now resolves and verifies profile files and enables the matching route; missing or mismatched files block it.

## Implemented / remaining

**VERIFIED local:** exact matching, plaintext SELF/ELF conversion, supplied BPS/SDK patch application, automatic 1.x-10.x SDK-recipe discovery, immutable originals and provenance. **EXPERIMENTAL:** console execution. **UNKNOWN:** universal compatibility patches, missing-import/NID fixes and game-specific 4.51 compatibility. Replacement of conflicting existing overlays remains to build.
