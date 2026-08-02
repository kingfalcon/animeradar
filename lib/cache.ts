import { Redis } from '@upstash/redis';

/**
 * Shared server-side cache.
 *
 * The browser cache in src/services/cacheService.ts is per visitor, so it does nothing for
 * upstream API quota - every new visitor starts cold. This one is global: the first request
 * for a key pays, everyone after is free.
 *
 * Entries are held far longer than their freshness window so a stale copy is available when
 * an upstream is down. Jikan returns MyAnimeList 504s regularly, and serving yesterday's
 * season list beats serving an error.
 */

const HARD_TTL_SECONDS = 7 * 24 * 60 * 60;

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

export interface CacheResult<T> {
  data: T;
  /** True when the upstream failed and this is a fallback to the last known good value. */
  stale: boolean;
  /** True when no upstream call was made. */
  hit: boolean;
}

let client: Redis | null | undefined;

/**
 * Returns null when the store isn't configured. A missing cache degrades to "uncached",
 * never to an error - previews without the integration should still work.
 */
function getClient(): Redis | null {
  if (client !== undefined) {
    return client;
  }

  // Vercel's Redis integrations inject different names depending on which one is installed
  // (Upstash Marketplace vs the older KV integration), so accept either rather than making
  // the deployment depend on getting the variable name right.
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

  if (!url || !token) {
    console.warn(
      'CACHE: no Redis credentials found (checked UPSTASH_REDIS_REST_URL and KV_REST_API_URL), running uncached'
    );
    client = null;
  } else {
    client = new Redis({ url, token });
  }

  return client;
}

async function read<T>(key: string): Promise<CacheEntry<T> | null> {
  const redis = getClient();
  if (!redis) return null;

  try {
    return (await redis.get<CacheEntry<T>>(key)) ?? null;
  } catch (error) {
    // A broken cache must never break the request.
    console.error(`CACHE: read failed for "${key}":`, error);
    return null;
  }
}

async function write<T>(key: string, data: T): Promise<void> {
  const redis = getClient();
  if (!redis) return;

  try {
    const entry: CacheEntry<T> = { data, fetchedAt: Date.now() };
    await redis.set(key, entry, { ex: HARD_TTL_SECONDS });
  } catch (error) {
    console.error(`CACHE: write failed for "${key}":`, error);
  }
}

/**
 * Serve `key` from cache when fresh, otherwise refetch. If the refetch throws and a stale
 * entry exists, the stale value is returned instead of propagating the error.
 *
 * `freshFor` may depend on the value - WatchMode holds empty results for less time than
 * populated ones, so a title that becomes available shows up promptly.
 */
export async function withCache<T>(options: {
  key: string;
  freshFor: number | ((data: T) => number);
  fetch: () => Promise<T>;
}): Promise<CacheResult<T>> {
  const { key, freshFor, fetch } = options;
  const freshSecondsFor = (data: T) => (typeof freshFor === 'function' ? freshFor(data) : freshFor);

  const cached = await read<T>(key);

  if (cached) {
    const ageSeconds = (Date.now() - cached.fetchedAt) / 1000;
    if (ageSeconds < freshSecondsFor(cached.data)) {
      return { data: cached.data, stale: false, hit: true };
    }
  }

  try {
    const data = await fetch();
    await write(key, data);
    return { data, stale: false, hit: false };
  } catch (error) {
    if (cached) {
      console.error(`CACHE: upstream failed for "${key}", serving stale copy:`, error);
      return { data: cached.data, stale: true, hit: true };
    }
    throw error;
  }
}
