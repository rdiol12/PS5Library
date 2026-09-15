# PS5Library status

Updated: 2026-09-15. Implementation in progress. Physical PS5 onboarding has started; storefront rendering, pairing and macOS/Xcode validation remain outstanding.

## Current milestone

First vertical slice: source manifest → visual catalog → one-confirmation durable preparation → paired console → capability/storage check → staged transfer → console inventory reconciliation. Real package/image builders cache verified outputs on the PC. Unsupported runtime operations fail explicitly.

## Completed

- Inspected Windows, WSL2, toolchains, storage, Docker availability; started the installed Docker engine.
- Created a new Git repository at `C:\Users\rdiol\dev\PS5Library` (no existing PS5Library repository found in inspected development roots).
- Cloned and pinned seventeen upstream repositories/source snapshots, including all seven requested high-priority projects and the user's pldmgr launcher.
- Established that PS5-FPKG-Builder's current Git tree contains only README.md; programmatic integration will use verified library source instead.

## Implemented and checked

- Invite-only multiple accounts, multiple consoles per owner, persistent pairing, credential revocation and default console selection.
- PostgreSQL 18 migrations, Redis/BullMQ downloads, owner-scoped catalog/artwork/sources/jobs/inventory, streaming SHA-256 verification, Range resume and persistent job events.
- Generic local, manifest, private HTTP and GitHub release connectors; grouped game/releases and cached optimized artwork.
- Firmware/runtime capability and exact compatibility-profile matching; storage planning and staged transfer API.
- Console-authoritative inventory reconciliation; missing files stop being available.
- Real .NET package and UFS2 image builders, output inspection, hashes/provenance, safe ZIP extraction and plaintext fake-SELF conversion.
- Native SDL storefront and agent source: saved credentials, storage, staged transfers, managed receipts and opt-in ShadowMount manual registration.
- Controller-first SDL storefront rebuilt around the supplied desktop `storefront.png`: top navigation, cinematic hero, cover rails, details, download flow, jobs, library, console status and search. Real API mode and clearly separated local design preview.
- Added first-run controller server setup and Settings → Server connection. The frontend embeds initial font/CA assets. HTTPS origin validation, explicit LAN HTTP opt-in, confirmed re-pairing, cancellation and process locking protect server changes. Managed receipts and artwork caches are scoped to the paired connection.
- Weekly server-selected hero with PostgreSQL history; the same normalized image hash cannot be selected again for two calendar months. Empty eligible pools request fresh artwork instead of breaking the repeat rule.
- Persistent installation coordinator now connects source preparation/download, cache reuse and transfer. A PostgreSQL/Redis integration check confirms it continues after a server restart and prevents duplicate transfer creation.
- Generated original PS5Library app icon and 512×512 installation artwork. The home-entry installer cross-builds with the actual frontend embedded; ownership and file rollback checks pass on the host.
- Added all ten requested research/architecture documents with pinned source evidence and separate hardware-validation limits.
- Added the native SwiftUI iPhone source and Xcode project: saved accounts, Keychain credentials, catalog, pairing, preparation, jobs and storage/cache controls. iOS compilation remains unverified.

## Next engineering work

- Continue from the clean PS5 restart: kstuff, ShadowMountPlus and pldmgr are running; OnionHEN and the old stalled payloads are absent. Remote diagnostic transmission remains blocked by automatic approval review after explicit user approval. A verified Desktop copy is ready for the user to load through pldmgr; check its startup log and HTTP listener before foreground launch, input, TLS and pairing.
- Exercise home-entry install/launch/exit/upgrade/uninstall on hardware, then ShadowMount registration. FPKG installation needs a verified completion/inventory adapter.
- Finish native WebSocket consumption, background-agent lifecycle and broader inventory/storage management.
- Complete exact-profile backport application and base-plus-compatible-update orchestration; implement live external metadata providers.
- Compile and run the iPhone project on macOS/Xcode; test account isolation, accessibility and app lifecycle on iOS.
- Complete parser resource isolation, quota/failed-staging accounting, retention and deployment security review.

## Known boundaries

- Source code evidence is not console execution evidence. Firmware support is never inferred from a successful desktop build.
- Native iOS compilation/signing requires macOS/Xcode, unavailable on this Windows host.
- User reports firmware **4.51**. LAN inspection found pldmgr **0.5.1**, OnionHEN, kstuff and ShadowMountPlus running. Exact runtime component versions are not established. Tests use generated project-owned content.
- The pldmgr launch reached PS5Library asset extraction but did not produce a visible storefront. Foreground Homebrew Launcher bootstrap and the PS5Library home entry are absent. The frontend and original icon have now been uploaded to `/data/homebrew/PS5Library` and verified by reading their SHA-256 hashes back from the console.
- Hardware blocker: official websrv v0.34 did not open port 8080. A minimal probe reaches `dlopen("libSceSystemService.sprx", RTLD_NOW)` and does not return; preloading Ipmi did not resolve it. OnionHEN's utility log repeatedly reports signal 11 in this session. The relationship and underlying cause are UNKNOWN. The user confirms the home screen still responds. Diagnostic probes remained listed after kill requests; stop retries and begin the next test in a clean session. See [hardware evidence](docs/PS5_SYSTEM_INTEGRATION.md#hardware-session-2026-09-15).
- Restart follow-up: the user restarted and ran the jailbreak. Read-only checks found the previous stuck processes gone and no OnionHEN processes; existing FTP was started for inspection, and staged files survived. Port 8080 is still closed. Automatic approval review rejected sending the already-built diagnostic ELF before execution, returning only "blocked by policy", then rejected the same transmission after the user explicitly approved it. No new launcher failure or successful launch can be inferred. `Desktop/PS5Library-Launcher-Diagnostic.elf` is hash-verified and ready for manual loading; no further approval is needed for the already-authorized diagnostic task.
- The PC API is healthy but currently listens only on `127.0.0.1:3150`; the production database has no accounts or paired consoles yet. Local-network access and first-account setup remain part of this hardware onboarding.
- Product target is all jailbreakable firmware, with negotiated per-feature support. No firmware/runtime combination is yet hardware-validated; do not equate broad design intent with verified support.
- No automatic warez sources or commercial game/library assets are included.

## Validation

- TypeScript production build, seven unit checks and an expanded PostgreSQL/Redis integration lifecycle passed, including cross-account authorization, pairing replay, restart persistence, cache reuse/deletion, weekly hero history and missing inventory.
- Worker checks passed with real generated `.pkg` and `.ffpkg` outputs and unchanged original sources.
- Native Linux desktop and PS5 frontend/agent/installer cross compilation passed using SDK v0.43 and ports v0.40.2. Three host checks pass (boundaries, focus, installer rollback).
- A real native host agent paired with the API, downloaded the compiled ELF, verified/published it and reported its removal as MISSING. A deliberately corrupted artifact reports ERROR/CORRUPT_INPUT. This exercises the real transfer code without claiming PS5 registration.
- Extended host checks exercise URL normalization, unbound credentials, locked settings, paired inventory isolation and interrupted hashing. The actual storefront setup/switching check saves a connection through controller/text events (including Enter completion), defaults to keeping the current server and confirms no previous credential reaches a newly selected test server. The final end-to-end run passed in 48 seconds. First-run setup is visually checked at 1080p and 720p; physical PS5 keyboard behavior is still unverified.
- Rendered and inspected Discover, Game Details, Downloads, My Library, My PS5, Categories, Search and the five-step download confirmation. Controller focus and translucent-surface defects found during these checks were fixed. 720p inspection is included; host software-render timings are not PS5 GPU performance evidence.
- Local server health check passes at `http://127.0.0.1:3150`. Browser automation is unavailable in this session, so browser visual/interaction QA remains outstanding.
- Dependency audit: zero known vulnerabilities at the last check.
- Broad installed-title scanning, automatic backport application, FPKG installation and ShellUI integration are not enabled. Hardware validation is outstanding.
