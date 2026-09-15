# PS5Library status

Updated: 2026-09-15. Implementation in progress. No physical PS5 or macOS/Xcode validation yet.

## Current milestone

First vertical slice: source manifest → visual catalog → one-confirmation durable preparation → paired console → capability/storage check → staged transfer → console inventory reconciliation. Real package/image builders cache verified outputs on the PC. Unsupported runtime operations fail explicitly.

## Completed

- Inspected Windows, WSL2, toolchains, storage, Docker availability; started the installed Docker engine.
- Created a new Git repository at `C:\Users\rdiol\dev\PS5Library` (no existing PS5Library repository found in inspected development roots).
- Cloned and pinned sixteen upstream repositories/source snapshots, including all seven requested high-priority projects.
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

- Validate the native storefront, input, TLS and pairing on the user's 4.51 console; identify its runtime and launcher before enabling registration.
- Exercise home-entry install/launch/exit/upgrade/uninstall on hardware, then ShadowMount registration. FPKG installation needs a verified completion/inventory adapter.
- Finish native WebSocket consumption, background-agent lifecycle and broader inventory/storage management.
- Complete exact-profile backport application and base-plus-compatible-update orchestration; implement live external metadata providers.
- Compile and run the iPhone project on macOS/Xcode; test account isolation, accessibility and app lifecycle on iOS.
- Complete parser resource isolation, quota/failed-staging accounting, retention and deployment security review.

## Known boundaries

- Source code evidence is not console execution evidence. Firmware support is never inferred from a successful desktop build.
- Native iOS compilation/signing requires macOS/Xcode, unavailable on this Windows host.
- User's console firmware is **4.51**; the user is unsure which runtime/launcher is installed. Runtime and console address remain unconfirmed. Tests use generated project-owned content.
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
