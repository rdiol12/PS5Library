# iPhone companion

## Implemented source

`ios/PS5LibraryCompanion.xcodeproj` contains a native SwiftUI iOS 17+ app, without a JavaScript wrapper or third-party UI dependencies. It shares PS5Library's dark/blue identity, server artwork and state language.

The source includes multiple saved server/account profiles, Keychain session tokens, invite registration/login, console code pairing, console selection/renaming/storage, visual Discover/details/library, preparation/install confirmation, real job progress and controls, PC artifact-cache deletion and admin invitations. All operations use the owner-scoped API. The library requires console-reported READY state. Cached views are identified as offline.

Artwork is fetched from our authenticated server and decoded off the main actor. The app keeps an account-specific protected catalog snapshot. WebSocket job events trigger refreshes; periodic REST refresh also reconciles console/storage information. Closing or suspending the iPhone does not stop the server's durable jobs.

## Build on macOS

Windows cannot compile or sign the SwiftUI/UIKit iPhone application. **No iOS build or simulator run has been performed on this machine.** The checked-in project is source, not a validated IPA.

On a Mac with Xcode and an installed iOS Simulator runtime:

```sh
xcodebuild -project ios/PS5LibraryCompanion.xcodeproj -scheme PS5LibraryCompanion -sdk iphonesimulator -configuration Debug CODE_SIGNING_ALLOWED=NO build
```

Open the project in Xcode to choose a simulator. For a physical iPhone, set your own development team and an available bundle identifier, then build/run using your signing account. PS5Library does not need a PSN account. Use the HTTPS server URL and a certificate trusted by iOS; no certificate-verification bypass is installed.

## Required next validation

Compile/type-check on Xcode; exercise sign-in/account switching without cross-account cache leakage; pair two owners' consoles; confirm a prepared-folder job survives app closure; verify progress, storage and manual deletion; test VoiceOver/Dynamic Type and narrow iPhone layouts. QR scanning, background push/APNs, automatic base-plus-update bundles, console move/delete/play and native network setup are incomplete. Current pairing uses the displayed code.

**VERIFIED:** server contracts used here pass backend integration checks; files and project structure exist. **EXPERIMENTAL:** the iOS implementation pending compilation. **UNKNOWN:** actual device rendering, permissions, signing and OS lifecycle behavior until Mac/iPhone tests run.
