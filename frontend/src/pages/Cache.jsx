import { CloudOff, AlertTriangle, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCacheStatus } from '../hooks/useCacheStatus';
import { useCacheHealth } from '../hooks/useCacheHealth';
import { SUPPORTED_ORCH_VERSIONS } from '../utils/orchVersion';
import CacheStats from '../components/cache/CacheStats';
import PlatformAuthCards from '../components/cache/PlatformAuthCards';
import RecentJobs from '../components/cache/RecentJobs';
import BlockListManager from '../components/cache/BlockListManager';

export default function Cache() {
  const queryClient = useQueryClient();
  const { isOffline } = useCacheStatus();
  const { isDegraded, isSkewed, version } = useCacheHealth();

  // Re-run every cache query on demand (one place to refresh the whole page).
  const retry = () =>
    queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('cache') });

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      <h1 className="text-xl font-bold text-white">Lancache</h1>

      {isOffline && (
        <div className="bg-amber-900/40 border border-amber-700 rounded-lg p-3 flex items-center gap-2 text-amber-200 text-sm">
          <CloudOff size={16} />
          <span className="flex-1">The orchestrator is offline — cache data and actions are unavailable.</span>
          <button
            onClick={retry}
            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-amber-800 hover:bg-amber-700 text-amber-100"
          >
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      )}

      {!isOffline && isDegraded && (
        <div className="bg-orange-900/40 border border-orange-700 rounded-lg p-3 flex items-center gap-2 text-orange-200 text-sm">
          <AlertTriangle size={16} />
          <span className="flex-1">
            The orchestrator is reachable but reports a degraded state — some cache operations may be unreliable.
          </span>
          <button
            onClick={retry}
            className="inline-flex items-center gap-1 px-2 py-1 rounded bg-orange-800 hover:bg-orange-700 text-orange-100"
          >
            <RefreshCw size={14} /> Retry
          </button>
        </div>
      )}

      {!isOffline && isSkewed && (
        <div className="bg-yellow-900/40 border border-yellow-700 rounded-lg p-3 flex items-start gap-2 text-yellow-200 text-sm">
          <AlertTriangle size={16} className="mt-0.5 shrink-0" />
          <span>
            Version skew — the orchestrator reports v{version}, which this build of Game_shelf has not been
            verified against (supported: {SUPPORTED_ORCH_VERSIONS.join(', ')}). Cache features may behave unexpectedly.
          </span>
        </div>
      )}

      <CacheStats />
      <PlatformAuthCards />
      <RecentJobs />
      <BlockListManager />
    </div>
  );
}
