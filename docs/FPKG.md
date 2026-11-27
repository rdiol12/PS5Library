# FPKG pipeline

## Large-file compression - 2026-10-04

**VERIFIED HOST:** the clean managed publisher path now streams file-backed content through the existing Kraken encoder at level 7 in 256 KiB blocks. It keeps at most eight source blocks in flight, stores executable modules and the keystone raw, and retains compressed output only when it saves at least 6.25% across the complete file. Large files no longer become raw merely because the 64 MiB aggregate memory budget was exhausted.

The forced file-backed regression produces the exact same physical inner image and encrypted Meta18/NAPS data as the buffered path. It compares mapping geometry, SHA3 digests, weak checksums, rolling hashes and recovered plaintext for every block. The builder revision suffix `ps5library-streaming-kraken-v1` changes the server cache key so an older raw artifact cannot be mistaken for a current build.

The locally supplied Sony Publishing Tools expose `img_create --compression_level`, but they are patched proprietary Windows binaries with an invalidated Authenticode signature and cannot be distributed with the Linux-capable worker. They remain a comparison tool; production uses the inspected managed implementation.

**LIMIT:** compression reduces compressible payloads; already-compressed media/archives may remain near their original size. Existing packages are immutable cache artifacts and are not rewritten in place. Rebuilding requires the authorized source folder/archive, or a separately verified future package-to-package streaming path.

## SDK 2.79 plaintext candidate - 2026-09-19

**VERIFIED HOST:** the user-supplied local toolkit identifies itself as profile `sdk279-plaintext-direct-v3` and Publishing Tools 2.79. Its own README accurately describes the result as diagnostic plaintext/unsigned output, not a retail-signed installable image. The patched `prospero-pub-cmd.exe` retains a Sony certificate whose Authenticode status is `HashMismatch`; SHA-256 is `c2d250c191d118b2d37020b9b1b7a76dfe89f0e7a4f37687f7f31a121509db9a`. The proprietary binaries remain local and are not part of PS5Library or its container.

The known-good native preview payload built successfully. Output is 33,634,544 bytes with SHA-256 `a5a92a09b03a1c3cb9b7149c67607514065fd6b2c395e83cf977fef1e1e946fe`. PS5Library's independent inspector verifies title `PPSA99051`, content ID `UP9000-PPSA99051_00-PS5LIBRARYHOMETE`, version `01.000.000` and the plaintext PPR profile. SDK extraction reproduces the executable, runtime module, keystone, icon and `snd0.at9` hashes exactly. The package contains the `PPRPLAIN-NOAUTH!` marker at file offsets `0x1a0370` and `0x2004a0`.

**VERIFIED LIMIT:** the SDK integrity pass checks both package CRC ranges successfully. Retail format verification still reports eight errors because this input lacks country ratings, `pic2.png`, `nptitle.dat` and `sce_sys/about`, and because the open homebrew `eboot.bin`/`libc.prx` are not retail SELF files. Passing package integrity is not proof of console launchability.

**VERIFIED HARDWARE / FIRMWARE 4.51:** the exact candidate was transferred with byte-for-byte SHA-256 readback. AppInst returned `0`, registered `UP9000-PPSA99051_00-PS5LIBRARYHOMETE`, and produced a 33,619,968-byte `/user/app/PPSA99051/app.pkg` matching the expected source prefix at SHA-256 `7cb25d1ae2b3a39ced1eae3f83765cdca60bdfb0bca3884527ef0ee6941308ed`. Launch started `/app0/eboot.bin` as PID 127, ShellUI recorded the title as a running `native_game`, and the user confirmed PS5Library loaded. Host build evidence remains under `data/native-fpkg-20260917/sdk279-fix8-output-20260919`; console evidence is under `data/console-evidence/native-fpkg-sdk279-20260919-100858`.

The successful runtime was the user's existing autoload set: `kstuff-1.12-dr-test8.elf` (SHA-256 `fafee1a13933e4a783e3438d7b3d10478e8dfd6f29e6e432a7a2a711650d81a4`), `a53_ppr_install_fast_15.09.elf` (`bf641bf7b3502ceeb1853d36c6aaad7ef501a0d1af931fc3f013eebe08908ebc`), ShadowMountPlus (`4780da117d7bc72c9e4f4485afd65806998feac2c39faba4116ae284ce601837`) and WebSrv. They were inspected read-only and left running unchanged. This result verifies only that exact 4.51 combination; other jailbreakable firmware still requires its own runtime capability check and launch test.

**ACTUAL STOREFRONT VERIFIED THROUGH STARTUP:** after the small launch candidate succeeded, the current storefront was rebuilt in native `app` mode and packaged with the same profile. FSELF size/hash are 34,390,946 bytes / `b96ed50ea2e488bbbb08581185290472ccef8a6be88dbc9dc198ff5dd3c4dc0f`; package size/hash are 44,470,772 bytes / `ce51c9042c7bd736f182970f7a78fd9a9631ce8a9cf450033797744985357599`. Full SDK extraction reproduces the FSELF and `libc.prx` exactly. AppInst returned `0`; installed `app.pkg` matches the package's 44,433,408-byte mount image at SHA-256 `e48f3fc77b947e9d58c5616314da45553710c1918a5dac78e1eb415e63646f1f`. `/app0/eboot.bin` is running as PID 135 and its sandbox telemetry file advances. Visual content and Home/resume still require user observation. Evidence is under `data/native-fpkg-20260917/sdk279-store-output-20260919` and `data/console-evidence/native-fpkg-store-20260919-102819`.

Current supported research pin is official kstuff-lite `v1.11`, commit `85fb88a526e58e357d6f1e626ce05af4acdb8b5d`. Its official 1,737,080-byte ELF hashes to `62d9bb6f16531e1c10fd522cb918431eaa3319dcd37405af5cc0b2240d7b2ee5`; console Payload Manager readback matches. It is staged for a clean runtime load and was not hot-swapped into the active session.

**LIKELY, NOT YET HARDWARE-PROVEN:** an execution breakpoint rejected by `try_emulate_plaintext_key_index` returns with RIP still on that armed breakpoint. If the 4.51 CMAC call differs from the single expected call shape, this can retrap before observability data reaches disk. A bounded diagnostic now logs the actual CMAC call and returns `-ENOENT` only when its kernel return address was read successfully. It disables DR3 and cleanup breakpoints to isolate that behavior. The exact source patch and 1,720,288-byte ELF (SHA-256 `4490366979c7e4f4419d119f2b6f2d680c60bd469384030dbdb73c82dc3cefbc`) are retained under `data/native-fpkg-20260917/kstuff-lite-cmac-failclosed-e8f6819`. It is not enabled in PS5Library or represented as a production fix.

## Firmware 4.51 mount experiment - 2026-09-18

**VERIFIED HARDWARE:** AppInst accepted the isolated `PPSA99051` package and installed its metadata and mount image. The installed `app.pkg` bytes matched the source mount-image region. Launch failed before executable startup with `0x80020060`; the bounded kernel capture records `verifyImage` returning EICV while `sceFsMountPprPkg` mounts the outer PPR image.

**VERIFIED SOURCE:** [kstuff `d44a254`](https://github.com/EchoStretch/kstuff/tree/d44a25400ecfab7e31afe9eb2c7c7c99770e8f56) intercepts `sceSblServiceMailbox_lr_verifySuperBlock` but has no `verifyImage` handler. [kstuff-lite `861e2d8`](https://github.com/EchoStretch/kstuff-lite/tree/861e2d885ff365e8c634635f29182e50ac0b8844) retains the 4.51 `verifyImage` offset and the narrow plaintext PPR profile: FIH offsets `0x10`, `0x28` and `0x60` equal `0x10000`; PFS version is 2, mode is `0x0d`, block size is `0x10000`, and the seed field is `PPRPLAIN-NOAUTH!`. Its included `71c189d` fix supplies the completed FIH and superblock lengths expected by the legacy 1.xx-6.xx response ABI. Other post-`4363fbd` commits repair plaintext mount lifecycle, absolute/FIH-relative staging, cleanup, wrapper stack alignment and fail-closed handling.

**VERIFIED HOST:** `ProsperoBuildOptions.EncryptOuterPfs` now reaches the existing publisher PPR builder. PS5Library selects publisher PPR/NAPS, plaintext outer-PFS output and the exact kstuff-lite marker. Package SHA-256 `d350fcab0788601b9e240e75384d57892753b2463fd13c345a92e12320f14399` passes every condition above and full inner-file readback. The worker regression fails when the marker is absent. This profile is paired with the kstuff-lite runtime; it is not a generic retail-PKG format claim.

**VERIFIED HARDWARE FAILURE:** with only hash-verified `4363fbd` running after a clean boot, AppInst accepted the package, then the console restarted inside `sceSystemServiceLaunchApp`. The synced receipt contains `BEGIN` and no return record. The test title was removed after recovery.

**UNKNOWN ON HARDWARE:** mount and launch with current `861e2d8`. Its 1,687,520-byte ELF (SHA-256 `16352417ed2df094280b17a9d0d9636f09a8ebdf2d149e28aae5c802ede3b7ef`) was built from the exact commit with `libSceIpmi` before `libSceAppInstUtil`; the loader dependency check passes and console readback is byte-identical. Replacing kstuff in place is unsafe, so the retest requires a clean boot. No released title was modified.

## Native delivery ? 0.2.7

**VERIFIED source/build/host checks; physical PS5 execution UNKNOWN.** The new adapter initializes AppInstUtil once off the render thread and calls `sceAppInstUtilInstallByPackage` with the connected server's URL. Successful initialization advertises adapter availability; actual install rejection is a job error, not evidence that all jailbreak firmware is supported. No ShellUI injection or process credential swapping is performed.

The native system service receives a random, persisted, job-specific URL, never the device credential. URLs support HTTP Range and HEAD, expire after 30 days and stop authorizing new requests when the job is cancelled, the device is revoked or the firmware/runtime changes. Unique streamed byte ranges survive server restarts. Server progress is labelled HTTP bytes sent, not proof of installation; the PS5 system queue owns its native display and controls.

Acceptance is recorded before any completion claim. HTTP Range, grants and transfer progress verify the complete source package. The worker also records an `installedImage` size/hash for the exact prefix through `ProsperoPackageMap.SupplementOffset`; the PS5 retains that prefix as `/user/app/<TITLE_ID>/app.pkg` and omits the final SI supplemental region. The agent verifies the installed image descriptor plus matching `/user/appmeta/<TITLE_ID>/param.json`, then inventory confirmation gates READY_ON_PS5. A missing descriptor fails closed instead of falling back to the source-package hash.

**VERIFIED HARDWARE / 2026-09-24:** installed PPSA99051 was 72,679,424 bytes and matched the first 72,679,424 bytes of its 72,807,082-byte source package exactly at SHA-256 `553df51e8dae874fb6edc1735baa65d8a8174e3444fcc27fce2f36dd22083348`. This proves the source and installed identities are related but distinct; it does not imply that every runtime may transform packages arbitrarily. The agent still withholds READY when the declared installed image or title metadata differs.

This first adapter covers PS5 base packages and internal installation confirmation. The native API follows PS5 installation settings and exposes no verified destination parameter in the researched ABI. Native update/DLC installation, external target confirmation, automatic native task failure discovery and OS queue cancellation are not verified. Use native PS5 Downloads for system queue errors/pause/cancel. ShadowMount images cannot be submitted as native PKG downloads.

Backport-required FPKGs embed verified game replacements and target metadata. Only required system providers remain in a separately verified exact-title ShadowMountPlus overlay. This does not revive the failed package-local system-provider experiment: those providers still need runtime selection. Profiles with no external files use `INTEGRATED` transfer placement. See [BACKPORTING](BACKPORTING.md); arbitrary folders without an exact profile are never applied.

Protected CNT system entries such as `nptitle.dat` are decrypted only when the package passcode and exact entry metadata are available. Recovery must validate the 160-byte `NPTD` structure and Title ID, preserve the embedded publisher authenticator byte-for-byte, and prove package readback matches the recovered file. This removes the package's CNT encryption layer; it does not create or forge a publisher-authenticated title record for another title.

### Hosted download, without a PC or USB

The verified PS4 FPKGi pattern is catalog URL -> direct package URL -> console background task. PS5Library already uses the same network shape for PS5: a Library Node stores the prepared FPKG, issues a short-lived job URL, and the PS5 installer pulls it directly with HTTP Range support. A user's laptop does not relay package bytes and can be offline after the content is uploaded.

The PS5 implementation is not the PS4 BGFT implementation. UnityOrbisBridge itself switches from PS4 BGFT to a PS5 loopback DPI request on port 9090. PS5Library therefore keeps the console-local installer/agent boundary and does not advertise agent-free installation. The hosted Library Node may run on a VPS; the Master Server remains separate and stores no game packages.


## Live status, 2026-09-16

VERIFIED: the worker built/read-back-verified Dead Cells (2,039,745,994 bytes); three server package records are now cached. Actual install/launch is unverified. Dead Cells preserves original required firmware 7.60 and has no matching backport profile.

HARDWARE UNKNOWN: PS5Library's new automatic FPKG installer/completion flow. The user's kstuff/ShadowMount setup may install packages through its existing tools; our agent must verify its adapter before advertising fpkgInstall. ShadowMount image registration is separate. New ps5upload findings and limitations are in [RESEARCH](RESEARCH.md).

## VERIFIED

The pinned PS5-FPKG-Builder Git tree has no implementation to automate. PS5Library now uses [drakmor/LibProsperoPKG at 5e26c8ae](https://github.com/drakmor/LibProsperoPKG/tree/5e26c8ae65f4b3cf88dcc7c84226ea9718c38e5e), the `feature/full-ppr-pkg-roundtrip` source branch. `ProsperoPackageBuilder.Build(ProsperoBuildOptions, Action<string>)` is called through `worker/Package/Builders.cs`. The previous 2.6.0 reader failed a generated package's full inner-image extraction; the new source passes that read-back check. Upstream version labels across these branches are not chronological release guarantees.

The supplied `fpkg-gui-0.6.7` DLL identifies itself as `1.2.0+bf02134f41d6908c1d4aec05bb24ee567ab5f589`. Its PDB points to drakmor's repository, but that exact commit could not be fetched. The worker uses the pinned, readable source above; it does not claim to be the supplied GUI binary or automate its mouse controls.

The worker maps verified executable patches and game files into the FPKG without a full staging copy. Required `fakelib`/`fakelib2` providers are published separately. Source dumps remain unchanged. Package cache keys include embedded replacement hashes, and the transfer planner refuses stale package/profile combinations. Profiles with identical embedded content can reuse the same package.

Our path is inspected prepared folder → source tree hash → private staging copy → `OutputFormat.DebugImage` → output reader/validator and identity inspection → SHA-256 → atomic cache publication. `.pkg` output is distinct from a UFS `.ffpkg`. Original files are not passed to builder mutation routines.

Provenance records builder commit/version, source tree hash, output SHA-256/size/time, release ID, selected profile ID when actually applied, and structural inspection. Profile IDs cannot be attached as if a backport were applied; the worker requires and applies the exact profile, validates library/patch hashes and records its digest.

Server conversion accepts local prepared folders or safe ZIPs with the game root inside. Remote ZIP downloads show actual byte progress. The library builder exposes log/stage completion rather than byte-level build work; conversion displays named stages and an indeterminate native progress indicator. A stage count must not be presented as elapsed-work percentage.

Repeated preparation can return the verified cached artifact. Users can list/delete their PC cache through `/api/v1/artifacts`. Active transfers block deletion.

## Input support

| Input | Current behavior |
| --- | --- |
| Prepared folder | Requires `sce_sys/param.json`, `eboot.bin`, safe paths and exact identity; supported build input |
| ZIP | Size/entry/path/symlink checks, extraction into a new staging directory, then identity inspection |
| `.pkg` | Recognizes supported FIH/CNT, structural validation and param identity; rejects retail/encrypted input |
| `.ffpkg` UFS | Read-only fsck and root param identity; transfer/mount path only, reverse conversion not yet exposed |
| `.ffpfs`, `.ffpfsc`, `.exfat` | Upstream ShadowMount support verified; our robust format inspection/conversion is not yet implemented |
| Multipart archives | Automatic extraction unsupported; requires a complete explicit part manifest before safe implementation |
| ELF / plaintext fake SELF | Header recognition and explicit module conversion tools; not a game package by themselves |

`UNSUPPORTED_INPUT`, `ENCRYPTED_INPUT`, `INCOMPLETE_INPUT`, `METADATA_MISMATCH` and `CORRUPT_INPUT` are real failure paths. Multipart missing-part detection is not fabricated merely from an extension.

## EXPERIMENTAL / UNKNOWN

Generated project-owned sample `.pkg` files pass local checks. The exact SDK 2.79 storefront package installs and starts on the tested 4.51 runtime; this does not establish automatic installation across jailbreakable firmware. etaHEN's researched direct installer accepts URL requests but does not establish reliable completion from its initial response. The production agent must keep `fpkgInstall=false` unless its exact runtime adapter and completion checks pass. Users can build/cache FPKG on the PC without implying universal console support.

The adapter verifies finalized-image format, ranges, content identity, image-key presence and the CNT public header wrap. The wrap is not a private signing-key signature. Regression checks stream-decode the actual inner image, recover the executable and confirm both library directories are absent; separate copies are compared byte for byte. This is stronger than checking only a `.pkg` extension/header, but still not a console launch test.

`ProsperoPkgBuilder.BuildPublisherParamJson` can normalize required firmware (including an observed 9.00 producer ceiling) and derive an SDK floor from the executable. PS5Library retains the original dump requirement for compatibility and raises it if output inspection reports a higher floor. Metadata normalization alone never creates a tested backport.
