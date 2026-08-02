
import { Star, Play } from 'lucide-react';
import { Anime } from '../../types/anime';
import { formatDate } from '../../utils/formatters';
import { hasAired } from '../../utils/airingStatus';
import { STREAMING_PLATFORM_COLORS, DEFAULT_PLATFORM_COLOR } from '../../constants/streaming';

interface AnimeCardProps {
  anime: Anime;
  streamingLoading?: boolean;
}

const AnimeCard = ({ anime, streamingLoading = false }: AnimeCardProps) => {
  const getStreamingPlatformColor = (platform: string) => {
    return STREAMING_PLATFORM_COLORS[platform.toLowerCase()] || DEFAULT_PLATFORM_COLOR;
  };

  const renderStreamingSection = () => {
    if (anime.streaming && anime.streaming.length > 0) {
      // Show real streaming platforms only
      return (
        <div className="mt-3">
          <div className="flex items-center gap-2 mb-2">
            <Play className="w-4 h-4 text-anime-primary" />
            <span className="text-sm font-medium">Streaming on:</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {anime.streaming.map((platform, index) => (
              <a
                key={index}
                href={platform.url}
                target="_blank"
                rel="noopener noreferrer"
                className={`px-2 py-1 rounded-full text-white text-xs font-medium ${getStreamingPlatformColor(platform.name)} hover:opacity-80 transition-opacity cursor-pointer`}
              >
                {platform.name}
              </a>
            ))}
          </div>
        </div>
      );
    }

    // Nothing is streaming a show that hasn't aired, and we deliberately skip the lookup,
    // so say so rather than showing a skeleton that resolves to blank.
    if (!hasAired(anime)) {
      return (
        <div className="mt-3">
          <div className="flex items-center gap-2">
            <Play className="w-4 h-4 text-gray-400" />
            <span className="text-sm font-medium text-gray-400">Not yet airing</span>
          </div>
        </div>
      );
    }

    // Show loading state while streaming data is being fetched
    if (streamingLoading) {
      return (
        <div className="mt-3">
          <div className="flex items-center gap-2 mb-2">
            <Play className="w-4 h-4 text-gray-400" />
            <span className="text-sm font-medium text-gray-400">Checking streaming platforms...</span>
          </div>
          <div className="flex gap-2">
            {/* Loading skeleton for streaming platforms */}
            <div className="h-6 w-16 bg-gray-200 rounded-full animate-pulse"></div>
            <div className="h-6 w-20 bg-gray-200 rounded-full animate-pulse"></div>
            <div className="h-6 w-18 bg-gray-200 rounded-full animate-pulse"></div>
          </div>
        </div>
      );
    }

    // Don't show anything if no streaming data is available and not loading
    // This is better than showing misleading "no platforms found" message
    return null;
  };

  const malUrl = `https://myanimelist.net/anime/${anime.mal_id}`;

  return (
    <div className="anime-card flex flex-col h-full">
      <div className="relative">
        <a href={malUrl} target="_blank" rel="noopener noreferrer" className="block">
          <img
            src={anime.images.jpg.large_image_url}
            alt={anime.title}
            className="w-full h-64 object-cover hover:opacity-90 transition-opacity cursor-pointer"
            loading="lazy"
          />
        </a>
        {anime.score && (
          <a
            href={malUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="absolute top-2 right-2 bg-yellow-400 text-black px-2 py-1 rounded-full text-sm font-bold flex items-center gap-1 hover:bg-yellow-300 transition-colors cursor-pointer"
            title="View on MyAnimeList"
          >
            <Star className="w-3 h-3" />
            {anime.score.toFixed(2)}
          </a>
        )}
      </div>
      
      <div className="p-4 flex-1 flex flex-col relative pb-12">
        <h3 className="font-bold text-lg mb-2 line-clamp-2">
          {anime.title_english || anime.title}
        </h3>
        
        <div className="flex items-center gap-2 mb-3 text-sm text-gray-600">
          <span className="text-base" title="Japanese broadcast date">🇯🇵</span>
          <span>{formatDate(anime.aired.from)}</span>
        </div>

        {anime.genres && anime.genres.length > 0 && (
          <div className="flex flex-wrap gap-1 mb-3">
            {anime.genres.slice(0, 3).map((genre) => (
              <span
                key={genre.mal_id}
                className="px-2 py-1 bg-gray-200 text-gray-700 rounded-full text-xs"
              >
                {genre.name}
              </span>
            ))}
          </div>
        )}

        {renderStreamingSection()}

        {anime.synopsis && (
          <p className="text-sm text-gray-600 mt-3 line-clamp-3">
            {anime.synopsis}
          </p>
        )}

        <a
          href={malUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="absolute bottom-4 right-4 text-sm text-anime-primary hover:text-anime-secondary font-medium transition-colors"
        >
          Read more →
        </a>
      </div>
    </div>
  );
};

export default AnimeCard; 