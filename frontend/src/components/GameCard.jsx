import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import LauncherBadge from './LauncherBadge';

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
  const [showAlsoOn, setShowAlsoOn] = useState(false);
  const navigate = useNavigate();

  const alsoOn = game.also_on || [];
  const hasMultipleLaunchers = alsoOn.length > 1;
  const playtime = formatPlaytime(game.playtime_minutes);

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

        {/* Launcher badges */}
        <div className="flex flex-wrap gap-1 mb-1">
          <LauncherBadge
            launcherName={game.launcher_name}
            displayName={game.launcher_display_name}
            primary
          />
          {hasMultipleLaunchers && (
            <div className="relative">
              <button
                onClick={(e) => { e.stopPropagation(); setShowAlsoOn(!showAlsoOn); }}
                className="text-xs text-gray-400 hover:text-gray-200"
              >
                +{alsoOn.length - 1} more
              </button>
              {showAlsoOn && (
                <div className="absolute z-10 top-full left-0 mt-1 bg-gray-700 rounded-lg shadow-lg p-2 min-w-[160px]">
                  {alsoOn.map((l, i) => (
                    <div key={i} className="flex items-center gap-2 py-1">
                      <LauncherBadge launcherName={l.launcher_name} displayName={l.launcher_display_name} />
                      <span className="text-xs text-gray-300">{l.launcher_display_name}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Playtime */}
        {playtime && (
          <span className="text-xs text-gray-500">{playtime}</span>
        )}
      </div>
    </div>
  );
}
