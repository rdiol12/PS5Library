// Official description text from the PlayStation Store, asked for by the game's exact title ID
// or content ID so a different game can never be attached. Nothing is persisted; the caller
// keeps results in memory only.

const STORE = 'https://store.playstation.com';
const HEADERS = { 'user-agent': 'PS5Library-metadata/1 (self-hosted game library)' };
// English storefronts, most complete first. IDs are regional, so several are tried.
const STOREFRONTS = ['US/en', 'GB/en', 'AU/en', 'CA/en'];
const LOCALES = ['en-us', 'en-gb', 'en-au'];

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

const NOTICE =
  /^(to play this game on ps5|edition includes|note:|offline single player|online multiplayer|buy the |if you already own|free update|about the game$|if playing on ps4|ps4 game disc owners|this product entitles|you can download and play|©|\(c\)|copyright|software subject to license|online features require|one-time licen[cs]e fee|purchase or use of this item|remote play requires|in-game purchases optional|vibration function|1 player|\d+ ?- ?\d+ players|network players)/i;

// The store's text is HTML mixing the blurb with edition item lists, system notices and legal
// lines. Only prose paragraphs are kept, and reading stops at the legal footer.
export function storeText(html: string) {
  const paragraphs = decode(
    html
      .replace(/<\s*br\s*\/?>/gi, '\n')
      .replace(/<\/\s*(p|div|li|h\d)\s*>/gi, '\n')
      .replace(/<[^>]+>/g, ''),
  )
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const kept: string[] = [];
  for (const paragraph of paragraphs) {
    if (/^(©|\(c\)|copyright|software subject to license)/i.test(paragraph)) break;
    if (NOTICE.test(paragraph) || /^[■●•▪◆*\-–\[]/.test(paragraph)) continue;
    kept.push(paragraph);
  }
  // A lone short line is a tagline or leftover heading, not a description.
  const text = kept.join('\n\n').slice(0, 4000);
  return text.length >= 80 ? text : null;
}

async function byTitleId(titleId: string) {
  for (const storefront of STOREFRONTS) {
    const response = await fetch(
      `${STORE}/store/api/chihiro/00_09_000/titlecontainer/${storefront}/999/${titleId}_00`,
      { headers: HEADERS, redirect: 'error', signal: AbortSignal.timeout(10_000) },
    );
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = (await response.json()) as { long_desc?: unknown };
    const text = typeof body.long_desc === 'string' ? storeText(body.long_desc) : null;
    if (text) return text;
  }
  return null;
}

// Newer games are only on the product page, which embeds the same text as JSON.
export function productPageText(html: string) {
  const match = /"type":"LONG","value":"((?:[^"\\]|\\.)*)"/.exec(html);
  if (!match) return null;
  try {
    return storeText(JSON.parse(`"${match[1]}"`) as string);
  } catch {
    return null;
  }
}

async function byContentId(contentId: string) {
  for (const locale of LOCALES) {
    const response = await fetch(`${STORE}/${locale}/product/${contentId}`, {
      headers: HEADERS,
      redirect: 'follow',
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404) continue;
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const html = await response.text();
    if (html.length > 4 * 1024 ** 2) continue;
    const text = productPageText(html);
    if (text) return text;
  }
  return null;
}

export async function storeDescription(ids: { titleId?: string; contentId?: string }) {
  if (ids.titleId && /^[A-Z]{4}\d{5}$/.test(ids.titleId)) {
    const text = await byTitleId(ids.titleId).catch(() => null);
    if (text) return text;
  }
  if (ids.contentId && /^[A-Z]{2}\d{4}-[A-Z]{4}\d{5}_00-[A-Z0-9]{16}$/.test(ids.contentId))
    return byContentId(ids.contentId);
  return null;
}
