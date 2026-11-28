// Live game details from playstationdb.com. Nothing here is persisted: results live only in this
// process's memory, are refetched after they expire, and are dropped when the feature is turned off.
// Pages are requested by exact title slug and must name the same game, so a similar title is never attached.

const ORIGIN = 'https://playstationdb.com';
const PAGE_TTL = 12 * 60 * 60_000;
const MISS_TTL = 24 * 60 * 60_000;
const ERROR_TTL = 30 * 60_000;
const REQUEST_GAP = 1500;
const MAX_PAGES = 2000;

export type ExternalGameInfo = {
  source: 'PlayStationDB';
  url: string;
  description: string | null;
  genre: string | null;
  releaseDate: string | null;
  metacritic: number | null;
  imageUrl: string | null;
  videos: string[];
};

let enabled = false;
const pages = new Map<string, { expires: number; value: ExternalGameInfo | null }>();
const queue: string[] = [];
let running = false;

export function setExternalMetadata(value: boolean) {
  enabled = value;
  if (!value) {
    pages.clear();
    queue.length = 0;
  }
}

export const slugFor = (title: string) =>
  title
    .replace(/[™®©]/g, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const EDITION =
  /\s*[:–-]?\s*\b(complete|enhanced|definitive|deluxe|standard|ultimate|gold|game of the year|goty)(\s+edition)?\s*$/i;
// Addresses to try for a title, most specific first: the site drops apostrophes for some games
// and lists special editions under the plain game name.
export function slugCandidates(title: string) {
  const plain = title.replace(EDITION, '');
  return [
    ...new Set(
      [title.replace(/['’]/g, ''), title, plain.replace(/['’]/g, ''), plain]
        .map(slugFor)
        .filter((slug) => slug.length >= 3),
    ),
  ];
}

const decode = (text: string) =>
  text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');

export function parseGamePage(html: string, slug: string): ExternalGameInfo | null {
  let name: string | undefined,
    imageUrl: string | null = null,
    releaseDate: string | null = null;
  for (const block of html.matchAll(
    /<script type="application\/ld\+json"[^>]*>(.*?)<\/script>/gs,
  )) {
    try {
      const data = JSON.parse(block[1]!);
      if (data?.['@type'] !== 'schema:VideoGame') continue;
      name = typeof data['schema:name'] === 'string' ? data['schema:name'] : undefined;
      const image = data['schema:thumbnailUrl'],
        date = data['schema:datePublished'];
      if (typeof image === 'string' && image.startsWith('https://imagedelivery.net/'))
        imageUrl = image;
      if (typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date)) releaseDate = date;
    } catch {
      // Ignore a malformed block; the page simply yields less.
    }
  }
  // The site is inconsistent about apostrophes in its addresses, so hyphens are not compared.
  if (!name || slugFor(name).replace(/-/g, '') !== slug.replace(/-/g, '')) return null;
  const lines = decode(
    html.replace(/<script.*?<\/script>|<style.*?<\/style>/gs, ' ').replace(/<[^>]+>/g, '\n'),
  )
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const after = (label: string) => {
    const index = lines.indexOf(label);
    return index >= 0 ? (lines[index + 1] ?? null) : null;
  };
  const start = lines.indexOf('Game Description'),
    paragraphs: string[] = [];
  if (start >= 0)
    for (const line of lines.slice(start + 1)) {
      if (/^(Videos|Buy Online|Terms|Privacy|More .+ games|View all .+ games)$/.test(line)) break;
      paragraphs.push(line);
    }
  const description = paragraphs.join('\n\n').slice(0, 4000) || null,
    genre = after('Genre'),
    score = Number(after('Metacritic Score'));
  return {
    source: 'PlayStationDB',
    url: `${ORIGIN}/games/${slug}/`,
    description,
    genre: genre && genre.length <= 40 ? genre : null,
    releaseDate,
    metacritic: Number.isInteger(score) && score > 0 && score <= 100 ? score : null,
    imageUrl,
    videos: [
      ...new Set(
        [...html.matchAll(/i\.ytimg\.com\/vi\/([A-Za-z0-9_-]{11})\//g)].map((match) => match[1]!),
      ),
    ].slice(0, 8),
  };
}

async function get(path: string) {
  const response = await fetch(ORIGIN + path, {
    headers: { 'user-agent': 'PS5Library-metadata/1 (self-hosted game library)' },
    redirect: 'follow',
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const text = await response.text();
  if (text.length > 4 * 1024 ** 2) throw new Error('RESPONSE_TOO_LARGE');
  return text;
}

function remember(slug: string, value: ExternalGameInfo | null, ttl: number) {
  if (pages.size >= MAX_PAGES) pages.delete(pages.keys().next().value!);
  pages.set(slug, { expires: Date.now() + ttl, value });
}

const absent = (error: unknown) =>
  error instanceof Error && (error.message === 'HTTP 404' || error.message === 'HTTP 500');

// Fetches the first address that holds this title and remembers the outcome under its key.
async function lookup(title: string): Promise<ExternalGameInfo | null> {
  const key = slugFor(title);
  let value: ExternalGameInfo | null = null,
    ttl = MISS_TTL;
  for (const slug of slugCandidates(title)) {
    try {
      value = parseGamePage(await get(`/games/${slug}/`), slug);
      if (value) {
        ttl = PAGE_TTL;
        break;
      }
    } catch (error) {
      // The site answers 500 for a game it does not list; anything else is retried sooner.
      if (!absent(error)) {
        value = pages.get(key)?.value ?? null;
        ttl = ERROR_TTL;
        break;
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  remember(key, value, ttl);
  return value;
}

async function drain() {
  if (running) return;
  running = true;
  try {
    while (enabled && queue.length) {
      await lookup(queue.shift()!);
      await new Promise((resolve) => setTimeout(resolve, REQUEST_GAP));
    }
  } finally {
    running = false;
  }
}

const immediate = new Map<string, Promise<ExternalGameInfo | null>>();
// For a single game a person is looking at right now: skips the background queue. Concurrent
// callers share one request.
export async function externalInfoNow(title: string): Promise<ExternalGameInfo | null> {
  if (!enabled) return null;
  const key = slugFor(title);
  if (!key) return null;
  const known = pages.get(key);
  if (known && known.expires > Date.now()) return known.value;
  let pending = immediate.get(key);
  if (!pending) {
    const queued = queue.findIndex((item) => slugFor(item) === key);
    if (queued >= 0) queue.splice(queued, 1);
    pending = lookup(title).finally(() => immediate.delete(key));
    immediate.set(key, pending);
  }
  return pending;
}

// Synchronous: returns what is already known and schedules a background lookup otherwise, so a
// catalog request never waits on the remote site.
export function externalInfo(title: string): ExternalGameInfo | null {
  if (!enabled) return null;
  const key = slugFor(title);
  if (!key) return null;
  const known = pages.get(key);
  if (
    (!known || known.expires <= Date.now()) &&
    !queue.some((item) => slugFor(item) === key) &&
    queue.length < 500
  ) {
    queue.push(title);
    void drain();
  }
  return known?.value ?? null;
}

// The game's picture, passed straight through to the caller; nothing is written to disk.
export async function externalImage(title: string) {
  const url = (await externalInfoNow(title))?.imageUrl;
  if (!url) return null;
  try {
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    const type = response.headers.get('content-type')?.split(';')[0] ?? '';
    if (!response.ok || !/^image\/(jpeg|png|webp|avif)$/.test(type)) return null;
    const body = Buffer.from(await response.arrayBuffer());
    return body.length && body.length <= 8 * 1024 ** 2 ? { type, body } : null;
  } catch {
    return null;
  }
}
