import { Anime } from '../types/anime';

/**
 * Whether an anime has started airing.
 *
 * Jikan's `status` ("Not yet aired" | "Currently Airing" | "Finished Airing") is
 * authoritative when present; `aired.from` is the fallback for records that omit it.
 *
 * Records with neither are treated as unaired. That is deliberate: a streaming lookup for
 * an unaired title can only come back empty, and WatchMode is metered, so the conservative
 * answer is the cheap one.
 */
export const hasAired = (anime: Pick<Anime, 'status' | 'aired'>): boolean => {
  if (anime.status) {
    return anime.status !== 'Not yet aired';
  }

  const from = anime.aired?.from;
  if (!from) {
    return false;
  }

  const airDate = new Date(from).getTime();
  return !Number.isNaN(airDate) && airDate <= Date.now();
};
