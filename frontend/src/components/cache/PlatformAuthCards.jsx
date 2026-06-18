import { useQuery } from '@tanstack/react-query';
import { Copy, CheckCircle, AlertCircle } from 'lucide-react';

function SectionShell({ title, children }) {
  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <h2 className="text-sm font-semibold text-gray-300 mb-3">{title}</h2>
      {children}
    </div>
  );
}

export default function PlatformAuthCards() {
  const { data, isLoading, isError } = useQuery({
    queryKey: ['cachePlatforms'],
    queryFn: () => fetch('/api/cache/platforms', { credentials: 'same-origin' }).then((r) => r.json()),
    retry: false,
  });

  if (isLoading) {
    return (
      <SectionShell title="Platforms">
        <p className="text-gray-500 text-sm">Loading…</p>
      </SectionShell>
    );
  }
  if (isError || data?.status === 'orchestrator_offline' || !data?.platforms) {
    return (
      <SectionShell title="Platforms">
        <p className="text-gray-500 text-sm">Platform status unavailable.</p>
      </SectionShell>
    );
  }

  return (
    <SectionShell title="Platforms">
      <div className="grid sm:grid-cols-2 gap-3">
        {data.platforms.map((p) => {
          const ok = p.auth_status === 'ok';
          const cmd = `orchestrator-cli auth ${p.name}`;
          return (
            <div key={p.name} className="bg-gray-900 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <span className="text-white text-sm font-medium">{p.name}</span>
                <span className={`flex items-center gap-1 text-xs ${ok ? 'text-green-400' : 'text-amber-400'}`}>
                  {ok ? <CheckCircle size={14} /> : <AlertCircle size={14} />} {p.auth_status}
                </span>
              </div>
              {p.last_sync_at && <div className="text-xs text-gray-500 mt-1">last sync: {p.last_sync_at}</div>}
              {!ok && (
                <div className="mt-2 flex items-center gap-2">
                  <code className="text-xs bg-gray-800 px-2 py-1 rounded text-gray-300 flex-1 truncate">{cmd}</code>
                  <button
                    className="text-xs px-2 py-1 rounded bg-gray-700 hover:bg-gray-600 flex items-center gap-1"
                    onClick={() => navigator.clipboard?.writeText(cmd)}
                  >
                    <Copy size={12} /> Copy
                  </button>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </SectionShell>
  );
}
