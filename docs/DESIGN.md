# PS5Library design system

## Shared visual language

PS5Library uses one cinematic visual system across PS5, web, and iPhone. Artwork provides atmosphere; dark surfaces and controlled fades keep text readable. Blue marks focus, progress, and connected state. Warm colors are reserved for warnings and failures.

The supplied `data/reference/storefront.png` is the visual authority for the PS5 storefront.

## Hierarchy

1. Current title or page goal
2. Primary action or live state
3. Visual collection and progress
4. Supporting metadata
5. Technical controls, only where the user needs them

Avoid decorative labels, repeated headings, nested panels, and borders that do not explain grouping.

## Tokens

- Canvas: near-black blue (`#070b11`)
- Raised surface: navy (`#101a28`)
- Primary text: cool white (`#f4f7fb`)
- Secondary text: blue-gray (`#b9c5d5`)
- Accent/focus: ice blue (`#8fc7ff`)
- Success: mint (`#73d7ae`)
- Warning: amber (`#ffbc5c`)
- Danger: coral (`#ff8178`)
- Corner radius: 12–16 px on web; scaled equivalent on console
- Motion: 140–220 ms for focus and surface transitions; longer only for background crossfades
- Master Control typography: locally bundled Space Grotesk for brand and headings; system UI sans-serif for body copy and controls; monospace for identifiers and audit details.

## PS5 storefront

- Keep the top navigation, large hero, and two artwork rails visible together at 1080p.
- Use large cover art as the card surface. Show title/status outside it only when needed.
- Focus uses a thin luminous blue outline, a small scale lift, and no bounce.
- Full game details use full-bleed hero art, a strong left fade, one obvious action, release choices, screenshots, and save state.
- Downloads foreground the title, exact byte progress, speed, ETA, destination, and current pipeline stage.
- Profile leads with the account identity and currently selected console, followed by games, trophies, friends, and saves.
- Empty, loading, offline, unavailable, and error states retain the same composition and controller hints.

## Web service

- Use a horizontal product header on wide screens and a compact scrollable navigation bar on small screens.
- Discover is artwork-led and uses live catalog data for its hero.
- Catalog cards remain visual and expose metadata on hover/focus without becoming dense tiles.
- Management pages use clean sections, readable status rows, and compact controls. Logs may be dense and monospace.
- Dialogs use a cinematic two-column game view on wide screens and a single column on phones.
- Every control has a visible keyboard focus state, useful label, disabled treatment, and touch target of at least 44 px.

## Responsive behavior

- PS5 uses a 1920x1080 logical canvas and safe-area scaling.
- Web content maxes out at a readable wide-screen measure, then collapses to one column where necessary.
- Navigation remains reachable without hiding primary actions.
- Cards never shrink below a useful cover size; grids reduce columns instead.

## Motion and performance

- Respect reduced-motion preferences on web.
- Load thumbnails lazily and preload only adjacent hero media.
- Crossfade backgrounds without delaying input.
- Prefer CSS/native rendering and existing caches over new animation dependencies.
