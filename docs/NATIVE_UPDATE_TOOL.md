# Native PS5 update tool

Run every command from the PS5Library repository root. The single supported
entry point is:

```powershell
npm run native:update -- --help
```

## One-time setup

Set the local package toolkit in `.env`:

```dotenv
PS5_PKG_TOOLKIT_DIR=C:\path\to\toolkit
PUBLIC_URL=http://<library-server>:3150
```

Before building the first package that supports **Check for Update**, write its
exact update address into the source metadata:

```powershell
npm run native:update -- configure --title-id PPSA99783 --source C:\build\PPSA99783 --update-origin http://<library-server>:3150
npm run native:update -- prerequisites --title-id PPSA99783 --source C:\build\PPSA99783
```

Use `PPSA99051` for PS5Library or `PPSA99783` for OpenStory. Run `configure`
again after increasing `contentVersion`. Every command requires an explicit
`--title-id`; there is no implicit PS5Library title.

## Build a patch

Give the tool the new source folder and the exact previous remastered package:

```powershell
npm run native:update -- build --title-id PPSA99783 --source C:\build\PPSA99783 --output C:\releases\OpenStory-01.000.003.pkg --reference C:\releases\OpenStory-01.000.002.pkg.remastered.pkg --base-version 01.000.002
```

If the packaged source contains an unsuitable SELF, add
`--executable C:\path\to\raw-game.elf`. For an unsigned homebrew title that has
no `nptitle.dat`, add `--generate-unsigned-nptitle`; this creates structural
homebrew metadata, not Sony-issued signing or PSN entitlement.

One build command produces:

- `.pkg` - SDK patch candidate;
- `.pkg.remastered.pkg` - cumulative package served to the console;
- `.pkg.delta.pkg` - native delta container.

You do **not** manually build another base package first. The previous
remastered package is the reference used to construct the new patch.

## Use the same output in the game catalog

For a catalog game, copy only `<patch>.pkg.remastered.pkg` into the configured
watched-games folder. The worker reads its embedded title, content version and
`targetContentVersion`; that target becomes the exact installed base required
by the release. The compact `.pkg` and `.delta.pkg` remain inputs for the
separate Home update-feed path and must not be imported as catalog releases.

The server exposes the update only to a console reporting that exact title,
Content ID and base version, and only on the storage containing that base. The
agent repeats those checks immediately before AppInst. After installation it
requires the target metadata and hashes the installed image before reporting
the update ready. No filename or catalog ordering is used to infer versions.

## Publish and check

The build runs the release gate automatically. Publish its two final outputs:

```powershell
npm run native:update -- publish --title-id PPSA99783 --package C:\releases\OpenStory-01.000.003.pkg.remastered.pkg --delta C:\releases\OpenStory-01.000.003.pkg.delta.pkg --base-version 01.000.002 --icon C:\build\PPSA99783\sce_sys\icon0.png
npm run native:update -- status --title-id PPSA99783
```

`--icon` is the PNG supplied when PS5Library starts the update through direct
AppInst. It is required so one registered title can never inherit another
title's artwork. Sony Home's **Check for Update** path does not request this
file and still leaves its in-progress card unnamed on firmware 4.51.

A successful publish atomically activates the new release and removes
superseded package, delta and CRC assets. It keeps release metadata for audit.
After an updater crash, qualify the replacement once from Home with the target
title fully closed. This isolates package installation from the previous
runtime state; it is a diagnostic control, not a normal user requirement. The
native updater remains responsible for the title lifecycle. Test the result on
the target PS5 before publishing the next version.

If installation fails or reboots the console, quarantine that release by
renaming `latest.json` to
`latest.quarantined-<reason>-<contentVersion>.json`. With no `latest.json`, the
server stops advertising the release while its numbered metadata remains for
audit. The publisher refuses `--repair` while that quarantine marker is active;
build and validate a higher `contentVersion` instead.

For validation rules and recovery details, see [PKG operations](PKG_OPERATIONS.md).
