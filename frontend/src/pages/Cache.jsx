import { CloudOff } from 'lucide-react';
import { useCacheStatus } from '../hooks/useCacheStatus';
import CacheStats from '../components/cache/CacheStats';
import PlatformAuthCards from '../components/cache/PlatformAuthCards';
import RecentJobs from '../components/cache/RecentJobs';
import BlockListManager from '../components/cache/BlockListManager';

export default function Cache() {
  const { isOffline } = useCacheStatus();
  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      <h1 className="text-xl font-bold text-white">Lancache</h1>
      {isOffline && (
        <div className="bg-amber-900/40 border border-amber-700 rounded-lg p-3 flex items-center gap-2 text-amber-200 text-sm">
          <CloudOff size={16} /> The orchestrator is offline — cache data and actions are unavailable.
        </div>
      )}
      <CacheStats />
      <PlatformAuthCards />
      <RecentJobs />
      <BlockListManager />
    </div>
  );
}
