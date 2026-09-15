# Storage and inventory

## VERIFIED implementation

Configured roots are enumerated with native filesystem space queries and actual write access. The API uses friendly `storageId`/display names; raw paths stay out of normal storefront screens. Unsupported/unwritable destinations are disabled. Planning includes game, update, backport, temporary bytes and safety margin; active transfers reserve capacity. Build output is remeasured before the transfer is queued.

All new PS5 data goes to `.ps5library/staging/<job>/content.part` outside watched final folders. The agent checks size and SHA-256 before atomic publication on the same filesystem. Receipts identify the exact release/hash/path and registration state. HTTP Range and strong artifact ETags support continuation after interruption. Remaining-byte checks allow resumed downloads without reserving the completed part twice.

Server cache and console library are separate. Console inventory is authoritative about physical availability. Missing/deleted files cause `MISSING`; the server does not continue showing READY just because it once transferred a file. Complete inventory revisions reconcile expected records. A device cannot report another owner's release.

The current scanner is limited to our managed receipts. It hashes on first observation and after file size/mtime changes. It does not open or modify Sony's system databases. The SDK `samples/mntinfo/main.c` verifies that mount enumeration is possible, but arbitrary mounts are not automatically treated as safe install targets.

## UNKNOWN / remaining

Broad discovery of normal installed titles and manually added ShadowMount titles, verified native storage-service integration, managed move/delete operations, robust removable-drive reconnects and sleep/reboot recovery need hardware work. Configured storage paths and a ShadowMount config file are not sufficient evidence of every filesystem's supported method.

Metadata inspection on the console is not yet as comprehensive as the worker's structural inspection. Hash equality proves the transferred file matches the verified server artifact; it is not an independent launch test. Large-title performance and unusual USB filesystems must be tested before release.
