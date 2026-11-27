import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import path from 'node:path';
// Local visual fixture only. The reference remains unchanged; native cards sample individual artwork regions.
// No commercial game binaries, download locations or compatibility assertions are supplied.
const root = path.resolve('data/reference');
await mkdir(root, { recursive: true });
const reference = process.argv[2] ?? 'C:/Users/rdiol/Desktop/storefront.png';
await copyFile(reference, path.join(root, 'storefront.png'));
const artwork =
  'https://gmedia.playstation.com/is/image/SIEPDC/god-of-war-raganok-clean-keyart-01-en-10mar22?wid=1920&fmt=jpeg&qlt=85';
try {
  await readFile(path.join(root, 'hero.jpg'));
} catch {
  const response = await fetch(artwork);
  if (!response.ok) throw Error('Official promotional artwork unavailable');
  await writeFile(path.join(root, 'hero.jpg'), Buffer.from(await response.arrayBuffer()));
}
const nativeRoot = '/workspace/data/reference';
const titles = [
  'Elden Ring',
  'Call of Duty: Black Ops 6',
  'Marvel’s Spider-Man 2',
  'Horizon Forbidden West',
  'Final Fantasy XVI',
  'The Last of Us Part I',
  'Gran Turismo 7',
  'Resident Evil 4',
  'Cyberpunk 2077',
  'Star Wars Jedi: Survivor',
  'Baldur’s Gate 3',
  'EA Sports FC 25',
  'Assassin’s Creed Mirage',
  'Silent Hill 2',
  'Dragon’s Dogma II',
  'Like a Dragon: Infinite Wealth',
];
const crops = [
  [50, 481, 162, 177],
  [226, 481, 176, 180],
  [418, 481, 184, 179],
  [619, 481, 187, 179],
  [821, 481, 188, 179],
  [1025, 481, 190, 179],
  [1233, 481, 195, 179],
  [1447, 481, 189, 179],
  [50, 721, 178, 164],
  [245, 721, 176, 164],
  [438, 721, 177, 164],
  [634, 721, 187, 164],
  [841, 721, 181, 164],
  [1039, 721, 181, 164],
  [1238, 721, 194, 164],
  [1454, 721, 182, 164],
];
const catalog = titles.map((title, i) => ({
  id: `preview-${i}`,
  title,
  description:
    'Preview artwork from the supplied design reference. Connect your own collection to see real release information.',
  genres: [i % 2 ? 'Adventure' : 'Action'],
  publisher: 'Design fixture',
  releaseDate: `2024-${String((i % 12) + 1).padStart(2, '0')}-01`,
  rail: i < 8 ? 'popular' : 'updated',
  popularity: 16 - i,
  coverUrl: nativeRoot + '/storefront.png',
  coverCrop: Object.fromEntries(['x', 'y', 'w', 'h'].map((k, n) => [k, crops[i][n]])),
  heroUrl: nativeRoot + '/hero.jpg',
  releases: [
    {
      id: `release-${i}`,
      version: '01.00',
      kind: 'BASE',
      region: 'Preview',
      languages: ['English'],
      size: 48700000000,
      sources: [],
      artifacts: [],
    },
  ],
  screenshotUrls: [],
}));
catalog.unshift({
  id: 'hero',
  title: 'God of War Ragnarök',
  description:
    'Embark on an epic and heartfelt journey as Kratos and Atreus face the fate of the Nine Realms.',
  genres: ['Action', 'Adventure', 'Single Player'],
  rail: 'hero',
  coverUrl: nativeRoot + '/hero.jpg',
  heroUrl: nativeRoot + '/hero.jpg',
  heroCrop: { x: 520, y: 235, w: 810, h: 380 },
  releaseDate: '2022-11-09',
  releases: [
    {
      id: 'release-hero',
      version: '01.00',
      kind: 'BASE',
      region: 'Preview',
      languages: ['English'],
      size: 48700000000,
      sources: [],
      artifacts: [],
    },
  ],
  screenshotUrls: [nativeRoot + '/hero.jpg'],
});
const console = {
  id: 'preview-console',
  name: 'Living Room PS5',
  presence: 'ONLINE',
  firmware: '9.60',
  runtime: 'Preview',
  games: 42,
  capabilities: { shadowMount: true, backportOverlay: true, nativeDownloads: true },
  storage: [
    {
      storageId: 'internal',
      displayName: 'Internal Storage',
      freeBytes: 238e9,
      totalBytes: 1e12,
      writable: true,
      installMethodsSupported: ['FPKG'],
    },
    {
      storageId: 'usb0',
      displayName: 'USB SSD',
      freeBytes: 684e9,
      totalBytes: 2e12,
      writable: true,
      installMethodsSupported: ['FPKG', 'SHADOWMOUNT'],
    },
  ],
};
const library = catalog.slice(1, 9).map((g) => ({
  releaseId: g.releases[0].id,
  state: 'READY_ON_PS5',
  storageId: 'usb0',
  registered: true,
}));
// Exercise the selection sheets locally; preview mode never submits their actions.
for (const game of catalog)
  for (const release of game.releases) {
    release.sources = [{ id: 'preview-source-' + release.id }];
    release.artifacts = [{ id: 'preview-artifact-' + release.id, method: 'FPKG' }];
  }
const jobs = [
  {
    id: 'preview-job',
    title: catalog[1].title,
    releaseId: catalog[1].releases[0].id,
    consoleId: console.id,
    storageId: 'usb0',
    kind: 'TRANSFER',
    state: 'TRANSFERRING',
    downloadedBytes: 35600000000,
    totalBytes: 48700000000,
    speedBytesPerSecond: 81700000,
    etaSeconds: 160,
  },
  {
    id: 'preview-build',
    title: catalog[2].title,
    releaseId: catalog[2].releases[0].id,
    kind: 'BUILD',
    state: 'BUILDING',
    progress: {
      package: { method: 'FPKG', state: 'BUILDING' },
      fakelib: { state: 'SEPARATED' },
      stage: 'Building package',
    },
  },
  {
    id: 'preview-error',
    title: catalog[3].title,
    releaseId: catalog[3].releases[0].id,
    kind: 'DOWNLOAD',
    state: 'ERROR',
    downloadedBytes: 1400000000,
    totalBytes: 6400000000,
    error: 'Source connection timed out',
  },
];
const profile = {
  username: 'Player',
  role: 'ADMIN',
  avatarUrl: nativeRoot + '/storefront.png',
  avatarCrop: catalog[4].coverCrop,
  consoles: [
    {
      ...console,
      games: catalog.slice(1, 9).map((g) => ({ gameId: g.id, available: true })),
      trophySummary: { earnedTrophies: { platinum: 4, gold: 38, silver: 126, bronze: 412 } },
    },
  ],
};
await writeFile(
  path.join(root, 'preview.json'),
  JSON.stringify(
    {
      catalog,
      consoles: [console],
      library,
      jobs,
      status: console,
      profile,
      device: { consoleId: console.id },
    },
    null,
    2,
  ),
);
await writeFile(
  path.join(root, 'config.json'),
  JSON.stringify(
    {
      serverUrl: 'http://127.0.0.1:3150',
      allowInsecureLan: true,
      name: 'Living Room PS5',
      font: '/workspace/ps5/assets/fonts/Inter-Regular.otf',
      storage: [],
    },
    null,
    2,
  ),
);
globalThis.console.log(
  'Local preview fixture ready in data/reference. All actions are disabled in --preview mode.',
);
