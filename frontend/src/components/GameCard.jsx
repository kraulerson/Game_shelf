import { useNavigate } from 'react-router-dom';
import LauncherBadge from './LauncherBadge';
import CacheBadge from './cache/CacheBadge';
import { useCacheStatus } from '../hooks/useCacheStatus';
import { launcherToPlatform } from '../utils/cacheBadge';

function getInitials(title) {
  if (!title) return '?';
  return title.split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

function formatPlaytime(minutes) {
  if (!minutes || minutes <= 0) return null;
  const hours = Math.round(minutes / 60);
  return hours > 0 ? `${hours} hrs` : `${minutes} min`;
}

export default function GameCard({ game }) {
  const navigate = useNavigate();

  const platforms = game.platforms || [];
  const playtime = formatPlaytime(game.playtime_minutes);

  const { statusFor, isOffline } = useCacheStatus();
  // #223/#224: the cache badge follows the highest-priority owned launcher
  // (cache_launcher_*), not the display edition's launcher — a game cached on
  // Steam but displayed as its Epic edition must still read as cached. Falls
  // back to the display launcher for older API responses.
  const platform = launcherToPlatform(game.cache_launcher_name || game.launcher_name);
  const cache = platform
    ? statusFor(platform, game.cache_launcher_game_id || game.launcher_game_id)
    : undefined;

  return (
    <div
      onClick={() => game.id && navigate(`/library/game/${game.id}`)}
      className="group bg-gray-800 rounded-lg overflow-hidden cursor-pointer transition-transform hover:scale-105 relative"
    >
      {/* Cover image */}
      {game.cover_url ? (
        <img
          src={game.cover_url}
          alt={game.title}
          className="w-full aspect-[3/4] object-cover"
          loading="lazy"
        />
      ) : (
        <div className="w-full aspect-[3/4] bg-gray-700 flex items-center justify-center">
          <span className="text-2xl font-bold text-gray-500">{getInitials(game.title)}</span>
        </div>
      )}

      {/* Hover overlay */}
      <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity p-3 flex flex-col justify-end">
        {game.description && (
          <p className="text-gray-300 text-xs line-clamp-4 mb-2">{game.description}</p>
        )}
      </div>

      {/* Info */}
      <div className="p-2">
        <h3 className="text-white text-sm font-medium line-clamp-2 mb-1">{game.title}</h3>
        {game.display_edition_title && game.display_edition_title !== game.title && (
          <p className="text-gray-400 text-xs truncate">{game.display_edition_title}</p>
        )}

        {/* Platform tags */}
        <div className="flex flex-wrap gap-1 mb-1">
          {platforms.map((p) => (
            <LauncherBadge
              key={p.launcher_name}
              launcherName={p.launcher_name}
              displayName={p.launcher_display_name}
              primary
              size="small"
            />
          ))}
        </div>

        {/* DLC count + Playtime */}
        <div className="flex gap-2 items-center">
          {game.dlc_count > 0 && (
            <span className="text-xs text-purple-400">+{game.dlc_count} DLC</span>
          )}
          {playtime && (
            <span className="text-xs text-gray-500">{playtime}</span>
          )}
        </div>

        {/* Cache/prefill status (relocated under the info) */}
        <div className="mt-1">
          <CacheBadge
            status={cache?.status}
            blocked={cache?.blocked}
            tracked={Boolean(platform)}
            offline={isOffline}
            size="small"
          />
        </div>
      </div>
    </div>
  );
}
