# Security model

## Implemented boundaries

- First-account bootstrap secret, scrypt password hashes, short-lived one-use invites and hashed session/device credentials. Cookies are HttpOnly/SameSite; state-changing browser requests enforce the configured Origin. TLS is required for native remote use; certificate checks are not disabled.
- Persistent random console identity and short-lived pairing code/poll secret. Account ownership is assigned by authenticated claim. The temporary encrypted credential handoff is erased on authenticated heartbeat. Expired unclaimed identities can renew codes; claimed devices cannot be taken over by repeating registration.
- Native device credentials are bound to the configured server. Changing the address cannot forward an existing credential to a new server. Offline catalog snapshots contain no credential and must match both server and paired console identity. Native checks cover the server-change rejection.
- Every user/device catalog, artwork, source, job, artifact and console route checks ownership. Admin status is not a private-data bypass. Friend isolation and replay denial are tested against real PostgreSQL.
- Repository credentials are environment references, never public metadata. Tokens are restricted to their configured origin; redirects do not inherit credentials across origins. Private hosts require an explicit exact-origin allowlist.
- Outbound source/artwork HTTP validates all resolved IPs, rejects forbidden/private destinations by default, pins the connection to the checked address, limits redirects/body sizes and applies timeouts. Local sources are restricted to the owner's source root. Symlinks, traversal, reserved Windows names and archive escape paths are rejected.
- Downloads stream to `.part`, verify complete SHA-256 before success and observe quota/free-space checks. Builders operate on copies. Cache deletion is owner-scoped and blocked for active transfers.
- PS5 installers refuse foreign title folders, verify an ownership marker and restore prior files on registration failure. Deeper ShellUI patches remain disabled. No Sony/PSN authentication is requested or proxied.

## Operational requirements and remaining risks

This is an engineering preview. Use trusted users and authorized inputs. A malicious owner with repository access must still be treated as untrusted at file/network boundaries. Native .NET/image parsers are not currently isolated with OS job-object/container resource limits; add that isolation before opening uploads to untrusted parties. Quotas do not yet include every failed staging directory; reclaim failed work deliberately and add a disk accounting/retention job before production.

Deploy the API behind HTTPS/private VPN for friends. PostgreSQL/Redis bind to loopback in the supplied Compose file. Do not expose their ports or the console's unauthenticated homebrew loader to the internet. User accounts and API checks do not protect an exposed jailbreak payload service.

Back up PostgreSQL, artwork/artifact storage and `.env` together; the bootstrap secret also encrypts pending credential handoffs. Do not commit `.env`, credentials, personal dumps, upstream binary packages or caches. Installer rollback covers our files; interrupted system registration can still need exact-title recovery on the console.

Outstanding: credential rotation UI, per-account storage quotas, heartbeat/event retention, end-to-end account/cache switching checks on iOS and PS5, complete malformed-artifact fuzzing and a deployment security review. No security audit or blanket firmware guarantee is claimed.
