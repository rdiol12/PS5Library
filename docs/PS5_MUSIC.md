# Music from game dumps

## Console-local artwork and music - 2026-09-22

**IMPLEMENTED / CROSS-BUILD VERIFIED; HARDWARE PLAYBACK PENDING:** the native storefront resolves the selected console's exact `READY_ON_PS5` release to its local app metadata or dump folder. It loads `icon0.png` for covers, `pic1.png`/`pic0.png` for heroes and `snd0.at9` for music directly on the PS5. Image and ATRAC9 decoding stay on the existing background workers; the render thread never downloads or decodes them.

The console no longer base64-uploads discovered game artwork to the Library Node, and `/api/v1/device/library/artwork` no longer exists. Server artwork and normalized music remain fallbacks for catalog items not installed locally. Local paths are derived only from authenticated inventory/storage state, constrained beneath the reported root, reject symlinks and enforce size/dimension limits. Host storefront, PostgreSQL lifecycle, ATRAC9 codec and PS5 cross-build checks pass; direct sandbox reads still need physical-console confirmation.

## VERIFIED: implementation and PC tests

The preferred source is the game's own menu music, not a title search on a music website. The current local dumps include `sce_sys/snd0.at9`. FFprobe identified the supplied PRAGMATA and PPSA04452 files as ATRAC9, 48 kHz stereo (188.57 and 72 seconds respectively). Originals are read only.

The watcher recognizes `sce_sys/snd0` or `sndgame` with `.at9`, `.wav`, `.ogg`, `.mp3`, `.flac` or `.m4a`. An optional explicit override is `DUMP_ROOT/.ps5library/<TITLE_ID>/<EXACT_VERSION>/music.<extension>`. Its existing metadata sidecar rules still apply. A game without a supplied track stays silent.

For an existing catalog title, music imports before the expensive full dump scan. The current `param.json` must match the release's title/content IDs and exact version; a changed identity defers that music until source reinspection. This media-only check never marks a changed game package verified. The live server has verified cached tracks for PRAGMATA (180 s), Space Marine 2 (72.021 s) and Gears of War: Reloaded (103.168 s).

The existing persistent media queue now handles both trailers and music. Migration 017 preserves old trailer records and adds a media kind. Music input is limited to 32 MiB, normalized to stereo 48 kHz AAC in MP4, limited to 180 seconds and 8 MiB, hashed, then published. Source formats are explicitly selected; playlists and network protocols are not accepted. Uploads, download authorization, Range, quotas, interrupted uploads and restart recovery use the same existing media path.

`PUT /api/v1/games/:id/music` supports explicit owner uploads; `GET /api/v1/music/:gameId` serves prepared audio to accounts/devices with access to that game. Shared catalog music is shared with catalog readers. Private game audio remains private. `DELETE /api/v1/games/:id/music` requires the owner. Music does not overwrite a trailer.

## Native behavior in 0.2.5

- Hold a cover for 650 ms to start its music. There are no hard-coded title-to-track associations.
- File loading, verification and decoding happen on the existing media worker thread. The bounded disk cache is reused; only one preview runs at a time.
- Music loops at reduced volume with a short initial fade. Interface cues can mix into the music.
- Changing the highlighted title, opening an overlay, disconnecting or losing application focus stops playback.
- The five-second trailer countdown is unchanged. A trailer takes over the audio; music and trailer audio never run together.
- Settings has a separate **Game music** toggle.

PC checks cover automatic import, authenticated/unauthenticated/private/shared downloads, audio hashes, restart persistence, looping, navigation cancellation, trailer takeover and disk-cache reuse. Synthetic test audio is generated locally. No commercial recording is included in test fixtures or the app installer.

## UNKNOWN / limitations

- Audible HDMI output is verified on the physical 4.50 console. 0.2.5 tries the current foreground user when initial-user lookup fails, retains the previous output route if that open fails, and records nonzero PCM blocks/peak.
- Music solely inside an unextracted archive is not imported by the folder-media scan. It becomes accessible after extraction into a watched dump folder, or can be supplied through the exact-title/version override.
- Built-in menu loops can contain fades or silence; the importer does not invent or fetch a replacement recording.

## Source evidence

- [Nativehbl](https://github.com/Rufidj/Nativehbl/tree/e9488102399de9546d13dd496694c74142abe49f), `main.c::find_preview_music_path`, `update_preview_music`: local OGG menu music and looping playback. Our implementation reuses our existing FFmpeg path instead of adding SDL_mixer.
- [LibProsperoPKG](https://github.com/SvenGDK/LibProsperoPKG/tree/748eabf1b7d17819528cabf367d8e27109d8fce3), `ProsperoCntEnums.cs`: package entry `SND0_AT9` (`0x1240`). File identity/decodability above was checked against the user's actual local inputs.
- [SDL PS5 audio](https://github.com/ps5-payload-dev/SDL/blob/a47182a20e741e4735d1fcd41e8656bf338b0c72/src/audio/ps5/SDL_ps5audio.c): SYSTEM/MAIN output, blocking PCM output. Its current head was rechecked on 2026-09-16.
