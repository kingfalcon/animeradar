import axios from 'axios';
import { SeasonEndpointResponse, Season, Anime } from '../types/anime';
import { streamingService, StreamingPlatform } from './streamingService';
import { cacheService, CacheService } from './cacheService';

class AnimeApiService {
  private async makeRequest<T>(url: string): Promise<T> {
    try {
      const response = await axios.get<T>(url);
      return response.data;
    } catch (error) {
      console.error('API request failed:', error);
      throw error;
    }
  }

  // Fast loading - get anime without streaming data
  async getSeasonalAnimeBasic(year: number, season: Season): Promise<Anime[]> {
    // Check cache first. The key is versioned: v1 entries hold the truncated 25-title
    // lists from before pagination existed and must not be served.
    const cacheKey = CacheService.generateKey('anime-basic-v2', { season, year });
    const cachedData = await cacheService.get<Anime[]>(cacheKey);
    
    if (cachedData) {
      console.log(`📦 CACHE HIT: Found cached basic anime data for ${season} ${year}`);
      return cachedData;
    }

    console.log(`📦 CACHE MISS: Fetching basic anime data for ${season} ${year} from API...`);

    // Served by api/season.ts, which pages Jikan to completion and caches the result
    // globally. Calling Jikan directly from here only ever returned the first 25 titles.
    const url = `/api/season?year=${year}&season=${season}`;
    const response = await this.makeRequest<SeasonEndpointResponse>(url);

    const { total, excluded, offSeason, partial, stale } = response.meta;
    console.log(
      `✓ SEASON: ${response.data.length} titles of ${total}` +
        `${offSeason ? ` (${offSeason} off-season)` : ''}` +
        `${excluded ? ` (${excluded} adult excluded)` : ''}` +
        `${partial ? ' (partial)' : ''}${stale ? ' (stale cache)' : ''}`
    );

    // Return anime with empty streaming arrays for fast initial load
    const animeData = response.data.map(anime => ({
      ...anime,
      streaming: []
    }));

    // Cache the basic anime data
    await cacheService.set(cacheKey, animeData);
    console.log(`✓ CACHE: Stored basic anime data for ${season} ${year}`);

    return animeData;
  }

  // Progressive streaming data loading - no artificial rate limiting, streaming APIs handle their own
  async getStreamingDataProgressively(
    animeList: Anime[], 
    onBatchComplete: (malId: number, platforms: StreamingPlatform[]) => void
  ): Promise<void> {
    // Process all anime in parallel, but call onBatchComplete as each one finishes
    const streamingPromises = animeList.map(async (anime) => {
      try {
        const streamingResult = await streamingService.findStreamingPlatforms(anime);
        const platforms = streamingResult.platforms || [];
        onBatchComplete(anime.mal_id, platforms);
        return { malId: anime.mal_id, platforms };
      } catch (error) {
        console.error(`Failed to get streaming data for ${anime.title}:`, error);
        onBatchComplete(anime.mal_id, []);
        return { malId: anime.mal_id, platforms: [] };
      }
    });

    // Wait for all to complete
    await Promise.all(streamingPromises);
  }

  // Batch process streaming data for multiple anime (legacy method)
  async batchGetStreamingData(animeList: Anime[]): Promise<Map<number, StreamingPlatform[]>> {
    const streamingMap = new Map<number, StreamingPlatform[]>();
    
    // Process all in parallel - streaming APIs have their own rate limiting
    const batchResults = await Promise.all(
      animeList.map(async (anime) => {
        try {
          const streamingResult = await streamingService.findStreamingPlatforms(anime);
          return { malId: anime.mal_id, platforms: streamingResult.platforms || [] };
        } catch (error) {
          console.error(`Failed to get streaming data for ${anime.title}:`, error);
          return { malId: anime.mal_id, platforms: [] };
        }
      })
    );
    
    // Add results to map
    batchResults.forEach(result => {
      streamingMap.set(result.malId, result.platforms);
    });
    
    return streamingMap;
  }

  getCurrentSeasonInfo(): { season: Season; year: number } {
    const now = new Date();
    const year = now.getFullYear();
    const month = now.getMonth() + 1;
    
    let season: Season;
    if (month >= 1 && month <= 3) {
      season = 'winter';
    } else if (month >= 4 && month <= 6) {
      season = 'spring';
    } else if (month >= 7 && month <= 9) {
      season = 'summer';
    } else {
      season = 'fall';
    }
    
    return { season, year };
  }
}

export const animeApiService = new AnimeApiService(); 