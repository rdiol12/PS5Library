# Artwork and visual reference

The user-supplied `storefront.png` reference is the canonical design. The actual SDL UI uses separate text, controls, controller focus, cover textures and hero textures; it does not display a flattened screenshot as the interface.

`scripts/preview.mjs` copies the local reference into ignored `data/reference`, creates explicit non-installable design fixtures and optionally fetches a clean hero from [the official God of War Ragnarök product page](https://www.playstation.com/en-us/games/god-of-war-ragnarok/). These preview-only commercial promotional assets are not distributed in the application bundle or production catalog.

## Original application icon

Generated through the built-in ImageGen tool using the `imagegen` skill, then resized through the normal Sharp asset build pipeline:

- `ps5/assets/store-icon-master.png`: original generated master.
- `ps5/assets/icon0.png`: 512×512 PS5 home-entry artwork.
- `clients/ios/PS5LibraryCompanion/Assets.xcassets/AppIcon.appiconset/AppIcon.png`: 1024×1024 iOS icon.

Prompt intent: “Create a premium square PS5Library application icon matching a midnight navy cinematic storefront. White generic controller, three restrained blue library spines/cards, subtle ice-blue illumination. Exact label PS5Library, PS5 in muted blue and Library in white. Full-bleed square with generous safe padding. No Sony/PlayStation logo, official controller button symbols, commercial game artwork, device mockup or watermark.” The result was visually inspected. The prompt did not request an official Sony identity.

## Performance evidence

The SDL software renderer, inside a headless Linux Docker container at 1920×1080, measured approximately 31.7 ms median / 34.5 ms p95 including `SDL_RenderPresent` over 120 preview frames, using about 14.6 MB of image textures. This is a software-renderer baseline, not a PS5 GPU frame-rate claim. Samples are capped at 6000 frames. PS5 frame timing, image decoding, focus/rail motion and memory limits still require physical-console profiling.
