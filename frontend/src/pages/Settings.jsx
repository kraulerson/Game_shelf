import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Loader2, RefreshCw } from 'lucide-react';
import LauncherBadge from '../components/LauncherBadge';

function LaunchersTab() {
  const queryClient = useQueryClient();
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
                  {status?.completed_at ? `Last synced: ${new Date(status.completed_at).toLocaleString()}` : 'Never synced'}
                  {status?.status && (
                    <span className={`ml-2 ${status.status === 'success' ? 'text-green-400' : status.status === 'failed' ? 'text-red-400' : 'text-yellow-400'}`}>
                      ({status.status})
                    </span>
                  )}
                </div>
              </div>
            </div>
            <button
              onClick={() => syncLauncher(l.id)}
              className="flex items-center gap-1 px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded transition-colors"
            >
              <RefreshCw size={14} /> Sync
            </button>
          </div>
        );
      })}
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
        <button onClick={() => setTab('account')} className={tabClass('account')}>Account</button>
      </div>

      {tab === 'launchers' && <LaunchersTab />}
      {tab === 'metadata' && <MetadataTab />}
      {tab === 'account' && <AccountTab />}
    </div>
  );
}
