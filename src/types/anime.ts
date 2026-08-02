export interface Anime {
  mal_id: number;
  title: string;
  title_english?: string;
  title_japanese?: string;
  title_synonyms?: string[];
  titles?: Array<{
    type: string;
    title: string;
  }>;
  images: {
    jpg: {
      image_url: string;
      small_image_url: string;
      large_image_url: string;
    };
  };
  aired: {
    from: string;
    to?: string;
  };
  // Jikan: "Not yet aired" | "Currently Airing" | "Finished Airing"
  status?: string;
  season: string;
  year: number;
  score?: number;
  synopsis?: string;
  genres: Array<{
    mal_id: number;
    name: string;
  }>;
  streaming?: Array<{
    name: string;
    url: string;
    confidence?: 'high' | 'medium' | 'low';
    source?: string;
  }>;
  broadcast?: {
    day: string;
    time: string;
  };
}

export interface SeasonResponse {
  pagination: {
    last_visible_page: number;
    has_next_page: boolean;
    current_page: number;
    items: {
      count: number;
      total: number;
      per_page: number;
    };
  };
  data: Anime[];
}

/** Response from api/season.ts - the full season, assembled and cached server-side. */
export interface SeasonEndpointResponse {
  data: Anime[];
  meta: {
    /** Upstream's season count, before adult titles are removed. */
    total: number;
    /** How many titles the server dropped as adult content. */
    excluded: number;
    /** How many titles belonged to a different season (MAL's "continuing" entries). */
    offSeason: number;
    pages: number;
    /** At least one Jikan page failed; the list is incomplete. */
    partial: boolean;
    /** Upstream was unreachable and this is the last known good copy. */
    stale: boolean;
    cached: boolean;
  };
}

export type Season = 'spring' | 'summer' | 'fall' | 'winter';

export interface SeasonInfo {
  season: Season;
  year: number;
  displayName: string;
} 