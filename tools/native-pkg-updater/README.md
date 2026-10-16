# Native PKG Update CLI

This CLI configures, builds, validates, and publishes update PKGs for registered
native titles. Use it only with software and content you are authorized to
modify.

It does **not** build the initial BASE PKG. Build that with your separately
obtained packaging toolkit, install that exact output, then use it as the
reference for the first update.

## Update paths

### PS5 Home: Check for Update

Each BASE or PATCH source must contain a `versionFileUri` for its own
`contentVersion`. The PS5 requests that public URL when the user selects
**Check for Update**:

```text
PS5 Home
  -> version.xml
  -> manifest.json
  -> delta/package/CRC assets
  -> native download and install UI
```

The Library Server exposes these GET routes without device authentication so
the native updater can reach them. The origin must be reachable directly from
the console, support HTTP Range requests, and contain no private files. Treat
published update packages and icons as public artifacts.

### PS5Library Store and agent

The PS5Library Store has a separate authenticated check for its own update. It
asks the paired agent to verify the installed title, content ID, and base
version before starting the native download. When `COMMUNITY_MASTER_URL` is
configured, this PS5Library-only check delegates to that service instead of the
locally published PS5Library release.

Adding a title to `server/shared/native-titles.json` creates its server routes and CLI
support. Agent-driven installation also requires that title identity and URL
route to be compiled into the agent. The released agent currently includes
PS5Library and OpenStory. Other registered titles use the PS5 Home update path
unless you build a matching agent.

Catalog `UPDATE` packages are a third, existing server feature. They are
matched to an exact base release and do not use this publishing CLI.

## Requirements

- Node.js `>=22.23.2 <23` or `>=24.18.1`
- .NET 10 SDK
- Python 3 available as `python`
- A prepared title folder with `sce_sys/param.json`, `sce_sys/icon0.png`, and
  the 96-byte `sce_sys/keystone` required by the community toolkit
- The exact installed BASE build for the first update, retained locally
- The previous CLI-generated `.remastered.pkg` for each later update
- A compatible external toolkit containing:
  - `build-from-folder.ps1`
  - `toolchain/prospero-pub-cmd.exe`
  - `toolchain/ext/sc2.exe`

The reference package must be readable by the publisher with the native update
passcode of 32 zeroes. A package readable only with `--no_passcode` cannot be
used as a delta reference. The CLI does not bundle the toolkit, credentials,
generated packages, or game data.

### Obtain and place the packaging tools

The `build` command currently requires Windows 10 or 11 and Windows
PowerShell. Get the compatible native-update toolkit from Drakmor's Discord,
then extract it to a permanent folder outside the PS5Library repository.

Keep the complete extracted toolkit together. At minimum, this layout must be
present; retain every other DLL and executable supplied under `toolchain` and
`toolchain\ext` because the publisher loads them at runtime:

```text
C:\PS5PackageTools\
|-- build-from-folder.ps1
|-- scripts\
|   `-- create-gp5-from-folder.py
`-- toolchain\
    |-- libScePubTools.dll
    |-- prospero-pub-cmd.exe
    `-- ext\
        |-- sc2.exe
        `-- ...other supplied runtime files
```

Then set the directory in `server/.env`:

```dotenv
PS5_PKG_TOOLKIT_DIR=C:\PS5PackageTools
```

Do not run the toolkit executables manually. After setting the path, use the
`prerequisites`, `build`, `inspect`, and `publish` commands below. PS5Library
calls the folder builder, publisher, and delta converter in the required order.

The Library Server itself can run on Linux. Build and inspect native updates
on a Windows machine that has the authorized toolkit, copy the generated
`.remastered.pkg`, `.delta.pkg`, and icon to the Linux host, and run the
`publish` command there. The current native PATCH builder is not a native Linux
tool. Wine is not tested or supported.

From `server/`:

```powershell
npm ci
npm run build:worker
npm run native:update -- --help
```

Register the exact title ID, content ID, and display name in
`server/shared/native-titles.json`, then rebuild and restart the server.

Set the console-reachable public origin in `server/.env`:

```dotenv
PUBLIC_URL=https://updates.example
```

Keep prepared title folders and build output outside the repository. The
`configure` command creates a sibling `.param-before-update-uri.json` backup;
do not commit it.

## Add your server URL to a PKG

Before building every BASE or PATCH, set its final `contentVersion`, then run:

```powershell
npm run native:update -- configure `
  --title-id PPSA99051 `
  --source C:\path\to\prepared-title `
  --update-origin https://updates.example
```

`configure` writes this field to `sce_sys/param.json`:

```json
{
  "versionFileUri": "https://updates.example/api/v1/native-updates/PPSA99051/from/01.000.000/version.xml"
}
```

The version in the URL comes from that source folder's current
`contentVersion`. Build the BASE PKG with the external toolkit after running
`configure`. Build PATCH PKGs with this CLI as described below. This preserves
the update URL in each installed version so it can discover the next update.

Use `--force` when intentionally replacing an existing origin:

```powershell
npm run native:update -- configure `
  --title-id PPSA99051 `
  --source C:\path\to\prepared-title `
  --update-origin https://new-updates.example `
  --force
```

For ordinary self-hosting, leave `PS5LIBRARY_NATIVE_VERSION_URI` and
`COMMUNITY_MASTER_URL` unset and set `PUBLIC_URL` to the same origin. For
PS5Library, an exact `PS5LIBRARY_NATIVE_VERSION_URI` takes precedence, followed
by `COMMUNITY_MASTER_URL`, then `PUBLIC_URL`. Configure the source against the
selected origin; an explicit version URI must exactly equal the full
`versionFileUri`.

Use HTTPS for an Internet-facing service. The origin must contain no path,
credentials, query, or fragment, and the resulting URI must fit the platform's
255-character metadata limit.

An installed package without this field cannot be redirected remotely. Rebuild
and reinstall it once with the URL embedded. Changing the origin also requires
rebuilding and reinstalling the affected version.

## Build and publish an update

Examples below update installed `01.000.000` to the newer `contentVersion`
already set in `C:\path\to\prepared-title\sce_sys\param.json`.

1. Embed the URL for the **new** version:

   ```powershell
   npm run native:update -- configure `
     --title-id PPSA99051 `
     --source C:\path\to\prepared-title `
     --update-origin https://updates.example `
     --force
   ```

2. Validate the source. Continue only when the JSON result contains
   `"ready": true`:

   ```powershell
   npm run native:update -- prerequisites `
     --title-id PPSA99051 `
     --source C:\path\to\prepared-title
   ```

3. Build against the exact installed BASE for the first update. For later
   updates, use the previous CLI-generated `.remastered.pkg` retained locally:

   ```powershell
   npm run native:update -- build `
     --title-id PPSA99051 `
     --source C:\path\to\prepared-title `
     --output C:\path\to\update.pkg `
     --reference C:\path\to\retained-reference.pkg `
     --base-version 01.000.000
   ```

   This creates the requested patch plus `.remastered.pkg` and `.delta.pkg`
   companions. Keep the `.remastered.pkg` for the next build. Do not substitute
   the server-served package because publication can remove supplemental bytes.

4. Inspect the generated native-update set:

   ```powershell
   npm run native:update -- inspect `
     --title-id PPSA99051 `
     --package C:\path\to\update.pkg.remastered.pkg `
     --delta C:\path\to\update.pkg.delta.pkg `
     --base-version 01.000.000 `
     --icon C:\path\to\prepared-title\sce_sys\icon0.png
   ```

5. Publish it:

   ```powershell
   npm run native:update -- publish `
     --title-id PPSA99051 `
     --package C:\path\to\update.pkg.remastered.pkg `
     --delta C:\path\to\update.pkg.delta.pkg `
     --base-version 01.000.000 `
     --icon C:\path\to\prepared-title\sce_sys\icon0.png `
     --data-dir C:\path\to\ps5library-data
   ```

6. Validate the local publication state:

   ```powershell
   npm run native:update -- status `
     --title-id PPSA99051 `
     --data-dir C:\path\to\ps5library-data
   ```

7. Test the running public route from another machine:

   ```powershell
   Invoke-WebRequest `
     https://updates.example/api/v1/native-updates/PPSA99051/from/01.000.000/version.xml
   ```

When the server runs in Docker, execute the CLI with the **host** data path from
`DOCKER_DATA_DIR`; do not pass the container-only `/data` path.

Every command prints one JSON result and returns a nonzero exit code on failure.
Publication verifies identity, version ordering, package geometry, delta
structure, icon type, hashes, and block checksums before atomically replacing
`latest.json`.

Use `--repair` only to republish the same non-quarantined release after repairing
its generated files. Published releases are otherwise immutable, and
superseded binary assets are removed automatically.

## Common failures

| Code | Meaning |
| --- | --- |
| `UNSUPPORTED_TITLE` | The title is absent from `server/shared/native-titles.json` |
| `UPDATE_ORIGIN_NOT_CONFIGURED` | `PUBLIC_URL` or the title update URL is missing |
| `VERSION_NOT_NEWER` | The prepared source version is not newer than the installed reference |
| `REFERENCE_MISMATCH` | The reference PKG identity/version does not match the requested base |
| `REFERENCE_PLAINTEXT_NATIVE_UPDATE_UNSUPPORTED` | The reference is readable only with `--no_passcode` |
| `NATIVE_UPDATE_BASE_MISMATCH` | The console does not have the exact required version installed |
| `INVALID_NATIVE_UPDATE` | Metadata or an update asset failed validation |

Do not rename or edit published files manually. Publish a newer content version
through the CLI.
