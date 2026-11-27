# Watched dumps and shared downloads

## VERIFIED local implementation

Configure `DUMP_ROOT=<WATCH_FOLDER>` and `DUMP_AUTO_PREPARE=FPKG` in the private `.env`. The process must restart to load these settings. `DATA_DIR` holds the PC cache, separate backports and job staging. No URL or console IP is compiled into the watcher.

After an admin account exists, the server creates a **Watched games** source automatically. It scans once a minute, discovers prepared roots inside up to four directory levels, and waits for at least 60 seconds without file changes. A prepared root needs `eboot.bin` and `sce_sys/param.json`. Source observations, input hashes, automatic preparation records and jobs survive restart in PostgreSQL.

A source with a queued or running build is marked `PREPARING` and skipped until that build finishes. This prevents the automatic creator's `backport` writes from appearing as a second settling entry or triggering another inspection during the build. Other games continue scanning; source and backport changes are checked normally afterward.

When a stable release requires newer firmware than a registered console, automatic preparation groups consoles by saved firmware, runtime and supported method. It generates or reuses an exact `UNTESTED` profile for each group, then queues the corresponding FPKG variant or ShadowMount overlay. Prepared folders and local ZIP/RAR/7z archives use the same flow; archives are safely extracted into temporary server staging and the profile remains bound to the original archive digest.

Discovery without a verified executable recipe or supplied `fakelib`/`fakelib2` fails closed with `BACKPORT_FILES_MISSING`. The source retains the error and each affected console receives a durable warning. It never treats lowered package metadata as a working backport.

Each stable game is inspected and published individually. Title ID, Content ID, exact version and firmware come from its metadata. For example, `0x0760000000000000` becomes firmware `7.60`; `01.005.000` keeps all its version components. Unknown values stay unknown. Game identity conflicts stop with `METADATA_MISMATCH`.

A patch built with the reference-package tool is imported by placing only its
`.pkg.remastered.pkg` output in this folder. The worker classifies it as
`UPDATE` and preserves embedded `targetContentVersion` as the exact
`baseContentVersion`. An UPDATE without that exact relationship is rejected;
the server never guesses from filenames or adjacent catalog versions.

The worker hashes the original, copies it to staging and verifies that copy. It moves the staging copies of root `fakelib` and `fakelib2` into a separate backport directory **before either FPKG or ShadowMount-image creation**. Inspection and preparation do not modify the source folder. Both generated game formats therefore work as game-only downloads for firmware-compatible consoles.

Published layout:

```text
DATA_DIR/
  artifacts/<RELEASE_ID>/<SHA256>.pkg
  backports/<TITLE_ID>/<RELEASE_ID>/<INPUT_TREE_HASH>/
    fakelib/...
    fakelib2/...       # if provided
```

`RELEASE_ID` resolves to exact Content ID/version in PostgreSQL. The backport record also stores its tree SHA-256, byte size and original dump hash. Merely finding libraries does not identify a target firmware or establish that a game was tested; those fields remain null/false until verified. The two build methods deduplicate the separate backport copy.

Select `SHADOWMOUNT` or `BOTH` in `DUMP_AUTO_PREPARE` for a newly created watch source, or choose the source's build mode when adding it in Sources. Existing source settings remain authoritative. ShadowMount images can also be requested on demand through the preparation API.

## Per-console delivery

The installation plan checks the selected owner's console, firmware, runtime, method and writable storage. Firmware equal to or above the original requirement yields `backportRequired=false`, no backport artifact and zero backport bytes. Older firmware needs an exact tested profile; an unclassified folder does not unlock transfer. Missing/invalid firmware yields unknown compatibility. A builder-normalized lower firmware value cannot reduce the original requirement; a higher output requirement raises the plan's requirement.

The PS5 pulls only its authenticated transfer task and reports measured bytes. A server cache hit is not an installed-console claim. Only matching console inventory can establish readiness. Host checks cover FPKG embedding and atomic ShadowMount overlay placement; physical 4.50 installation and launch remain unverified. See [BACKPORTING](BACKPORTING.md) and [SHADOWMOUNT](SHADOWMOUNT.md).

## Sharing and deletion

The admin's watched games are shared with server members. Private source URLs, credentials, consoles, profile data and jobs remain scoped to their owners. Friends can prepare/download shared releases to their own consoles, but cannot delete the owner's cache or change sharing. An owner can unshare a game; rescanning does not reset that decision.

Deleting a PC FPKG through Server cache preserves its original dump, separate backports and console copies. The automatic-preparation ledger prevents the next scan/restart from recreating a deliberately deleted package with the same input hash. An explicit preparation request can rebuild it. `DELETE /api/v1/backports/:id` removes only an owner's unassigned separate copy; assigned profiles block deletion.

An administrator may explicitly retire one watched dump folder after its exact FPKG and any required backport are verified. `POST /api/v1/source-releases/:id/retire` requires `confirm: "RETIRE"`, the current `inputSha256`, and `deleteSource: true` to remove the folder. Supply the exact `profileId` when the dump contains root `backport`, `backports`, `fakelib`, or `fakelib2` material; a native clean FPKG with none of those inputs may be retired without a profile. Retirement refuses changed source/cache bytes and active jobs, moves the folder through a confined quarantine, and removes it only when deletion is requested. The source record remains retired, so later scans do not reopen it; the verified package, backport and catalog release remain usable. If those retained artifacts are later removed or invalidated, restoring the source is required to rebuild them. Build completion does not retire or delete dumps automatically because another profile or build method may still need the source.

## Artwork and trailers

Local `sce_sys/icon0.png` supplies cover/icon artwork; `pic1.png`, then `pic0.png`, supplies the hero. Images are validated, optimized and served from our authenticated cache. Optional user-provided media lives outside the original dump:

```text
DUMP_ROOT/.ps5library/<TITLE_ID>/<VERSION>/
  metadata.json
  cover.webp
  hero.jpg
  icon.png
  trailer.mp4
```

`metadata.json` must contain exactly matching `titleId`, `contentId` and `version`. It can add description, publisher, developer, genres and release date. It cannot replace an inspected game title. Trailer preparation produces a bounded H.264/AAC clip; the PS5 starts it after five seconds on the same cover. A missing trailer is not synthesized or fetched from an unconfigured source. See [TRAILERS](TRAILERS.md).

## Limits and validation

- Both the global quota and actual free space constrain builds. The current default quota is 100 GiB and preparation reserves roughly four times input size plus 64 MiB; large games may report `QUOTA_EXCEEDED` or `INSUFFICIENT_SPACE`.
- Multipart RAR/7z, encrypted retail PKGs and unimplemented filesystem conversions are explicit unsupported inputs. A watched directory is not proof that every file in it can be converted.
- Existing file-only images are inspected/downloaded; game-local libraries inside an existing image are not automatically removed. The separation guarantee applies to our prepared-folder/ZIP build pipeline.
- Input hashes detect source changes. Per-item inspection errors remain visible in Sources. Failed terminal build staging is removed; broad orphan retention/accounting remains future work.
- Isolated PostgreSQL/Redis tests exercise real package/image builds, separate byte-exact library copies, artwork and video, cross-account visibility, firmware decisions, authenticated game-only delivery, deletion and restart. These are host checks, not proof of console game launch.
