# PS5Library

A self-hosted, visual homebrew/game library for authorized content, with a native PS5 storefront, durable preparation/download jobs, multiple private user accounts and registered consoles.

**Engineering preview.** The server, real package/image worker and native PS5 ELF build locally. The generated packages, home-entry installer, notifications and mounting need physical PS5 validation. The user's first target is firmware **4.51**; the design supports capability negotiation across jailbreakable firmware, not a blanket promise that every feature works everywhere. See [STATUS.md](STATUS.md) for what is verified and what remains.

## Start the server on this Windows machine

Prerequisites: Node 22.18+, Git, Docker Desktop and .NET 10 SDK. Commands below run from `C:\Users\rdiol\dev\PS5Library`.

```powershell
npm ci
npm run setup
docker compose --env-file .env -f docker/compose.yml up -d --wait
npm run upstream
npm run build:worker
npm run build
npm start
```

Open **http://127.0.0.1:3150**. Create the first account using `BOOTSTRAP_TOKEN` from the local `.env` file and a password of at least 5 characters. Do not paste that secret into public messages. Later accounts require a one-use invitation created by an admin in Accounts. Each owner sees only their catalog, consoles, cached packages and jobs. A PS5 pairs once using its displayed code; its random device credential persists across launches.

The API binds to loopback by default. For friends/remote consoles, put it behind your HTTPS reverse proxy or private VPN, configure `PUBLIC_URL` and the appropriate bind address, and use a trusted certificate. Keep PostgreSQL/Redis and console payload-loader ports private. Native clients do not bypass certificate verification.

`PUBLIC_URL` is also the trusted browser origin. To open the same server at additional addresses, list their exact origins in `BROWSER_ORIGINS` and restart the server. For example, after setting a LAN `PUBLIC_URL`, use `BROWSER_ORIGINS=http://127.0.0.1:3150,http://localhost:3150` to keep PC access working. Include the scheme and port; omit paths and wildcards. An unconfigured browser address returns `ORIGIN_DENIED`.

## Add your content

Connectors support local folders, static manifests, private HTTP manifests and a GitHub release containing `ps5library.json`. Automatic source scanning can be configured every 5–1440 minutes. There is no automated commercial-game warez-site connector.

For local content, create `data/sources/<YOUR_USER_UUID>/<folder>/library.json`, then add a Local Folder source using that folder name. `/api/v1/me` returns your account ID. The browser Source form and [shared schema](shared/schemas/index.ts) define the complete format.

```json
{
  "schemaVersion": 1,
  "releases": [{
    "key": "my-homebrew-1.0",
    "game": {
      "title": "My Homebrew",
      "titleId": "BREW05002",
      "contentId": "IV0000-BREW05002_00-MYHOMEBREW000000",
      "description": "My own homebrew application",
      "genres": ["Homebrew"],
      "artwork": { "cover": "cover.png", "hero": "hero.jpg" }
    },
    "version": "01.00",
    "format": "elf",
    "size": 65536,
    "sha256": "REPLACE_WITH_THE_ACTUAL_64_CHARACTER_SHA256",
    "location": "my-homebrew.elf",
    "minimumFirmware": null
  }]
}
```

Replace sample size/hash with actual values. Unknown firmware stays unknown. For prepared game folders, use format `folder`, a relative directory location and the hash/size from `dotnet worker/bin/Release/net10.0/PS5Library.Worker.dll hash-tree <folder>`. The folder must contain `eboot.bin` and `sce_sys/param.json`. Source files are never modified. Private repository tokens are configured as `REPOSITORY_TOKEN_*` environment variables; exact private origins must be allowlisted.

After building our PS5 ELF, `npm run demo -- <YOUR_USER_UUID>` creates a local source containing PS5Library's own compiled payload and original icon. It does not install itself or claim untested firmware compatibility.

## Downloads, preparation and PC cache

Select a release, an owned PS5, supported storage and method. `POST /api/v1/installations` persists the workflow. The server downloads/extracts/builds when supported, verifies the output, reuses an exact verified cache hit, waits for an offline console, then queues transfer. Jobs continue when a client closes or the server restarts.

Folder and safe-ZIP inputs can build real `.pkg` FPKG/debug images with LibProsperoPKG or UFS2 `.ffpkg` images for ShadowMountPlus. These are separate adapters. Unsupported/encrypted/corrupt/mismatched inputs fail explicitly. Conversion exposes actual stages, not fabricated byte percentages.

Prepared packages remain on the PC. The **Server cache** page lists them and can delete a selected copy when no active transfer uses it. Deletion preserves the source and console copy. Native/iPhone normal flows use the installation coordinator; browser advanced controls also expose standalone download, build and transfer.

## Build the PS5 application

```powershell
docker build -f docker/ps5-build.Dockerfile -t ps5library-build:0.43 .
docker run --rm -v "${PWD}:/workspace" ps5library-build:0.43 cmake -S ps5 -B ps5/build/ps5 -DCMAKE_TOOLCHAIN_FILE=/opt/ps5-payload-sdk/toolchain/prospero.cmake
docker run --rm -v "${PWD}:/workspace" ps5library-build:0.43 cmake --build ps5/build/ps5 -j 8
```

Outputs:

- `ps5/build/ps5/ps5library.elf` — native SDL storefront with embedded foreground agent.
- `ps5/build/ps5/ps5library-agent.elf` — separate agent payload, with runtime persistence still unverified.
- `ps5/build/ps5/ps5library-install.elf` — experimental home-entry installer with the original PS5Library icon, frontend ELF, font and CA bundle.

The installer requires a running compatible websrv and an already configured Homebrew Launcher bootstrap. It registers only our owned `BREW05001` title folder through an available exact-title API; it does not automatically invoke broad install-all or create system bootstrap files. It cannot currently register the shortcut through the unverified 12+ path. The storefront can still be deployed through a supported homebrew launcher when shortcut registration is unavailable.

On first launch, **Connect your library** opens automatically. Enter your server's HTTPS address, choose **Save & connect**, then claim the displayed pairing code from your signed-in account. **Settings → Server connection** reopens this flow. The frontend ELF includes its initial font, font license and trusted CA bundle, extracting missing files beside its configuration. Existing custom certificates/fonts are preserved. First-run rendering and input still need PS5 hardware validation.

HTTPS is the default. Plain HTTP requires explicitly enabling **Unencrypted HTTP** and should only be used on a trusted local network. Enter the server origin without an API path, query or embedded password. Changing to another server requires **Switch & pair again**; it stops the old connection, generates a new device identity and preserves existing local files. The old credential is never sent to the new server. If a separate agent is running, stop it before changing settings. One previous configuration/device backup is kept locally in `previous-server.json`; protect it like a password.

Advanced settings remain in `/data/ps5library/config.json`, using [config.example.json](ps5/config.example.json): display name, runtime and actual storage. Unknown runtime keeps compatibility unknown. Notifications/ShadowMount are explicit settings pending hardware verification. Preserve `device-state.json`; it contains the paired credential and is bound to the selected server. Inventory receipts are bound to both the server and console; older unbound receipts require explicit re-import and are not silently shared after switching.

Selecting the home entry uses the existing loader to start the native app. That loader may close the running game. Reboot requires re-enabling the jailbreak/runtime/loader; a persistent icon does not create persistence for those services. [System integration](docs/PS5_SYSTEM_INTEGRATION.md) records the source evidence, requirements and recovery details. No deployment to a real console has been performed.

## Native design preview and checks

```powershell
docker run --rm -v "${PWD}:/workspace" ps5library-build:0.43 cmake -S ps5 -B ps5/build/host -DCMAKE_C_COMPILER=clang-18 -DCMAKE_CXX_COMPILER=clang++-18
docker run --rm -v "${PWD}:/workspace" ps5library-build:0.43 cmake --build ps5/build/host -j 8
docker run --rm -v "${PWD}:/workspace" ps5library-build:0.43 ctest --test-dir ps5/build/host --output-on-failure
node scripts/preview.mjs
docker run --rm -e SDL_VIDEODRIVER=dummy -v "${PWD}:/workspace" ps5library-build:0.43 ps5/build/host/ps5library data/reference/config.json --preview --frames=120 --capture=data/reference/discover.bmp
npm test
npm run test:worker
npm run test:integration
npm run test:native
```

Preview requires the user-supplied desktop `storefront.png`; preview assets stay local/ignored. It renders actual widgets, not a flattened screenshot. `--screen=Downloads`, `--screen=Game`, `--screen=My Library`, `--screen=My PS5`, `--size=1280x720` and `--script=right,down,select,back` support further inspection. Mutation is disabled in preview. Production mode obtains real API data.

Integration checks create/drop isolated PostgreSQL schemas and use generated/project-owned content. Native checks require the Docker build image and both native build outputs; they exercise controller server setup, pairing, verified ELF transfer, missing/corrupt content and confirmed server switching through the actual native application/agent running as an explicitly labeled host simulator.

## iPhone and documentation

The SwiftUI Xcode project lives in `ios/PS5LibraryCompanion.xcodeproj`. Source can be developed here; compiling, signing and simulator/device verification require macOS/Xcode. See [IOS.md](docs/IOS.md).

Research and evidence: [RESEARCH](docs/RESEARCH.md), [ARCHITECTURE](docs/ARCHITECTURE.md), [FPKG](docs/FPKG.md), [SHADOWMOUNT](docs/SHADOWMOUNT.md), [BACKPORTING](docs/BACKPORTING.md), [SYSTEM INTEGRATION](docs/PS5_SYSTEM_INTEGRATION.md), [NOTIFICATIONS](docs/PS5_NOTIFICATIONS.md), [STORAGE](docs/PS5_STORAGE.md), [SECURITY](docs/SECURITY.md), [ARTWORK](docs/ARTWORK.md), [ENVIRONMENT](docs/ENVIRONMENT.md).

Third-party dependencies have their own licenses. The payload SDK, LibProsperoPKG and several researched projects carry GPL terms; UFS2Tool uses BSD-2-Clause. Keep corresponding notices/source obligations when distributing linked binaries. No public release is published by this workspace task.
