# ShadowMountPlus

Pinned source: [3530d8d88ea1fa0d907545eda7ac95d4240a0213](https://github.com/drakmor/ShadowMountPlus/tree/3530d8d88ea1fa0d907545eda7ac95d4240a0213).

## VERIFIED source behavior

- `sm_image.c::detect_image_fs_type` distinguishes UFS `.ffpkg`, exFAT `.exfat`, PFS `.ffpfs` and compressed/nested `.ffpfsc` handling. The root game's metadata must resolve at `sce_sys/param.json`; do not add a Title-ID directory around the game inside the UFS image.
- Scan-path configuration replaces built-in paths. Default stability delay is 10 seconds. Never count on a filename extension to protect an incomplete watched image.
- `manual.lst` supplies one absolute image/folder path per line. `manual.status` contains tab-separated `installed|deleted`, Title ID, path and title name. Status is published through a temporary file.
- Backports use `<scanpath>/backports/<TITLE_ID>/`; this subtree is excluded from normal game scanning.
- `sm_fakelib.c` prioritizes per-game `fakelib2`, then `fakelib`; global libraries live under `/data/shadowmount/fakelib`. Configuration controls exclusions/priority. These are runtime overlays, not automatically rewritten packages.
- Upstream warns of conflict with standalone BackPork when ShadowMount's backport/fakelib behavior is enabled.
- `sm_install.c` resolves the title installation APIs; firmware major 12+ uses different handling. `sm_appdb.c` contains database maintenance. Our inventory scanner does not copy its write access to app.db.

## Our adapter

The image builder sets UFS format **2**, builds in an isolated directory and verifies the result with read-only UFS inspection. The console agent downloads into `<storage>/.ps5library/staging/<job>/`, verifies complete size/SHA-256, then atomically moves the image into its managed final location. It appends a manual registration request and waits for the exact title/path in `manual.status`. A matching receipt and console heartbeat are needed before `READY_ON_PS5`.

`.pkg` never goes through this adapter. Backport placement is currently gated off; no matching-directory success is invented. Configure only actual writable storage roots and compatible scan paths. The presence of a configuration file is a configuration signal, not proof that ShadowMount is running; hardware/runtime detection must improve before automatic capability enablement.

## EXPERIMENTAL / UNKNOWN

The source protocol and UFS output are verified locally. Actual mount, launch, restart and removal behavior on the user's 4.51 console remain untested. Simulators cannot register PS5 titles. Supporting every jailbreakable firmware requires testing the relevant ShadowMount and runtime combination, not a single global version check.
