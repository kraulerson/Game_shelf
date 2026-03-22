import { useState, useCallback, useEffect } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Search, Grid3X3, List, RefreshCw, Loader2, X, SlidersHorizontal, ChevronLeft, ChevronRight } from 'lucide-react';
import GameCard from '../components/GameCard';
import GameRow from '../components/GameRow';
import FilterPanel from '../components/FilterPanel';

export default function Library() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [view, setView] = useState('grid');
  const [filterOpen, setFilterOpen] = useState(false);
  const [searchInput, setSearchInput] = useState(searchParams.get('search') || '');
  const [syncing, setSyncing] = useState(false);
  const queryClient = useQueryClient();

  // Debounced search
  useEffect(() => {
    const timer = setTimeout(() => {
      const newParams = new URLSearchParams(searchParams);
      if (searchInput) {
        newParams.set('search', searchInput);
      } else {
        newParams.delete('search');
      }
      if (newParams.toString() !== searchParams.toString()) {
        newParams.set('page', '1');
        setSearchParams(newParams);
      }
    }, 300);
    return () => clearTimeout(timer);
  }, [searchInput]);

  const sort = searchParams.get('sort') || 'title_asc';
  function handleSortChange(e) {
    const newParams = new URLSearchParams(searchParams);
    newParams.set('sort', e.target.value);
    newParams.set('page', '1');
    setSearchParams(newParams);
  }

  const { data, isLoading } = useQuery({
    queryKey: ['games', searchParams.toString()],
    queryFn: () => fetch(`/api/games?${searchParams}`, { credentials: 'same-origin' }).then(r => r.json()),
  });

  const games = data?.games || [];
  const total = data?.total || 0;
  const page = data?.page || 1;
  const limit = data?.limit || 50;
  const totalPages = Math.ceil(total / limit);

  function goToPage(p) {
    const newParams = new URLSearchParams(searchParams);
    newParams.set('page', String(p));
    setSearchParams(newParams);
  }

  async function handleSync() {
    setSyncing(true);
    await fetch('/api/sync/all', { method: 'POST', credentials: 'same-origin' });
    const poll = setInterval(async () => {
      try {
        const res = await fetch('/api/sync/status', { credentials: 'same-origin' });
        const status = await res.json();
        const stillRunning = status.some(j => j.status === 'running');
        if (!stillRunning) {
          clearInterval(poll);
          setSyncing(false);
          queryClient.invalidateQueries({ queryKey: ['games'] });
          queryClient.invalidateQueries({ queryKey: ['gameFilters'] });
        }
      } catch {
        clearInterval(poll);
        setSyncing(false);
      }
    }, 3000);
  }

  const filterKeys = ['genre', 'tag', 'launcher', 'release_year_min', 'release_year_max', 'playtime_min', 'playtime_max', 'owned', 'duplicates'];
  const activeFilterCount = filterKeys.filter(k => searchParams.has(k)).length;

  function clearAllFilters() {
    const newParams = new URLSearchParams();
    if (searchParams.get('search')) newParams.set('search', searchParams.get('search'));
    setSearchParams(newParams);
  }

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      <div className="border-b border-gray-800 px-4 py-3">
        <div className="flex items-center gap-3 flex-wrap">
          <div className="relative flex-1 min-w-[200px]">
            <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              placeholder="Search games..."
              value={searchInput}
              onChange={e => setSearchInput(e.target.value)}
              className="w-full pl-9 pr-3 py-2 bg-gray-800 border border-gray-700 rounded-lg text-sm text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <div className="flex items-center gap-1 bg-gray-800 rounded-lg p-1">
            <button onClick={() => setView('grid')} className={`p-1.5 rounded ${view === 'grid' ? 'bg-gray-700 text-white' : 'text-gray-400'}`}>
              <Grid3X3 size={16} />
            </button>
            <button onClick={() => setView('list')} className={`p-1.5 rounded ${view === 'list' ? 'bg-gray-700 text-white' : 'text-gray-400'}`}>
              <List size={16} />
            </button>
          </div>

          <select value={sort} onChange={handleSortChange} className="bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-sm text-white">
            <option value="title_asc">Title A-Z</option>
            <option value="title_desc">Title Z-A</option>
            <option value="release_desc">Newest</option>
            <option value="release_asc">Oldest</option>
            <option value="playtime_desc">Most Played</option>
          </select>

          <button onClick={handleSync} disabled={syncing} className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 text-white text-sm rounded-lg transition-colors">
            {syncing ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
            {syncing ? 'Syncing...' : 'Sync Now'}
          </button>
        </div>

        <div className="flex items-center gap-2 mt-2 flex-wrap relative">
          <button onClick={() => setFilterOpen(!filterOpen)} className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-800 border border-gray-700 rounded-lg text-sm text-gray-300 hover:text-white">
            <SlidersHorizontal size={14} />
            Filters
            {activeFilterCount > 0 && (
              <span className="bg-blue-600 text-white text-xs rounded-full w-5 h-5 flex items-center justify-center">{activeFilterCount}</span>
            )}
          </button>

          <FilterPanel open={filterOpen} onClose={() => setFilterOpen(false)} />

          {searchParams.get('genre') && searchParams.get('genre').split(',').map(g => (
            <span key={`g-${g}`} className="flex items-center gap-1 bg-blue-600/20 text-blue-400 px-2 py-1 rounded-full text-xs">
              {g}
              <button onClick={() => {
                const genres = searchParams.get('genre').split(',').filter(v => v !== g);
                const p = new URLSearchParams(searchParams);
                genres.length ? p.set('genre', genres.join(',')) : p.delete('genre');
                setSearchParams(p);
              }}><X size={12} /></button>
            </span>
          ))}
          {searchParams.get('launcher') && searchParams.get('launcher').split(',').map(l => (
            <span key={`l-${l}`} className="flex items-center gap-1 bg-blue-600/20 text-blue-400 px-2 py-1 rounded-full text-xs">
              {l}
              <button onClick={() => {
                const launchers = searchParams.get('launcher').split(',').filter(v => v !== l);
                const p = new URLSearchParams(searchParams);
                launchers.length ? p.set('launcher', launchers.join(',')) : p.delete('launcher');
                setSearchParams(p);
              }}><X size={12} /></button>
            </span>
          ))}

          {activeFilterCount > 0 && (
            <button onClick={clearAllFilters} className="text-xs text-gray-400 hover:text-white">Clear all</button>
          )}
        </div>
      </div>

      <div className="p-4">
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 size={24} className="animate-spin text-gray-400" />
          </div>
        ) : games.length === 0 ? (
          <div className="text-center py-20">
            <p className="text-gray-400 text-lg mb-2">No games found</p>
            <p className="text-gray-500 text-sm">Try adjusting your filters or sync your library.</p>
          </div>
        ) : view === 'grid' ? (
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-4">
            {games.map((game, i) => <GameCard key={game.id || `e-${i}`} game={game} />)}
          </div>
        ) : (
          <div className="space-y-1">
            {games.map((game, i) => <GameRow key={game.id || `e-${i}`} game={game} />)}
          </div>
        )}

        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-2 mt-6">
            <button onClick={() => goToPage(page - 1)} disabled={page <= 1} className="p-2 text-gray-400 hover:text-white disabled:opacity-30">
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm text-gray-400">Page {page} of {totalPages} ({total} games)</span>
            <button onClick={() => goToPage(page + 1)} disabled={page >= totalPages} className="p-2 text-gray-400 hover:text-white disabled:opacity-30">
              <ChevronRight size={16} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
