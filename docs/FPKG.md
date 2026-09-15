# FPKG pipeline

## VERIFIED

The pinned PS5-FPKG-Builder Git tree has no implementation to automate. PS5Library uses [LibProsperoPKG 2.6.0](https://github.com/SvenGDK/LibProsperoPKG/tree/748eabf1b7d17819528cabf367d8e27109d8fce3), `ProsperoPackageBuilder.Build(ProsperoBuildOptions, Action<string>)`, through `worker/Package/Builders.cs`.

Our path is inspected prepared folder → source tree hash → private staging copy → `OutputFormat.DebugImage` → output reader/validator and identity inspection → SHA-256 → atomic cache publication. `.pkg` output is distinct from a UFS `.ffpkg`. Original files are not passed to builder mutation routines.

Provenance records builder commit/version, source tree hash, output SHA-256/size/time, release ID, selected profile ID when actually applied, and structural inspection. Profile IDs cannot be attached as if a backport were applied; the current worker rejects that request.

Server conversion accepts local prepared folders or safe ZIPs with the game root inside. Remote ZIP downloads show actual byte progress. The library builder exposes log/stage completion rather than byte-level build work; conversion displays named stages and an indeterminate native progress indicator. A stage count must not be presented as elapsed-work percentage.

Repeated preparation can return the verified cached artifact. Users can list/delete their PC cache through `/api/v1/artifacts`. Active transfers block deletion.

## Input support

| Input | Current behavior |
| --- | --- |
| Prepared folder | Requires `sce_sys/param.json`, `eboot.bin`, safe paths and exact identity; supported build input |
| ZIP | Size/entry/path/symlink checks, extraction into a new staging directory, then identity inspection |
| `.pkg` | Recognizes supported FIH/CNT, structural validation and param identity; rejects retail/encrypted input |
| `.ffpkg` UFS | Read-only fsck and root param identity; transfer/mount path only, reverse conversion not yet exposed |
| `.ffpfs`, `.ffpfsc`, `.exfat` | Upstream ShadowMount support verified; our robust format inspection/conversion is not yet implemented |
| Multipart archives | Automatic extraction unsupported; requires a complete explicit part manifest before safe implementation |
| ELF / plaintext fake SELF | Header recognition and explicit module conversion tools; not a game package by themselves |

`UNSUPPORTED_INPUT`, `ENCRYPTED_INPUT`, `INCOMPLETE_INPUT`, `METADATA_MISMATCH` and `CORRUPT_INPUT` are real failure paths. Multipart missing-part detection is not fabricated merely from an extension.

## EXPERIMENTAL / UNKNOWN

Generated project-owned sample `.pkg` files pass local checks. No actual PS5 installation/launch has been verified. etaHEN's researched direct installer accepts URL requests but does not establish reliable completion from its initial response. Our agent therefore advertises `fpkgInstall=false` until a verified install/status adapter is available. Users can already build/cache FPKG on the PC; this does not imply automatic console installation works.
