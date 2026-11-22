import { useQuery } from '@tanstack/react-query';
import { cacheCounts } from '../utils/cacheBadge';

async function fetchCacheGames() {
  const res = await fetch('/api/cache/games', { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 503 || body.status === 'orchestrator_offline') {
      return { offline: true, games: [] };
    }
    throw new Error(`cache games HTTP ${res.status}`);
  }
  return { offline: false, games: Array.isArray(body.games) ? body.games : [] };
}

// Bulk-fetch the orchestrator's games ONCE and expose a (platform, app_id) lookup.
// Value = { id (orchestrator game id), status, blocked, chunks_cached, chunks_total,
//           is_new, status_measured_at }.
// The chunk counts (latest validation) drive the "Partial · N%" badge; they're
// undefined against an orchestrator that predates that field. react-query dedupes
// the shared queryKey, so many cards/panels mounting this hook = one network call.
export function useCacheStatus() {
  const { data, isLoading } = useQuery({
    queryKey: ['cacheStatus'],
    queryFn: fetchCacheGames,
    staleTime: 30000,
    retry: false,
  });

  const games = Array.isArray(data?.games) ? data.games : [];
  const map = new Map();
  for (const g of games) {
    map.set(`${g.platform}:${g.app_id}`, {
      id: g.id,
      status: g.status,
      blocked: g.blocked,
      chunks_cached: g.chunks_cached,
      chunks_total: g.chunks_total,
      // First seen within the orchestrator's new-game window; undefined (= false)
      // against an orchestrator that predates the field.
      is_new: g.is_new,
      // When a measurement last looked at the disk (#309). Undefined against an
      // orchestrator predating the field, which renders no age rather than a guess.
      status_measured_at: g.status_measured_at,
    });
  }

  return {
    isLoading,
    isOffline: Boolean(data?.offline),
    statusFor: (platform, appId) => map.get(`${platform}:${appId}`),
    games,
    counts: cacheCounts(games),
  };
}
