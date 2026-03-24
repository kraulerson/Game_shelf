import { useNavigate } from 'react-router-dom';
import LauncherBadge from './LauncherBadge';

function formatPlaytime(minutes) {
  if (!minutes || minutes <= 0) return '-';
  const hours = Math.round(minutes / 60);
  return hours > 0 ? `${hours} hrs` : `${minutes} min`;
}

export default function GameRow({ game }) {
  const navigate = useNavigate();

  const platforms = game.platforms || [];
  const genres = (game.genres || []).slice(0, 3);

  return (
    <div
      onClick={() => game.id && navigate(`/library/game/${game.id}`)}
      className="flex items-center gap-3 px-3 py-2 bg-gray-800 rounded-lg cursor-pointer hover:bg-gray-750 transition-colors"
    >
      {/* Small icon */}
      {game.icon_url || game.cover_url ? (
        <img src={game.icon_url || game.cover_url} alt="" className="w-10 h-10 rounded object-cover flex-shrink-0" />
      ) : (
        <div className="w-10 h-10 rounded bg-gray-700 flex-shrink-0" />
      )}

      {/* Title */}
      <div className="flex-1 min-w-0">
        <div className="text-white text-sm font-medium truncate">{game.title}</div>
        <div className="flex gap-1 mt-0.5">
          {genres.map(g => (
            <span key={g} className="text-xs text-gray-500 bg-gray-700 px-1.5 py-0.5 rounded">{g}</span>
          ))}
        </div>
      </div>

      {/* Platform tags */}
      <div className="flex items-center gap-1 flex-shrink-0">
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

      {/* Playtime */}
      <div className="text-xs text-gray-400 w-16 text-right flex-shrink-0">
        {formatPlaytime(game.playtime_minutes)}
      </div>

      {/* Year */}
      <div className="text-xs text-gray-500 w-12 text-right flex-shrink-0">
        {game.release_year || '-'}
      </div>
    </div>
  );
}
