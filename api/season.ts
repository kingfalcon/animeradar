// Explicit .js extension: these run as Node ESM, which does not resolve extensionless
// relative imports. The extension refers to the compiled output, not this source file.
import { withCache } from '../lib/cache.js';

// Tenrai rather than Jikan. Jikan scrapes MyAnimeList and is rate-limited by it, so any
// request it hasn't cached fails - which is precisely our paginated back-page requests.
// Tenrai's v1 schema is Jikan-v4-compatible, so this is a base-URL swap. It also dedupes
// server-side: Fall 2026 is 83 unique titles here versus Jikan's 92 with duplicates.
const API_BASE_URL = 'https://api.tenrai.org/v1';
const SEASONS = ['winter', 'spring', 'summer', 'fall'];
const FRESH_FOR_SECONDS = 6 * 60 * 60;

/**
 * Bump this whenever the cached payload's shape or its filtering rules change.
 *
 * Cached entries stay fresh for hours and hard-live for a week, so without a version in the
 * key a deploy keeps serving payloads built by the old code - after the off-season filter
 * shipped, production went on returning unfiltered seasons from cache. Changing the key
 * retires the old entries instead of waiting them out or flushing Redis by hand.
 *
 * v2: added the off-season filter and meta.offSeason; stopped excluding Erotica.
 */
const CACHE_VERSION = 'v2';

/**
 * Incomplete seasons are held briefly rather than for the full window. Caching a partial
 * list at full freshness would pin a truncated season in place for hours after the upstream
 * recovered - reintroducing exactly the bug this endpoint exists to fix.
 */
const PARTIAL_FRESH_FOR_SECONDS = 10 * 60;

/** last_visible_page is upstream-reported; this bounds the damage if it is ever wrong. */
const MAX_PAGES = 10;

interface ProxyRequest {
  query: Record<string, string | string[] | undefined>;
}

interface ProxyResponse {
  status(code: number): ProxyResponse;
  json(body: unknown): ProxyResponse;
  setHeader(name: string, value: string): void;
}

interface ApiGenre {
  mal_id: number;
  name: string;
}

interface ApiAnime {
  mal_id: number;
  title?: string;
  rating?: string | null;
  season?: string | null;
  year?: number | null;
  genres?: ApiGenre[];
  explicit_genres?: ApiGenre[];
  themes?: ApiGenre[];
  [key: string]: unknown;
}

/**
 * MAL's season pages include "continuing" entries - shows that began in an earlier season
 * and are still airing - and each record carries the season it actually belongs to. Left in,
 * a Fall listing shows titles that premiered on 4 July while Summer holds shows airing
 * later, which reads as plain wrong.
 *
 * Records with no season assigned are kept. That's usually an announced show MAL hasn't
 * slotted yet, and incomplete metadata shouldn't hide it.
 */
function belongsToSeason(anime: ApiAnime, season: string, year: string): boolean {
  if (!anime.season || anime.year == null) {
    return true;
  }
  return anime.season === season && String(anime.year) === year;
}

/**
 * MAL classifies adult work three ways and doesn't always populate all of them, so all
 * three are checked:
 *  - rating "Rx - Hentai" (R and R+ are mainstream violence/nudity, not this)
 *  - the explicit_genres array, which exists specifically to separate this out
 *  - a Hentai genre/theme, for records that put it in the ordinary list
 *
 * Neither Ecchi nor Erotica is excluded. Both are suggestive rather than pornographic and
 * both sit on mainstream shows - Ranma 1/2 carries Ecchi, and Erotica alone was removing
 * every excluded title in Fall 2026, none of which was rated Rx.
 */
const ADULT_GENRE_NAMES = new Set(['hentai']);

function isAdult(anime: ApiAnime): boolean {
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

interface ApiPage {
  data: ApiAnime[];
  pagination?: {
    last_visible_page?: number;
    items?: { total?: number };
  };
}

interface SeasonPayload {
  anime: ApiAnime[];
  /** Upstream's count for the season, before adult titles are removed. */
  total: number;
  pages: number;
  /** True when at least one page failed and the list is incomplete. */
  partial: boolean;
  /** How many titles were dropped as adult content. */
  excluded: number;
  /** How many titles belonged to a different season (MAL's "continuing" entries). */
  offSeason: number;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Upstream limits aren't published; this stays deliberately gentle. */
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
): Promise<ApiPage> {
  // The bare-URL special case this used to carry was a workaround for Jikan's cache
  // behaviour and no longer applies - Tenrai serves ?page=1 the same as any other page.
  const response = await fetch(`${API_BASE_URL}/seasons/${year}/${season}?page=${page}`);

  // 429 is our own pacing; 5xx is an upstream problem. Both are worth a backed-off retry.
  const transient = response.status === 429 || response.status >= 500;
  if (transient && attempt < MAX_ATTEMPTS) {
    console.warn(`SEASON: page ${page} got ${response.status}, retry ${attempt}`);
    await sleep(RETRY_BASE_DELAY_MS * attempt);
    return fetchPage(year, season, page, attempt + 1);
  }

  if (!response.ok) {
    throw new Error(`Upstream responded ${response.status} for page ${page}`);
  }

  return (await response.json()) as ApiPage;
}

/**
 * Seasons are paginated at 25 per page, and a season runs to ~150 titles.
 *
 * Pages are fetched sequentially with a delay. Fetching them in parallel is faster but
 * tripped rate limiting when measured against Jikan - a 6-page season came back with 44 of
 * 149 titles and a 429. Tenrai's limits aren't published, so the same pacing is kept. Since
 * the result is cached for hours, a few seconds here is a good trade for completeness.
 */
async function fetchSeason(year: string, season: string): Promise<SeasonPayload> {
  const first = await fetchPage(year, season, 1);

  const total = first.pagination?.items?.total ?? first.data.length;
  const lastPage = Math.min(first.pagination?.last_visible_page ?? 1, MAX_PAGES);

  const anime: ApiAnime[] = [...first.data];
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

  const inSeason = deduped.filter((a) => belongsToSeason(a, season, year));
  const offSeason = deduped.length - inSeason.length;

  const safe = inSeason.filter((a) => !isAdult(a));
  const excluded = inSeason.length - safe.length;

  if (offSeason > 0 || excluded > 0) {
    console.log(
      `SEASON: ${year} ${season} dropped ${offSeason} off-season, ${excluded} adult title(s)`
    );
  }

  return { anime: safe, total, pages: lastPage, partial, excluded, offSeason };
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
      key: `season:${CACHE_VERSION}:${year}:${season}`,
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
        offSeason: result.data.offSeason,
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
