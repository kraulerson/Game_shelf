import { useQuery } from '@tanstack/react-query';

async function fetchCacheGames() {
  const res = await fetch('/api/cache/games', { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 503 || body.status === 'orchestrator_offline') {
      return { offline: true, games: [] };
    }
    throw new Error(`cache games HTTP ${res.status}`);
  }
  return { offline: false, games: body.games || [] };
}

// Bulk-fetch the orchestrator's games ONCE and expose a (platform, app_id) lookup.
// Value = { id (orchestrator game id), status, blocked }. react-query dedupes the
// shared queryKey, so many cards/panels mounting this hook = one network call.
export function useCacheStatus() {
  const { data, isLoading } = useQuery({
    queryKey: ['cacheStatus'],
    queryFn: fetchCacheGames,
    staleTime: 30000,
    retry: false,
  });

  const map = new Map();
  for (const g of data?.games || []) {
    map.set(`${g.platform}:${g.app_id}`, { id: g.id, status: g.status, blocked: g.blocked });
  }

  return {
    isLoading,
    isOffline: Boolean(data?.offline),
    statusFor: (platform, appId) => map.get(`${platform}:${appId}`),
  };
}
