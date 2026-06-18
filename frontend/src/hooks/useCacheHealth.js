import { useQuery } from '@tanstack/react-query';
import { isVersionSkewed } from '../utils/orchVersion';

// ONE health probe per page load. staleTime:Infinity + retry:false + no
// refetchInterval => no polling, no retry storms. The operator re-checks via
// the Retry button on the dashboard (which invalidates this query).
//
// /api/cache/health forwards the orchestrator's /api/v1/health verbatim:
//   200            -> { status:'ok',       version, git_sha, ... }   (healthy)
//   503 + body     -> { status:'degraded', version, git_sha, ... }   (reachable, unhealthy)
//   503 offline    -> { status:'orchestrator_offline' }              (unreachable)
// fetch() only throws on a real transport failure (-> treat as offline).
async function fetchCacheHealth() {
  let res;
  try {
    res = await fetch('/api/cache/health', { credentials: 'same-origin' });
  } catch {
    return { offline: true, health: null };
  }
  const body = await res.json().catch(() => ({}));
  if (body.status === 'orchestrator_offline') return { offline: true, health: null };
  return { offline: false, health: body };
}

export function useCacheHealth() {
  const { data, isLoading } = useQuery({
    queryKey: ['cacheHealth'],
    queryFn: fetchCacheHealth,
    staleTime: Infinity,
    retry: false,
  });

  const health = data?.health || null;
  const version = health?.version || null;
  const isOffline = Boolean(data?.offline);
  const isDegraded = !isOffline && health?.status === 'degraded';
  const isSkewed = !isOffline && isVersionSkewed(version);

  return { isLoading, health, version, isOffline, isDegraded, isSkewed };
}
