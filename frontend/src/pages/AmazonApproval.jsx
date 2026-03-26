import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, CheckSquare, Square, Upload } from 'lucide-react';

export default function AmazonApproval() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [games, setGames] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  const handleFileUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';

    setUploading(true);
    setError(null);
    try {
      const formData = new FormData();
      formData.append('games_db', file);
      const res = await fetch('/api/launchers/amazon/preview', {
        method: 'POST',
        credentials: 'same-origin',
        body: formData,
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || 'Failed to parse database');
        return;
      }
      setGames(data.games);
      setSelected(new Set(data.games.map((_, i) => i)));
    } catch (err) {
      setError('Network error — please try again');
    } finally {
      setUploading(false);
    }
  };

  const toggleGame = (index) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(games.map((_, i) => i)));
  const deselectAll = () => setSelected(new Set());

  const handleImport = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const approved_games = games.filter((_, i) => selected.has(i));
      const res = await fetch('/api/launchers/amazon/import', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved_games }),
      });
      const result = await res.json();
      if (res.ok) {
        queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
        navigate('/settings', {
          state: { flash: `Imported ${result.imported} Amazon games.` },
        });
      } else {
        setError(result.error || 'Import failed');
      }
    } catch (err) {
      setError('Network error — please try again');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto p-6">
      <button
        onClick={() => navigate('/settings')}
        className="flex items-center gap-1 text-gray-400 hover:text-white mb-4 transition-colors"
      >
        <ArrowLeft size={16} /> Back to Settings
      </button>

      <h1 className="text-xl font-bold text-white mb-2">Amazon Games Import</h1>
      <p className="text-sm text-gray-400 mb-4">
        Upload your <code className="text-gray-300">games.db</code> file from{' '}
        <code className="text-gray-300">%LocalAppData%\Amazon Games\Data\</code> to import your library.
      </p>

      {error && (
        <div className="bg-red-900/50 border border-red-700 text-red-300 text-sm rounded-lg p-3 mb-4">
          {error}
        </div>
      )}

      {!games ? (
        <label className="flex items-center justify-center gap-2 px-4 py-8 border-2 border-dashed border-gray-600 rounded-lg cursor-pointer hover:border-gray-500 transition-colors">
          <Upload size={20} className="text-gray-400" />
          <span className="text-gray-400">{uploading ? 'Parsing...' : 'Select games.db file'}</span>
          <input
            type="file"
            accept=".db"
            className="hidden"
            onChange={handleFileUpload}
            disabled={uploading}
          />
        </label>
      ) : (
        <>
          <div className="flex items-center gap-3 mb-4">
            <button
              onClick={selectAll}
              className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
            >
              <CheckSquare size={14} /> Select All
            </button>
            <button
              onClick={deselectAll}
              className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
            >
              <Square size={14} /> Deselect All
            </button>
            <span className="text-sm text-gray-500">
              {selected.size} of {games.length} selected
            </span>
          </div>

          <div className="space-y-1 mb-6">
            {games.map((game, i) => (
              <label
                key={game.launcher_game_id}
                className="flex items-center gap-3 p-2 rounded hover:bg-gray-800 cursor-pointer transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selected.has(i)}
                  onChange={() => toggleGame(i)}
                  className="w-4 h-4 rounded border-gray-600 text-blue-600 focus:ring-blue-500 bg-gray-700"
                />
                <span className="text-sm text-white">{game.title}</span>
              </label>
            ))}
          </div>

          <div className="sticky bottom-0 bg-gray-900 border-t border-gray-700 p-4 -mx-6 px-6 flex items-center gap-3">
            <button
              onClick={handleImport}
              disabled={selected.size === 0 || submitting}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm rounded transition-colors"
            >
              {submitting ? 'Importing...' : `Import ${selected.size} game${selected.size !== 1 ? 's' : ''}`}
            </button>
            <button
              onClick={() => { setGames(null); setSelected(new Set()); setError(null); }}
              className="px-4 py-2 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
            >
              Upload Different File
            </button>
          </div>
        </>
      )}
    </div>
  );
}
