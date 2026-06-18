import { useCacheStatus } from '../../hooks/useCacheStatus';

const TILES = [
  ['Total', 'total', 'text-gray-200'],
  ['Cached', 'cached', 'text-green-400'],
  ['Update ready', 'update_ready', 'text-amber-400'],
  ['Not cached', 'not_cached', 'text-gray-400'],
  ['Failed', 'failed', 'text-red-400'],
  ['Blocked', 'blocked', 'text-slate-300'],
];

export default function CacheStats() {
  const { counts, isLoading } = useCacheStatus();
  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <h2 className="text-sm font-semibold text-gray-300 mb-3">Cache stats</h2>
      <div className="grid grid-cols-3 sm:grid-cols-6 gap-3">
        {TILES.map(([label, key, color]) => (
          <div key={key} className="bg-gray-900 rounded-lg p-3 text-center">
            <div className={`text-2xl font-bold ${color}`}>{isLoading ? '—' : counts[key]}</div>
            <div className="text-xs text-gray-500 mt-1">{label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
