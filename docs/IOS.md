# iPhone companion

## Implemented source

`clients/ios/PS5LibraryCompanion.xcodeproj` contains a native SwiftUI iOS 17+ app, without a JavaScript wrapper or third-party UI dependencies. It shares PS5Library's dark/blue identity, server artwork and state language.

The source includes multiple saved server/account profiles, Keychain session tokens, invite registration/login, console code pairing, console selection/renaming/storage, visual Discover/details/library, preparation/install confirmation, real job progress and controls, PC artifact-cache deletion and admin invitations. All operations use the owner-scoped API. The library requires console-reported READY state. Cached views are identified as offline.

My PS5 now includes a capability-gated native Remote Play pairing sheet. It asks the owning console agent for a real five-minute PIN, shows the exact account ID and follows the request through paired/error state. Unsupported or offline consoles cannot start it. The server never receives a PSN password or a Remote Play registration key; pending PIN/account material is encrypted and erased after completion.

Profile links each console to **Save backups**. The companion lists exact reported PS4/PS5 slots, requests an encrypted raw backup only from an online `saveBackup`-capable agent, polls real persisted upload bytes, and permits owner deletion. A ready raw archive is downloaded without redirects, checked against its exact content type, byte size and SHA-256, and exposed through Apple's share sheet from a protected temporary file that is removed when the sheet closes.

The same screen now exposes the separate portable/community flow only when the console reports `saveExport`, `saveImport` and `saveRollback`. It shows the current terms, requests exact-version export, lists portable revisions/import progress, publishes one explicitly selected revision, finds/downloads only saves matching a title/version and imports only into an existing matching slot with rollback. Raw console-bound backups are never offered for publication. PS5 import and real iPhone interaction still require device validation; the firmware 4.50 hardware pass covered one PS4 round trip driven through the server/agent path.

This is the shared registration foundation, not an embedded iPhone stream player. Current chiaki-ng builds its core library for iOS/tvOS but ships no iPhone frontend. The remaining player needs an Xcode-built libchiaki bridge, VideoToolbox/Metal video, audio, controller input and a device-local Keychain registration record. Until then, the matching PC view supplies the PIN/account ID to an installed chiaki-ng client, which carries the stream directly to the PS5.

The pairing form now lets the owner choose an existing PS5 for a native storefront code, or register a new PS5 for an agent code. The server rejects cross-owner links and the wrong pairing mode. This SwiftUI addition is source-only until a macOS/Xcode build is available; the matching server and actual C++ frontend flows pass host integration checks.

Profile now includes a separate **Community & Friends** view. A signed-in local user can request a one-use Master account link, open the passkey approval page, monitor authorization, view coarse friend presence, manage exact-handle friend requests and disconnect the account. The Library Server stores each user's rotating Master session encrypted and never exposes the server-wide node credential to either client. This SwiftUI source still requires an Xcode build and real iPhone interaction testing.

Artwork is fetched from our authenticated server and decoded off the main actor. The app keeps an account-specific protected catalog snapshot. WebSocket job events merge directly into matching jobs; only terminal or unknown jobs trigger an immediate snapshot reconciliation, while periodic REST refresh still reconciles console/storage information. Closing or suspending the iPhone does not stop the server's durable jobs.

Public server names require HTTPS. A self-hosted server on loopback, a `.local`/single-label LAN name, or a private/link-local IP may use explicit HTTP; both Xcode configurations declare Apple's [`NSAllowsLocalNetworking`](https://developer.apple.com/documentation/bundleresources/information-property-list/nsapptransportsecurity/nsallowslocalnetworking) exception without enabling arbitrary public loads. The client uses `ws` for those validated HTTP origins and `wss` for HTTPS. It never silently downgrades a failed HTTPS connection.

## Feature parity work — September 17, 2026

Continued the existing SwiftUI app rather than introducing a second client. This pass adds:

- Discover collections for all games, recently added/updated, new releases, saved games and verified server copies; category filtering and title-ID search.
- Save/unsave through the account-scoped API. Saved games, verified server packages and console-reported availability remain distinct collections.
- Library switching between console, server and saved games, with the selected console's actual storage destinations as filters.
- Profile and per-console local trophy summaries, source timestamps and game availability. Missing trophy data remains unavailable; totals are never combined across consoles.
- Profile picture selection from catalog artwork and reset to the default picture.
- Notifications with refresh/retry, console names and server messages.
- Named DLC release choices and support for newer preparation-progress payloads without failing the entire refresh.
- Console default selection, firmware refresh requests, and confirmed access revocation. Firmware requests report that a check was requested; they do not claim the console has already responded.
- Pairing code normalization/validation, console-name validation, and retained pairing input on failure. Console requests disable duplicate submissions and ignore responses after account switches.
- Content Sources in Settings: list sources and scan observations/errors, add all five supported source types, configure scan intervals, and manually scan. Admin-only options include watched folders, repository credential references, sharing and automatic preparation. Saving adds the source; use **Scan now** to import it. Existing server APIs do not provide source editing/deletion, so those controls are not offered.

The Swift parser also found four missing view-closing braces in the existing source (game details, installation, job card and cache); these are repaired.

### Validation

Run the model behavior checks and syntax check from a Mac or Linux Swift installation:

```sh
sh clients/ios/check.sh
```

On Windows with Docker:

```powershell
docker run --rm -v "${PWD}/clients/ios:/src:ro" swift:6.0 sh /src/check.sh
```

These compile and execute the actual Foundation models and collection logic, including old catalog compatibility, cached snapshot round trips, storage availability, DLC labels, profile/save-backup/notification decoding and current progress payloads. The parser checks all app Swift files. **This does not type-check SwiftUI/UIKit or replace an Xcode build.**

### Remaining parity work

Push notifications remain outstanding. Console-local runtime/network settings require platform-specific design. Existing installation, download and Remote Play screens still need real device/API testing; no claim of an embedded Remote Play player is made by this source milestone.

### Installation flow

The download sheet now selects a release and source, then an owned console, installation method and supported storage. Missing sources/consoles have explicit empty states. Unsupported-method responses correctly decode a null method and omitted online status and show the server explanation.

Each plan is associated with its exact source, console and method selection. Changing a selection immediately makes the prior plan unusable for confirmation. Cancelled/outdated responses are ignored; submission captures the reviewed request, disables editing/duplicate submits and checks that storage is allowed. Errors require checking the plan again. Account switching dismisses the sheet.

Downloads now fetches `/installations` alongside `/jobs` and shows durable installation states such as waiting for a PS5 or storage, rather than only individual preparation/transfer jobs. The installation list is included in account-specific offline snapshots; older snapshots without it still decode.

Runnable Swift checks cover unsupported plans, source/console/method mismatches, blocked/missing storage, offline-console planning and installation decoding. A full Xcode build and live API/UI tests are still required; no installation was submitted to a real console during this work.

### QR pairing

My PS5 now offers **Scan pairing QR code**, using Apple's [VisionKit scanner](https://developer.apple.com/documentation/visionkit/datascannerviewcontroller). Camera access is requested only when the scanner is opened. Unsupported devices, denied permissions and camera failures retain manual code entry. Both Xcode configurations include the camera permission description. The camera stops on dismissal or when the app leaves the foreground.

Scanned URLs must use the selected server's exact scheme, host and port, the exact `/pair` path, one valid code and optionally `kind=frontend`. This supports a validated private-LAN HTTP server without accepting an HTTPS-to-HTTP downgrade. Duplicate/unknown parameters, credentials, fragments and foreign-server links are rejected. The scanner never opens the scanned URL. Agent codes select new-console registration; storefront codes require an existing console. Scanning fills the form; the user still taps **Link to my account** to submit.

Parser checks cover valid agent/storefront URLs, default HTTPS ports and rejected inputs. Camera permission flows, VisionKit availability, camera lifecycle and actual QR recognition remain untested until a supported iPhone/Xcode environment is available.

### Trailer and music playback

Game details now offer **Watch trailer** and **Play game music** when the catalog reports ready media, and display preparation states otherwise. Playback uses Apple's [VideoPlayer](https://developer.apple.com/documentation/avkit/videoplayer) and AVPlayer with local files. No third-party player dependency is added.

The client uses an authenticated, ephemeral URLSession to fetch media from the configured server. It refuses redirects, checks content type, bounds downloads to the catalog size and server limits (8 MiB music / 128 MiB trailers), and verifies SHA-256 before playback. Data is written in 64 KiB chunks to a protected temporary file. Failure/cancellation removes partial files; closing playback removes the finished copy. App suspension pauses playback and account switching closes it.

This first implementation downloads the complete clip before playing; progressive streaming, automatic menu music, background audio and persistent media caching are deferred. Metadata validation and Swift syntax checks pass on Linux. Actual AVKit playback, URLSession streaming, integrity-failure cleanup, cancellation, audio routing and lifecycle behavior still require Mac/iPhone testing. Temporary files left by a process crash remain subject to iOS temporary-directory cleanup.

## Build on macOS

Windows cannot compile or sign the SwiftUI/UIKit iPhone application. **No iOS build or simulator run has been performed on this machine.** The checked-in project is source, not a validated IPA.

On a Mac with Xcode and an installed iOS Simulator runtime:

```sh
xcodebuild -project clients/ios/PS5LibraryCompanion.xcodeproj -scheme PS5LibraryCompanion -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build
```

Open the project in Xcode to choose a simulator. For a physical iPhone, set your own development team and an available bundle identifier, then build/run using your signing account. PS5Library does not need a PSN account. Use HTTPS with an iOS-trusted certificate for remote access. On the same private network, enter the server's explicit HTTP URL, such as `http://192.168.1.20:3150`; no certificate-verification bypass is installed.

## Required next validation

Compile/type-check on Xcode; exercise sign-in/account switching without cross-account cache leakage; pair two owners' consoles using manual codes and QR scanning; confirm a prepared-folder job survives app closure; verify progress, storage and manual deletion; test VoiceOver/Dynamic Type and narrow iPhone layouts. Background push/APNs, automatic base-plus-update bundles, console move/delete/play and native network setup are incomplete.

**PHYSICAL CONNECTION / 2026-09-21:** companion 0.1.1 build 2 successfully connected from a physical iPhone to the live private-LAN server. This verifies the local-network transport and sign-in path for that device/server combination; the broader interaction checks above remain outstanding.

**VERIFIED:** server contracts used here pass backend integration checks; files and project structure exist. **EXPERIMENTAL:** the iOS implementation pending compilation. **UNKNOWN:** actual device rendering, permissions, signing and OS lifecycle behavior until Mac/iPhone tests run.
