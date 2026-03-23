import { useState, useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Loader2, RefreshCw } from 'lucide-react';
import LauncherBadge from '../components/LauncherBadge';

function LaunchersTab() {
  const queryClient = useQueryClient();
  const [confirmRemove, setConfirmRemove] = useState(null);

  const { data: launchers } = useQuery({
    queryKey: ['launchersAvailable'],
    queryFn: () => fetch('/api/launchers/available', { credentials: 'same-origin' }).then(r => r.json()),
  });
  const { data: syncStatus } = useQuery({
    queryKey: ['syncStatus'],
    queryFn: () => fetch('/api/sync/status', { credentials: 'same-origin' }).then(r => r.json()),
    refetchInterval: 10000,
  });

  const statusMap = {};
  (syncStatus || []).forEach(j => { statusMap[j.launcher_name] = j; });

  async function syncLauncher(name) {
    await fetch(`/api/sync/${name}`, { method: 'POST', credentials: 'same-origin' });
    queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
  }

  async function removeLauncher(name) {
    await fetch(`/api/launchers/${name}/credentials`, { method: 'DELETE', credentials: 'same-origin' });
    setConfirmRemove(null);
    queryClient.invalidateQueries({ queryKey: ['launchersAvailable'] });
    queryClient.invalidateQueries({ queryKey: ['syncStatus'] });
    queryClient.invalidateQueries({ queryKey: ['games'] });
  }

  return (
    <div className="space-y-3">
      {(launchers || []).map(l => {
        const status = statusMap[l.id];
        return (
          <div key={l.id} className="bg-gray-800 rounded-lg p-4 flex items-center justify-between">
            <div className="flex items-center gap-3">
              <LauncherBadge launcherName={l.id} displayName={l.display_name} primary />
              <div>
                <div className="text-sm text-white">{l.display_name}</div>
                <div className="text-xs text-gray-500">
                  {l.configured
                    ? (status?.completed_at ? `Last synced: ${new Date(status.completed_at).toLocaleString()}` : 'Configured — never synced')
                    : 'Not configured'}
                  {status?.status && l.configured && (
                    <span className={`ml-2 ${status.status === 'success' ? 'text-green-400' : status.status === 'failed' ? 'text-red-400' : 'text-yellow-400'}`}>
                      ({status.status})
                    </span>
                  )}
                </div>
              </div>
            </div>
            {l.configured && (
              <div className="flex items-center gap-2">
                <button
                  onClick={() => syncLauncher(l.id)}
                  className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
                >
                  <RefreshCw size={14} /> Sync
                </button>
                <button
                  onClick={() => setConfirmRemove(l.id)}
                  className="flex items-center gap-1 px-3 py-1.5 bg-red-900/50 hover:bg-red-800/50 text-red-400 text-sm rounded transition-colors"
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        );
      })}

      {/* Confirmation dialog */}
      {confirmRemove && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-sm mx-4">
            <h3 className="text-white font-medium mb-2">Remove Launcher</h3>
            <p className="text-gray-400 text-sm mb-4">
              Remove {launchers?.find(l => l.id === confirmRemove)?.display_name || confirmRemove} credentials? Your games will be hidden until you re-add credentials.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setConfirmRemove(null)}
                className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => removeLauncher(confirmRemove)}
                className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded transition-colors"
              >
                Remove
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function MetadataTab() {
  const { data: status } = useQuery({
    queryKey: ['metadataStatus'],
    queryFn: () => fetch('/api/metadata/status', { credentials: 'same-origin' }).then(r => r.json()),
  });
  const [enriching, setEnriching] = useState(false);

  async function handleEnrichAll() {
    setEnriching(true);
    await fetch('/api/metadata/enrich-all', { method: 'POST', credentials: 'same-origin' });
    setTimeout(() => setEnriching(false), 3000);
  }

  return (
    <div className="space-y-4">
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="text-sm text-gray-300 mb-2">
          {status ? `${status.unenriched} of ${status.total} games need metadata enrichment` : 'Loading...'}
        </div>
        <button
          onClick={handleEnrichAll}
          disabled={enriching}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-800 text-white text-sm rounded transition-colors"
        >
          {enriching ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
          {enriching ? 'Enriching...' : 'Re-enrich All'}
        </button>
      </div>
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-white font-medium mb-2">IGDB API Setup</h3>
        <p className="text-sm text-gray-400 mb-2">
          Gameshelf uses the IGDB API (via Twitch) for game metadata. To enable enrichment:
        </p>
        <ol className="text-sm text-gray-400 list-decimal list-inside space-y-1">
          <li>Create a Twitch developer application at dev.twitch.tv</li>
          <li>Set IGDB_CLIENT_ID and IGDB_CLIENT_SECRET in your .env file</li>
          <li>Restart Gameshelf to pick up the new credentials</li>
        </ol>
      </div>
    </div>
  );
}

function TagsTab() {
  const queryClient = useQueryClient();
  const [editingTag, setEditingTag] = useState(null);
  const [newTagName, setNewTagName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [search, setSearch] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [page, setPage] = useState(1);

  useEffect(() => {
    const timer = setTimeout(() => setDebouncedSearch(search), 300);
    return () => clearTimeout(timer);
  }, [search]);

  const { data: tags } = useQuery({
    queryKey: ['tags'],
    queryFn: () => fetch('/api/tags', { credentials: 'same-origin' }).then(r => r.json()),
  });

  const { data: tagGames } = useQuery({
    queryKey: ['tagGames', editingTag?.id, page, debouncedSearch],
    queryFn: () => fetch(`/api/tags/${editingTag.id}/games?page=${page}&limit=200&search=${encodeURIComponent(debouncedSearch)}`, { credentials: 'same-origin' }).then(r => r.json()),
    enabled: !!editingTag,
  });

  async function createTag() {
    const trimmed = newTagName.trim();
    if (!trimmed) return;
    const res = await fetch('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ name: trimmed }),
    });
    if (res.ok) {
      setNewTagName('');
      queryClient.invalidateQueries({ queryKey: ['tags'] });
      queryClient.invalidateQueries({ queryKey: ['gameFilters'] });
    }
  }

  async function deleteTag(id) {
    await fetch(`/api/tags/${id}`, { method: 'DELETE', credentials: 'same-origin' });
    setConfirmDelete(null);
    queryClient.invalidateQueries({ queryKey: ['tags'] });
    queryClient.invalidateQueries({ queryKey: ['gameFilters'] });
  }

  async function toggleGame(gameId, tagged) {
    const body = tagged ? { remove: [gameId] } : { add: [gameId] };
    await fetch(`/api/tags/${editingTag.id}/games`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(body),
    });
    queryClient.invalidateQueries({ queryKey: ['tagGames'] });
    queryClient.invalidateQueries({ queryKey: ['tags'] });
    queryClient.invalidateQueries({ queryKey: ['gameFilters'] });
  }

  // Bulk editor view
  if (editingTag) {
    const totalPages = tagGames ? Math.ceil(tagGames.total / tagGames.limit) : 1;
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-3">
            <button onClick={() => { setEditingTag(null); setSearch(''); setDebouncedSearch(''); setPage(1); }} className="text-blue-400 hover:text-blue-300 text-sm">&larr; Back to tags</button>
            <h3 className="text-white font-medium">{editingTag.name}</h3>
            {tagGames && <span className="text-xs text-gray-500">{tagGames.taggedCount} of {tagGames.total} games tagged</span>}
          </div>
        </div>
        <input
          type="text"
          placeholder="Search games..."
          value={search}
          onChange={e => { setSearch(e.target.value); setPage(1); }}
          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <div className="space-y-1 max-h-[600px] overflow-y-auto">
          {(tagGames?.games || []).map(g => (
            <label key={g.edition_id} className="flex items-center gap-3 px-3 py-2 bg-gray-800 rounded cursor-pointer hover:bg-gray-750">
              <input
                type="checkbox"
                checked={!!g.tagged}
                onChange={() => toggleGame(g.game_id, g.tagged)}
                className="rounded"
              />
              {g.icon_url ? (
                <img src={g.icon_url} alt="" className="w-8 h-8 rounded object-cover flex-shrink-0" />
              ) : (
                <div className="w-8 h-8 rounded bg-gray-700 flex-shrink-0" />
              )}
              <span className="text-sm text-white flex-1 truncate">{g.title}</span>
              <LauncherBadge launcherName={g.launcher_name} displayName={g.launcher_display_name} />
            </label>
          ))}
        </div>
        {totalPages > 1 && (
          <div className="flex items-center justify-center gap-3 pt-2">
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-3 py-1 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-sm rounded">Previous</button>
            <span className="text-sm text-gray-400">Page {page} of {totalPages}</span>
            <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="px-3 py-1 bg-gray-700 hover:bg-gray-600 disabled:opacity-50 text-sm rounded">Next</button>
          </div>
        )}
      </div>
    );
  }

  // Tag list view
  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <input
          type="text"
          placeholder="New tag name..."
          value={newTagName}
          onChange={e => setNewTagName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && createTag()}
          maxLength={50}
          className="flex-1 px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <button onClick={createTag} className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors">Create Tag</button>
      </div>

      {(tags || []).map(t => (
        <div key={t.id} className="bg-gray-800 rounded-lg p-3 flex items-center justify-between">
          <div>
            <span className="text-sm text-white">{t.name}</span>
            <span className="text-xs text-gray-500 ml-2">({t.gameCount} games)</span>
            {t.isGenre && <span className="text-xs text-yellow-600 ml-2">genre</span>}
          </div>
          <div className="flex items-center gap-2">
            <button onClick={() => { setEditingTag(t); setPage(1); setSearch(''); setDebouncedSearch(''); }} className="px-2 py-1 bg-gray-700 hover:bg-gray-600 text-sm rounded">Edit</button>
            {!t.isGenre && (
              <button onClick={() => setConfirmDelete(t)} className="px-2 py-1 bg-red-900/50 hover:bg-red-800/50 text-red-400 text-sm rounded">Delete</button>
            )}
          </div>
        </div>
      ))}

      {confirmDelete && (
        <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
          <div className="bg-gray-800 rounded-lg p-6 max-w-sm mx-4">
            <h3 className="text-white font-medium mb-2">Delete Tag</h3>
            <p className="text-gray-400 text-sm mb-4">Delete tag &quot;{confirmDelete.name}&quot;? It will be removed from all games.</p>
            <div className="flex gap-2 justify-end">
              <button onClick={() => setConfirmDelete(null)} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded">Cancel</button>
              <button onClick={() => deleteTag(confirmDelete.id)} className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded">Delete</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function AccountTab() {
  const navigate = useNavigate();
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);

  async function handleChangePassword(e) {
    e.preventDefault();
    setError('');
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match');
      return;
    }
    if (newPassword.length < 8) {
      setError('New password must be at least 8 characters');
      return;
    }

    const res = await fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ currentPassword, newPassword }),
    });

    if (!res.ok) {
      const data = await res.json();
      setError(data.error || 'Failed to change password');
      return;
    }

    setSuccess(true);
    setTimeout(() => navigate('/login'), 2000);
  }

  if (success) {
    return (
      <div className="bg-gray-800 rounded-lg p-4">
        <p className="text-green-400">Password changed. Please log in again.</p>
      </div>
    );
  }

  return (
    <form onSubmit={handleChangePassword} className="bg-gray-800 rounded-lg p-4 space-y-3 max-w-md">
      <h3 className="text-white font-medium">Change Password</h3>
      <div>
        <label className="block text-sm text-gray-300 mb-1">Current Password</label>
        <input
          type="password"
          value={currentPassword}
          onChange={e => setCurrentPassword(e.target.value)}
          required
          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <div>
        <label className="block text-sm text-gray-300 mb-1">New Password</label>
        <input
          type="password"
          value={newPassword}
          onChange={e => setNewPassword(e.target.value)}
          required
          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      <div>
        <label className="block text-sm text-gray-300 mb-1">Confirm New Password</label>
        <input
          type="password"
          value={confirmPassword}
          onChange={e => setConfirmPassword(e.target.value)}
          required
          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>
      {error && <p className="text-red-400 text-sm">{error}</p>}
      <button type="submit" className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors">
        Change Password
      </button>
    </form>
  );
}

export default function Settings() {
  const [tab, setTab] = useState('launchers');

  const tabClass = (t) =>
    `px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${
      tab === t ? 'text-white bg-gray-800 border-b-2 border-blue-500' : 'text-gray-400 hover:text-white'
    }`;

  return (
    <div className="min-h-screen bg-gray-900 text-white p-6">
      <h1 className="text-2xl font-bold mb-4">Settings</h1>

      <div className="flex gap-1 mb-4 border-b border-gray-800">
        <button onClick={() => setTab('launchers')} className={tabClass('launchers')}>Launchers</button>
        <button onClick={() => setTab('metadata')} className={tabClass('metadata')}>Metadata</button>
        <button onClick={() => setTab('tags')} className={tabClass('tags')}>Tags</button>
        <button onClick={() => setTab('account')} className={tabClass('account')}>Account</button>
      </div>

      {tab === 'launchers' && <LaunchersTab />}
      {tab === 'metadata' && <MetadataTab />}
      {tab === 'tags' && <TagsTab />}
      {tab === 'account' && <AccountTab />}
    </div>
  );
}
