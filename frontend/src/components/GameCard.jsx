import { useNavigate } from 'react-router-dom';
import LauncherBadge from './LauncherBadge';
import CardStatusSection from './cache/CardStatusSection';
import { useCacheStatus } from '../hooks/useCacheStatus';
import { launcherToPlatform, manualDownloadBadge } from '../utils/cacheBadge';
import { storeStatusList } from '../utils/perStoreStatus';

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

  const playtime = formatPlaytime(game.playtime_minutes);

  const { statusFor, isOffline, isLoading } = useCacheStatus();
  // #223/#224: the cache badge follows the highest-priority owned launcher
  // (cache_launcher_*), not the display edition's launcher — a game cached on
  // Steam but displayed as its Epic edition must still read as cached. Falls
  // back to the display launcher for older API responses.
  const platform = launcherToPlatform(game.cache_launcher_name || game.launcher_name);
  const cache = platform
    ? statusFor(platform, game.cache_launcher_game_id || game.launcher_game_id)
    : undefined;
  // #222: a game with no lancache platform (e.g. GOG-only) shows its manual
  // download status instead of the neutral dash. Multi-launcher games (Steam+GOG)
  // keep the lancache badge — download state shows on the game-detail page.
  const manualBadge = platform ? null : manualDownloadBadge(game.download_status);
  // #31: each owned store's OWN status, resolved from that store's
  // launcher_game_id. Drives both the per-store symbol on each launcher badge and
  // the explanatory line the status section shows when the stores disagree.
  const stores = storeStatusList(game, { statusFor, offline: isOffline });

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

        {/* Platform tags. #31: nowrap + clip — with 4 stores a wrapping row would
            add a second line and make this card taller than its neighbours. Each
            badge carries its own store's status symbol; the wording is in its
            tooltip and in the sr-only text. */}
        <div data-testid="platform-row" className="flex flex-nowrap gap-1 mb-1 overflow-hidden">
          {stores.map((s) => (
            <LauncherBadge
              key={s.launcherName}
              launcherName={s.launcherName}
              displayName={s.displayName}
              primary
              size="small"
              statusSymbol={s.symbol}
              statusLabel={s.label}
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

        {/* Cache/prefill status — a fixed-height section (#31). Agreeing stores
            keep the single primary badge; disagreeing ones get the per-store line,
            inside the SAME reserved height so no card grows. */}
        <CardStatusSection
          stores={stores}
          loading={isLoading}
          badge={{
            status: cache?.status,
            blocked: cache?.blocked,
            tracked: Boolean(platform),
            offline: isOffline,
            badge: manualBadge,
            size: 'small',
          }}
        />
      </div>
    </div>
  );
}
