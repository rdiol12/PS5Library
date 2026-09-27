<p align="center"><img src="ps5/assets/icon0.png" width="140" alt="PS5Library icon"></p>

# PS5Library

PS5Library is a controller-first native PS5 storefront for locally available titles and other content you are authorized to use.

**Engineering preview.** This repository contains the PS5 storefront, console agent, native-title wrapper, tests, and reproducible ELF build. It does not contain games, dumps, package links, credentials, or diagnostic logs.

[Download releases](https://github.com/rdiol12/PS5Library/releases)
· [Build status](https://github.com/rdiol12/PS5Library/actions/workflows/client-checks.yml)

## Release files

Version 0.2.54 provides:

- `PS5Library-0.2.54-update.pkg` — native storefront update, content version `01.043.000`.
- `ps5library-agent-0.2.54.elf` — matching console agent.

The 0.2.54 PKG is an **update package**, not a fresh-install base. It requires PS5Library content version `01.042.000` already installed. Do not install it over another content version.

## Offline installation

1. Start your jailbreak and the compatible FPKG runtime for your firmware.
2. Install `PS5Library-0.2.54-update.pkg` with your runtime's package installer.
3. Load `ps5library-agent-0.2.54.elf` with Payload Manager or another compatible ELF loader.
4. Open PS5Library from the Home screen.
5. Open Settings and turn **Offline mode** on.
6. Leave PS5Library open until the native notification says **PS5Library Agent connected**.

Wait for that notification before using local inventory or console actions. Until the connection completes, the footer says `OFFLINE MODE · WAITING FOR LOCAL AGENT` and local actions remain unavailable.

Load the agent again after every reboot. The installed storefront stays on the Home screen, but the agent does not survive a cold boot.

## Offline capabilities

After the connection notification, offline mode can:

- Scan locally installed PS4 and PS5 titles.
- Show My Library, profile, console status, runtime, ShadowMountPlus status, and storage.
- Use locally available cover, hero, and menu-music assets.
- Show locally readable trophy and save summaries.
- Launch an installed title.
- Delete or move a title when the console reports that operation as supported.

Discover, New Releases, and Categories are disabled in offline mode. Offline mode does not fetch or install packages, and unsupported console actions stay disabled.

USB formatting is experimental and is not a supported offline capability in this release.

## Build

Requires Git and Docker with Linux containers.

```sh
git clone https://github.com/rdiol12/PS5Library.git
cd PS5Library
docker build -t ps5library-build -f docker/ps5-build.Dockerfile .
docker run --rm --network none -v "${PWD}:/workspace" ps5library-build bash scripts/build.sh
```

The build runs host checks, cross-compiles the storefront and agent, validates ELF dependencies, and writes verified outputs to `dist/`. The native PKG packaging step uses separately installed PS5 publishing tools and is not part of the GitHub Actions build.

## Source layout

```text
ps5/frontend/    Store UI, controller input, artwork, audio, and video
ps5/agent/       Local inventory, capabilities, storage, and console actions
ps5/common/      Shared client, configuration, and update verification
ps5/installer/   ELF installer and bundled assets
ps5/native/      Native-title wrapper and FSELF verification
ps5/assets/      PS5Library branding and fonts
ps5/tests/       Host and native boundary checks
scripts/         Build and public-release checks
docker/          Pinned PS5 build environment
```

## License

Original PS5Library console code: **GPL-3.0-or-later**. Dependencies retain their own licenses. See [LICENSE](LICENSE) and [NOTICE.txt](NOTICE.txt).
