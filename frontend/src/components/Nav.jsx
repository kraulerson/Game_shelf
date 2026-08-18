import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Library, Settings, LogOut, Menu, X, Loader2, HardDrive } from 'lucide-react';
import { isAnySyncRunning, latestCompletedAt } from '../utils/syncStatus';

export default function Nav() {
  const [menuOpen, setMenuOpen] = useState(false);
  const navigate = useNavigate();
  const location = useLocation();
  const queryClient = useQueryClient();

  const { data: syncStatus } = useQuery({
    queryKey: ['syncStatus'],
    queryFn: () => fetch('/api/sync/status', { credentials: 'same-origin' }).then(r => r.json()),
    refetchInterval: 30000,
  });

  const { data: health } = useQuery({
    queryKey: ['health'],
    queryFn: () => fetch('/api/health').then(r => r.json()),
    staleTime: Infinity,
  });

  // Sync HEALTH is distinct from sync recency: a launcher can stop syncing without
  // its latest job ever looking wrong (syncAll treats an awaiting_otp job as
  // neither success nor failure), so a broken credential can age silently.
  const { data: syncHealth } = useQuery({
    queryKey: ['syncHealth'],
    queryFn: () => fetch('/api/sync/health', { credentials: 'same-origin' }).then(r => r.json()),
    refetchInterval: 60000,
  });

  // /api/sync/status returns { jobs, otp_window_ms }; these read through a shared
  // normaliser that tolerates that shape and the older bare array. Reading the
  // object directly made isRunning undefined and lastSync undefined, so
  // hoursSinceSync was permanently Infinity and the dot never left yellow.
  const isRunning = isAnySyncRunning(syncStatus);
  const lastSync = latestCompletedAt(syncStatus);
  const hoursSinceSync = lastSync ? (Date.now() - new Date(lastSync).getTime()) / 3600000 : Infinity;

  const problems = syncHealth?.problems || [];
  const hasProblems = problems.length > 0;

  let syncDot = 'bg-yellow-500'; // >24h or unknown
  if (isRunning) syncDot = 'animate-spin';
  else if (hasProblems) syncDot = 'bg-red-500';
  else if (hoursSinceSync < 1) syncDot = 'bg-green-500';
  else if (hoursSinceSync < 24) syncDot = 'bg-green-500 opacity-60';

  // Colour alone must never carry the meaning — the label and tooltip say it in
  // words, so the state is legible without relying on colour perception.
  const syncLabel = isRunning
    ? 'Syncing'
    : hasProblems
      ? `${problems.length} sync issue${problems.length > 1 ? 's' : ''}`
      : hoursSinceSync < 24
        ? 'Synced'
        : 'Sync overdue';
  const syncTitle = hasProblems
    ? problems.map(p => `${p.display_name || p.name}: ${p.status}${p.detail ? ` — ${p.detail}` : ''}`).join('\n')
    : syncLabel;

  async function handleLogout() {
    await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin' });
    queryClient.clear();
    navigate('/login');
  }

  const linkClass = (path) =>
    `flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors ${
      location.pathname.startsWith(path) ? 'text-white bg-gray-800' : 'text-gray-400 hover:text-white'
    }`;

  return (
    <nav className="bg-gray-900 border-b border-gray-800 px-4 py-2">
      <div className="flex items-center justify-between">
        <Link to="/library" className="text-xl font-bold text-white">
          Gameshelf
          {health?.version && <span className="text-xs font-normal text-gray-500 ml-2">v{health.version}</span>}
        </Link>

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-2">
          <Link to="/library" className={linkClass('/library')}>
            <Library size={16} /> Library
          </Link>
          <Link to="/settings" className={linkClass('/settings')}>
            <Settings size={16} /> Settings
          </Link>
          <Link to="/cache" className={linkClass('/cache')}>
            <HardDrive size={16} /> Cache
          </Link>
          <div className="flex items-center gap-2 ml-4">
            {isRunning ? (
              <Loader2 size={14} className="text-blue-400 animate-spin" />
            ) : (
              <span className={`w-2 h-2 rounded-full ${syncDot}`} />
            )}
            <span
              title={syncTitle}
              className={`text-xs ${hasProblems ? 'text-red-400' : 'text-gray-500'}`}
            >
              {syncLabel}
            </span>
          </div>
          <button onClick={handleLogout} className="flex items-center gap-1 text-gray-400 hover:text-white text-sm ml-2">
            <LogOut size={16} /> Logout
          </button>
        </div>

        {/* Mobile hamburger */}
        <button className="md:hidden text-gray-400" onClick={() => setMenuOpen(!menuOpen)}>
          {menuOpen ? <X size={24} /> : <Menu size={24} />}
        </button>
      </div>

      {/* Mobile menu */}
      {menuOpen && (
        <div className="md:hidden mt-2 space-y-1 pb-2">
          <Link to="/library" className={linkClass('/library')} onClick={() => setMenuOpen(false)}>
            <Library size={16} /> Library
          </Link>
          <Link to="/settings" className={linkClass('/settings')} onClick={() => setMenuOpen(false)}>
            <Settings size={16} /> Settings
          </Link>
          <Link to="/cache" className={linkClass('/cache')} onClick={() => setMenuOpen(false)}>
            <HardDrive size={16} /> Cache
          </Link>
          <button onClick={handleLogout} className="flex items-center gap-2 px-3 py-2 text-gray-400 hover:text-white text-sm w-full">
            <LogOut size={16} /> Logout
          </button>
        </div>
      )}
    </nav>
  );
}
