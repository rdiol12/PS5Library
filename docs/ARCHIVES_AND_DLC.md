# Archives, DLC and compatibility libraries

## VERIFIED — implemented and tested

Place a complete game or complete archive set under the configured `DUMP_ROOT`. Keep all archive volumes together with their original names. RAR `.rar/.r00/.r01/...`, `.part1.rar/...`, ZIP and 7z are supported for local sources. Archive contents may have one wrapper folder around `sce_sys/param.json` and `eboot.bin`.

The watcher waits for stable files, inspects metadata, checks required space, hashes all volumes, and queues preparation. Extraction writes into `DATA_DIR/jobs/<job-id>/output/`. It never extracts over the source. An interrupted extraction restarts; it does not claim byte-level resume. Admin Downloads shows measured extraction bytes. Stages without byte measurements remain indeterminate.

The worker rejects incomplete parts, encrypted archives, unsafe paths/links, duplicate names, inconsistent sizes, failed CRCs, multiple prepared game roots and exceeded quotas. It verifies the source again after building. Successful archive listing alone does not publish a package.

### Separate folders

```text
games/<game>/
  eboot.bin
  sce_sys/param.json
  fakelib/                 # supplied compatibility libraries
  fakelib2/                # only when supplied
  DLC/                     # separate supplied .pkg files
```

The builders exclude root `DLC`/`DLCs` from both base images. The watcher scans those package files separately. It classifies PS5 CNT content types `0x21`/`0x22` as DLC, matches the Title ID to its game and keeps each Content ID/version distinct. DLC metadata never renames the parent game. Existing packages are copied and verified without rebuilding. The native selector separates game/updates and DLC; four rows per page keep every DLC reachable with a controller.

Root fakelib/fakelib2 are copied separately, preserving originals. Merely finding these files does not establish an exact tested firmware/runtime profile. Native-compatible consoles do not need that overlay; lower firmware still requires verified profile matching.

## Current physical input

The supplied Shadows archive is recognized as PPSA20397 / 01.019.076 / required firmware 12.60. Its 659 volumes expand to 316,078,473,008 bytes. The current worker conservatively reserves `expandedSize * 5 + 64 MiB`, plus the configured disk margin, for extraction and builder temporary/output data. Its 100 GiB server quota cannot accommodate this input. It is blocked before extraction, not stuck on an unknown format.

All six externally supplied DLC packages have verified DLC identities and group under Shadows. The base game has not been built. Five DLC packages are cached; a previously deleted cached DLC is not silently recreated.

## Limitations

- Remote multipart downloads need an explicit part manifest/connector; only complete local RAR/7z sets are enabled.
- Password entry, multiple game roots in one archive, and unpacking already-prepared PKGs from an archive are not enabled.
- DLC found only inside an archive is excluded from the base output but is not independently imported yet. Provide the DLC packages separately in a watched folder.
- Native FPKG install/completion remains a separate adapter task. The selector cannot bypass console capability, firmware or backport checks.
- The supplied large archive has been inspected, not fully extracted or checksum-tested. Synthetic multipart extraction/build and missing-volume regression checks have passed.

## Sources

SharpCompress [0.50.4](https://www.nuget.org/packages/SharpCompress/0.50.4), commit `c083c6efd843a844b0c8f7878787360e815be781`: `Archives/ArchiveFactory.cs`, `Archives/Rar/RarArchiveVolumeFactory.cs`, `Archives/Rar/RarArchiveEntry.cs` and `IArchive.ExtractAllEntries()`. Non-solid RAR uses entry streams; solid archives use the sequential reader.

LibProsperoPKG, drakmor commit `5e26c8ae65f4b3cf88dcc7c84226ea9718c38e5e`: `PKG/ProsperoPkgBuilder.cs::ContentTypeFor`, `PKG/ProsperoPkgReader.cs` and the `ContentType` field. These distinguish DLC using embedded metadata, rather than filenames.
