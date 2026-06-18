import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Trash2 } from 'lucide-react';

async function fetchBlockList() {
  const res = await fetch('/api/cache/block-list', { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status === 'orchestrator_offline') throw new Error('block-list unavailable');
  return body.block_list || [];
}

export default function BlockListManager() {
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState('');
  const [platform, setPlatform] = useState('steam');
  const [appId, setAppId] = useState('');
  const { data: rows, isLoading, isError } = useQuery({
    queryKey: ['cacheBlockList'],
    queryFn: fetchBlockList,
    retry: false,
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['cacheBlockList'] });

  async function add(e) {
    e.preventDefault();
    if (!appId.trim()) return;
    await fetch('/api/cache/block-list', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ platform, app_id: appId.trim(), source: 'gameshelf' }),
    });
    setAppId('');
    invalidate();
  }

  async function remove(p, a) {
    await fetch(`/api/cache/block-list/${p}/${encodeURIComponent(a)}`, {
      method: 'DELETE',
      credentials: 'same-origin',
    });
    invalidate();
  }

  const shown = (rows || []).filter(
    (r) => !filter || `${r.platform} ${r.app_id} ${r.reason || ''}`.toLowerCase().includes(filter.toLowerCase())
  );

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <h2 className="text-sm font-semibold text-gray-300 mb-3">Block list</h2>
      <form onSubmit={add} className="flex gap-2 mb-3">
        <select
          value={platform}
          onChange={(e) => setPlatform(e.target.value)}
          className="bg-gray-900 text-sm text-white rounded px-2 py-1"
        >
          <option value="steam">steam</option>
          <option value="epic">epic</option>
        </select>
        <input
          value={appId}
          onChange={(e) => setAppId(e.target.value)}
          placeholder="app_id"
          className="bg-gray-900 text-sm text-white rounded px-2 py-1 flex-1"
        />
        <button type="submit" className="text-sm px-3 py-1 rounded bg-blue-700 hover:bg-blue-600 text-white">
          Block
        </button>
      </form>
      <input
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
        placeholder="Filter…"
        className="bg-gray-900 text-sm text-white rounded px-2 py-1 w-full mb-2"
      />
      {isLoading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : isError ? (
        <p className="text-gray-500 text-sm">Block list unavailable.</p>
      ) : (
        <div className="max-h-72 overflow-y-auto space-y-1">
          {shown.map((r) => (
            <div key={r.id} className="flex items-center gap-3 text-sm py-1">
              <span className="text-gray-400 w-16">{r.platform}</span>
              <span className="text-gray-200 flex-1 truncate">{r.app_id}</span>
              {r.reason && <span className="text-gray-500 text-xs truncate max-w-[40%]">{r.reason}</span>}
              <button
                onClick={() => remove(r.platform, r.app_id)}
                className="text-gray-500 hover:text-red-400 flex items-center gap-1 text-xs"
                aria-label={`remove ${r.app_id}`}
              >
                <Trash2 size={12} /> Remove
              </button>
            </div>
          ))}
          {shown.length === 0 && <p className="text-gray-500 text-sm">No entries.</p>}
        </div>
      )}
    </div>
  );
}
