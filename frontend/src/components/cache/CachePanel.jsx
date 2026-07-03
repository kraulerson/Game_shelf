import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import CacheBadge from './CacheBadge';
import { useCacheStatus } from '../../hooks/useCacheStatus';
import { launcherToPlatform } from '../../utils/cacheBadge';

const POLL_INTERVAL_MS = 1500;
const MAX_POLLS = 60; // ~90s ceiling — fine for the fast disk-stat validate
// A force prefill (Repair) re-requests EVERY chunk (a LAN re-read of the whole
// game plus a WAN pull of the evicted gaps), so it runs minutes, not seconds.
// Poll slower and far longer so "Repairing…" reflects the real duration instead
// of reverting at 90s (which looked like nothing happened and prompted re-clicks).
// A re-click is harmless: the orchestrator dedups in-flight prefills per game.
const PREFILL_POLL_INTERVAL_MS = 3000;
const PREFILL_MAX_POLLS = 240; // ~12 min ceiling
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled']);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export default function CachePanel({ editions = [] }) {
  const queryClient = useQueryClient();
  const { statusFor, isOffline } = useCacheStatus();
  // orchId -> true while a validate job for that game is in flight.
  const [validating, setValidating] = useState({});
  // orchId -> true while a force-prefill (Repair) job for that game is in flight.
  const [forcing, setForcing] = useState({});

  const tracked = editions
    .map((e) => ({ e, platform: launcherToPlatform(e.launcher_name) }))
    .filter((x) => x.platform);

  if (tracked.length === 0) return null;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['cacheStatus'] });

  async function trigger(path) {
    await fetch(path, { method: 'POST', credentials: 'same-origin' });
    invalidate();
  }

  // Validate is async on the orchestrator: the POST only ENQUEUES a job; the
  // disk-stat runs later. Fire-and-forget looked like nothing happened, so we
  // show "Validating…" and poll the job to completion, refreshing the badge as
  // it progresses.
  async function validate(orchId) {
    setValidating((v) => ({ ...v, [orchId]: true }));
    try {
      const res = await fetch(`/api/cache/games/${orchId}/validate`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (res.ok) await pollJob(orchId, 'validate');
    } finally {
      setValidating((v) => {
        const next = { ...v };
        delete next[orchId];
        return next;
      });
      invalidate();
    }
  }

  // Repair = a FORCE prefill: re-requests every chunk so the lancache refills the
  // evicted gaps a normal prefill would skip. Enqueues a prefill job (force=true)
  // and polls it to completion like Validate, refreshing the badge as it runs.
  async function force(orchId) {
    setForcing((v) => ({ ...v, [orchId]: true }));
    try {
      const res = await fetch(`/api/cache/games/${orchId}/prefill?force=true`, {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (res.ok) await pollJob(orchId, 'prefill');
    } finally {
      setForcing((v) => {
        const next = { ...v };
        delete next[orchId];
        return next;
      });
      invalidate();
    }
  }

  async function pollJob(orchId, kind) {
    const interval = kind === 'prefill' ? PREFILL_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
    const maxPolls = kind === 'prefill' ? PREFILL_MAX_POLLS : MAX_POLLS;
    for (let i = 0; i < maxPolls; i++) {
      let job = null;
      try {
        const r = await fetch(
          `/api/cache/jobs?game_id=${orchId}&kind=${kind}&sort=id:desc&limit=1`,
          { credentials: 'same-origin' }
        );
        const body = await r.json().catch(() => ({}));
        job = Array.isArray(body.jobs) ? body.jobs[0] : null;
      } catch {
        return; // transient network error — stop polling; finally still refreshes
      }
      if (job && TERMINAL.has(job.state)) return;
      invalidate(); // progressive: pick up any mid-flight status change
      await sleep(interval);
    }
  }

  async function block(platform, appId) {
    await fetch('/api/cache/block-list', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, app_id: appId, source: 'gameshelf' }),
    });
    invalidate();
  }

  async function unblock(platform, appId) {
    await fetch(`/api/cache/block-list/${platform}/${encodeURIComponent(appId)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    invalidate();
  }

  const btn = 'text-xs px-2 py-1 rounded disabled:opacity-50';

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <h3 className="text-sm font-semibold text-gray-300 mb-3">Cache</h3>
      <div className="space-y-2">
        {tracked.map(({ e, platform }) => {
          const cache = statusFor(platform, e.launcher_game_id);
          const orchId = cache?.id;
          const isValidating = Boolean(orchId && validating[orchId]);
          const isForcing = Boolean(orchId && forcing[orchId]);
          return (
            <div key={e.id} className="flex items-center gap-3">
              <span className="w-24 text-sm text-gray-400">{e.launcher_display_name || e.launcher_name}</span>
              <CacheBadge
                status={cache?.status}
                blocked={cache?.blocked}
                tracked
                offline={isOffline}
                chunksCached={cache?.chunks_cached}
                chunksTotal={cache?.chunks_total}
              />
              <div className="ml-auto flex gap-2">
                {cache?.blocked ? (
                  <button
                    className={`${btn} bg-gray-700 hover:bg-gray-600`}
                    disabled={isOffline}
                    onClick={() => unblock(platform, e.launcher_game_id)}
                  >
                    Unblock
                  </button>
                ) : (
                  <button
                    className={`${btn} bg-gray-700 hover:bg-gray-600`}
                    disabled={isOffline}
                    onClick={() => block(platform, e.launcher_game_id)}
                  >
                    Block
                  </button>
                )}
                <button
                  className={`${btn} bg-blue-700 hover:bg-blue-600`}
                  disabled={isOffline || !orchId}
                  onClick={() => trigger(`/api/cache/games/${orchId}/prefill`)}
                >
                  Prefill
                </button>
                <button
                  className={`${btn} bg-gray-700 hover:bg-gray-600`}
                  disabled={isOffline || !orchId || isValidating}
                  onClick={() => validate(orchId)}
                >
                  {isValidating ? 'Validating…' : 'Validate'}
                </button>
                {cache?.status === 'validation_failed' && (
                  <button
                    className={`${btn} bg-amber-700 hover:bg-amber-600`}
                    disabled={isOffline || !orchId || isForcing}
                    onClick={() => force(orchId)}
                    title="Re-download every chunk fresh from the source (a complete re-download, not just the missing chunks). Use only if Validate confirms real missing data."
                  >
                    {isForcing ? 'Re-downloading…' : 'Complete Re-download'}
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
