# iPhone companion

The iPhone companion connects to an operator-owned PS5Library server. It does not contain a public service address or catalog. The maintainers do not provide game-server hosting, packages, dumps, or game links; each operator supplies their own server and authorized content.

The current app can:

- Keep multiple server accounts with device-only Keychain credentials.
- Use HTTPS, private local-network addresses, and an optional private Tailscale fallback.
- Browse the library, artwork, trailers, and menu audio.
- Select a release, console, install method, and supported storage destination.
- Monitor preparation and transfer progress and pause, resume, retry, cancel, or dismiss jobs.
- Pair consoles by QR code or manual code, rename them, select a default, refresh firmware details, and revoke access.
- Manage content sources, notifications, invitations, cached packages, and supported Remote Play pairing.

The project targets iOS 17 or newer. On macOS with Xcode installed, run from the repository's `frontend` directory:

```sh
sh ios/check.sh
xcodebuild -project ios/PS5LibraryCompanion.xcodeproj \
  -scheme PS5LibraryCompanion -configuration Debug \
  -sdk iphonesimulator -destination 'generic/platform=iOS Simulator' \
  CODE_SIGNING_ALLOWED=NO build
```

The `ios-ipa.yml` workflow also creates an unsigned device IPA. It must be signed with an appropriate Apple identity before installation.
