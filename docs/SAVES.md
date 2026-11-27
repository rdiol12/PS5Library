# Save data

## VERIFIED

- PS5 save metadata is indexed per user in `/system_data/savedata_prospero/<uid>/db/user/savedata.db`. Encrypted data and metadata live under `/user/home/<uid>/savedata_prospero` and `/user/home/<uid>/savedata_prospero_meta/user`.
- PS4 save metadata uses `/system_data/savedata/<uid>/db/user/savedata.db`, with encrypted data under `/user/home/<uid>/savedata`.
- Platform ownership is separate from ordinary game files. Current PS5 tooling reads `ACCOUNT_ID` plus the local user ID in `PARAMS` from `sce_sys/param.sfo`, and stores `account_id`/`user_id` in the per-user database. Apollo performs the equivalent PS4 `ACCOUNT_ID` and `PARAMS.user_id` update when resigning.
- The agent opens both databases read-only with SQLite `query_only`, bounds database/row sizes, validates identifiers and strings, and binds the scan to one foreground local user. A complete scan removes missing slots; a partial scan preserves the last good cache.
- `RAW_CONSOLE_V1` stores an immutable console-bound safety copy. PS4 includes `sdimg_<directory>` and the adjacent 96-byte sealed-key file. PS5 includes the encrypted image, SFO and optional icon. Decrypted keys never leave the console.
- Portable export mounts one existing slot locally, excludes `sce_sys`, links and unsafe paths, hashes every entry, and emits a bounded `PORTABLE_FILES` archive. The Library Node verifies the complete envelope, entry hashes, size, count and SHA-256 before atomic publication.
- Portable import is owner-scoped and requires an online console that advertises `saveBackup`, `saveImport` and `saveRollback`, an existing target slot, and the exact installed game version. Save lookup binds the console, foreground local user, platform, `gameTitleId`, `saveTitleId` and slot directory; a stale or colliding row cannot select another title's container. The agent independently refuses export or import tasks whose local-user ID differs from the foreground user.
- The server resolves the effective installed game version instead of trusting a client label. A READY update takes precedence over a READY base release, the highest unambiguous numeric update wins, and ambiguous nonnumeric candidates fail closed. Export, Community discovery/download and import must match that effective version exactly.
- The server creates a durable raw safety backup before releasing an import task. The agent uses the existing target slot as the account donor: PS4 requires mounted `sce_sys/param.sfo`; PS5 may use the slot SFO under `savedata_prospero_meta/user` because the mounted container does not necessarily contain `param.sfo`. The chosen target metadata is preserved byte-for-byte while only ordinary portable game files are written into the target user's encrypted container.
- The agent refuses portable export or import while the matching title is running. If a positive running-app ID cannot be resolved to a Title ID, the operation fails closed.
- Save mount privileges exist only while obtaining the key/mount or unmounting. The normal file copy runs after the original credential is restored and verified. A credential-restore failure terminates the agent rather than leaving a privileged process alive.
- Before writing, the agent copies and hashes the original encrypted image. It automatically restores this temporary copy only when applying the import fails. After a successful import and unmount, that temporary copy is removed. The durable raw safety backup remains downloadable, but there is no one-click restore after a successful import if the game later rejects the save.
- On physical firmware 4.50, the hardened agent completed raw backup, portable export, import, rollback-backup creation and a second export for the PS4 slot `CUSA12771/SavedUserOptions`. The post-import portable bytes exactly matched the source export. This verifies that one exact PS4 round trip completed; it does not prove that the game accepted the save.
- Local export, download and import do not require Community Master terms. Publishing, Community discovery and Community download require the current exact terms version/hash and an approved Node credential.
- Community catalog and download responses are accepted only when the top-level Title ID, every version group, every item, fixed download path, manifest identity, hash and size all match the exact request. A mismatch fails with `MASTER_METADATA_MISMATCH`.
- Quota reservations for concurrent portable exports/downloads are serialized in PostgreSQL, so two requests cannot both spend the same remaining quota.
- Current upstream revisions checked for this work are `c0w-ar/ps5-sd-tool` `ef5df2706b1b1fda7395c0db24a0b0ab86f97799`, `n0llptr/Playstation-5-Save-Mounter` `1a0281ea9794afadc2e2da345ca0b66e5db45bc7`, `bucanero/apollo-ps4` `252a9d5a187c463994263009851a179f4f910c49`, and `earthonion/garlic-savemgr` `ac651cbd72bf80a6ad0ce97cd182e4fb8eab6ecd`.
- Sony documents Home's **Check Sync Status of Saved Data** action as the entry to PlayStation Plus cloud-save status. No package metadata field or public homebrew API was found that assigns that action to another provider. It is separate from PS5Library's owner-scoped save backup/import API.

## Apollo Save Tool comparison

Current Apollo Save Tool PS4 (`252a9d5a`) is an on-console PS4 save manager. It decrypts a save's 96-byte sealed key through `/dev/sbl_srv`, mounts the encrypted PFS image, exports/imports decrypted files, and can create or overwrite a PS4 save container. Its full resign path patches `ACCOUNT_ID`, `PARAMS.user_id`, the PSID HMAC and related title metadata, then updates the per-user save database and icon. It also provides game patches, keystone management, trophy backup and database utilities.

Apollo's documented donor-save path is the safer fit for PS5Library: create a valid save with the receiving game/account, ignore the source `sce_sys`, and copy only ordinary decrypted game files into the target. PS5Library follows that path and preserves the target `param.sfo`, keystone and encryption container. This avoids generic SFO/PSID rewriting and direct save-database creation. A focused regression proves source `sce_sys` never enters the portable archive and target account metadata plus keystone survive import unchanged.

Apollo is GPL-3.0 and PS4-specific. PS5Library uses independently written archive/mount code and does not copy Apollo implementation code. Creating a brand-new slot without first launching the game would require separately verified container creation, database updates and rollback on the PS5; it remains disabled.

## LIKELY

- Empty optional title/subtitle fields occur in real save rows. The UI safely falls back to the bounded slot name.
- A portable archive can move ordinary save files between compatible local slots when the exact title/version agrees, but only launching the game can establish semantic compatibility.

## UNKNOWN

- A physical PS5 save image on firmware 4.50 was decrypted and mounted read-only through the same scoped key/mount path. Its external slot SFO and ordinary game file layout match the implemented export path. The corrected agent still needs a complete rollback/import/re-export run and in-game acceptance test.
- The mount/key/database behavior has not been verified across all jailbreakable firmware and runtime combinations.
- The physical game did not launch as part of the PS4 round-trip test, so application-level checksums or version-specific save migrations remain unknown.
- Generic removal of account identifiers embedded inside title-specific save files is not possible without a per-game parser. Games may also keep private checksums or encryption inside ordinary save files. Those cases require an exact, reviewed per-title adapter; PS5Library makes no universal resign or compatibility guarantee. The manifest truthfully sets `embeddedAccountIdentifiersRemoved` to `false`; owners must review what they publish.
- A durable raw backup can be downloaded after a successful import, but restoring it is not yet a one-click operation.
- Portable save editing and title-specific checksum repair are not implemented.

## EXPERIMENTAL

- The private Community Master accepts an explicitly published portable archive into quarantine. Its operator UI can publish or reject it, and only an approved immutable `CLEAN` record is discoverable. Automated scanning and production deployment are still pending.
- Community download stages and verifies the exact archive on the receiving Library Node, then uses the same explicit rollback-first import flow. The Master never receives an unsealed save key or any game package.
- etaHEN commit `dafa13b` proves a firmware-specific ShellUI hook can intercept internal game-options construction: `shellui/src/HookFunctions.cpp::createJson_hook` recognizes the PS4/PS5 save-management menu IDs and substitutes an etaHEN action. That is an injected ShellUI replacement, not a configurable cloud-save endpoint. PS5Library will use its own clearly named save action unless an exact-firmware, opt-in hook with recovery is separately verified.

## Implemented flow

1. Select one reported slot. The server resolves its exact effective installed version, and the receiving user must first create a matching donor slot by launching the same title/version.
2. Create or reuse a console-bound raw safety backup.
3. Mount on the source console and export bounded portable files.
4. Resume upload to the owning Library Node; verify and atomically publish it privately.
5. Optionally accept current Community terms and explicitly publish that revision to Master quarantine.
6. Discover/download only an exact compatible title and version; verify it again on the receiving Node.
7. Require the exact foreground-user donor slot, take a fresh raw safety backup, refuse an active target game, mount locally and import.
8. Automatically restore the temporary encrypted-image copy only if applying the import fails. Otherwise unmount, restore normal privileges and rescan. Treat the result as untested until the matching game loads it successfully.

## Sources

- `c0w-ar/ps5-sd-tool`, commit `ef5df2706b1b1fda7395c0db24a0b0ab86f97799`: `include/db.h`, `include/sd.h`, `source/db.c`, `source/commands/parse_sfo.c::{parse_sfo_info,resign_param_sfo}`.
- `n0llptr/Playstation-5-Save-Mounter`, commit `1a0281ea9794afadc2e2da345ca0b66e5db45bc7`: `mounter_payload/main.c`, `MounterClient.cs`.
- `bucanero/apollo-ps4`, commit `252a9d5a187c463994263009851a179f4f910c49`: `source/sfo.c::{sfo_patch_account,sfo_patch_user_id,patch_sfo}`, `source/exec_cmd.c::resignSave`.
- `earthonion/garlic-savemgr`, commit `ac651cbd72bf80a6ad0ce97cd182e4fb8eab6ecd`: PS5 mount, decrypt, create, import and rebind implementations; useful implementation evidence, not a universal compatibility guarantee.
