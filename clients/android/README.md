# PS5Library — Android companion

A native Jetpack Compose (Kotlin) companion for a self-hosted **PS5Library** server.
It mirrors the iOS SwiftUI app (`clients/ios/PS5LibraryCompanion`): connect to a server,
sign in / register, browse the game library, open a game, watch download /
preparation jobs with live progress, and inspect linked consoles.

## Build / open

1. **Android Studio** (Ladybug / Koala or newer, bundling AGP 8.7).
   Open the `android/` folder as a project (not the repository root).
2. Let Gradle sync. The project uses a Gradle **version catalog**
   (`gradle/libs.versions.toml`) and the Kotlin DSL.
3. Run the `app` configuration on a device or emulator (minSdk 26 / Android 8.0).

> **Gradle wrapper jar:** this project ships `gradlew`, `gradlew.bat` and
> `gradle/wrapper/gradle-wrapper.properties` (Gradle 8.10.2) but **not** the
> binary `gradle/wrapper/gradle-wrapper.jar`. Android Studio regenerates it on
> first sync. To build from the command line first run, from a machine that has
> Gradle 8.10.x installed:
> ```
> gradle wrapper --gradle-version 8.10.2
> ```
> then `./gradlew assembleDebug`.

## Requirements

- JDK 17 (Android Studio's bundled JDK is fine).
- Android SDK Platform 35 and Build-Tools (installed via the SDK Manager).

## Connecting

The sign-in screen takes **two** address rows:

- **LAN / IP address** — e.g. `192.168.1.20:13150` or `https://...`
- **Tailscale address (optional)** — e.g. `100.x.x.x:13150` or `https://name.ts.net`

Fill either or both. With both, the LAN address is the primary and the Tailscale
address is tried automatically when the LAN host is unreachable (handled by an
OkHttp interceptor, so REST calls, artwork and the live WebSocket all re-route).
Plain `http://` is only accepted for loopback / `.local` / private-LAN /
Tailscale (CGNAT) hosts; everything else must be `https://`. Addresses are
verified against `GET /api/v1/service-info` before authentication.

The signed-in token + server are stored with **EncryptedSharedPreferences**.

## Architecture

```
data/   ServerAddress, Models (kotlinx.serialization), ApiService (Retrofit),
        ApiClient (OkHttp + Coil + WebSocket), TokenStore (EncryptedSharedPreferences),
        Repository (validation, auth, refresh, job controls, live events)
ui/     theme/, components/ (ServerImage with auth headers, empty/loading/offline),
        SessionViewModel (auth + snapshot + polling + WebSocket),
        ConnectViewModel, LibraryViewModel,
        screens/ (Connect, Library, GameDetail, Downloads, Consoles, Settings)
MainActivity  single Activity hosting Compose + a NavHost + bottom navigation
```

Live job progress is driven by the WebSocket at `/api/v1/events/live`; if it is
unreachable the app falls back to polling `GET /api/v1/jobs` (and the rest of the
catalog) every ~3 seconds, backing off to 30 s while the socket is connected.

## Library versions

Pinned in `gradle/libs.versions.toml`. Key versions: AGP 8.7.3, Kotlin 2.0.21,
Compose BOM 2024.12.01 (Material 3), Coroutines 1.9.0, kotlinx.serialization
1.7.3, Retrofit 2.11.0, OkHttp 4.12.0, Coil 2.7.0, androidx.security-crypto
1.1.0-alpha06.
