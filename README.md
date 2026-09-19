server files will be release after i ironed out some bugs  

<p align="center"><img src="ps5/assets/icon0.png" width="140" alt="PS5Library icon"></p>

# PS5Library

A native, controller-first storefront for a self-hosted PS5 library.

Browse cover artwork, explore games, manage your console library, and follow real
download progress. Designed for your own dumps, homebrew, private repositories,
and other content you are authorized to use.

**Engineering preview.** This repository contains the PS5 frontend, console-side
client code, installer, tests, and build workflow. A separately hosted PS5Library
server is required; the server and its data are not included here.

[Download releases](https://github.com/rdiol12/PS5Library/releases)
· [Build status](https://github.com/rdiol12/PS5Library/actions/workflows/elf.yml)

## Features

- Cinematic Discover screen, artwork rails, game details, search, and categories.
- Controller navigation, account/profile screens, and persistent console pairing.
- Separate views of server packages and games reported by console inventory.
- Storage selection, supported title launching, and real job/transfer progress.
- Cached artwork, supplied game music, and trailers after five seconds of focus.
- Capability negotiation and signed updates from your configured server.
- Firmware saved at registration, with an explicit refresh in My PS5.
- Exact backport profile selection, missing-file warnings and verified placement.

Version 0.2.10 lets you choose the installation method before selecting storage.
This fixes a dead end when the default FPKG route cannot use the selected drive:
ShadowMount remains reachable for supported USB/M.2 destinations. Compatibility
profiles and free-space checks still apply. Native package installation currently
supports PS5 base games on internal storage; native update/DLC installation is pending.

The native preview is distributed as an installed store package plus one agent
ELF. The store remembers its server address; on first start the agent copies that
address into its separate device identity, so no compiled address or third config
file is required. IPMI loads before AppInstUtil, built ELF dependencies are checked,
and an empty update feed parses correctly.

The storefront follows the approved dark cinematic
reference: Inter typography, translucent controls, a larger hero composition,
clean controller icons and a consistent profile page. Search's View All retains
the selected results. Fonts and their license are bundled for offline startup.

The app needs the matching private server APIs (firmware, backport and
native-download APIs). A 4.51 system can carry a libc SDK baseline labelled 4.50;
the registration measurement now uses the system software API and rejects
conflicting version reports. Host checks cover that distinction; hardware
confirmation remains required.

Availability depends on the connected server and the console's actual runtime.
PS5Library is independent of Sony infrastructure and does not request PSN credentials.

## Screenshots

Captured from version 0.2.10 running on the development PS5 at 1920×1080,
using its paired server and actual library data. Downloads shows completed source
jobs and a failed preparation from that library.

### Discover

![Discover on PS5](ps5/screenshots/discover.png)

### Downloads

![Downloads on PS5](ps5/screenshots/downloads.png)

### Profile

![Profile and console library on PS5](ps5/screenshots/profile.png)

## Install

1. Start the jailbreak and the compatible kstuff/FPKG patches for your firmware.
2. Download **`PS5Library.pkg`** and **`ps5library-agent.elf`** from the same release.
3. Install `PS5Library.pkg` with the package installer supplied by your runtime.
4. Open PS5Library from the PS5 Home screen, enter your self-hosted server address,
   and complete the account pairing shown by the store.
5. Load `ps5library-agent.elf` with Payload Manager or another compatible ELF
   loader. Claim its pairing code when the PS5 notification appears.

The package stays installed. The agent supplies console inventory, runtime and
storage capabilities, native FPKG download submission, transfer progress, and
installation confirmation. Load it again after each reboot; a payload manager may
autoload it after the jailbreak. Start the store and save its server address before
the agent's first launch. These two release files are the complete console-side
installation; the separately hosted PS5Library server is still required.

The older `ps5library-install.elf` and `ps5library.elf` artifacts remain the
developer/homebrew-loader route. New users should use the native package above.

The server address is configured at first launch, not compiled into the app.
Keep the release's `SHA256SUMS` to verify downloaded files. GitHub releases are
downloads; in-app updates still come from your configured server and require a
trusted signed update envelope.

## Build

Requires Git and Docker with Linux containers. The verified development setup is
Windows with Docker Desktop running Linux x86-64 containers.

```sh
git clone https://github.com/rdiol12/PS5Library.git
cd PS5Library
docker build -t ps5library-build -f docker/ps5-build.Dockerfile .
docker run --rm --network none -v "${PWD}:/workspace" ps5library-build bash scripts/build.sh
```

The same Docker commands work in PowerShell. The Docker build downloads the
public PS5 payload SDK **v0.43** and ports **v0.40.2**, verifying their SHA-256
digests. The application build runs without network access.

`scripts/build.sh` builds the desktop test targets, runs the native tests,
cross-compiles the PS5 frontend/installer, and checks the ELF files and metadata.
Results appear in `dist/`:

| File | Purpose |
| --- | --- |
| `ps5library-install.elf` | Install/update the frontend and its assets |
| `ps5library.elf` | Application binary |
| `ps5library-install.elf.json` | Version, build and integrity metadata |
| `SHA256SUMS` | Download integrity checks |

The native application source is in `ps5/native/`. Its FSELF build pins ProsperoTV
at commit `fdee81e746308f7f2b27f7914a84eab678088fb6` and verifies an extract/readback
round trip. Creating the final FPKG requires locally installed PS5 Publishing Tools,
which cannot be redistributed or installed on GitHub-hosted runners. GitHub Releases
therefore host the exact package that passed the physical-console check; Actions
continues to build the open-source ELF artifacts.

The public update verification key is in `ps5/assets/update-public-key.pem`.
Its private key is not included. Builds for a different update publisher must
use that publisher's public key and matching signed manifests.

## Automated releases

GitHub Actions tests main-branch pushes and pull requests. Installable artifacts are
built only for an explicit version tag or a manually started packaging workflow.
Push a version tag matching `ps5/common/version.hpp` to publish the verified ELF
files as a prerelease:

```sh
git tag v0.2.10
git push origin v0.2.10
```

For subsequent releases, update the application version and increase its build
number first. Tagged releases also include the dependency sources, upstream
patches/build recipes, and license notices needed for redistribution. Source
downloads are pinned by hash in `licenses/sources.json`.

## Current limitations

- Development targets a user-reported **4.51** console. Support for every
  jailbreakable firmware has not been verified; features are negotiated at runtime.
- Host tests and cross-compilation do not prove physical-console behavior.
- Interface sounds use the native PS5 SDL audio device and were verified on the
  development console. Per-game music/trailers still depend on media supplied by
  the configured server.
- PS-button **Home/background** behavior remains unresolved.
- Native PS5 base-package downloads use the AppInstUtil URL installer when it
  initializes successfully. The first adapter confirms internal installs;
  external targets, native update/DLC installation and automatic native error
  polling are not implemented. Use PS5 Downloads for its queue controls/errors.
- ShadowMount 1.7 overlays use verified staging and separate title directories;
  FPKG backport variants contain their selected libraries inside the package.
  These runtime paths require matching server profiles and physical launch tests.
- The app does not claim completion from an accepted install request: installed
  package bytes, exact title metadata and server inventory must agree.
- The native title and separate agent were tested on firmware 4.51. The agent is
  not cold-boot persistent and must be loaded again after the jailbreak.

## Source layout

```text
ps5/frontend/    Store UI, input, artwork, audio and video
ps5/common/      API client, configuration and signed-update verification
ps5/agent/       Console discovery, inventory and transfer-related client code
ps5/installer/   Installer and asset publication
ps5/native/      Native-title link/FSELF build and readback verification
ps5/assets/      PS5Library branding and launch assets
ps5/tests/       Native checks and hardware diagnostic source
scripts/        Build, packaging and release checks
docker/         Pinned PS5 build environment
```

No server implementation, account database, private credentials, diagnostic logs,
game dumps, or game media are published in this repository.

## License

Original PS5Library console code: **GPL-3.0-or-later**. Dependencies retain their
own copyrights and licenses. See [LICENSE](LICENSE) and [NOTICE.txt](NOTICE.txt).
