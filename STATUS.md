# PS5Library status

Updated: 2026-09-15. Implementation in progress. The user confirms the storefront/server-address keyboard is visible on the physical PS5, which has contacted the LAN server. Account pairing, home-icon visibility and macOS/Xcode validation remain outstanding.

## Current milestone

First vertical slice: source manifest → visual catalog → one-confirmation durable preparation → paired console → capability/storage check → staged transfer → console inventory reconciliation. Real package/image builders cache verified outputs on the PC. Unsupported runtime operations fail explicitly.

## Completed

- Inspected Windows, WSL2, toolchains, storage, Docker availability; started the installed Docker engine.
- Created a new Git repository at `C:\Users\rdiol\dev\PS5Library` (no existing PS5Library repository found in inspected development roots).
- Cloned and pinned seventeen upstream repositories/source snapshots, including all seven requested high-priority projects and the user's pldmgr launcher.
- Established that PS5-FPKG-Builder's current Git tree contains only README.md; programmatic integration will use verified library source instead.

## Implemented and checked

- Invite-only multiple accounts, multiple consoles per owner, persistent pairing, credential revocation and default console selection.
- Fixed PC onboarding after changing the server's public address to its LAN address: explicit browser aliases now work for account requests and WebSocket events. Unlisted origins remain blocked. Password minimum is 5 characters in both API and browser; the running server was rebuilt, restarted and checked.
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

- Complete first-account creation and claim the pairing code shown on the PS5. Verify authenticated heartbeat, stored credentials and relaunch on hardware. The user must choose the account password locally; no production account was created by the checks.
- Exercise home-entry install/launch/exit/upgrade/uninstall on hardware, then ShadowMount registration. FPKG installation needs a verified completion/inventory adapter.
- Finish native WebSocket consumption, background-agent lifecycle and broader inventory/storage management.
- Complete exact-profile backport application and base-plus-compatible-update orchestration; implement live external metadata providers.
- Compile and run the iPhone project on macOS/Xcode; test account isolation, accessibility and app lifecycle on iOS.
- Complete parser resource isolation, quota/failed-staging accounting, retention and deployment security review.

## Known boundaries

- Source code evidence is not console execution evidence. Firmware support is never inferred from a successful desktop build.
- Native iOS compilation/signing requires macOS/Xcode, unavailable on this Windows host.
- User reports firmware **4.51**. The current session has pldmgr **0.5.1**, kstuff and ShadowMountPlus; exact versions of the latter components are unknown. OnionHEN and the previously stalled processes are absent after the restart. Earlier startup failures and tool approval rejections are preserved as history in [hardware evidence](docs/PS5_SYSTEM_INTEGRATION.md#hardware-session-2026-09-15).
- The user manually loaded the diagnostic helper. Its startup log and HTTP listener now work. The verified `/hbldr` path launched a foreground `eboot.elf` process, and the user confirmed seeing PS5Library or its server-address keyboard. Saved configuration and a pending console record confirm PS5-to-server LAN connectivity. PS5 performance, HTTPS and full controller behavior remain untested.
- The generic `/system_ex/app/FAKE00000` bootstrap was created by the verified launcher path and its two files read back against expected hashes. This is shared launcher infrastructure, not part of normal PS5Library uninstall. The exact-title PS5Library installer returned success; installed frontend, original icon, parameters and launch page match the bundle. Home-menu visibility and launch through that entry remain unconfirmed; `/user/appmeta/BREW05001` returned 404. See the documented recovery limits.
- The API now listens on `0.0.0.0:3150`; LAN and PC access pass live checks. Latest production check: zero users, one unclaimed console, zero paired consoles. Browser sign-up/login works in an isolated PostgreSQL schema with a 5-character password; production pairing still awaits the user's account and code claim.
- Product target is all jailbreakable firmware, with negotiated per-feature support. Initial foreground launch and server contact have physical 4.51 evidence; this is not full firmware/runtime compatibility validation.
- No automatic warez sources or commercial game/library assets are included.

## Validation

- TypeScript production build, eight unit checks and an expanded PostgreSQL/Redis integration lifecycle passed, including cross-account authorization, pairing replay, restart persistence, cache reuse/deletion, weekly hero history and missing inventory. The origin regression failed before the fix; configured LAN/loopback origins, 5-character registration/login, shorter/wrong password rejection, session cookies and authenticated WebSocket connection now pass. Unlisted origins and spoofed Host headers are rejected.
- Worker checks passed with real generated `.pkg` and `.ffpkg` outputs and unchanged original sources.
- Native Linux desktop and PS5 frontend/agent/installer cross compilation passed using SDK v0.43 and ports v0.40.2. Three host checks pass (boundaries, focus, installer rollback).
- A real native host agent paired with the API, downloaded the compiled ELF, verified/published it and reported its removal as MISSING. A deliberately corrupted artifact reports ERROR/CORRUPT_INPUT. This exercises the real transfer code without claiming PS5 registration.
- Extended host checks exercise URL normalization, unbound credentials, locked settings, paired inventory isolation and interrupted hashing. The actual storefront setup/switching check saves a connection through controller/text events (including Enter completion), defaults to keeping the current server and confirms no previous credential reaches a newly selected test server. The final end-to-end run passed in 48 seconds. First-run setup is visually checked at 1080p and 720p; physical PS5 server-address entry is now supported by saved configuration and server contact; cancellation and edge cases remain unverified.
- Rendered and inspected Discover, Game Details, Downloads, My Library, My PS5, Categories, Search and the five-step download confirmation. Controller focus and translucent-surface defects found during these checks were fixed. 720p inspection is included; host software-render timings are not PS5 GPU performance evidence.
- Live checks pass for `http://127.0.0.1:3150`, `http://localhost:3150` and the configured LAN address. The running server serves the 5-character browser form and rejects foreign browser origins. No production test accounts or credentials were created; browser visual/interaction QA remains outstanding.
- Dependency audit: zero known vulnerabilities at the last check.
- Broad installed-title scanning, automatic backport application, FPKG installation and ShellUI integration are not enabled. Hardware validation is outstanding.
