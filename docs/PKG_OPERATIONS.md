# PS5 package operations

This is the operator and coding-agent contract for the two package paths in
PS5Library. Run commands from the repository root.

## Choose the correct path

| Goal | Input | Tool | Result |
| --- | --- | --- | --- |
| Inspect or directly install a complete package | Finalized `.pkg` | `tools/ps5-dev/pkg_cli.py` | One console installation through the local developer services |
| Deliver a catalog game from a Library Node | Verified BASE artifact in the database | Storefront/server transfer flow | AppInst downloads the package from the Node and the agent verifies inventory |
| Publish a Home-menu update for a registered native title | PATCH built against the exact installed base | `npm run native:update --` | Exact-base PS5 update feed |

A higher `contentVersion` does not turn a BASE package into a PATCH. Uploading
another full MapleStory/OpenStory BASE package as `01.000.001` therefore does
not make the PS5 Home updater offer it to an installed `01.000.000` BASE. It is
a separate full-package install/replacement candidate.

The publisher accepts only titles registered in `shared/native-titles.json`:
PS5Library `PPSA99051` and OpenStory `PPSA99783`. This allowlist does not make
an uploaded BASE package a native update; a matching PATCH, delta and exact
installed base are still required.

## Regular package: existing developer CLI

### Prerequisites

- Python 3 and .NET 10 on the PC.
- Payload Manager, websrv/file service and FTP running on the jailbroken PS5.
- A compatible jailbreak runtime. These packages are unsigned homebrew FPKGs,
  not retail-signed packages.
- These repository `.env` values:

```dotenv
PS5_CONSOLE_HOST=<private-LAN-host-or-address>
PS5_HTTP_PORT=8080
PS5_MANAGER_PORT=12800
PS5_FTP_PORT=2121
```

The bridge rejects non-private console addresses and HTTP redirects. Do not
put a console address in source code or a published artifact.

Build the worker and helper once:

```powershell
npm run build:worker
docker run --rm --network none -v "${PWD}:/workspace" -w /workspace ps5library-build:0.43 sh -c "cmake -S ps5 -B ps5/build/ps5 -DPS5=ON -DCMAKE_BUILD_TYPE=Release -DCMAKE_TOOLCHAIN_FILE=/opt/ps5-payload-sdk/toolchain/prospero.cmake && cmake --build ps5/build/ps5 --target ps5library-package-tool"
```

Inspect before installing:

```powershell
python tools/ps5-dev/pkg_cli.py inspect C:\authorized\game.pkg
```

For the worker's complete inspection record rather than the CLI's reduced
install plan:

```powershell
dotnet worker/bin/Release/net10.0/PS5Library.Worker.dll inspect C:\authorized\game.pkg
```

The worker reads the CNT content type and flags: `0x21`/`0x22` are DLC,
verified patch-marker flags are `UPDATE`, and other packages are `BASE`.
Classification alone does not prove that an arbitrary update is safe to
publish against a particular installed base.

Install and optionally launch:

```powershell
python tools/ps5-dev/pkg_cli.py install C:\authorized\game.pkg --expect-content-id UP0000-PPSA00000_00-EXAMPLE000000000 --launch
```

Useful install options:

- `--expect-content-id ID`: fail if the inspected identity is not exactly `ID`.
- `--force-upload`: replace an already staged file of the same size.
- `--keep-running`: fail instead of closing a running BigApp.
- `--timeout SECONDS`: wait 10 to 3600 seconds for installation confirmation;
  the default is 300.
- `--worker PATH` and `--helper PATH`: override the Release worker or helper.

On success the CLI writes one JSON object to stdout and exits `0`. A handled
validation, service, install or verification failure writes
`{"status":"ERROR","message":"..."}` to stderr and exits `1`. Treat an
"outcome is unknown" error as indeterminate: inspect the nonce-bound console
receipt before retrying.

### What the CLI verifies

`inspect` accepts only a non-empty, regular, non-symlink package for which the
worker reports all of the following:

- format `pkg`;
- `structurallyRecognized: true`;
- `metadataVerified: true`;
- matching Title ID inside the Content ID;
- a valid package version.

`install` repeats inspection, checks the manager/file/FTP services, stages the
package as `/user/data/ps5library/packages/<sha256>.pkg`, and runs the bounded
package helper. The helper verifies the local file path, byte count and
SHA-256 before calling AppInst, then requires AppInst's returned Content ID to
match the requested identity. The CLI accepts only a fresh nonce-bound
receipt, then waits for matching installed metadata and package files.

This developer CLI is independent of the catalog. It does not create a Game,
GameRelease, Artifact or server job.

### Standalone GUI

The existing GUI calls the same inspection and install functions:

```powershell
python tools/ps5-dev/pkg_gui.py
```

Build its single-file Windows executable with:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File tools/ps5-dev/build-standalone.ps1
```

The output is `tools/ps5-dev/PS5Library-FPKG-Installer.exe`. Its `--check`
mode validates that the bundled self-contained worker and PS5 helper exist; it
does not contact or modify a console.

## Complete BASE package: Library Node delivery

The server path does not use the developer FTP, websrv or Payload Manager
ports. Before it queues an FPKG transfer, the current server requires:

- a verified `pkg` artifact with exact game/release identity;
- a PS5 BASE release whose Title ID begins with `PPSA`;
- a worker-produced `installedImage` size and SHA-256;
- an online paired console reporting compatible firmware/runtime and FPKG
  capability;
- an allowed PS5-managed storage choice with enough free space.

The authenticated agent obtains a revocable job-specific URL. AppInst pulls
the package from the Library Node; the route supports HTTP Range requests and
records unique bytes served. Bytes served are transfer progress, not proof of
installation. `READY_ON_PS5` requires exact installed-image, metadata and
inventory confirmation from the console.

The verified AppInst URL ABI has no destination argument. The console's PS5
installation setting chooses internal or M.2 storage. A raw `/mnt/usb0` mount
is not a supported native package destination.

## Native Home-menu PATCH update

`npm run native:update -- --help` prints the machine-readable command contract.
Every subcommand prints exactly one JSON object to stdout and exits `0` on
success, or prints one JSON error object to stderr and exits `1`. Every command
requires an explicit registered `--title-id`; use `PPSA99051` for PS5Library
or `PPSA99783` for OpenStory.

Home/main-menu update discovery is not automatic merely because a newer PKG
exists. The installed BASE must already contain a `sce_sys/param.json`
`versionFileUri` that points to the exact title feed. For PS5Library builds,
`ps5/native/build.py` derives this URI from `PS5LIBRARY_NATIVE_VERSION_URI`,
then `COMMUNITY_MASTER_URL`, then `PUBLIC_URL`. Other registered titles use
`PUBLIC_URL`. The installed content version is part of the route:

```text
/api/v1/native-updates/<TITLE_ID>/from/<installed-content-version>/version.xml
```

If the installed BASE has no usable URI, Home never asks this server. Rebuild
and install one bootstrap BASE with the correct URI before testing later
patches.

### 1. Configure the local package toolkit

```dotenv
PS5_PKG_TOOLKIT_DIR=<folder-containing-build-from-folder.ps1>
```

That private local folder must also contain
`toolchain/prospero-pub-cmd.exe` and `toolchain/ext/sc2.exe`. Proprietary
toolkit binaries are not stored in this repository or server container.

Check the contract, then validate a title folder's identity and feed URI
without building anything:

```powershell
npm run native:update -- prerequisites --title-id PPSA99051 --source C:\build\PPSA99051
```

Before building the **first BASE package**, inject its Home update address:

```powershell
npm run native:update -- configure --title-id PPSA99783 --source C:\build\PPSA99783 --update-origin http://<PC-LAN-IP>:3150
```

`configure` changes only `versionFileUri` in `sce_sys/param.json`, using the
source's exact title and content version. It keeps the original metadata in
`<source-folder>.param-before-update-uri.json`, outside the package inputs.
The command is idempotent; replacing a different existing URI requires
`--force`. Run it again after increasing `contentVersion`, then run
`prerequisites`. Configure `PUBLIC_URL` to match the same game update server.

`prerequisites --source ...` reports `ready: false` and a
`MISSING_VERSION_FILE_URI` warning with this remedy when the field is absent.
Patch builds reject a missing URI. This is a **source-folder edit before
packaging**, not an edit to a finalized PKG or the installed console title.
The direct PowerShell `build-native-update.ps1` entry point runs the same
prerequisite check before invoking the toolkit.

For another homebrew game, add its exact Title ID, Content ID and display name
to `shared/native-titles.json`, rebuild/restart the Library Node, and use that
Title ID with `configure`, `prerequisites`, `build` and `publish`. Registration
enables its local feed; it does not bypass package identity or exact-base
checks. Keep the server origin stable and reachable by the console.

### 2. Build and gate the patch

For OpenStory, use `--title-id PPSA99783` and the exact feed URI
`/api/v1/native-updates/PPSA99783/from/<content-version>/version.xml`. Its
installed `01.000.001` BASE has no update URI, so Home discovery needs a one-time
bootstrap BASE install with that URI. Merely publishing a patch cannot change
already-installed metadata. Keep the exact bootstrap/reference package.

The source folder must be the newer native title tree. The reference package
must be the previous remastered package, and `BaseContentVersion` must exactly
equal the version installed on the target console.

```powershell
npm run native:update -- build --title-id PPSA99051 --source C:\build\PPSA99051 --output C:\releases\ps5library-01.003.000.pkg --reference C:\releases\ps5library-01.002.000.pkg.remastered.pkg --base-version 01.002.000
```

Use `--toolkit <folder>` to override `PS5_PKG_TOOLKIT_DIR`,
`--compression <-4..9>` to override level 9, or `--force` to replace existing
outputs.

The command creates:

- `ps5library-01.003.000.pkg`: SDK patch build;
- `ps5library-01.003.000.pkg.remastered.pkg`: finalized cumulative package
  consumed by the feed;
- `ps5library-01.003.000.pkg.delta.pkg`: PS5 delta-distribution container.

It automatically runs the isolated release gate. The gate rebuilds the
worker, publishes into a temporary directory, validates exact title/content
identity, requires a version newer than the base, checks distributable
geometry and the internal digest, generates full 64-KiB PlayGo CRC coverage,
and validates the CNT `0x23` / RLC delta container. Any failure exits nonzero
and the patch must not be published.

Before delta conversion, the build runs the publisher's two checks separately.
Integrity output is saved as `<output>.integrity.log` and any integrity failure
stops the build. Retail submission-format output is saved as
`<output>.validation.log`; homebrew-only metadata errors are reported as a
warning because the same checker rejects the hardware-tested PS5Library package.
The later release gate still requires exact identity, package geometry, hashes,
CRC coverage and a valid native delta container. A passed build is therefore an
integrity-checked homebrew candidate, not a Sony submission package; hardware
testing remains required.

The gate can also be run directly:

```powershell
npm run native:update -- inspect --title-id PPSA99051 --package C:\releases\ps5library-01.003.000.pkg.remastered.pkg --delta C:\releases\ps5library-01.003.000.pkg.delta.pkg --base-version 01.002.000 --icon C:\build\PPSA99051\sce_sys\icon0.png
```

Success prints one JSON object containing `ok: true` and a validation result,
then exits `0`. Failure prints one JSON error object to stderr and exits `1`.
The gate deletes its temporary publication.

### 3. Publish

Only publish after the release gate passes:

```powershell
npm run native:update -- publish --title-id PPSA99051 --package C:\releases\ps5library-01.003.000.pkg.remastered.pkg --delta C:\releases\ps5library-01.003.000.pkg.delta.pkg --base-version 01.002.000 --icon C:\build\PPSA99051\sce_sys\icon0.png
```

The icon must be the PNG for this exact title. Requiring it prevents a release
from silently receiving PS5Library's artwork.

Add `--data-dir <folder>` to publish outside the configured/default `data`
directory. `--repair` is reserved for replacing the bytes of the same already
published version/base pair after the publisher's repair checks pass.

Success prints one JSON object containing `ok: true` and a `published` result
with the new content version, revision, size and SHA-256. A validation or
immutable-file conflict prints one JSON error object to stderr, exits `1`, and
does not advance `latest.json`.

The publisher stores content-addressed package, CRC and delta files under
`DATA_DIR/native-updates/<TITLE_ID>`, writes an immutable numbered release, and
atomically advances `latest.json`. The server re-hashes these files before it
serves them. The exact-base feed is empty when the installed version differs
from the release's `baseContentVersion`.

Read and cryptographically validate the currently served release without
changing it:

```powershell
npm run native:update -- status --title-id PPSA99051 --data-dir data
```

After publication, use the matching title's PS5Library Settings action to check
and install through the authenticated agent/direct AppInst path. Home's
**Options** -> **Check for Update** remains a separate exact-base feed path.
Do not publish a second successor until the first one has installed
successfully on hardware.

On firmware 4.51 that Home path creates its BGFT row without a task title or
icon, even though completion resolves both from AppDb. PS5Library's
authenticated agent path instead requires the registered Title ID and exact
installed base, derives the name/Content ID/package/icon on the Library Node,
and supplies the name and icon URL to direct AppInst when the task is created.

## Coding-agent rules

1. Run inspection before any install or publication.
2. Do not infer BASE versus PATCH from the version. The worker uses CNT flags,
   and only artifacts produced by the native patch build and gate enter the
   PATCH publisher.
3. Never send an ordinary BASE package to the native update publisher.
4. Never change Title ID, Content ID or base version to force a mismatch
   through a gate.
5. Never retry an indeterminate console install until its receipt and current
   installed state have been checked.
6. Keep package toolkit binaries, console addresses, credentials and package
   content out of Git.
7. Report host validation and PS5 hardware validation separately.
8. Before a new native BASE or PATCH build, run `native:update prerequisites`
   with its source and Title ID. Report a missing update URI and use the explicit
   `configure` command to add it when Home updates are wanted. Do not silently
   replace an existing update address.

Relevant implementations:

- `tools/ps5-dev/pkg_cli.py`
- `tools/ps5-dev/pkg_gui.py`
- `scripts/native-update.mjs`
- `scripts/build-native-update.ps1`
- `scripts/check-native-update.mjs`
- `scripts/publish-native-update.mjs`
- `server/src/updates/routes.ts`
- `server/src/transfers/routes.ts`
- `ps5/developer/package_tool.c`
