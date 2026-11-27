# Security model

## Account/content authorization audit - 2026-10-08

This pass covered multi-account package creation, sharing revocation, queued work, native artifact delivery and 10-20-client database pressure.

### VERIFIED

- BUILD/FPKG creation is restricted to the current `ADMIN` role at enqueue, retry and queue claim. A demoted owner cannot execute previously queued package work. Members may consume an already-verified artifact they can currently access.
- A `MEMBER` cannot reorder a mixed queue containing BUILD work. Queue-position ranking scopes the ranked subquery to the authenticated user.
- Byte-bearing source, artifact, backport and native-download routes plus icon grants use current `game_content_access`, which contains only ownership, global sharing and current explicit grants. A stale console inventory entry may preserve catalog visibility but cannot preserve content access after revocation.
- Unchanged capabilities, diagnostics, pairing state, storage, inventory metadata and trophy summaries no longer rewrite rows; unchanged trophy summaries also leave their sync timestamp unchanged. Both agent loops honor the authenticated server cadence, cache full scans for 60 seconds and upload full inventory only on first sync or a revision change. Console and save inventory use set-based reconciliation with bounded SQL round trips.
- Shared-proxy authenticated traffic uses hashed credential rate-limit buckets plus a 2,000-request-per-minute IP backstop. A 20-client shared-proxy check passed 10,000 authenticated requests without cross-client throttling and confirmed that rotating untrusted credentials cannot evade the backstop. Authentication, pairing and recovery retain strict IP buckets.
- Native Range progress keeps at most one database transaction active per job and merges pending byte ranges without losing gaps or double-counting overlaps. Token rotation preserves existing byte coverage, transient progress-write failures requeue the pending ranges and retry, and shutdown drains pending progress. Caddy access logging is disabled so 256-bit native capability tokens in URL paths are not persisted; server logs record route templates only.
- PostgreSQL uses finite connection, statement, lock and idle-transaction timeouts. Migrations explicitly disable those limits within their migration transaction. The installation coordinator performs slow planning and queue enqueue outside transactions, and a cancelled installation cannot be resurrected. Source retirement and artifact/backport cleanup keep verification and recursive deletion outside the short state-check, staging-rename and metadata transactions.
- Migration 049 adds partial indexes for completed launch-failure history and heartbeat pairing credential lookup.
- Twenty isolated sessions completed 60 concurrent catalog/job/console reads without failures or timeouts in 189.2 ms total, p95 184.5 ms. Twenty distinct authenticated agents also consumed 20 concurrent non-overlapping 256 KiB Range streams with exact headers, content and SHA-256 in 165.8 ms total, p95 154.3 ms.
- The production TypeScript build, 143/143 unit checks, 54/54 PostgreSQL/Redis integration checks, dependency audits and 30 repeated native-progress stress runs pass. Personal IP addresses were removed from test fixtures. The authorized Baldur's Gate 3 build completed and both its package and fakelib artifact are verified. CODE VEIN II completed with a verified 66,131,349,480-byte package.

### REMAINING

- The concurrent Range check validates authentication, streaming correctness and progress behavior; it is not a sustained 20-client multi-gigabyte disk/network soak.
- Deployment and cutover are in progress.
- Historical `console_heartbeats` bloat needs maintenance after deployment, and `job_events` still needs a bounded retention policy.
- The application PostgreSQL credential still owns broad database privileges. A separate least-privilege runtime role remains production hardening work.
- Extreme roughly 10,000-item inventory behavior, cross-device hardware coverage and the clean PS5 uninstall/reinstall/pair/transfer/update/offline/reboot publication gate remain mandatory.
- Public server release remains blocked until the server-scoped license and required notice/source package are complete.

## Storefront authority over the persistent agent

The native title sandbox and the autoloaded agent use separate storage. Removing the title therefore cannot be treated as revocation of files under `/data`. Startup is local-only and performs no Library Node request until the currently installed storefront authorizes its normalized server origin over the authenticated same-console channel. A storefront with no saved origin sends `disconnect`; the agent then replaces its persisted device state without carrying forward the server URL, console ID, credential or pending pairing. Local inventory, runtime and storage discovery remain available.

Firmware 4.51 denies the installed title's cross-sandbox Unix-socket connection with `EPERM`, so the agent initializes `SceNetCtl` and binds TCP only to the console's exact private IPv4 address. It never binds a wildcard address. Before reading a request, it rejects every peer whose source IPv4 is not exactly the bound console address; requests also require the local bearer, strict route grammar, size limits and timeouts. The shared title mount carries only the held `frontend.lock` used to detect the current storefront lifecycle. No mutable snapshot or command file crosses that mount. A root-equivalent payload can still bypass this local boundary; jailbreak services must remain private to the console network.

This deliberately requires opening PS5Library once after each jailbreak session before background server synchronization starts. It prevents an autoloaded agent from silently reconnecting with state left by an uninstalled storefront.

## Library Node to Community Master audit - 2026-09-25

This review covered the authenticated Library Node-to-Master path, user-session isolation, disconnection and native-update activation. It is source and integration-test evidence, not a penetration test or production certification.

### VERIFIED

- The Node accepts credentials only for its stored exact Master origin. Redirects, response-supplied origins and configured-origin changes cannot move a Node or user credential to another host. Master error values cross the boundary only through a fixed code allowlist.
- AES-256-GCM ciphertexts are domain-bound to their purpose, Master origin and local user where applicable. A Node credential cannot be substituted for a device authorization or user session. Legacy unbound Community ciphertexts fail closed and require relinking/reapproval.
- Master user sessions and game-session membership are bound to the exact approved Node. Another approved Node cannot replay the same account session, host membership or private connection data.
- Disconnect atomically revokes the Node, its user sessions, pending device authorizations, native-update consoles/grants and game-session access, then withdraws publications. File cleanup runs after the authorization transaction, so an I/O failure cannot roll back revocation.
- Credential replacement always returns the Node to `PENDING`; operator approval cannot be recovered implicitly. Revoked connections cannot complete a previously consumed device authorization. A Node blocks user calls while disconnect is pending, and an upstream `401` retires the local user session before it can be replayed.
- Native update activation accepts only the configured exact Master origin. A Master-supplied foreign URL is rejected before a token is returned.
- Browser-facing Node and Master services must use separate HTTPS origins. The reverse-proxy configuration supports a dedicated `PS5LIBRARY_MASTER_HTTPS_HOST`; path multiplexing both services on one origin is prohibited because a Node-origin script compromise would cross the Master admin browser boundary.

### REMAINING

- Production still needs a dedicated Master DNS name, proxy cutover and post-cutover verification before the separate-origin control is operational there.
- Native update activation is short-lived and IP/grant bound, not cryptographically bound to one console on every fetch. Clients sharing a public address remain a known limit until the native updater can carry and retain an opaque console-bound token through the full download lifecycle.
- The Node's Master credential is a revocable 256-bit bearer stored as a digest on Master and sealed locally, but it has no automatic expiry, rotation or last-use telemetry yet.

## Follow-up security and performance review - 2026-09-22

This review covered authentication failure handling, native update publication, save-file streaming, dependency state and container isolation. It is source and local integration evidence, not a penetration test or production certification.

| ID | Severity | Status | Finding and disposition |
| --- | --- | --- | --- |
| SEC-17 | Medium | Fixed | A malformed password hash in PostgreSQL could pass different-length buffers to `timingSafeEqual` and turn login into a server error. Stored hashes must now match the exact generated scrypt format before derivation and comparison; malformed values fail closed. |
| SEC-18 | High | Fixed | The private Community Master container default selected a terms file older than its declared terms version. The image now selects the exact current document, and a regression binds the container setting to the configured version so recorded consent cannot refer to different text. |
| SEC-19 | Medium | Fixed | Every native update request rehashed the complete package, CRC and delta, creating avoidable disk/CPU load on an unauthenticated system-update endpoint. Successful verification is now cached only for the exact manifest digest and file device/inode/size/mtime/ctime generations. Changed generations re-run SHA-256, SHA-1 and delta validation; failed verification evicts the entry. A same-size package mutation regression proves stale verified state is rejected. |
| SEC-20 | Low | Fixed | Encrypted backups and portable saves duplicated the same anti-symlink/TOCTOU file-handle checks and hashing loop. They now use one shared implementation. TypeScript's normal build also rejects unused locals and parameters. |

Validation: 31 unit tests, 29 integration checks, 12 native checks, four private Master checks, the 12-check worker suite, TypeScript/C# builds, Compose validation and the container isolation/persistence/Range smoke test pass. `npm audit --omit=dev` and NuGet's transitive vulnerability query report zero findings. The live native feed dropped from a 1.05-second cold verification to about 15 ms for verified warm requests. PS5/iOS hardware behavior and a current sanitizer rerun were unavailable in this pass.

Console-discovered artwork and music are not uploaded. The native frontend opens only fixed media filenames beneath authenticated local storage roots, rejects symlinks and oversized files, and keeps network-provided URLs on the existing authenticated server loader. The removed `/api/v1/device/library/artwork` route returns 404.

## Portable saves and offline-mode audit - 2026-09-21

This audit covered the final Library Node-to-Master save path, the privileged console mount/import path and explicit native offline mode. It is source, integration and one-console hardware evidence; it is not a production certification.

| ID | Severity | Status | Finding and disposition |
| --- | --- | --- | --- |
| SAVE-01 | High | Fixed | A compromised or incorrect Master response could return a different title/version while the Node trusted only the requested URL. The Node now binds the top-level title, every version group/item, fixed archive URL, manifest identity, size and SHA-256 to the exact requested title/version before discovery or download. A mismatch returns `MASTER_METADATA_MISMATCH`. |
| SAVE-02 | High | Fixed | Concurrent portable exports/downloads could both observe the same remaining quota. Reservations now share the existing PostgreSQL transaction advisory lock before accounting and insertion. |
| SAVE-03 | Critical | Fixed | Console save mount work requires elevated credentials. The agent now elevates only for key/mount or unmount, restores and verifies the original auth ID/capabilities before file copying, and terminates if restoration cannot be proven. Plaintext save bytes and network I/O run unprivileged. |
| SAVE-04 | High | Fixed | Replacing a live title's save could corrupt active state. Portable export and import now resolve the running BigApp, refuse the matching game, and fail closed when a positive app ID cannot be identified. Import retains both the durable server-requested raw backup and a verified local encrypted-image rollback copy. |
| SAVE-05 | Medium | Restricted | Generic code cannot identify account-specific values embedded in arbitrary game files. Platform metadata and `sce_sys` are excluded, but the manifest explicitly records that embedded identifiers were not generically removed. Publication is separate opt-in, stays quarantined and requires independent review; production needs operator scanning and clear privacy guidance. |
| SAVE-06 | High | Fixed | Import previously trusted that an existing path necessarily contained valid receiving-user metadata. The agent now requires mounted `sce_sys/param.sfo` for PS4 or the existing external per-slot SFO for PS5 before clearing game files, then verifies that exact target metadata after import. Portable archives still cannot contain `sce_sys` or external platform metadata, so source account metadata and keys cannot replace the target user's platform binding. |
| OFF-01 | Medium | Fixed | A UI labelled offline could still leak credentials through background refresh/media fetches. Explicit offline mode now cancels/suppresses refresh and foreground-agent work, makes artwork/music/trailers cache-only and disables all server mutations. Cached snapshots contain no credential and remain bound to the configured server and console identity. |

Hardware validation on firmware 4.50 passed a byte-exact PS4 portable export/import/export round trip and a read-only PS5 decrypt/mount probe. PS5 import, other firmware/runtime combinations and in-game save acceptance remain unverified.

## Community Master enrollment audit - 2026-09-21

This review covered the new trust path from a self-hosted Library Node to the private Community Master. It is source and integration-test evidence, not a penetration test or deployment approval.

| ID | Severity | Status | Finding and disposition |
| --- | --- | --- | --- |
| CM-01 | Critical | Fixed | A public server identifier could have become an implicit credential. Each Node now receives a random `srv_...` identifier used only for display and operator lookup, plus a separate 256-bit bearer credential stored only as a SHA-256 digest on Master and AES-256-GCM ciphertext on the Node. A regression proves the identifier receives `401` when presented as authentication. |
| CM-02 | High | Fixed | First connection could have enrolled a Node without proving account control. Enrollment now uses a ten-minute limited-input flow: the owner signs in with a user-verifying discoverable passkey, accepts the exact terms hash and authorizes an eight-character code. The short-code endpoints are limited to ten attempts per minute. The resulting Node remains `PENDING` until the independent Master operator approves it. |
| CM-03 | High | Fixed | Approval and enforcement needed an operator boundary. `/admin` uses a separate random 256-bit `MASTER_ADMIN_TOKEN`; approve, ban and unban require it. Ban immediately blocks all content/social routes while retaining authenticated status lookup so the Node can display the reason. Every request and operator action is recorded in PostgreSQL and structured logs. Authorization headers are redacted. |
| CM-04 | High | Fixed | A compromised Master response could redirect a Node owner or leak the Node credential. `COMMUNITY_MASTER_URL` must be an exact HTTPS origin, redirects are refused, both verification URLs must match that origin, responses are capped at 1 MiB and requests time out after ten seconds. The web and iPhone views never receive the secret credential. |
| CM-05 | Medium | Fixed | Generated account/admin pages could break or broaden browser trust. Both use a per-response CSP nonce, `default-src 'none'`, same-origin connections, no framing, no referrer and no persistent browser token storage. A test compiles each emitted script; it caught and prevented a broken Base64URL encoder before release. |
| CM-06 | High | Restricted | Participant save upload streams to a unique quarantine file, enforces the declared byte count and SHA-256, syncs before publication and remains invisible as `PUBLISHING`. Only a separately reviewed record with `scan_result='CLEAN'` is discoverable. Portable console export/import now exists, but automated scanning, moderation UI and production quotas remain required before deployment. |
| CM-07 | High | Fixed for rendezvous | Generic session metadata could have exposed private endpoints or become an undeclared arbitrary-game proxy. Session creation now fails unless the adapter ID is in the operator allowlist, binds discovery to exact title/version and current friendship, omits bounded Base64URL connection data from discovery, serializes joins under the session lock, enforces capacity and expires after 90 seconds without a host heartbeat. No PSN credential, packet relay or DNS redirection path exists. |

Validation: TypeScript builds, four PostgreSQL enrollment/save integration checks, generated-page syntax checks, Library Node restart persistence, iOS model/parser checks, the public-release boundary, dependency audit and the private Master container build pass. The Master has not been deployed.

## Security audit - 2026-09-20

This was a targeted source, dependency, container and trust-boundary audit of the current working tree. It is not a penetration test or production certification. The review covered authentication and account isolation, console pairing and credentials, source/artwork SSRF, local path handling, archive extraction, update signing, transfer capabilities, Community Master save delivery, native/iOS transport rules, Docker confinement and CI inputs.

### Results

| ID | Severity | Status | Finding and disposition |
| --- | --- | --- | --- |
| SEC-01 | High | Fixed | Artifact and artwork paths read from PostgreSQL could escape `DATA_DIR` if the database were corrupted or compromised. Every affected download route now resolves the existing target beneath `DATA_DIR`; a regression proves `../outside.bin` is refused. |
| SEC-02 | High | Fixed | The update private key defaulted beneath the runtime `/data` tree and was eligible for the Docker build context. It now lives under ignored `.secrets/update-signing`, is excluded by `.dockerignore`, and is configurable through `UPDATE_SIGNING_DIR`. The existing key was moved without rotation so installed clients retain the matching public key. |
| SEC-03 | High | Fixed | Each Community Master Range request rehashed the entire immutable save archive, allowing inexpensive repeated reads to cause disproportionate disk I/O. Verification is now coalesced and cached per file generation, with type, link, size, generation and SHA-256 checks. Concurrent and changed-file regressions pass. |
| SEC-04 | High | Fixed | Explicit insecure-LAN mode accepted plain HTTP for any hostname. PS5 and iOS clients now allow it only for loopback, `.local` and literal private/link-local addresses; public or ambiguous names are rejected. PS5 currently rejects IPv6 HTTP because its SDK lacks the required IPv6 address parser. HTTPS remains valid everywhere. |
| SEC-05 | High | Fixed | The Windows host and pinned production stages now use Node 22.23.2. The host ZIP was checked against Node's published `SHASUMS256.txt`, and `package.json` rejects older Node 22 runtimes. See the official [July 2026 Node security release](https://nodejs.org/uk/blog/vulnerability/july-2026-security-releases). |
| SEC-06 | High | Mitigated | Production package/archive, FFmpeg and Sharp image work now runs through a bounded, unprivileged, networkless worker with a read-only root, source/dump/published-data mounts and CPU/memory/PID limits. It can write only job, trailer and artwork staging trees. The API does not load Sharp or execute these tools. Per-job write mounts remain future hardening. |
| SEC-07 | High | Fixed | PostgreSQL now uses a derived pinned image with `gosu` removed and runs directly as `postgres`. PostgreSQL, Redis, server, worker and Community Master images report zero high/critical Trivy findings. The backed-up live database and queue were recreated on the clean images. |
| SEC-08 | Medium | Open by design | Private-LAN HTTP still exposes bearer credentials to an attacker on that LAN. It requires explicit opt-in and is syntactically confined, but remote/friend access must use HTTPS or a private VPN. |
| SEC-09 | Medium | Open | The privileged PS5 agent stores its credential under `/data/ps5library`. A separately exposed unauthenticated WebSrv/file service could disclose it. Keep PS5 debug/file services off untrusted networks and stop them outside debugging; no verified PS5 secure-keystore integration exists yet. |
| SEC-10 | Medium | Fixed for new accounts | Registration requires at least 12 characters. Existing password hashes remain login-compatible so the update does not lock out users; legacy users should rotate weak passwords. Scrypt, generic errors, dummy verification and rate limits remain in place. |
| SEC-11 | Medium | Restricted | Participant publication upload streams only to quarantine with exact size/hash checks and cannot self-promote. Catalog and download queries expose only operator-reviewed rows explicitly marked `CLEAN`; unreviewed or rejected rows remain hidden. Automated scanning, production quotas, moderation and broader hardware validation remain required before production publication. |
| SEC-12 | Medium | Fixed | Device WebSockets permit one in-flight heartbeat. A second pending message closes the authenticated connection with policy code 1008, preventing an unbounded per-connection promise backlog. |
| SEC-13 | Low | Fixed | Master hashes through an exact open file handle, verifies that path and handle still identify the same generation, and streams that verified handle. A regression replaces the pathname after verification and proves the original verified bytes are served. |
| SEC-14 | High | Fixed | The public Library Node release could accidentally include the private Community Master implementation or operator data. Git and Docker excludes now cover Master source/images, runtime data, secrets and real environment files; `npm run check:public-release` fails if any becomes tracked. The public save manifest schema remains available as the versioned interoperability contract. |
| SEC-15 | High | Fixed | The previous game-sharing switch exposed a title to every account on one Library Node. Owners can now grant or revoke each game for exact local account IDs. Catalog, artwork and source resolution all use the same PostgreSQL access view, and a database integration regression covers grant, non-recipient isolation and revocation. |
| SEC-16 | High | Fixed; PS4 hardware pass | Raw save backups are owner- and exact-console scoped. The agent copies encrypted console files without exporting decrypted keys; the server enforces exact resumable offsets, canonical bounded chunks, quota/free-space checks, `fsync`, SHA-256 verification, link/handle identity checks and atomic publication. One PS4 portable round trip passed on firmware 4.50; PS5 import remains disabled by capability unless a runtime reports support and remains hardware-unverified. |

Additional hardening completed during the audit:

- Main API HSTS is emitted when `PUBLIC_URL` is HTTPS. Login performs the same scrypt work for known and unknown usernames. Master save discovery is bounded to 500 rows.
- Production base images, PostgreSQL/Redis images and PS5 SDK release assets are pinned by digest or SHA-256. The Master runtime no longer contains npm/npx.
- Trivy 0.74.0 reports 0 high/critical records for the rebuilt server, worker, Community Master, PostgreSQL and Redis images. `npm audit` reports 0 findings; both .NET projects report no vulnerable NuGet packages; a scan of tracked and untracked non-ignored source reports 0 embedded secrets. Trivy version evidence uses the official [v0.74.0 release](https://github.com/aquasecurity/trivy/releases/tag/v0.74.0).
- SharpCompress 0.50.4 is in use. The worker does not call the vulnerable `WriteToDirectory()` path described by [GHSA-6c8g-7p36-r338](https://github.com/advisories/GHSA-6c8g-7p36-r338); its custom extractor validates each relative path, rejects links/reparse points and conflicting entries, and enforces entry and expanded-byte limits.

### Validation

- 22 server unit tests, 2 private Community Master tests, 24 integration checks and all worker checks pass.
- All 18 native host CTests pass. The PS5 app, installer and agent cross-build with loader prerequisite checks.
- The complete native integration suite passes all 10 checks. The former large-fixture agent timeout and delayed installation-plan focus failure were corrected at their fixtures.
- iOS model checks and Swift parsing pass in the Linux Swift 6 image; the previously recorded GitHub Xcode simulator build remains the full Apple-platform build evidence.
- A verified PostgreSQL backup was created before the live PostgreSQL, Redis, worker and server cutover. Health, retained account/console data and clean recent logs were checked afterward. Nothing was installed on the PS5, published or pushed.
- A second verified PostgreSQL backup preceded deployment of migration 027. The live Library Node is healthy with exact game grants available; retained account, console and game counts were checked. The Community Master implementation was not deployed or included in the public server image.

## Docker/runtime update, 2026-09-16

VERIFIED: the non-root server has a read-only root, dropped capabilities, no-new-privileges and CPU/memory/PID limits. Its source mount is read-only; its dump mount is writable only for the explicit verified-retirement path. No Docker socket is mounted. In Compose, package/archive, FFmpeg and Sharp processing runs through a separate networkless worker whose source, dump and published-data mounts remain read-only. Host development retains a local fallback. Common input/output validation applies to both.

VERIFIED: update-signing material is outside the `/data` bind and Docker build context. Runtime data may still include operator backups, so keep the bind private. Per-job write mounts and full failed-staging accounting remain unfinished.

ShadowMount requests stay on loopback with redirects/proxies disabled, deadlines and body limits. No PS5Library credential is forwarded. API acceptance alone does not establish READY.

## Implemented boundaries

- Native Remote Play pairing is explicitly started by the console owner, expires after five minutes and is delivered only to that owner and the agent credential. A frontend credential cannot impersonate the agent. The temporary PIN and account ID are AES-256-GCM sealed with the Library Node bootstrap secret and cleared after paired/error/expiry; HTTP logs contain no body. The eventual registration key stays in the viewing device's secure store. The Community Master is not involved, and PS5Library never asks for a PSN password, Sony token or official TLS identity.
- Native app credentials are separately paired to an existing owned console and restricted by a fail-closed route allowlist. They cannot report physical state, consume agent work/notifications, mint OS download grants or invoke the payload updater. Agent heartbeats acknowledge only agent pairings; frontend handoff is acknowledged by use of that exact credential. Existing credentials migrate as `AGENT`. These controls and migration 023 are deployed. Before rolling back to older server code, revoke all `FRONTEND` credentials because the old authentication code does not enforce their narrower role.
- First-account bootstrap secret, passwords of 12-200 characters for new registration, scrypt password hashes, short-lived one-use invites and hashed session/device credentials. Legacy short-password login remains compatible to avoid lockout. Cookies are HttpOnly/SameSite. Browser requests, including WebSocket upgrades, enforce `PUBLIC_URL` plus explicitly configured `BROWSER_ORIGINS`; these are exact HTTP(S) origins, never wildcard or request-Host-derived trust. Native requests without an Origin still require the route's authentication. TLS is required for native remote use; certificate checks are not disabled.
- Persistent random console identity and short-lived pairing code/poll secret. Account ownership is assigned by authenticated claim. The temporary encrypted credential handoff is erased on authenticated heartbeat. Expired unclaimed identities can renew codes; claimed devices cannot be taken over by repeating registration.
- Native device credentials are bound to a normalized server origin. URL validation rejects embedded credentials, non-root paths, queries and fragments; HTTPS is the default and HTTP needs explicit opt-in. Confirmed server changes stop the old request/agent/artwork workers and create a new identity. Unbound legacy credentials also require re-pairing. Host checks cover rejection before confirmation and prove no old Authorization header reaches the new server.
- Offline catalog snapshots contain no credential and must match both server and paired console identity. Artwork cache keys include the server configuration and device credential. Managed inventory receipts are scoped to the server and console; old or unbound receipts stay on disk and are not reported to a new pairing. A process lock prevents settings changes while a separate agent is active.
- Catalog/artwork/trailer reads allow explicit shared-game access; source configuration, consoles, jobs, credentials and profiles remain private. Shared readers cannot delete another owner's cache or backport copies. Admin status is not a private-data bypass. PostgreSQL integration tests cover shared reads, private writes and cross-owner console denial.
- Repository credentials are environment references, never public metadata. Tokens are restricted to their configured origin; redirects do not inherit credentials across origins. Private hosts require an explicit exact-origin allowlist.
- Outbound source/artwork HTTP validates all resolved IPs, rejects forbidden/private destinations by default, pins the connection to the checked address, limits redirects/body sizes and applies timeouts. Local sources are restricted to the owner's source root. Symlinks, traversal, reserved Windows names and archive escape paths are rejected.
- Downloads stream to `.part`, verify complete SHA-256 before success and observe quota/free-space checks. Builders operate on copies. Cache deletion is owner-scoped and blocked for active transfers.
- One storage-usage transaction now accounts for packages, standalone backports, artwork/trailers, active download/build reservations, raw save backups and portable-save archives under the same PostgreSQL advisory lock. Save and community uploads share one resumable writer that requires a regular staging file, canonical bounded Base64 chunks, exact monotonic offsets, full writes and `fsync`; publication still requires exact size and SHA-256. Consolidation removed divergent copies without relaxing either trust boundary.
- Only admins can configure watched server folders, automatic preparation, source sharing or dump retirement. Real-path and symlink checks confine reads to the configured root. Inspection and preparation leave original dumps unchanged; explicit retirement revalidates the exact source, FPKG and required backport, rejects active work, and confines quarantine/removal beneath the dump root. No automatic source deletion runs after a build. Library separation touches only job staging, and the published backport records retain exact release/input hashes. Unclassified libraries cannot unlock compatibility. Quota reservations include separate backport copies and trailers; terminal failed build staging is cleaned up.
- Artwork/avatar and MP4 uploads are streamed or bounded before they cross into the networkless worker. Images are dimension/type/page checked and normalized; video output is probed, hashed and published before clients can receive it.
- PS5 installers refuse foreign title folders, verify an ownership marker and restore prior files on registration failure. Deeper ShellUI patches remain disabled. No Sony/PSN authentication is requested or proxied.
- Community Master participation and every save publication are separate explicit opt-ins. The master receives no game dumps/packages, source URLs, console credentials, PSN identifiers or save encryption keys. Published saves are treated as untrusted archives, verified in bounded staging and never executed or restored automatically. Disabling participation revokes the master credential and requests publication withdrawal.
- Master accounts use discoverable passkeys with required user verification. Access tokens are short lived; refresh tokens rotate and replay revokes the token family. A Node's stable public server ID cannot authenticate. Its separate secret is encrypted at rest locally, hashed on Master and can be approved, banned, unbanned or revoked without changing the identifier.
- Local social accounts do not share the Node credential. Each user authorizes a separate one-use device code; the Node seals the resulting access/refresh session with the bootstrap secret and embeds the local user UUID inside the authenticated ciphertext. Refresh rotation runs under that user's database row lock, and a paired storefront credential resolves its owner before any friend or presence request.
- The Library Node source is the public self-hosted product. The Community Master implementation and deployment remain private and are excluded from the public repository and normal Docker context. Private source is not treated as a security control: every Master request still authenticates, validates the public strict schema and enforces owner/recipient authorization.
- A Master friend relationship never grants access to a Library Node game. Game access is an explicit local account grant. Remote nodes use HTTPS or an established private network such as WireGuard; PS5Library does not invent transport cryptography or relay game packages through the Master.
- Community chat must use an audited end-to-end protocol before launch. Session coordination is limited to homebrew or individually authorized title adapters. No PSN passwords, Sony tickets, TLS identities or official endpoints are impersonated.

## Operational requirements and remaining risks

This is an engineering preview. Use trusted users and authorized inputs. A malicious owner with repository access must still be treated as untrusted at file/network boundaries. Native parsers now run in a resource-limited networkless container with published data mounted read-only; its three writable staging trees are shared across jobs. Use per-job writable mounts before opening arbitrary uploads to untrusted parties. Quotas do not yet include every failed staging directory; reclaim failed work deliberately and add a disk accounting/retention job before production.

Deploy the API behind HTTPS/private VPN for friends. PostgreSQL/Redis bind to loopback in the supplied Compose file. Do not expose their ports or the console's unauthenticated homebrew loader to the internet. User accounts and API checks do not protect an exposed jailbreak payload service.

Back up PostgreSQL, artwork/artifact storage and `.env` together; the bootstrap secret also encrypts pending credential handoffs. Do not commit `.env`, credentials, personal dumps, upstream binary packages or caches. Installer rollback covers our files; interrupted system registration can still need exact-title recovery on the console.

Native connection files use atomic replacement and owner-only file permissions on supported POSIX filesystems. A server switch retains one local `previous-server.json` with the previous configuration and device credential. Treat this as sensitive backup data; it is never sent over the network. The previous server's credential is not automatically revoked, so remove that console from its old account when retiring it. If power fails between identity and configuration replacement, the origin check rejects the mismatched identity. With the app and separate agent stopped, restore both `config` and `device` from the same backup or pair again; automatic crash recovery for this two-file change is not implemented.

Outstanding: credential rotation UI, per-account storage quotas, heartbeat/event retention, end-to-end account/cache switching checks on iOS and PS5, complete malformed-artifact fuzzing and an independent deployment review. This targeted audit is not a blanket firmware or production-safety guarantee.

## Private firmware research boundary

The 4.51 PUP experiment is outside the product runtime. Its ignored research build accepts one exact USB input, creates one exclusive output, validates every container range and exposes only PUP verification/decryption ioctls. It temporarily changes only its own short-lived credential to the observed updater credential, restores the original credential before exit and never changes the updater process. Static checks reject SFlash, OTP, update installation, reboot, network and system-database APIs. Official PUPs, decrypted output, selected segments and logs stay under ignored private data and must not be published with PS5Library.

## Native package delivery grants

The OS installer cannot supply the normal console bearer token. It receives a random 256-bit per-job capability URL, stored hashed plus encrypted for idempotent re-issuance. It is restricted to that job's verified artifact, expires after 30 days and checks active device credentials/job state/firmware/runtime on each HTTP request. Console credentials never appear in its URL. Request-path logging must remain disabled/redacted for this route in any external reverse proxy. HTTP byte coverage is persisted as a PostgreSQL multirange; overlap/resume cannot inflate progress. Readiness additionally requires console verification and inventory, not bytes served or API acceptance. An already open HTTP response may finish after revocation; new requests are denied.

Backport paths are relative and validated at server/worker/console boundaries. Worker provenance binds the exact profile hash and source hash. Overlay staging is outside scan roots; existing differing title overlays are never replaced automatically. Firmware refresh is owner-authorized and must be answered by the paired device with a single-use request ID.

## Supplied patch recipes (2026-09-16)

Patch recipes are data, not executable scripts. They are owner-scoped profiles, matched to exact release/input hashes and pinned in durable jobs. BPS data is bounded, canonical base64, SHA-256/CRC checked and stored with the profile. The worker checks source/target hashes, offsets, lengths, module limits and explicit SDK structures. It works only in staging and never executes a module or modifies a source dump. No patch URL, process command or arbitrary output path is accepted.

Automatic profile discovery is admin-only and limited to an owned prepared folder resolved below the configured local source root. The isolated worker accepts explicit validated arguments, rejects encrypted SELF input and unsafe/reparse paths, hashes the complete source before and after scanning, and emits only an `UNTESTED` data profile. The API checks that its input hash still equals the catalog observation before storing it.

Module growth has a bounded allowance included in quota/free-space reservations. Post-builder library hash checks prevent an implicit packaging transform from invalidating selected overlay bytes. Different firmware profiles have separate cache identities; duplicate active transfers are rejected before the database constraint. These are automated checks, not a security audit or physical compatibility claim.
