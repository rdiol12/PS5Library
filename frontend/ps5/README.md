# PS5 application and agent

Version **0.2.70** contains the controller-first PS5 storefront, its local console agent, the home-entry installer, and the host/native checks used by the public build.

PS5Library is self-hosted. The maintainers do not provide a game server address, hosted catalog, packages, dumps, or game links. Each operator runs their own PS5Library server and supplies content they are authorized to use.

## Current scope

- Pair the storefront with an operator-owned PS5Library server.
- Browse the operator's catalog and locally installed titles.
- Track preparation and transfer jobs and select supported console storage.
- Launch, move, or remove installed titles when the console reports the required capability.
- Display local artwork, trailers, menu audio, trophies, console status, runtime, and storage information.
- Run as the foreground storefront or as the separate `ps5library-agent` payload.

Capabilities are negotiated at runtime. Unsupported operations remain unavailable rather than being presented as broadly compatible.

USB formatting is experimental. It has been tested only on firmware **4.51**; behavior on every other firmware is unverified. Back up the entire drive before using it.

## Build

Install Git and Docker with Linux containers, then run from the repository's `frontend` directory:

```sh
docker build -t ps5library-build -f docker/ps5-build.Dockerfile .
docker run --rm --network none -v "${PWD}/..:/workspace" -w /workspace/frontend ps5library-build bash scripts/build.sh
```

The build runs the host checks, cross-compiles the PS5 targets, verifies their ELF dependencies, and writes the verified application, agent, and installer outputs to `dist/`. PS5 publishing tools and developer probes are not required by this public source build.

The primary source areas are:

```text
ps5/frontend/         Storefront UI, input, artwork, audio, and video
ps5/agent/            Console inventory, storage, and runtime actions
ps5/common/           Shared client, configuration, and update verification
ps5/installer/        Home-entry installer and bundled assets
ps5/native/           Native-title wrapper and verification
ps5/shell-indicator/  Optional firmware-specific ShellUI helper
ps5/tests/            Host and native boundary checks
```

Original PS5Library console code is GPL-3.0-or-later. Bundled dependencies retain their own licenses; see the repository `LICENSE`, `NOTICE.txt`, and component notices.
