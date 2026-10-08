<p align="center"><img src="frontend/ps5/assets/icon0.png" width="140" alt="PS5Library icon"></p>

# PS5Library

PS5Library is a self-hosted library platform for a jailbroken PS5. It combines
a private Library Server, a controller-first PS5 storefront and console agent,
and an iPhone companion.

PS5Library is for homebrew, your own dumps, private repositories, public
releases, and other content you are legally authorized to use. It does not
support piracy and does not provide, locate, scrape, or redistribute commercial
game packages, dumps, package links, or copyrighted downloads.

The maintainers do not provide a server address, hosted game catalog, or game
packages. Every operator supplies and manages their own server and authorized
content.

[Download releases](https://github.com/rdiol12/PS5Library/releases) |
[Build status](https://github.com/rdiol12/PS5Library/actions/workflows/client-checks.yml)

## Components

| Folder | Purpose |
| --- | --- |
| [`server/`](server/README.md) | API, web UI, package worker, shared schemas, Docker stack, PostgreSQL, and Redis |
| [`frontend/`](frontend/) | Native PS5 storefront and agent plus the iPhone companion |

The local Library Server holds each operator's catalog and generated artifacts.
The PS5 and iPhone connect only to the server address configured by that
operator. Private central services are not included in this repository.

## Library Server quick start

Requirements: Git, Node.js 22.23.2 (or a supported newer release), Docker
Engine or Docker Desktop with Compose, and enough storage for source folders,
temporary build data, packages, and a safety margin.

```sh
git clone https://github.com/rdiol12/PS5Library.git
cd PS5Library/server
npm ci
npm run setup
```

Review the generated `.env`, set `DATA_DIR`, `DUMP_ROOT`, and `SOURCE_ROOT`,
then start the stack:

```sh
npm run docker:up
```

Open the configured `PUBLIC_URL` and use the one-time bootstrap token from
`.env` to create the first administrator. Administrators can invite members,
prepare packages, manage sources, and administer the server. Members can browse
shared entries and manage only their own consoles and jobs.

The server supports startup controls for companion connections, PS5
connections, account registration, community connectivity, new downloads, the
experimental Home update bridge, and automatic preparation. Each setting and
its safe default is documented in the [server guide](server/README.md).

### Watch folders and backports

Place authorized prepared releases below `DUMP_ROOT`. A typical release with a
supplied compatibility overlay looks like this:

```text
DUMP_ROOT/
  My Game [PPSA12345]/
    eboot.bin
    sce_sys/param.json
    backport/
      eboot.bin
      sce_module/example.sprx
```

`backport/`, `fakelib/`, and `fakelib2/` are recognized inside the exact
prepared release folder. Their relative paths are preserved and hashed against
that title, content ID, version, and source. They remain separate from the clean
FPKG so a compatible console does not receive an unnecessary overlay. The
server does not guess that an unrelated neighboring folder belongs to a lone
`.pkg` file.

See [server setup and configuration](server/README.md) for folder permissions,
automatic preparation, storage sizing, HTTPS, backup, and operations.

## PS5 installation

GitHub releases provide the complete PS5Library base package and its matching
agent ELF. A compatible jailbreak and FPKG runtime are required.

1. Install the complete `PS5Library-<version>.pkg`.
2. Load the matching `ps5library-agent-<version>.elf` after each reboot.
3. Open PS5Library from Home.
4. Enter your own Library Server address and complete the pairing flow, or use
   offline mode for supported local functions.
5. Wait for the **PS5Library Agent connected** notification before using local
   inventory or console actions.

USB formatting is **experimental** and has been tested only on firmware
**4.51**. Other firmware versions are unverified. Back up the entire drive
before testing it.

See the [PS5 build and capability guide](frontend/ps5/README.md).

## iPhone companion

The iPhone app connects to an operator-owned Library Server. It supports
multiple accounts, catalog browsing, console pairing and management, install
selection, storage selection, notifications, and live preparation/transfer
progress.

Building the iPhone app requires macOS and Xcode. GitHub Actions produces an
unsigned IPA on selected iOS changes; installation still requires signing with
an appropriate Apple identity. See the [iPhone guide](frontend/ios/README.md).

## Building the PS5 client

The public PS5 build uses Docker with Linux containers:

```sh
docker build -t ps5library-build -f frontend/docker/ps5-build.Dockerfile frontend
docker run --rm --network none -v "${PWD}:/workspace" -w /workspace/frontend ps5library-build bash scripts/build.sh
```

This builds and checks the storefront, agent, and installer ELFs. Creating a
native app package requires separately obtained packaging prerequisites; this
repository does not contain proprietary publishing tools, keys, or SDK files.
The server worker builds supported game FPKGs with its bundled, source-available
LibProsperoPKG implementation and does not use that proprietary publisher.

## License

Original PS5Library code is licensed under **GPL-3.0-or-later**. Bundled
dependencies retain their own licenses and notices. See [`LICENSE`](LICENSE),
[`server/LICENSE`](server/LICENSE), [`NOTICE.txt`](NOTICE.txt), and the notices
within `server/upstream/` and `frontend/licenses/`.

## Special thanks

PS5Library learned from or builds on technical work published by:

- [ps5-payload-dev/sdk](https://github.com/ps5-payload-dev/sdk)
- [ProsperoTV](https://github.com/blackbearreloaded/ProsperoTV) and
  [ps5-native-app-boilerplate](https://github.com/blackbearreloaded/ps5-native-app-boilerplate)
- [LibProsperoPKG](https://github.com/SvenGDK/LibProsperoPKG),
  [drakmor/LibProsperoPKG](https://github.com/drakmor/LibProsperoPKG), and
  [UFS2Tool](https://github.com/SvenGDK/UFS2Tool)
- [PS5-FPKG-Builder](https://github.com/Phoenixx1202/PS5-FPKG-Builder)
- [ShadowMountPlus](https://github.com/drakmor/ShadowMountPlus) and
  [BackPork](https://github.com/BestPig/BackPork)
- [kstuff-lite](https://github.com/EchoStretch/kstuff-lite)
- [ps5-ezremote-client](https://github.com/cy33hc/ps5-ezremote-client) and
  [ps5-ezremote-dpi](https://github.com/cy33hc/ps5-ezremote-dpi)
- [OnionHEN](https://github.com/aydencharles/onionHEN)
- [ooz](https://github.com/powzix/ooz)

Thank you to their maintainers and contributors for publishing source,
documentation, and research that made independent PS5 homebrew development
possible. Their original licenses and notices remain in the relevant source
directories.
