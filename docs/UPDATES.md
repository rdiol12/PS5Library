# PS5 app updates

## Catalog game patches

The existing reference-package builder remains the source of game patches. Its
`<name>.pkg.remastered.pkg` output is the cumulative package accepted by the
catalog installer. Place only that remastered package in the watched games
folder; the compact `.pkg` and `.delta.pkg` outputs belong to the separate Home
update feed.

The worker reads the package's embedded `targetContentVersion` and stores it as
`baseContentVersion`. The server offers the UPDATE only when the selected PS5
reports the exact same Title ID, Content ID and installed base version. The
destination is locked to the drive containing that installed version. The
agent repeats those checks from `/user/appmeta/<TITLE_ID>/param.json`
immediately before AppInst and confirms the requested target version and
installed-image hash before reporting `READY_ON_PS5`.

This catalog path uses the existing authenticated transfer queue and full
remastered package. It does not add commercial games to the fixed homebrew
title registry, alter an installed game's `versionFileUri`, or infer a base
version from release ordering. Hardware installation of a catalog game patch
remains pending.

## Native title package updates (0.2.13+)

The installed native title `PPSA99051` uses the PS5 package-update feed in its `versionFileUri`. New builds include their content version in that URI. The feed advertises a patch only when its declared `baseContentVersion` exactly matches that version. It serves a digest-bound manifest, full cumulative update package, PlayGo CRC and delta from immutable revision-scoped URLs. The build uses `PS5LIBRARY_NATIVE_VERSION_URI` when explicitly set, then the exact HTTPS `COMMUNITY_MASTER_URL`, then the self-hosted `PUBLIC_URL`; no server address is stored in source.

With a Community Master configured, Settings checks through the approved Library Node. Installing from Settings requests a one-use console activation, which the PS5 agent redeems before submitting the exact registered title metadata to direct AppInst. Home's separate **Check for Update** action requests the exact-base Master feed. The Master returns an empty feed for an unregistered IP, a banned Node, an unbound URL or a different installed content version. Accepted manifests and package ranges use short-lived random grants bound to that console's observed IP. The Master hosts only PS5Library application updates, never game packages.

One manual package bootstrap installed content version `01.002.000` and was confirmed on the firmware-4.50 console as app version 0.2.13. That bootstrap corrected the previously blank `versionFileUri`. Later releases can use Home: highlight PS5Library, press Options, then choose **Check for Update**. The app's Settings page instead checks the authenticated Node metadata and asks the paired agent to install through direct AppInst, which can supply the task name and icon.

### Native download-card artwork

**VERIFIED ON FIRMWARE 4.51:** Home successfully installed PS5Library content
`01.038.000`, but its in-progress Downloads card had no title artwork. This is
not a missing package asset. AppDb names PS5Library and points to a readable
512x512 `icon0.png`; the completion notification resolves that local title and
icon correctly. Both retained PS5Library Home-update rows instead have empty
`tbl_downloads.title` and `icon_path` values.

The matching ShellCore trace registers the BGFT patch task with those fields
empty. Its later notification resolver first records
`EntitlementMgr::getByEntitlementId()` and `AppGetEntitlementByContentId()`
failing with `0x809C0201`. Firmware 4.51 then falls back to HDB/AppDb, where the
captured record provides `TITLE=PS5Library`, `_metadata_path`, and the readable
`icon0.png`. That fallback can repair notification presentation, but it runs
after task registration and never backfills the BGFT row. Current update
tooling treats `app_tag@name` as an import timestamp, not a display-title or
artwork field, so the feed cannot populate the individual Home download task.

Static analysis places that task creation inside PlayGoCore/BGFT before the
title-and-icon resolver runs. No supported caller-controlled title or icon
input was found on the Home `Check for Update` path.

**VERIFIED DIRECT-APPINST ALTERNATIVE ON FIRMWARE 4.51:** an exact-base
`01.039.000` cumulative update was submitted with
`sceAppInstUtilInstallByPackage`, `content_name=PS5Library`, and the installed
PS5Library icon served over console loopback. The finalized `FIH` package was
accepted, installed over `01.038.000`, and launched successfully. Its completed
BGFT row contains `title=PS5Library`, the supplied icon URL, version
`01.039.000`, and error `0x00000000`; the completion notification also resolved
the installed PS5Library name and icon. The SDK's intermediate `LIH` candidate
was rejected synchronously with `0x80B2116A` and is not an AppInst input.

This proves the two routes behave differently: explicit AppInst metadata can
decorate the native Downloads task, while Home `Options -> Check for Update`
cannot provide that metadata for this unentitled homebrew title. Keeping the
Home action therefore keeps its blank in-progress card. PS5Library-initiated
updates now use the authenticated agent/AppInst route with an explicit
registered title and exact installed base; they do not edit a system database.

**VERIFIED SOURCE:** etaHEN commit `dafa13b562ddb137a4b4a97b9aaa287c0c57cc9c`
documents the PS5 `sceAppInstUtilInstallByPackage` `MetaInfo` fields
`content_name` and `icon_url`; ps5-ezremote-client commit
`a81a264c5caf6de16844141a380135ecc27d8adf` declares the same six-pointer ABI.
PS5Library's agent already supplies those fields for direct native package
downloads. The nonempty icon URL is now hardware-validated for direct AppInst;
it is not a Home-updater fix. Direct database edits, fabricated entitlements
and unverified XML attributes are intentionally excluded.

Build a cumulative native update with the unified CLI and the local toolkit
configured in `PS5_PKG_TOOLKIT_DIR`:

```text
npm run native:update -- build --title-id <registered-title-id> --source <native-title-folder> --output <patch.pkg> --reference <previous-remastered.pkg> --base-version <previous-version>
```

The build command creates the SDK patch and remastered package, extracts their declared subcontainer and supplemental regions, and uses the toolkit's delta converter to create the PS5 `CNT 0x23`/`RLC` distribution file. It then runs one isolated release gate automatically. The gate rebuilds the worker and checks exact title/content/version identity, distributable package geometry, internal digest, 64-KiB CRC coverage and the delta container before the artifacts can be published.

After that gate passes, publish with:

```text
npm run native:update -- publish --title-id <registered-title-id> --package <patch.pkg.remastered.pkg> --delta <patch.pkg.delta.pkg> --base-version <previous-version> --icon <native-title-folder>\sce_sys\icon0.png
```

The publisher repeats the boundary checks, rejects non-monotonic versions and changed/symlinked inputs, requires the selected title's explicit PNG icon, writes an immutable revision record and atomically advances `latest.json`. Superseded package, delta and CRC assets are removed after activation; release metadata remains for audit. Do not publish a second successor until the previous release has installed successfully on hardware. Base-bound feeds prevent upgraded clients from receiving a patch for another base. The SDK-generated homebrew package is unsigned and requires the compatible jailbreak runtime; it is not a retail-signed package. See the [short tool guide](NATIVE_UPDATE_TOOL.md) for the complete command sequence.

## Local OpenStory updates

Before a title's first BASE build, `npm run native:update -- configure
--title-id <registered-title-id> --source <folder> --update-origin <origin>`
inserts its exact-version update URL and backs up the original `param.json`
outside the source folder. `prerequisites --title-id ... --source ...` warns when that address
is missing. See [PKG operations](PKG_OPERATIONS.md) for overwrite handling and
registering another homebrew game. Existing installed metadata requires a
one-time bootstrap install before Home can discover patches.

The same local CLI, release gate and immutable feed now support the pinned
OpenStory identity `PPSA99783` / `UP9000-PPSA99783_00-OPENSTORYPS50000`.
Select it explicitly with `--title-id PPSA99783`. Package classification must
be UPDATE, all title/content identities must match, and the release must be
newer than its exact declared base. Game feeds require the `/from/<version>/`
route; the generic unbound game feed is not exposed.

OpenStory uses the Library Node's `PUBLIC_URL`. Community Master activation and
the base-qualified `GET /api/v1/device/native-updates?baseContentVersion=...`
check remain PS5Library-only. The query stays optional for already-published
clients; when supplied, discovery returns a release only for that exact base.
the strict authenticated direct-install POST accepts a registered OpenStory
title plus its exact installed base and derives all display/package metadata on
the server. OpenStory `01.000.023` installed successfully over exact base
`01.000.021` through Home on firmware 4.51. The generic direct OpenStory path
passes host and cross-build checks but still needs a newer exact-base package
for physical name/icon validation while downloading.
See [the command guide](PKG_OPERATIONS.md) and the OpenStory project's
`platform/ps5/README.md` for the pending build inputs.

## Startup and empty-feed fixes (0.2.9)

The 0.2.8 app omitted `SceIpmi` before `SceAppInstUtil` in its ELF dependencies. Loading the native download library prevented startup on the development console; the updater restored 0.2.4 after receiving no new boot receipt. The corrected shared linkage is checked against the app, agent and installer ELF files after linking. The corrected candidate reached the storefront on the PS5; this does not prove native package installation or Home/background behavior.

Withdrawing the failed update also exposed a parser defect: json-c returned “continue” for the complete scalar `null` because the client did not supply end-of-input. The shared parser now includes the terminating NUL while still rejecting malformed/trailing input. The server sends `null` followed by a newline for an empty feed so earlier clients can finish parsing it. The JSON value and authentication contract are unchanged. Regression checks reproduce the original failure, accept complete scalars and reject malformed input; signed download/resume and corrupt-signature tests pass.

## Connection and trust

The updater uses the same `serverUrl` and paired device credential as the storefront. There is no separate update-server IP. Paths are relative `/api/v1/device/updates` and `/api/v1/device/updates/<sha256>`; the native integration check uses a dynamically assigned server port.

The console's homebrew loader is a separate local service. Its address is `launcherUrl` in the console config, optionally overridden by the `PS5LIBRARY_LAUNCHER_URL` process environment variable. Provision this value from your environment. No launcher host/port is hard-coded in updater code. This loader URL is never used to download app updates from the PC.

The server advertises a manifest signed with Ed25519. The app pins the corresponding public key at build time and verifies the exact signed bytes before downloading executable content. SHA-256 and size are then checked before publication. A hash delivered over the same HTTP connection alone is not treated as an authenticity guarantee. Older/equal builds cannot replace the current app through the updater.

## Publishing a build

1. Once, run `node --env-file=.env scripts/publish-update.mjs --init`. The private key stays in ignored `.secrets/update-signing/private.pem` (or `UPDATE_SIGNING_DIR`) outside runtime data and the Docker build context; back it up privately. Only `ps5/assets/update-public-key.pem` belongs in the repository/build. Rebuilding a server's trust key requires a new trusted bootstrap on consoles.
2. Increment `appVersion` and monotonic `appBuild` in `ps5/common/version.hpp` and build the PS5 targets. CMake produces `ps5library-install.elf.json` containing the build, installer hash and public-key fingerprint.
3. Run `node --env-file=.env scripts/publish-update.mjs`. The publisher checks the ELF, generated metadata, matching signing key and increasing build number, then publishes an immutable hash-named installer and atomically replaces the signed announcement.

Only the local publisher needs the private key. There is no HTTP upload/signing endpoint. A server can serve only prebuilt releases; this does not download or execute arbitrary upstream binaries.

## Console behavior

The app checks at launch after pairing, then every six hours while open. Settings provides Update & restart and measured byte progress. Downloads use `.part` files and HTTP Range resume; cancellation retains partial data. Corrupt or untrusted content is rejected.

The verified installer runs through the configured, source-verified homebrew loader. `websrv` treats its `args` parameter as the full argv, including argv[0]; every update/restart request explicitly includes the program name. The installer waits for the storefront's file lock to release after SDL cleanup, stages the owned home-entry files, preserves configuration/pairing, registers the exact title and starts the replacement app.

The previous owned title is retained until the new app reports its compiled build after rendering 60 frames. Registration or launch failure restores the previous files where no app is holding the lock. A hung app or interrupted installation preserves recovery files and reports failure; it does not kill arbitrary processes or discard the backup. Server jobs continue independently; console transfers resume when the agent returns.

## Recovery / limitations

- Automatic app update requires the owned `BREW05001` home entry, a compatible configured loader and the standard `/data/ps5library` config location.
- A raw old ELF without this updater needs one initial replacement. Subsequent supported app updates use the saved server connection.
- `.ps5library-previous` under `/user/app` is protected recovery state. If a failed update leaves it, verify the current/previous hashes and app startup before choosing restoration or cleanup. Do not remove foreign/unmarked folders.
- The current hardware session retains an additional owned `.ps5library-recovery-2026091601` bootstrap copy while upgrade testing is in progress.
- Existing package/game installations, Sony system files, paired identities and source dumps are outside the update target.
- Unit/native checks cover signatures, tampering, downgrade refusal, download resume, corruption rejection and installer rollback. Hardware upgrade validation is tracked in STATUS.md; a host check is not a PS5 execution claim.

Verified upstream references: [websrv](https://github.com/ps5-payload-dev/websrv), local commit `1afd476c5044d68df4e45dc773769e5de3b2cdd6`, `src/websrv.c` (`elfldr_request`), `src/ps5/sys.c` (`args_split`, `sys_launch_daemon`, `sys_launch_homebrew`); [OpenSSL Ed25519](https://docs.openssl.org/3.0/man7/EVP_SIGNATURE-ED25519/) documents the one-shot verification API used by the already-linked OpenSSL dependency.
