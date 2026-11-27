# PS5Library product context

## Product

PS5Library is a self-hosted game-library platform for jailbroken PS5 consoles. It gives people a polished, visual storefront for their own dumps, homebrew, private repositories, public releases, and other content they are authorized to use.

## Primary users and jobs

- Console owners browse, prepare, download, install, launch, update, move, and remove games without handling package filenames or mount paths.
- Server owners manage private content, accounts, consoles, preparation jobs, storage, and service health.
- Invited friends and family use separate accounts and see only their own consoles, jobs, saves, and explicitly shared catalog entries.

## Product shape

The product has three coordinated surfaces:

1. A controller-first native PS5 storefront.
2. A responsive web service for catalog access and server administration.
3. An iPhone companion that shares the same identity and state language.

The private Library Server stores and prepares authorized content. The optional Master Server distributes app updates and community features, never games or package links.

## Experience principles

- Lead with artwork, title, state, and the next useful action.
- Keep FPKG, ShadowMount, fakelib, hashes, and paths behind Advanced mode.
- Show only measured progress and verified compatibility.
- Treat the PS5 as authoritative for physical inventory and local capability state.
- Preserve focus, context, and progress across screens and restarts.
- Keep every account and console isolated by owner.

## Brand and visual direction

- Product name: PS5Library
- Subtitle: Games without limits
- Tone: direct, calm, premium, and independent from Sony branding.
- Canonical reference: `data/reference/storefront.png`.
- Visual world: dark cinematic artwork, generous space, white typography, restrained blue focus, large covers, and quiet motion.

## Constraints

- Design for 1920x1080 and scale to other 16:9 outputs within safe margins.
- Every PS5 flow works with a controller and keeps visible focus.
- Do not impersonate Sony, collect PSN credentials, or automate commercial warez sources.
- Do not claim runtime, backport, install, notification, or inventory capabilities until verified.
- Important screens use real API data after fixture development.
- Artwork and media load asynchronously and never block rendering.
- Offline mode remains useful with local agent data and cached artwork.

## Success

A normal user can find a game, choose a release, select a paired PS5 and storage destination, start preparation, follow real progress, and see the verified result in their console library without learning the underlying package pipeline.
