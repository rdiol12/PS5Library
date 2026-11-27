# ShadowMountPlus

## Current upstream verification - 2026-09-22

**VERIFIED at release `1.7beta2`, commit [`13a8223`](https://github.com/drakmor/ShadowMountPlus/tree/13a8223b1e75c6d5b2cc0d30355b6566c80a2552):** managed folders/images still use `<scanpath>/backports/<TITLE_ID>/`. Installed PKGs now use the same exact-title source: `sm_pkg_backport_on_sandbox_ready` resolves the ready NSFS `app0` and creates plain file redirects plus directory overlays before spawn. `sm_fakelib_game_on_sandbox_ready` also selects the external backport's `fakelib2` or `fakelib`. The implementation permits two concurrent sessions and at most 256 redirects per package sandbox; missing backports and non-NSFS sandboxes are skipped.

PS5Library therefore keeps both FPKG and ShadowMount base artifacts clean and reusable. When firmware matching requires a backport, it separately delivers the exact patched executables, metadata and libraries to `backports/<TITLE_ID>/`. Standalone BackPork and ShadowMountPlus fakelib handling must not run together.

## Full overlay delivery - 2026-09-21

**VERIFIED in worker, server integration and native host checks; hardware launch EXPERIMENTAL.** The worker keeps the UFS image or FPKG clean and creates a separate overlay containing every changed executable/module, selected `fakelib` or `fakelib2` file, and lowered `sce_sys/param.json`. The server binds that tree to the exact profile hash and exposes every file through authenticated per-task endpoints. The agent stages and verifies the exact manifest, rejects missing/extra files, and atomically renames it into a supported scan root's `backports/<TITLE_ID>` directory. A conflicting existing directory is never overwritten. Inventory checks the required overlay as well as the game.

Overlay capability is accepted from any running ShadowMountPlus release whose local API reports version 1 plus `add_manual_source` and `rescan`. Exact release-name gates were removed; a standalone BackPork conflict still blocks delivery. No runtime is advertised solely from a process name.


## PS5Library 0.2.4 implementation

HOST TESTED: the agent probes API v1 on loopback, reading api_enabled/api_port from existing ShadowMount settings. Only a valid version response advertising add_manual_source and rescan enables SHADOWMOUNT on writable volumes. Obsolete app-level false defaults no longer override detection. An unreachable API does not mean storage is read-only.

Verified staging/atomic publication is followed by idempotent POST manual/add and scan. Exact-title/path manual.status plus verified console inventory still gate READY. The old direct file append is replaced; no LAN listener is enabled, credentials forwarded, or PKG sent to this image adapter. Physical registration remains unverified.

Current inspected source and supported payload: [`1.7beta2` / `13a8223`](https://github.com/drakmor/ShadowMountPlus/releases/tag/1.7beta2). The official ELF is 2,437,704 bytes with SHA-256 `3f716a7b2220c7e87e87452ae05cad689ef842d3beb4cdad6c526cb6dfc2b6b5`; console Payload Manager readback matches. It is stored for the next clean runtime load and was not hot-swapped into the active session.

## VERIFIED 1.7 differences

`src/sm_pkg_backport.c::sm_pkg_backport_on_sandbox_ready` finds `/mnt/sandbox/<TITLE_ID>_*/app0`, verifies an NSFS mount, and creates bounded redirects from the external exact-title backport. `src/sm_fakelib.c::sm_fakelib_game_on_sandbox_ready` resolves the same external backport before package-local libraries. `fakelib2` remains exclusive and is not supplemented with global/emulator libraries.

The clean-build path preserves dump libraries separately. FPKG and ShadowMount variants reuse their clean base artifact; exact profile files are delivered through the running ShadowMount overlay. Physical launch confirmation of the installed-PKG overlay remains pending.

The 1.7 HTTP/JSON API defaults to loopback `127.0.0.1:10101`. `docs/api.md`, `docs/openapi.yaml` and `src` verify version/capabilities, storage, games/inventory, manual-list changes, scanning and storage-job byte progress. It has no verified FPKG-install endpoint. The unauthenticated API is bridged locally by our authenticated agent, never exposed automatically to the LAN.

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

`.pkg` never goes through this adapter. A required overlay must match the exact profile and finish verified atomic publication before registration; no matching-directory success is invented. Configure only actual writable storage roots and compatible scan paths. The presence of a configuration file is a configuration signal, not proof that ShadowMount is running; hardware/runtime detection must improve before automatic capability enablement.

## EXPERIMENTAL / UNKNOWN

The source protocol and UFS output are verified locally. Actual mount, launch, restart and removal behavior on the user's 4.50 console remain untested. Simulators cannot register PS5 titles. Supporting every jailbreakable firmware requires testing the relevant ShadowMount and runtime combination, not a single global version check.
