# Local trophy collection

## VERIFIED — 2026-09-16

- User-authorized read-only inspection of the connected console found one local user directory. Its `trophy/data/sce_trop/trpsummary.dat` is a 75-byte JSON file with `format: 1` and `earnedTrophies: {platinum: 0, gold: 0, silver: 0, bronze: 4}`. The source modification time is Unix `1741335221`. This is an old local aggregate, not proof of current PSN totals or per-game completion.
- Seven NPWR directories exist under that user's legacy `trophy/data` directory. The inspected entry contains `trophy.img` and `sealedkey`; existence does not establish unlock counts. Keys were not read. No databases, records or system modules were modified for this inspection.
- The shared `/user/trophy2/nobackup/conf` contains one NPWR trophy definition. The newer per-user `trophy2/nobackup/data` path is absent on this session. The existing Ghost of Tsushima dump has `sce_sys/trophy2/npbind.dat` and `trophy00.ucp`.
- [PS5TrophyExtract0r](https://github.com/LiEnby/PS5TrophyExtract0r), commit `9310f22f81feaa27a29a08ac81130498da19226d`, `PS5TrophyExtract/TrophyReader.cs`, `readToc` / `readFile`: reads UCP archive entries and extracts named resources. These are trophy definitions/artwork; this code does not read a user's earned progress. Its unbounded C-string reader should not be copied into an untrusted-file parser.
- [PS5-PHU-Trophy-System](https://github.com/ArkSama/PS5-PHU-Trophy-System), commit `ae29e8a7b4b458233c4859c1a33903b814c5010f`, `src/phu_trophy.cpp`, `phu_trophy_already_installed_for_user`: explicitly distinguishes shared UCP definitions, per-user TRPTITLE.DAT state and aggregate JSON. The source documents newer-firmware observations; those are not automatically valid for 4.51. Its patches/unlock functionality have not been executed by PS5Library.

## Implemented collection

The agent reads only the bounded aggregate JSON. It binds a local user once, from an explicit `trophyUserId` configuration or the foreground user reported by UserService. That binding is saved alongside the server-bound device identity; a later local-user switch does not silently import another profile. Rebinding needs an explicit configuration/state operation; a profile-selection UI is outstanding.

The authenticated heartbeat sends normalized counts, source hash and modification time. PostgreSQL retains the last valid observation. `GET /api/v1/profile` uses the signed-in account's consoles only. The server Profile page shows each console separately and retains the source timestamp. Counts are not added across consoles, which could duplicate the same achievements. Missing/unreadable/unsupported summaries remain unavailable; they are not converted to zeros.

## UNKNOWN / EXPERIMENTAL

- Per-game earned records and timestamps on this console; no trophy.img parser or mount operation has been enabled.
- Whether the aggregate mixes PS4 and PS5 achievements and how promptly this old local file is refreshed by the runtime.
- Exact title/release ↔ NPWR mapping for every dump; a title name is insufficient.
- Native trophy service IPC structs/calling conventions across firmware. SDK export names alone are insufficient to call undocumented APIs.
- PSN synchronization protocol. Reading local trophies requires no PSN password, NPSSO cookie or online session.

Next milestone: implement a bounded UCP/npbind metadata parser with fixtures, then independently verify a read-only per-user progress source against the console's native trophy screen. Never infer an unlock from an icon, trophy definition, folder or save file.
