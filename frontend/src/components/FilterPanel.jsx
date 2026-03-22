import { useState, useEffect, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { X } from 'lucide-react';
import Fuse from 'fuse.js';

export default function FilterPanel({ open, onClose }) {
  const ref = useRef(null);
  const [searchParams, setSearchParams] = useSearchParams();
  const [genreSearch, setGenreSearch] = useState('');
  const [showAllGenres, setShowAllGenres] = useState(false);
  const [showAllTags, setShowAllTags] = useState(false);

  const { data: filters } = useQuery({
    queryKey: ['gameFilters'],
    queryFn: () => fetch('/api/games/filters', { credentials: 'same-origin' }).then(r => r.json()),
  });

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handleClick(e) {
      if (ref.current && !ref.current.contains(e.target)) onClose();
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open, onClose]);

  if (!open) return null;

  const selectedGenres = (searchParams.get('genre') || '').split(',').filter(Boolean);
  const selectedTags = (searchParams.get('tag') || '').split(',').filter(Boolean);
  const selectedLaunchers = (searchParams.get('launcher') || '').split(',').filter(Boolean);

  function toggleFilter(key, value) {
    const current = (searchParams.get(key) || '').split(',').filter(Boolean);
    const next = current.includes(value)
      ? current.filter(v => v !== value)
      : [...current, value];
    const newParams = new URLSearchParams(searchParams);
    if (next.length > 0) {
      newParams.set(key, next.join(','));
    } else {
      newParams.delete(key);
    }
    newParams.set('page', '1');
    setSearchParams(newParams);
  }

  function setParam(key, value) {
    const newParams = new URLSearchParams(searchParams);
    if (value) {
      newParams.set(key, value);
    } else {
      newParams.delete(key);
    }
    newParams.set('page', '1');
    setSearchParams(newParams);
  }

  // Fuzzy search for genres
  const allGenres = filters?.genres || [];
  let displayGenres = allGenres;
  if (genreSearch) {
    const fuse = new Fuse(allGenres, { keys: ['name'], threshold: 0.4 });
    displayGenres = fuse.search(genreSearch).map(r => r.item);
  }
  if (!showAllGenres && !genreSearch) displayGenres = displayGenres.slice(0, 20);

  const allTags = filters?.tags || [];
  let displayTags = showAllTags ? allTags : allTags.slice(0, 20);

  return (
    <div ref={ref} className="absolute z-20 top-full left-0 mt-2 w-80 bg-gray-800 border border-gray-700 rounded-lg shadow-xl p-4 max-h-[70vh] overflow-y-auto">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-white font-medium">Filters</h3>
        <button onClick={onClose} className="text-gray-400 hover:text-white">
          <X size={16} />
        </button>
      </div>

      {/* Launchers */}
      <div className="mb-4">
        <div className="text-sm text-gray-400 mb-2">Launchers</div>
        {(filters?.launchers || []).map(l => (
          <label key={l.name} className="flex items-center gap-2 text-sm text-gray-300 py-0.5 cursor-pointer">
            <input
              type="checkbox"
              checked={selectedLaunchers.includes(l.name)}
              onChange={() => toggleFilter('launcher', l.name)}
              className="rounded"
            />
            {l.display_name}
            <span className="text-gray-500 text-xs ml-auto">{l.count}</span>
          </label>
        ))}
      </div>

      {/* Genres */}
      <div className="mb-4">
        <div className="text-sm text-gray-400 mb-2">Genres</div>
        <input
          type="text"
          placeholder="Search genres..."
          value={genreSearch}
          onChange={e => setGenreSearch(e.target.value)}
          className="w-full px-2 py-1 mb-2 bg-gray-700 border border-gray-600 rounded text-sm text-white"
        />
        {displayGenres.map(g => (
          <label key={g.name} className="flex items-center gap-2 text-sm text-gray-300 py-0.5 cursor-pointer">
            <input
              type="checkbox"
              checked={selectedGenres.includes(g.name)}
              onChange={() => toggleFilter('genre', g.name)}
              className="rounded"
            />
            {g.name}
            <span className="text-gray-500 text-xs ml-auto">{g.count}</span>
          </label>
        ))}
        {!genreSearch && allGenres.length > 20 && (
          <button onClick={() => setShowAllGenres(!showAllGenres)} className="text-xs text-blue-400 mt-1">
            {showAllGenres ? 'Show less' : `Show all (${allGenres.length})`}
          </button>
        )}
      </div>

      {/* Tags */}
      {allTags.length > 0 && (
        <div className="mb-4">
          <div className="text-sm text-gray-400 mb-2">Tags</div>
          {displayTags.map(t => (
            <label key={t.name} className="flex items-center gap-2 text-sm text-gray-300 py-0.5 cursor-pointer">
              <input
                type="checkbox"
                checked={selectedTags.includes(t.name)}
                onChange={() => toggleFilter('tag', t.name)}
                className="rounded"
              />
              {t.name}
              <span className="text-gray-500 text-xs ml-auto">{t.count}</span>
            </label>
          ))}
          {allTags.length > 20 && (
            <button onClick={() => setShowAllTags(!showAllTags)} className="text-xs text-blue-400 mt-1">
              {showAllTags ? 'Show less' : `Show all (${allTags.length})`}
            </button>
          )}
        </div>
      )}

      {/* Release Year */}
      <div className="mb-4">
        <div className="text-sm text-gray-400 mb-2">Release Year</div>
        <div className="flex gap-2">
          <input
            type="number"
            placeholder={filters?.release_year_min || 'Min'}
            value={searchParams.get('release_year_min') || ''}
            onChange={e => setParam('release_year_min', e.target.value)}
            className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-sm text-white"
          />
          <input
            type="number"
            placeholder={filters?.release_year_max || 'Max'}
            value={searchParams.get('release_year_max') || ''}
            onChange={e => setParam('release_year_max', e.target.value)}
            className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-sm text-white"
          />
        </div>
      </div>

      {/* Playtime */}
      <div className="mb-4">
        <div className="text-sm text-gray-400 mb-2">Playtime (hours)</div>
        <div className="flex gap-2">
          <input
            type="number"
            placeholder="Min"
            value={searchParams.get('playtime_min') ? Math.round(searchParams.get('playtime_min') / 60) : ''}
            onChange={e => setParam('playtime_min', e.target.value ? String(e.target.value * 60) : '')}
            className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-sm text-white"
          />
          <input
            type="number"
            placeholder="Max"
            value={searchParams.get('playtime_max') ? Math.round(searchParams.get('playtime_max') / 60) : ''}
            onChange={e => setParam('playtime_max', e.target.value ? String(e.target.value * 60) : '')}
            className="w-full px-2 py-1 bg-gray-700 border border-gray-600 rounded text-sm text-white"
          />
        </div>
      </div>

      {/* Toggles */}
      <div className="space-y-2 mb-4">
        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={searchParams.get('owned') === 'all'}
            onChange={e => setParam('owned', e.target.checked ? 'all' : '')}
            className="rounded"
          />
          Show unowned games
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-300 cursor-pointer">
          <input
            type="checkbox"
            checked={searchParams.get('duplicates') === 'show'}
            onChange={e => setParam('duplicates', e.target.checked ? 'show' : '')}
            className="rounded"
          />
          Show all copies (duplicates)
        </label>
      </div>

      <button onClick={onClose} className="w-full py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors">
        Apply
      </button>
    </div>
  );
}
