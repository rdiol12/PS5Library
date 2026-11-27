# Highlighted-cover trailers

## Standalone Bink 2 converter: verified 2026-09-16

`tools/video/` now contains PS5Library Video 0.1.0: a source-built Docker converter
with a PowerShell launcher, truthful timestamp progress, strict verification and
atomic publication. `dist/ps5library-video-0.1.0-source.zip` is the standalone
source distribution. It is separate from the public frontend repository.

The actual 499,127,628-byte Gears `KB2n` attract clip was converted using this
open-source build with audio: **72.6 seconds, 2,178 decoded output frames,
27,290,010 bytes**, output SHA-256
`a71394df81dd7a4fa4d149a4160957960b0d6f9f34d9e3d86d1f1d495f6b1e3e`.
The original input hash remained unchanged. FFprobe and a complete output decode
passed. This tool selects audio track 0 by default, with an explicit track option;
it does not infer how multiple language/surround tracks should be grouped.

The decoder combines pinned FFmpeg 7.1.2, sharpemu's public Bink 2 patch and
Librempeg's Bink Audio 2 implementation, retaining authorship and licenses. A
bounded metadata-header adjustment handles the observed KB2n text extension.
Full-range Bink output is converted into limited-range YUV420P for the MP4.
The source archive and image include the corresponding codec source/build
instructions. No RAD SDK/binary or supplied game media is redistributed.

**EXPERIMENTAL:** compatibility with other Bink revisions/files. **NOT IMPLEMENTED:**
automatic invocation by the server's dump watcher. The already imported live
trailer below remains the earlier RAD-converted reference; it was not replaced.

## Supplied dump video: verified 2026-09-16

Read-only inspection of the configured authorized dump root found 106 loose `.bik` files in Gears of War: Reloaded: 83 had Bink 2 `KB2n` headers and 23 had Bink 1 `BIKi` headers. No loose MP4/WebM/MOV videos were found in the inspected dumps. Space Marine has video-named `.pak` archives, whose contents were not extracted. This is not proof that other games contain no video.

`WarGame/Movies/AttractMode.bik` is a suitable inspected attract sequence: 499,127,628 bytes, 2,178 frames, 2560×1440 at 30 FPS, 72.6 seconds. Input SHA-256: `053f021f2513cde3d55bd66d11224f43a02224d7450c33a455f7b7239c7e7802`. The supplied converter rejected it as unsupported Bink 2; the `.bik` suffix alone did not identify the codec.

The official [RAD Video Tools](https://www.radgametools.com/bnkdown.htm) 2026.06 download was verified against its published SHA-1, `76e7b8e41c36edf9aba68ebc6d872871f5a1c5c5`. Its documented `BinkConv` command decoded this clip into private temporary frames and stereo audio; a frame was visually inspected and all 2,178 frames verified. The converter's completion window did not exit automatically, so only our own started converter process was stopped after complete output appeared. FFmpeg then encoded and fully decoded the resulting 720p MP4. No game executable was run. RAD binaries are kept in ignored local research storage and are not bundled with PS5Library or Docker.

The MP4 was placed outside the original dump, at `.ps5library/PPSA17525/01.008.001/trailer.mp4`, with an exact-identity metadata sidecar. The server imported and normalized it through the existing authenticated media pipeline. **READY:** 72.6 seconds, 19,081,928 bytes, SHA-256 `8935ce9ac20f76bf90dc7819cc3fed0e4b4d56b08d2a743268b7acb8c5252dd6`. Cache hash and catalog URL were verified. It includes supplied audio, and uses the existing five-second hover behavior.

The known-title media prepass now imports both music and trailers before expensive full-dump verification. A new-clip-during-stabilization regression passes. This does not mark the game package ready or rebuild it. General automatic Bink 2 conversion inside Docker is **not implemented**; this clip was converted locally with the official Windows tool. Ratings/credit clips and arbitrary story cutscenes are not automatically chosen by filename.

## VERIFIED on host

`server/src/artwork/trailers.ts` accepts an owner's MP4 at `PUT /api/v1/games/:id/trailer` or through the watched-folder media sidecar. Uploads stream to a temporary file with a 512 MiB limit, timeout, quota and disk checks. PostgreSQL records upload/preparation state; BullMQ reconciles queued work after restart.

FFmpeg runs in the configured Docker image with no network, a read-only container filesystem, dropped capabilities, bounded CPU/memory and a job-specific input/output mount. Output is at most 720p/30 FPS H.264 with optional stereo AAC audio, at most 180 seconds and under 128 MiB. ffprobe validates the result before hashing/publication. Failed clips expose an error rather than a fictitious ready state.

Authenticated `GET /api/v1/trailers/:gameId` supports Range requests. Shared-title readers can play clips; upload/delete remain owner-only. Raw source paths are not returned in catalog responses. Deleting an automatically imported clip is respected by the automatic-import ledger.

`ps5/frontend/video.cpp` downloads and decodes off the render thread, prebuffers bounded video/audio queues, uploads textures on the render thread and uses the shared SDL audio output. The local video cache is bounded to 256 MiB. Moving focus, opening another page/modal, changing server or losing application focus cancels playback. Five continuous seconds on one cover starts its trailer once; playback includes sound when the saved sound setting is enabled. The hero returns when playback ends.

The integration tests create a synthetic clip, run the actual transcoder, verify authenticated playback and check native five-second delay, audio output, focus cancellation and cache reuse. Native SDL host compilation and PS5 cross compilation include FFmpeg.

## EXPERIMENTAL / UNKNOWN

Video playback and frame time on the physical PS5 remain untested. The current PS5 SDL port does not supply a verified PS-button visibility/suspension event; that Home/background problem is still open. Generated CPU/render timings from the host do not establish PS5 performance.
