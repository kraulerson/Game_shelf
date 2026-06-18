import { useQuery } from '@tanstack/react-query';

async function fetchJobs() {
  const res = await fetch('/api/cache/jobs?limit=25&sort=id:desc', { credentials: 'same-origin' });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.status === 'orchestrator_offline') throw new Error('jobs unavailable');
  return body.jobs || [];
}

export default function RecentJobs() {
  const { data: jobs, isLoading, isError } = useQuery({
    queryKey: ['cacheJobs'],
    queryFn: fetchJobs,
    retry: false,
  });

  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <h2 className="text-sm font-semibold text-gray-300 mb-3">Recent jobs</h2>
      {isLoading ? (
        <p className="text-gray-500 text-sm">Loading…</p>
      ) : isError ? (
        <p className="text-gray-500 text-sm">Jobs unavailable.</p>
      ) : jobs.length === 0 ? (
        <p className="text-gray-500 text-sm">No recent jobs.</p>
      ) : (
        <div className="space-y-1">
          {jobs.map((j) => (
            <div
              key={j.id}
              className="flex items-center gap-3 text-sm py-1 border-b border-gray-700/50 last:border-0"
            >
              <span className="text-gray-300 w-28">{j.kind}</span>
              <span className="text-gray-400 w-20">{j.state}</span>
              <span className="text-gray-500 w-16">{j.platform || '—'}</span>
              <span className="text-gray-600 ml-auto text-xs">{j.game_id ? `game ${j.game_id}` : ''}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
