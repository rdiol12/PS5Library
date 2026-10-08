# PS5Library Server

PS5Library Server is a self-hosted library for homebrew, your own game dumps,
private repositories, public releases, and other content you are legally
authorized to use. It indexes a visual catalog, prepares reusable FPKGs,
keeps exact backport overlays separate, and coordinates delivery to paired
PS5 consoles.

## Legal use

PS5Library does not provide, locate, scrape, or redistribute copyrighted game
content. It does not include games, dumps, package links, or access to piracy
sites. You must supply and administer your own authorized content. Do not use
this software to infringe copyright or share material you do not have
permission to distribute.

PS5Library is an independent homebrew project. It is not affiliated with,
endorsed by, or connected to Sony Interactive Entertainment or PlayStation.
It does not use PSN credentials or impersonate Sony services.

This project is designed to be self-hosted. The project maintainers do not
provide a hosted game server address, game catalog, packages, dumps, or game
download links. Each operator must configure and maintain their own server and
authorized content.

## What it can do

- Create separate local accounts for family and friends.
- Keep each account's consoles, jobs, credentials, sources, and library state
  separate.
- Pair more than one PS5 to an account with short-lived codes and persistent
  device credentials.
- Scan configured folders for supported dumps and existing packages.
- Read verified title metadata and group base games, updates, and DLC.
- Cache artwork and serve optimized variants to clients.
- Queue persistent preparation and transfer jobs with real byte progress.
- Build and verify reusable FPKGs from supported prepared folders.
- Publish supplied `backport/`, `fakelib/`, or `fakelib2/` files as an exact
  release overlay instead of silently adding them to the clean package.
- Track console heartbeat, capabilities, inventory, storage, and installation
  state reported by the PS5 agent.
- Provide an administrator dashboard for services, jobs, accounts, devices,
  logs, and cache management.

Compatibility still depends on the console firmware, jailbreak runtime,
installed agent, package runtime, source quality, and an exact matching
backport when one is required. The server never labels an unverified package
or backport as tested.

## Requirements

- A 64-bit Linux host, or Windows/macOS running Linux containers
- Docker Engine or Docker Desktop with Docker Compose v2
- Node.js `22.23.2` or `24.18.1` or newer in the same supported major ranges
- Git
- Storage for the source, build workspace, generated package, overlay, and a
  free-space safety margin
- A supported PS5 environment for installing and using the separate
  PS5Library app and agent

PostgreSQL, Redis, the API/web UI, and the network-isolated package worker run
as separate containers. PostgreSQL stores durable application state. Redis
persists job coordination so closing a browser or companion does not stop a
job.

## Install

```sh
git clone https://github.com/rdiol12/PS5Library.git
cd PS5Library/server
npm run setup
```

Edit the generated `.env` before starting the server. At minimum, choose the
persistent data, watched dump, and optional source-manifest folders:

```dotenv
DATA_DIR=/srv/ps5library/data
DUMP_ROOT=/srv/ps5library/authorized-dumps
SOURCE_ROOT=/srv/ps5library/sources
PUBLIC_URL=http://127.0.0.1:3150
SERVER_BIND=127.0.0.1
```

Then configure the host paths and start the stack:

```sh
npm run docker:configure
npm run docker:up
```

On Windows, normal paths such as `D:\PS5Library\data` are accepted in
`.env`; `docker:configure` writes Docker-safe absolute bind paths. Do not
edit the generated `DOCKER_*` values by hand.

Check the services:

```sh
docker compose --env-file .env -f docker/compose.yml ps
npm run docker:logs
```

Open `PUBLIC_URL` in a browser. Select **Create an account**, expand **First
server account**, and enter the `BOOTSTRAP_TOKEN` from `.env`. The first
valid account becomes the administrator. Later users register with a
single-use invitation created by that administrator and receive the member
role.

Never commit or share `.env`. It contains database, bootstrap, and internal
service credentials.

## Connect a PS5

The PS5 app and matching agent are released separately at
<https://github.com/rdiol12/PS5Library/releases>.

1. Install the PS5Library package and load its matching agent using tools
   compatible with the console's firmware and runtime.
2. In PS5Library, enter this server's stable LAN or private-VPN address.
3. The app displays a five-character pairing code.
4. In the server web UI, open **My PS5s**, enter the code, and choose
   **Register a new PS5**.
5. Wait for the console to report online before selecting a destination or
   starting a transfer.

Use a stable address. For a trusted LAN, set `SERVER_BIND=0.0.0.0` and set
`PUBLIC_URL` to that LAN origin. Permit TCP 3150 only from the trusted
network. For access outside the LAN, use the included Caddy HTTPS profile or a
private VPN; do not expose PostgreSQL, Redis, worker IPC, loader, FTP, or debug
ports.

## Storage configuration

| Setting | Purpose |
| --- | --- |
| `DATA_DIR` | Persistent jobs, artwork, generated packages, overlays, updates, and logs |
| `DUMP_ROOT` | Folder watched for authorized dumps and packages |
| `SOURCE_ROOT` | Read-only local manifest repositories |
| `DUMP_AUTO_PREPARE` | `FPKG`, `SHADOWMOUNT`, or `BOTH` |
| `QUOTA_BYTES` | Logical server-storage limit; `0` uses real free-space checks |
| `DISK_MARGIN_BYTES` | Space reserved after every job |

Generated packages live under `DATA_DIR/artifacts`; exact overlays live
under `DATA_DIR/backports`; temporary work lives under `DATA_DIR/jobs`.
Configure these locations before the first large build. Moving them later
requires stopping jobs, moving the complete data tree, updating `.env`,
rerunning `docker:configure`, and recreating the containers.

The API needs read/write access to `DATA_DIR` and `DUMP_ROOT`. The worker
sees the dump folder read-only. Source dumps are never deleted automatically.
After the final package and required overlay are verified, an administrator
may use the explicit retirement action to quarantine and remove one source
dump.

## Enable or disable features

Boolean options accept only `true` or `false`. Restart the server after
changing them.

| Setting | Default | Effect |
| --- | --- | --- |
| `ENABLE_COMPANION_APP` | `true` | Allows the iOS companion to use this server |
| `ENABLE_PS5_CONNECTIONS` | `true` | Allows PS5 app/agent pairing and device requests |
| `ALLOW_ACCOUNT_REGISTRATION` | `true` | Allows the first bootstrap account and invited member registration |
| `ENABLE_NEW_DOWNLOADS` | `true` | Allows new download, preparation, and transfer work |
| `ENABLE_HOME_UPDATE_BRIDGE` | `false` | Enables the experimental native Home update bridge |

`DUMP_AUTO_PREPARE` selects the default automatic build route and must be
`FPKG`, `SHADOWMOUNT`, or `BOTH`. To disable automatic preparation for a
source, choose **Off** for that source in the web UI; manual administrator
preparation remains available. Leave `COMPOSE_PROFILES` empty for the core
stack, use `https` for Caddy, `operator` for dashboard service controls, or
`https,operator` for both.

## Watched folder layout

The scanner searches up to four directory levels and waits until an item has
been unchanged for 60 seconds. A prepared game folder normally contains:

```text
Game folder/
  eboot.bin
  sce_sys/
    param.json
    icon0.png        # optional artwork
    pic1.png         # optional hero artwork
  backport/          # optional exact overlay; every file path is preserved
  fakelib/           # optional; do not combine with fakelib2
  fakelib2/          # optional; do not combine with fakelib
  DLC/               # optional, inspected as separate content
```

Every regular file in `backport/` is treated as required for that supplied
overlay. The worker hashes it and preserves its relative destination. Do not
mix files from another title, version, or firmware target. Existing `.pkg`
files are indexed as packages; they are not rebuilt as dump folders.

### Where to place backport files

For automatic preparation, put the supplied files inside the exact prepared
release folder:

```text
My Game [PPSA12345]/
  eboot.bin
  sce_sys/param.json
  backport/
    eboot.bin
    sce_module/
      example.sprx
```

Keep the same relative paths supplied by the backport author. Do not rename,
flatten, or copy only selected files. The server treats every regular file in
`backport/` as required, hashes the complete tree, and binds it to the
inspected Title ID, Content ID, game version, and source hash.

These files remain separate from the clean FPKG because a console whose
firmware already supports the game does not need the overlay. A lower-firmware
console receives the exact overlay only when its recorded firmware, runtime, and
installation method match the compatibility profile. This also lets one
verified package serve different registered consoles without rebuilding it.

A lone existing `.pkg` is indexed as one package file. The scanner does not
guess that an arbitrary neighboring folder belongs to it. For automatic
package-plus-backport preparation, keep the original prepared release folder
and use the `backport/` layout above.

With `DUMP_AUTO_PREPARE=FPKG`, each stable supported base dump enters the
persistent preparation queue. The worker:

1. Inspects and validates the input without modifying it.
2. Copies required files to isolated staging.
3. Builds one clean FPKG with compression where supported.
4. Inspects and verifies the output.
5. Publishes the package atomically under `DATA_DIR/artifacts`.
6. Publishes supplied compatibility files separately under
   `DATA_DIR/backports` with exact title, content, version, and hash matching.

Encrypted, incomplete, corrupt, mismatched, and unsupported inputs fail with a
recorded error. A console below the release's required firmware is blocked if
no exact compatibility profile is available.

## Accounts and permissions

- **Administrator:** manages sources, preparation, cache, invitations,
  accounts, consoles, service status, and server-wide job visibility.
- **Member:** sees shared catalog entries, manages only their own consoles and
  jobs, and cannot start FPKG preparation.
- **Console credential:** belongs to one registered console and does not grant
  browser or administrator access.

An administrator can share selected catalog entries with individual members
without sharing credentials or console state. Removing a console record also
removes its recovery identity; it must then be paired again.

## Operations

```sh
# Follow bounded container logs
npm run docker:logs

# Restart only the API/web service
npm run docker:restart

# Stop containers while preserving volumes
docker compose --env-file .env -f docker/compose.yml down

# Rebuild after updating the checked-out source
npm run docker:up
```

Do not add `--volumes` to `down` during an upgrade. It would remove
persistent PostgreSQL and Redis volumes.

The optional operator container lets an administrator restart a fixed list of
Compose services from the dashboard. It has Docker-socket access and therefore
host-level power. It is disabled by default. Enable it only on a trusted host:

```dotenv
COMPOSE_PROFILES=operator
OPERATOR_URL=http://operator:3160
```

Then run `npm run docker:up` again. The operator has no published port and
uses the random internal token generated by `npm run setup`.

## HTTPS and hardening

For any connection outside a trusted private network:

1. Set `PUBLIC_URL` to one exact HTTPS origin.
2. Set `PS5LIBRARY_HTTPS_HOST` to that hostname.
3. Set `COMPOSE_PROFILES=https` (or `https,operator` when explicitly needed).
4. Forward only TCP 80 and 443 to the host.
5. Keep `TRUST_PROXY_HOPS=0` unless Caddy is the only possible API ingress.

Use exact origins in `BROWSER_ORIGINS` and `PRIVATE_HTTP_ORIGINS`; wildcards
are rejected. Put private-repository bearer tokens only in ignored environment
variables named `REPOSITORY_TOKEN_*`. Run containers as the generated
non-root UID/GID and keep Docker, the host OS, and the checked-out release up
to date.

## Backup and upgrade

Stop preparation and transfer jobs, then back up these together:

- `.env`
- `DATA_DIR`
- a PostgreSQL `pg_dump` or the PostgreSQL named volume
- the Redis named volume when queued-job recovery matters

To upgrade, preserve those locations, pull the new release, review its notes,
and run `npm run docker:up`. `app/schema.sql` contains the ordered,
idempotently recorded database sections; do not edit sections already applied
to a production database.

## Repository boundary

This public repository contains the local Library Server, web UI, package
worker, database schema, container configuration, and the pinned upstream
source needed to reproduce its worker. The same repository also contains the
separate PS5 application, console agent, and iPhone companion under their own
top-level folders.
It contains no game content, generated packages, dumps, database state,
credentials, personal addresses, logs, private central services, proprietary
publishing tools, or internal development utilities.

## License

PS5Library Server is released under **GPL-3.0-or-later**. Bundled upstream
projects retain their own licenses and notices in their respective directories.
