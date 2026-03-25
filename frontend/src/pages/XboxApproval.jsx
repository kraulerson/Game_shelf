import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowLeft, CheckSquare, Square } from 'lucide-react';

export default function XboxApproval() {
  const navigate = useNavigate();
  const [selected, setSelected] = useState(new Set());
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState(null);

  const { data, isLoading } = useQuery({
    queryKey: ['xboxEditions'],
    queryFn: () =>
      fetch('/api/launchers/xbox/editions', {
        credentials: 'same-origin',
      }).then(r => r.json()),
  });

  const editions = data?.editions || [];

  const toggleGame = (editionId) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(editionId)) next.delete(editionId);
      else next.add(editionId);
      return next;
    });
  };

  const selectAll = () => {
    setSelected(new Set(editions.map(e => e.edition_id)));
  };

  const deselectAll = () => {
    setSelected(new Set());
  };

  const deleteCount = editions.length - selected.size;

  const handleSave = async () => {
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetch('/api/launchers/xbox/approve', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          approved_edition_ids: [...selected],
        }),
      });
      const result = await res.json();
      if (res.ok) {
        navigate('/settings', {
          state: {
            flash: `Approved ${selected.size} games. Removed ${result.deleted_editions} editions and ${result.deleted_games} games.`,
          },
        });
      } else {
        setError(result.error || 'Approval failed');
      }
    } catch (err) {
      setError('Network error — please try again');
    } finally {
      setSubmitting(false);
      setConfirmDelete(false);
    }
  };

  if (isLoading) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <p className="text-gray-400">Loading Xbox games...</p>
      </div>
    );
  }

  if (editions.length === 0) {
    return (
      <div className="max-w-3xl mx-auto p-6">
        <button
          onClick={() => navigate('/settings')}
          className="flex items-center gap-1 text-gray-400 hover:text-white mb-4 transition-colors"
        >
          <ArrowLeft size={16} /> Back to Settings
        </button>
        <h1 className="text-xl font-bold text-white mb-4">Xbox Game Approval</h1>
        <p className="text-gray-400">No Xbox games to review.</p>
      </div>
    );
  }

  return (
    <div className="max-w-3xl mx-auto p-6">
      <button
        onClick={() => navigate('/settings')}
        className="flex items-center gap-1 text-gray-400 hover:text-white mb-4 transition-colors"
      >
        <ArrowLeft size={16} /> Back to Settings
      </button>

      <h1 className="text-xl font-bold text-white mb-2">Xbox Game Approval</h1>
      <p className="text-sm text-gray-400 mb-4">
        Check the games you own. Unchecked games will be permanently deleted.
      </p>

      {error && (
        <div className="bg-red-900/50 border border-red-700 text-red-300 text-sm rounded-lg p-3 mb-4">
          {error}
        </div>
      )}

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
          {selected.size} of {editions.length} selected
        </span>
      </div>

      <div className="space-y-1 mb-6">
        {editions.map(edition => (
          <label
            key={edition.edition_id}
            className="flex items-center gap-3 p-2 rounded hover:bg-gray-800 cursor-pointer transition-colors"
          >
            <input
              type="checkbox"
              checked={selected.has(edition.edition_id)}
              onChange={() => toggleGame(edition.edition_id)}
              className="w-4 h-4 rounded border-gray-600 text-blue-600 focus:ring-blue-500 bg-gray-700"
            />
            {edition.cover_url && (
              <img
                src={edition.cover_url}
                alt=""
                className="w-8 h-10 object-cover rounded"
              />
            )}
            <span className="text-sm text-white">{edition.title}</span>
          </label>
        ))}
      </div>

      <div className="sticky bottom-0 bg-gray-900 border-t border-gray-700 p-4 -mx-6 px-6">
        <button
          onClick={() => setConfirmDelete(true)}
          disabled={selected.size === 0 || deleteCount === 0 || submitting}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:text-gray-500 text-white text-sm rounded transition-colors"
        >
          {deleteCount === 0
            ? 'Save (all approved)'
            : `Save (${deleteCount} game${deleteCount !== 1 ? 's' : ''} will be deleted)`}
        </button>
      </div>

      {/* Confirmation dialog */}
      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-sm mx-4">
            <h3 className="text-white font-medium mb-2">Confirm Deletion</h3>
            <p className="text-gray-400 text-sm mb-4">
              Delete {deleteCount} Xbox game{deleteCount !== 1 ? 's' : ''}? This cannot be undone (re-sync to recover).
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmDelete(false)}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={submitting}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded transition-colors"
              >
                {submitting ? 'Deleting...' : 'Delete'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
