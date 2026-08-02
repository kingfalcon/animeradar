import { useState, useEffect, useCallback } from 'react';
import { Anime, Season } from '../types/anime';
import { animeApiService } from '../services/animeApi';
import { cacheService } from '../services/cacheService';

export const useAnimeData = (currentSeason: Season, currentYear: number) => {
  const [animeList, setAnimeList] = useState<Anime[]>([]);
  const [loading, setLoading] = useState(true);
  const [streamingLoading, setStreamingLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Cleanup expired cache entries on mount
  useEffect(() => {
    const cleanupCache = async () => {
      try {
        await cacheService.cleanup();
      } catch (error) {
        console.error('Cache cleanup failed:', error);
      }
    };
    
    cleanupCache();
  }, []);

  // Update streaming data for specific anime
  const updateAnimeStreaming = useCallback((malId: number, streamingPlatforms: any[]) => {
    setAnimeList(prevList => 
      prevList.map(anime => 
        anime.mal_id === malId 
          ? { ...anime, streaming: streamingPlatforms }
          : anime
      )
    );
  }, []);

  const fetchAnimeData = async () => {
    try {
      setLoading(true);
      setStreamingLoading(false);
      setError(null);
      
      // Phase 1: Fast load - Get basic anime data without streaming info
      console.log('Phase 1: Loading basic anime data...');
      const basicData = await animeApiService.getSeasonalAnimeBasic(currentYear, currentSeason);
      
      // Deduplication happens server-side in api/season.ts, which assembles the list.
      const sortedAnime = [...basicData].sort((a, b) => {
        const dateA = new Date(a.aired.from);
        const dateB = new Date(b.aired.from);
        return dateA.getTime() - dateB.getTime();
      });
      
      // Set anime list immediately for fast initial render
      setAnimeList(sortedAnime);
      setLoading(false);
      
      // Phase 2: Progressive enhancement - Load streaming data with immediate UI updates
      if (sortedAnime.length > 0) {
        console.log('Phase 2: Loading streaming data progressively...');
        setStreamingLoading(true);
        
        let completedCount = 0;
        const totalCount = sortedAnime.length;
        
        try {
          // Use the new progressive method that updates UI immediately as each result comes in
          await animeApiService.getStreamingDataProgressively(
            sortedAnime, 
            (malId, platforms) => {
              // This callback is called immediately when each anime's streaming data is ready
              updateAnimeStreaming(malId, platforms);
              completedCount++;
              
              // Log progress
              if (completedCount % 5 === 0 || completedCount === totalCount) {
                console.log(`Streaming data: ${completedCount}/${totalCount} complete`);
              }
            }
          );
          
          console.log('All streaming data loaded!');
        } catch (streamingError) {
          console.error('Error loading streaming data:', streamingError);
          // Don't set main error since we already have the anime list
        } finally {
          setStreamingLoading(false);
        }
      }
      
    } catch (err) {
      setError('Failed to fetch anime data. Please try again later.');
      console.error('Error fetching anime data:', err);
      setLoading(false);
      setStreamingLoading(false);
    }
  };

  const clearCache = useCallback(async () => {
    try {
      await cacheService.clear();
      console.log('✓ Cache cleared successfully');
    } catch (error) {
      console.error('❌ Failed to clear cache:', error);
    }
  }, []);

  const getCacheStats = useCallback(async () => {
    try {
      return await cacheService.getStats();
    } catch (error) {
      console.error('❌ Failed to get cache stats:', error);
      return { totalEntries: 0, expiredEntries: 0, totalSize: 0 };
    }
  }, []);

  useEffect(() => {
    fetchAnimeData();
  }, [currentSeason, currentYear]);

  return {
    animeList,
    loading,
    streamingLoading,
    error,
    refetch: fetchAnimeData,
    clearCache,
    getCacheStats
  };
}; 