import { useQueryClient } from '@tanstack/react-query';
import CacheBadge from './CacheBadge';
import { useCacheStatus } from '../../hooks/useCacheStatus';
import { launcherToPlatform } from '../../utils/cacheBadge';

export default function CachePanel({ editions = [] }) {
  const queryClient = useQueryClient();
  const { statusFor, isOffline } = useCacheStatus();

  const tracked = editions
    .map((e) => ({ e, platform: launcherToPlatform(e.launcher_name) }))
    .filter((x) => x.platform);

  if (tracked.length === 0) return null;

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['cacheStatus'] });

  async function trigger(path) {
    await fetch(path, { method: 'POST', credentials: 'same-origin' });
    invalidate();
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
          return (
            <div key={e.id} className="flex items-center gap-3">
              <span className="w-24 text-sm text-gray-400">{e.launcher_display_name || e.launcher_name}</span>
              <CacheBadge status={cache?.status} blocked={cache?.blocked} tracked offline={isOffline} />
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
                  disabled={isOffline || !orchId}
                  onClick={() => trigger(`/api/cache/games/${orchId}/validate`)}
                >
                  Validate
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
