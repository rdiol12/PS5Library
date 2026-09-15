# Backporting and compatibility

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
| Patch game content | Stage a copy, validate exact input, modify ELF/modules, fake-sign as required, rebuild/inspect/verify the package | Stage a copy and rebuild the supported filesystem image |
| Runtime library overlay | Requires a verified compatible runtime mechanism for installed titles; our adapter is not yet enabled | Source-backed ShadowMount title overlay path exists; exact profile/placement and hardware validation still required |
| Lower metadata minimum firmware | May change selection/registration metadata; does not prove executable compatibility | Same limitation |

The user's 4.51 console is the first requested hardware target. A profile for 6.xx or 7.xx is not automatically suitable for 4.51. kstuff and kstuff-lite provide runtime functionality but do not by themselves prove that a particular libc/NID mismatch is solved.

## Profile contract

`CompatibilityProfile` includes Title ID, Content ID, exact version, accepted input hashes, target firmware, runtime, installation method, required libraries/patches, packaging options, notes and `UNKNOWN | PROFILE_AVAILABLE | PREPARED | UNTESTED | TESTED` state. Matching requires all identity/runtime constraints. A friendly title is never a sufficient key.

`BackportArtifact` records game/release IDs, Title ID/version, target firmware, type/source, SHA-256, size, profile ID, tested flag and time. A tested profile without a verified matching artifact is not an installable backport.

The planner displays native firmware eligibility, matching tested backport, untested match or no match. Standalone BackPork plus conflicting ShadowMount fakelib is rejected. The transfer route currently refuses backport-required installations with `BACKPORT_PLACEMENT_NOT_ENABLED`.

## Implemented / remaining

**VERIFIED local:** exact matching and mismatch tests, plaintext SELF↔ELF tools, unchanged original source files and provenance. **EXPERIMENTAL:** all console execution. **UNKNOWN:** a safe universal patch set, all-games libc replacement or automatic per-game 4.51 patch generation. Automatic patch application and rollback-aware overlay deployment remain to build; no sample game is labeled TESTED.
