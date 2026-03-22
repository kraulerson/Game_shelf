import { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Library, Settings, LogOut, Menu, X, Loader2 } from 'lucide-react';

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

  const isRunning = syncStatus?.some?.(j => j.status === 'running');
  const lastSync = syncStatus?.[0]?.completed_at;
  const hoursSinceSync = lastSync ? (Date.now() - new Date(lastSync).getTime()) / 3600000 : Infinity;

  let syncDot = 'bg-yellow-500'; // >24h or unknown
  if (isRunning) syncDot = 'animate-spin';
  else if (hoursSinceSync < 1) syncDot = 'bg-green-500';
  else if (hoursSinceSync < 24) syncDot = 'bg-green-500 opacity-60';

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
        <Link to="/library" className="text-xl font-bold text-white">Gameshelf</Link>

        {/* Desktop nav */}
        <div className="hidden md:flex items-center gap-2">
          <Link to="/library" className={linkClass('/library')}>
            <Library size={16} /> Library
          </Link>
          <Link to="/settings" className={linkClass('/settings')}>
            <Settings size={16} /> Settings
          </Link>
          <div className="flex items-center gap-2 ml-4">
            {isRunning ? (
              <Loader2 size={14} className="text-blue-400 animate-spin" />
            ) : (
              <span className={`w-2 h-2 rounded-full ${syncDot}`} />
            )}
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
          <button onClick={handleLogout} className="flex items-center gap-2 px-3 py-2 text-gray-400 hover:text-white text-sm w-full">
            <LogOut size={16} /> Logout
          </button>
        </div>
      )}
    </nav>
  );
}
