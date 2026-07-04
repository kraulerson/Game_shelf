import { useState, useRef, useEffect } from 'react';
import { CloudOff, AlertTriangle, RefreshCw } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useCacheStatus } from '../hooks/useCacheStatus';
import { useCacheHealth } from '../hooks/useCacheHealth';
import { SUPPORTED_ORCH_VERSIONS } from '../utils/orchVersion';
import CacheStats from '../components/cache/CacheStats';
import PlatformAuthCards from '../components/cache/PlatformAuthCards';
import RecentJobs from '../components/cache/RecentJobs';
import BlockListManager from '../components/cache/BlockListManager';

// A full sweep re-validates the entire steam library and can run for minutes,
// so poll on a slow cadence with a generous ceiling rather than spinning fast.
const SWEEP_POLL_MS = 3000;
const SWEEP_MAX_POLLS = 240; // ~12 min ceiling
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default function Cache() {
  const queryClient = useQueryClient();
  const { isOffline } = useCacheStatus();
  const { isDegraded, isSkewed, version } = useCacheHealth();
  const [sweeping, setSweeping] = useState(false);
  const [sweepMsg, setSweepMsg] = useState('');
  // #230: stop the sweep poll once this page unmounts so it doesn't keep firing
  // /api/cache/jobs after the user navigates away.
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Re-run every cache query on demand (one place to refresh the whole page).
  const retry = () =>
    queryClient.invalidateQueries({ predicate: (q) => String(q.queryKey[0]).startsWith('cache') });

  // "Refresh cache status" — enqueue a FULL re-validation sweep over every steam
  // game (so never-validated games are included), then poll the sweep job to
  // completion, refreshing badges progressively as games are re-validated.
  async function refreshCacheStatus() {
    setSweeping(true);
    setSweepMsg('Starting full re-validation…');
    try {
      const res = await fetch('/api/cache/sweep', { method: 'POST', credentials: 'same-origin' });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setSweepMsg('Could not start — the orchestrator is unavailable.');
        return;
      }
      setSweepMsg(
        body.queued
          ? `Full re-validation running (job #${body.job_id})…`
          : `A sweep is already running (job #${body.job_id})…`
      );
      await pollSweep();
      setSweepMsg('Re-validation complete — badges updated.');
    } catch {
      setSweepMsg('Could not start — the orchestrator is unavailable.');
    } finally {
      retry();
      setSweeping(false);
    }
  }

  async function pollSweep() {
    for (let i = 0; i < SWEEP_MAX_POLLS; i++) {
      if (!mountedRef.current) return; // #230: page unmounted — stop polling
      let job = null;
      try {
        const r = await fetch('/api/cache/jobs?kind=sweep&sort=id:desc&limit=1', {
          credentials: 'same-origin',
        });
        const body = await r.json().catch(() => ({}));
        job = Array.isArray(body.jobs) ? body.jobs[0] : null;
      } catch {
        return; // transient error — stop polling; finally still refreshes
      }
      if (job && TERMINAL.has(job.state)) return;
      // Progressive: refresh ONLY the badges (cacheStatus) as the sweep runs —
      // re-fetching platforms/health/jobs every tick would needlessly hammer
      // the orchestrator across a multi-minute sweep. The finally-block retry()
      // refreshes everything (incl. the sweep job in RecentJobs) once it ends.
      queryClient.invalidateQueries({ queryKey: ['cacheStatus'] });
      await sleep(SWEEP_POLL_MS);
    }
  }

  return (
    <div className="max-w-5xl mx-auto p-4 space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h1 className="text-xl font-bold text-white">Lancache</h1>
        <div className="flex items-center gap-3">
          {sweepMsg && <span className="text-sm text-gray-400">{sweepMsg}</span>}
          <button
            onClick={refreshCacheStatus}
            disabled={isOffline || sweeping}
            title="Re-validate every cached game against the on-disk cache"
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded bg-blue-700 hover:bg-blue-600 text-blue-50 text-sm disabled:opacity-50"
          >
            <RefreshCw size={14} className={sweeping ? 'animate-spin' : ''} />
            {sweeping ? 'Refreshing…' : 'Refresh cache status'}
          </button>
        </div>
      </div>

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
