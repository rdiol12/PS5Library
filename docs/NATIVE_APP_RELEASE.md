# Publishing updates for native PS5 titles

One command packages a new version of a native title and publishes it on your
server, so a console that has the title installs the update itself: press
Options on the title's tile and choose **Check for Update**.

It works for the PS5Library app and for any homebrew title you register.

## Your own game

```powershell
npm run native:release -- -TitleId PPSA99783 -Source C:\build\PPSA99783
```

`-Source` is the game's ready folder (the one containing `eboot.bin` and
`sce_sys/param.json`). Before running it, raise `contentVersion` in that
folder's `sce_sys/param.json`; the command refuses a version that is not higher
than the one already published.

The command copies the folder (yours is never modified), writes your server's
update address into the copy, builds the update against the last published
package, publishes it into the server's data folder and prints the served
status.

Optional switches, passed through to the packager:

- `-Executable C:\path\game.elf` when the folder's executable is not a suitable
  SELF.
- `-GenerateUnsignedNptitle` for a homebrew title with no `nptitle.dat`.

### Registering a title

Only registered titles are accepted. Add yours to `shared/native-titles.json`
with its exact content ID, then rebuild and restart the server:

```json
"PPSA99783": { "contentId": "UP9000-PPSA99783_00-OPENSTORYPS50000", "name": "OpenStory" }
```

## The PS5Library app

```powershell
npm run native:release
```

With no `-Source` the command builds the app and agent from the current source
first. The content version goes up by one each time (`01.093.000` →
`01.094.000`); pass `-ContentVersion 01.100.000` to choose one.

The app build needs three files that are not in the repository and are never
committed. Put them in the assets folder (`data/developer/native-assets/` by default)
once:

| File         | Purpose                                          |
| ------------ | ------------------------------------------------ |
| `snd0.at9`   | Home-menu selection sound                        |
| `right.sprx` | `sce_sys/about/right.sprx` for native packages   |
| `keystone`   | `sce_sys/keystone` the packaging toolkit expects |

It also needs ProsperoTV cloned at commit
`fdee81e746308f7f2b27f7914a84eab678088fb6` into `upstream/ProsperoTV` (or the
folder you set).

## One-time setup

`.env` must contain:

- `PUBLIC_URL`: the address consoles use to reach the server;
- `DATA_DIR`: the server's data folder;
- `PS5_PKG_TOOLKIT_DIR`: the packaging toolkit.

Docker and Node must be available. Build images are created on first use.

Nothing is tied to a fixed location. These optional settings (in `.env`, the
environment, or as switches) move the working folders; relative values are
taken from the repository root:

| Setting                          | Switch         | Default                          |
| -------------------------------- | -------------- | -------------------------------- |
| `PS5LIBRARY_NATIVE_RELEASES_DIR` | `-ReleasesDir` | `data/developer/native-releases` |
| `PS5LIBRARY_NATIVE_ASSETS_DIR`   | `-AssetsDir`   | `data/developer/native-assets`   |
| `PS5LIBRARY_PROSPEROTV_DIR`      | `-Upstream`    | `upstream/ProsperoTV`            |

`-DataDir` and `-UpdateOrigin` override `DATA_DIR` and `PUBLIC_URL` for one run.

## First install on a console

An update can only be applied over the exact package the console already has.
For a title that is not installed yet, or was removed, build a base package and
install it once:

```powershell
npm run native:release -- -TitleId PPSA99783 -Source C:\build\PPSA99783 -Base
python tools/ps5-dev/pkg_cli.py install <printed package path> --expect-content-id <content id>
```

For the app, `npm run native:release -- -Base -ContentVersion 01.092.000`.
The command prints the exact install line. Every later run is then an update
over that package.

## What it keeps

Each title has its own folder inside the releases folder, `<TITLE_ID>/`:

- `latest.json` records the last published content version and, as a path
  relative to that folder, the package the next update must be built against;
- `<content version>/` holds that release's staged copy and outputs.

Do not delete the package named in `latest.json`. Without it the next update
cannot be built and the title needs a new base install.

## If the server address changes

The update address is written into the package from `PUBLIC_URL`. A console
keeps asking the address in the version it has installed, so after moving the
server to another address or port, build a new base package and install it
once.

The individual steps are described in
[Native PS5 update tool](NATIVE_UPDATE_TOOL.md).
