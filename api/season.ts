// Explicit .js extension: these run as Node ESM, which does not resolve extensionless
// relative imports. The extension refers to the compiled output, not this source file.
import { withCache } from '../lib/cache.js';

const JIKAN_BASE_URL = 'https://api.jikan.moe/v4';
const SEASONS = ['winter', 'spring', 'summer', 'fall'];
const FRESH_FOR_SECONDS = 6 * 60 * 60;

/**
 * Incomplete seasons are held briefly rather than for the full window. Caching a partial
 * list at full freshness would pin a truncated season in place for hours after the upstream
 * recovered - reintroducing exactly the bug this endpoint exists to fix.
 */
const PARTIAL_FRESH_FOR_SECONDS = 10 * 60;

/** Jikan reports last_visible_page; this bounds the damage if that value is ever wrong. */
const MAX_PAGES = 10;

interface ProxyRequest {
  query: Record<string, string | string[] | undefined>;
}

interface ProxyResponse {
  status(code: number): ProxyResponse;
  json(body: unknown): ProxyResponse;
  setHeader(name: string, value: string): void;
}

interface JikanGenre {
  mal_id: number;
  name: string;
}

interface JikanAnime {
  mal_id: number;
  title?: string;
  rating?: string | null;
  genres?: JikanGenre[];
  explicit_genres?: JikanGenre[];
  themes?: JikanGenre[];
  [key: string]: unknown;
}

/**
 * MAL classifies adult work three ways and doesn't always populate all of them, so all
 * three are checked:
 *  - rating "Rx - Hentai" (R and R+ are mainstream violence/nudity, not this)
 *  - the explicit_genres array, which exists specifically to separate this out
 *  - a Hentai or Erotica genre/theme, for records that put it in the ordinary list
 *
 * Ecchi is deliberately not excluded. It's fanservice, not pornography, and it's attached
 * to plenty of mainstream shows - Ranma 1/2 in the current season carries it.
 */
const ADULT_GENRE_NAMES = new Set(['hentai', 'erotica']);

function isAdult(anime: JikanAnime): boolean {
  if (anime.rating?.startsWith('Rx')) {
    return true;
  }

  if (anime.explicit_genres && anime.explicit_genres.length > 0) {
    return true;
  }

  return [...(anime.genres ?? []), ...(anime.themes ?? [])].some((genre) =>
    ADULT_GENRE_NAMES.has(genre.name.toLowerCase())
  );
}

interface JikanPage {
  data: JikanAnime[];
  pagination?: {
    last_visible_page?: number;
    items?: { total?: number };
  };
}

interface SeasonPayload {
  anime: JikanAnime[];
  /** Upstream's count for the season, before adult titles are removed. */
  total: number;
  pages: number;
  /** True when at least one page failed and the list is incomplete. */
  partial: boolean;
  /** How many titles were dropped as adult content. */
  excluded: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Jikan allows roughly 3 requests/second; this stays comfortably under it. */
const PAGE_DELAY_MS = 400;
const RETRY_BASE_DELAY_MS = 1200;
const MAX_ATTEMPTS = 3;

/** Wall-clock budget for pages 2..N, leaving headroom under the function execution limit. */
const PAGE_BUDGET_MS = 8000;

async function fetchPage(
  year: string,
  season: string,
  page: number,
  attempt = 1
): Promise<JikanPage> {
  // Page 1 is requested without the page parameter even though ?page=1 is equivalent.
  // Jikan caches the unparameterized URL; any ?page= request goes to MyAnimeList live and
  // fails whenever MAL is unavailable. Measured during one such window: the bare URL
  // returned 200 three times out of three while ?page=1 returned 504 three times out of
  // three. Using the bare form means a degraded season still returns its first 25 titles
  // instead of nothing.
  const url =
    page === 1
      ? `${JIKAN_BASE_URL}/seasons/${year}/${season}`
      : `${JIKAN_BASE_URL}/seasons/${year}/${season}?page=${page}`;

  const response = await fetch(url);

  // 429 is our own pacing; 5xx is usually Jikan failing to reach MyAnimeList, which it does
  // often enough to matter. Both are worth a backed-off retry.
  const transient = response.status === 429 || response.status >= 500;
  if (transient && attempt < MAX_ATTEMPTS) {
    console.warn(`SEASON: page ${page} got ${response.status}, retry ${attempt}`);
    await sleep(RETRY_BASE_DELAY_MS * attempt);
    return fetchPage(year, season, page, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`Jikan responded ${response.status} for page ${page}`);
  }

  return (await response.json()) as JikanPage;
}

/**
 * Jikan paginates seasons at 25 per page, and a season runs to ~150 titles.
 *
 * Pages are fetched sequentially with a delay. Fetching them in parallel is faster but
 * trips Jikan's rate limit - measured against the live API, a 6-page season came back with
 * 44 of 149 titles and a 429. Since the result is cached for hours, a few seconds here is
 * a good trade for completeness.
 */
async function fetchSeason(year: string, season: string): Promise<SeasonPayload> {
  const first = await fetchPage(year, season, 1);

  const total = first.pagination?.items?.total ?? first.data.length;
  const lastPage = Math.min(first.pagination?.last_visible_page ?? 1, MAX_PAGES);

  const anime: JikanAnime[] = [...first.data];
  let partial = false;
  const startedAt = Date.now();

  for (let page = 2; page <= lastPage; page++) {
    // Throttling plus retries can add up. Return what we have rather than let the function
    // hit its execution limit and produce nothing at all.
    if (Date.now() - startedAt > PAGE_BUDGET_MS) {
      console.warn(`SEASON: time budget reached after page ${page - 1} of ${lastPage}`);
      partial = true;
      break;
    }

    await sleep(PAGE_DELAY_MS);
    try {
      const next = await fetchPage(year, season, page);
      anime.push(...next.data);
    } catch (error) {
      // One bad page shouldn't sink the whole season - an incomplete list still beats none.
      console.error(`SEASON: page ${page} failed:`, error);
      partial = true;
    }
  }

  const deduped = Array.from(new Map(anime.map((a) => [a.mal_id, a])).values());
  const safe = deduped.filter((a) => !isAdult(a));
  const excluded = deduped.length - safe.length;

  if (excluded > 0) {
    console.log(`SEASON: excluded ${excluded} adult title(s) from ${year} ${season}`);
  }

  return { anime: safe, total, pages: lastPage, partial, excluded };
}

/**
 * Full seasonal listing, assembled server-side and cached globally.
 *
 * The client previously called Jikan directly and read only page 1, which silently capped
 * every season at 25 titles.
 */
export default async function handler(req: ProxyRequest, res: ProxyResponse) {
  const { year, season } = req.query;

  if (typeof year !== 'string' || !/^\d{4}$/.test(year)) {
    return res.status(400).json({ error: 'year must be a 4-digit year' });
  }

  const yearNumber = Number(year);
  if (yearNumber < 1917 || yearNumber > new Date().getFullYear() + 5) {
    return res.status(400).json({ error: 'year out of range' });
  }

  if (typeof season !== 'string' || !SEASONS.includes(season)) {
    return res.status(400).json({ error: `season must be one of ${SEASONS.join(', ')}` });
  }

  try {
    const result = await withCache<SeasonPayload>({
      key: `season:${year}:${season}`,
      freshFor: (payload) =>
        payload.partial ? PARTIAL_FRESH_FOR_SECONDS : FRESH_FOR_SECONDS,
      fetch: () => fetchSeason(year, season)
    });

    // Short CDN tier in front of the shared cache: absorbs bursts without holding data long
    // enough to matter, since Redis is the authoritative layer.
    res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=86400');

    return res.status(200).json({
      data: result.data.anime,
      meta: {
        total: result.data.total,
        excluded: result.data.excluded,
        pages: result.data.pages,
        partial: result.data.partial,
        stale: result.stale,
        cached: result.hit
      }
    });
  } catch (error) {
    console.error('SEASON: request failed:', error);
    return res.status(502).json({ error: 'upstream request failed' });
  }
}
