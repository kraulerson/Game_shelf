import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, Loader2 } from 'lucide-react';
import LauncherBadge from '../components/LauncherBadge';

function formatPlaytime(minutes) {
  if (!minutes || minutes <= 0) return 'Never played';
  const hours = Math.round(minutes / 60);
  return hours > 0 ? `${hours} hours played` : `${minutes} minutes played`;
}

export default function GameDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [showFullDesc, setShowFullDesc] = useState(false);

  const { data: game, isLoading, error } = useQuery({
    queryKey: ['game', id],
    queryFn: () => fetch(`/api/games/${id}`, { credentials: 'same-origin' }).then(r => {
      if (!r.ok) throw new Error('Game not found');
      return r.json();
    }),
  });

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <Loader2 size={24} className="animate-spin text-gray-400" />
      </div>
    );
  }

  if (error || !game) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-400 text-lg mb-4">Game not found</p>
          <button onClick={() => navigate(-1)} className="text-blue-400 hover:text-blue-300">Go back</button>
        </div>
      </div>
    );
  }

  const primaryEdition = game.editions?.find(e => e.is_primary);
  const heroUrl = game.hero_url || game.cover_url;

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Hero banner */}
      <div className="relative h-64 md:h-80 overflow-hidden">
        {heroUrl ? (
          <>
            <img src={heroUrl} alt="" className="w-full h-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-gray-900 via-gray-900/60 to-transparent" />
          </>
        ) : (
          <div className="w-full h-full bg-gray-800" />
        )}

        {/* Back button */}
        <button
          onClick={() => navigate(-1)}
          className="absolute top-4 left-4 flex items-center gap-1 bg-black/50 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-black/70"
        >
          <ArrowLeft size={16} /> Back
        </button>

        {/* Cover + title overlay */}
        <div className="absolute bottom-0 left-0 right-0 px-6 pb-4 flex items-end gap-4">
          {game.cover_url && (
            <img
              src={game.cover_url}
              alt={game.title}
              className="w-24 md:w-32 rounded-lg shadow-lg border-2 border-gray-700 -mb-8 relative z-10"
            />
          )}
          <div className="pb-2">
            <h1 className="text-2xl md:text-3xl font-bold">{game.title}</h1>
            <div className="flex items-center gap-2 text-sm text-gray-400 mt-1">
              {game.developer && <span>{game.developer}</span>}
              {game.developer && game.publisher && game.developer !== game.publisher && (
                <><span className="text-gray-600">|</span><span>{game.publisher}</span></>
              )}
              {game.release_year && <><span className="text-gray-600">|</span><span>{game.release_year}</span></>}
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="px-6 pt-12 pb-8 max-w-4xl">
        {/* Genre + tag chips */}
        {(game.genres?.length > 0 || game.tags?.length > 0) && (
          <div className="flex flex-wrap gap-2 mb-4">
            {game.genres?.map(g => (
              <span key={g} className="bg-blue-600/20 text-blue-400 px-2.5 py-1 rounded-full text-xs">{g}</span>
            ))}
            {game.tags?.filter(t => !game.genres?.includes(t)).map(t => (
              <span key={t} className="bg-gray-700 text-gray-300 px-2.5 py-1 rounded-full text-xs">{t}</span>
            ))}
          </div>
        )}

        {/* Description */}
        {game.description && (
          <div className="mb-6">
            <p className={`text-gray-300 text-sm leading-relaxed ${!showFullDesc ? 'line-clamp-4' : ''}`}>
              {game.description}
            </p>
            {game.description.length > 200 && (
              <button
                onClick={() => setShowFullDesc(!showFullDesc)}
                className="text-blue-400 text-sm mt-1 hover:text-blue-300"
              >
                {showFullDesc ? 'Show less' : 'Read more'}
              </button>
            )}
          </div>
        )}

        {/* Owned On section */}
        {game.editions?.length > 0 && (
          <div>
            <h2 className="text-lg font-semibold mb-3">Owned On</h2>
            <div className="space-y-2">
              {game.editions.map(edition => (
                <div
                  key={edition.id}
                  className={`bg-gray-800 rounded-lg p-4 flex items-center justify-between ${
                    !edition.is_primary ? 'opacity-50' : ''
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <LauncherBadge
                      launcherName={edition.launcher_name}
                      displayName={edition.launcher_display_name}
                      primary={edition.is_primary}
                    />
                    <div>
                      <div className="text-sm text-gray-300">{formatPlaytime(edition.playtime_minutes)}</div>
                      {!edition.is_primary && primaryEdition && (
                        <div className="text-xs text-gray-500 mt-0.5">
                          Secondary copy — {primaryEdition.launcher_display_name} is preferred
                        </div>
                      )}
                    </div>
                  </div>
                  {edition.launcher_url && (
                    <a
                      href={edition.launcher_url}
                      target="_blank"
                      rel="noopener noreferrer"
                      onClick={e => e.stopPropagation()}
                      className="text-xs text-blue-400 hover:text-blue-300"
                    >
                      View in store
                    </a>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
