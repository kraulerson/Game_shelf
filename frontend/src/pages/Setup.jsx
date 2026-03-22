import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { QRCodeSVG } from 'qrcode.react';
import { DndContext, closestCenter, KeyboardSensor, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy, useSortable, arrayMove } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';

function SortableItem({ launcher, index }) {
  const { attributes, listeners, setNodeRef, transform, transition } = useSortable({ id: launcher.id });

  const style = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      {...attributes}
      {...listeners}
      className="flex items-center gap-3 bg-gray-800 rounded-lg p-3 cursor-grab active:cursor-grabbing"
    >
      <span className="text-gray-500 font-mono text-sm w-6">{index + 1}</span>
      <span className="text-white">{launcher.display_name}</span>
      <span className="text-gray-500 text-xs ml-auto">drag to reorder</span>
    </div>
  );
}

export default function Setup() {
  const [step, setStep] = useState(1);
  const [availableLaunchers, setAvailableLaunchers] = useState([]);
  const [selectedLaunchers, setSelectedLaunchers] = useState([]);
  const [credentials, setCredentials] = useState({});
  const navigate = useNavigate();

  // Fetch available launchers on mount
  useEffect(() => {
    fetch('/api/launchers/available', { credentials: 'same-origin' })
      .then((res) => res.json())
      .then(setAvailableLaunchers)
      .catch(() => {});
  }, []);

  // dnd-kit sensors (must be at top level — hooks cannot be conditional)
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  );

  // Step 5 side effects — must be at top level per React hooks rules
  useEffect(() => {
    if (step === 5) {
      fetch('/api/setup/complete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      }).catch(() => {});

      fetch('/api/sync/all', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
      }).catch(() => {});

      const timer = setTimeout(() => navigate('/library'), 2000);
      return () => clearTimeout(timer);
    }
  }, [step, navigate]);

  function toggleLauncher(launcher) {
    setSelectedLaunchers((prev) => {
      const exists = prev.find((l) => l.id === launcher.id);
      if (exists) {
        return prev.filter((l) => l.id !== launcher.id);
      }
      return [...prev, launcher];
    });
  }

  // Step 1: Welcome
  if (step === 1) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center px-4">
        <div className="text-center max-w-md">
          <h1 className="text-4xl font-bold text-white mb-4">Welcome to Gameshelf</h1>
          <p className="text-gray-400 mb-8">
            Gameshelf unifies your game libraries from multiple launchers into a single view.
            Let&apos;s set up your accounts.
          </p>
          <button
            onClick={() => setStep(2)}
            className="px-6 py-3 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded-lg transition-colors"
          >
            Begin Setup
          </button>
        </div>
      </div>
    );
  }

  // Step 2: Select Launchers
  if (step === 2) {
    return (
      <div className="min-h-screen bg-gray-900 px-4 py-8">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-2xl font-bold text-white mb-2">Select Your Launchers</h2>
          <p className="text-gray-400 mb-6">Choose which game stores you use.</p>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
            {availableLaunchers.map((launcher) => {
              const isSelected = selectedLaunchers.some((l) => l.id === launcher.id);
              return (
                <button
                  key={launcher.id}
                  onClick={() => toggleLauncher(launcher)}
                  className={`p-4 rounded-lg border-2 text-left transition-colors ${
                    isSelected
                      ? 'border-blue-500 bg-gray-800'
                      : 'border-gray-700 bg-gray-800 hover:border-gray-500'
                  }`}
                >
                  <div className="text-white font-medium">{launcher.display_name}</div>
                  <div className="text-xs text-gray-400 mt-1">
                    {launcher.auth_type === 'api_key' ? 'API Key' : 'Username/Password'}
                    {launcher.otp_supported && ' + 2FA'}
                  </div>
                </button>
              );
            })}
          </div>

          <div className="flex justify-between">
            <button
              onClick={() => setStep(1)}
              className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
            >
              Back
            </button>
            <button
              onClick={() => setStep(3)}
              disabled={selectedLaunchers.length === 0}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium rounded transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Step 3: Configure Credentials
  if (step === 3) {
    async function saveCredentials(launcher) {
      const creds = credentials[launcher.id] || {};
      try {
        const res = await fetch(`/api/launchers/${launcher.id}/credentials`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(creds),
        });
        if (res.ok) {
          setCredentials((prev) => ({
            ...prev,
            [launcher.id]: { ...prev[launcher.id], saved: true, error: '' },
          }));
        } else {
          const data = await res.json();
          setCredentials((prev) => ({
            ...prev,
            [launcher.id]: { ...prev[launcher.id], saved: false, error: data.error || 'Failed to save' },
          }));
        }
      } catch {
        setCredentials((prev) => ({
          ...prev,
          [launcher.id]: { ...prev[launcher.id], saved: false, error: 'Network error' },
        }));
      }
    }

    async function testConnection(launcher) {
      setCredentials((prev) => ({
        ...prev,
        [launcher.id]: { ...prev[launcher.id], testing: true, testResult: null },
      }));
      try {
        const res = await fetch(`/api/launchers/${launcher.id}/test`, { credentials: 'same-origin' });
        const data = await res.json();
        setCredentials((prev) => ({
          ...prev,
          [launcher.id]: { ...prev[launcher.id], testing: false, testResult: data },
        }));
      } catch {
        setCredentials((prev) => ({
          ...prev,
          [launcher.id]: { ...prev[launcher.id], testing: false, testResult: { success: false, error: 'Network error' } },
        }));
      }
    }

    async function loadQR(launcher) {
      try {
        const res = await fetch(`/api/setup/qr/${launcher.id}`, { credentials: 'same-origin' });
        const data = await res.json();
        setCredentials((prev) => ({
          ...prev,
          [launcher.id]: { ...prev[launcher.id], qrUri: data.uri },
        }));
      } catch {
        // QR load failed silently
      }
    }

    function updateField(launcherId, field, value) {
      setCredentials((prev) => ({
        ...prev,
        [launcherId]: { ...prev[launcherId], [field]: value, saved: false },
      }));
    }

    const allSaved = selectedLaunchers.every((l) => credentials[l.id]?.saved);

    return (
      <div className="min-h-screen bg-gray-900 px-4 py-8">
        <div className="max-w-2xl mx-auto">
          <h2 className="text-2xl font-bold text-white mb-2">Configure Credentials</h2>
          <p className="text-gray-400 mb-6">Enter your login details for each launcher.</p>

          <div className="space-y-6">
            {selectedLaunchers.map((launcher) => {
              const creds = credentials[launcher.id] || {};
              const showCredentials = launcher.auth_type.includes('credentials');
              const showApiKey = launcher.auth_type === 'api_key';

              return (
                <div key={launcher.id} className="bg-gray-800 rounded-lg p-4">
                  <h3 className="text-lg font-semibold text-white mb-3">{launcher.display_name}</h3>

                  {showCredentials && (
                    <>
                      <div className="mb-3">
                        <label className="block text-sm text-gray-300 mb-1">Username</label>
                        <input
                          type="text"
                          value={creds.username || ''}
                          onChange={(e) => updateField(launcher.id, 'username', e.target.value)}
                          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                      <div className="mb-3">
                        <label className="block text-sm text-gray-300 mb-1">Password</label>
                        <input
                          type="password"
                          value={creds.password || ''}
                          onChange={(e) => updateField(launcher.id, 'password', e.target.value)}
                          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                        />
                      </div>
                    </>
                  )}

                  {showApiKey && (
                    <div className="mb-3">
                      <label className="block text-sm text-gray-300 mb-1">API Key</label>
                      <input
                        type="password"
                        value={creds.api_key || ''}
                        onChange={(e) => updateField(launcher.id, 'api_key', e.target.value)}
                        className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                      />
                    </div>
                  )}

                  {launcher.otp_supported && (
                    <div className="mb-3">
                      <label className="flex items-center gap-2 text-sm text-gray-300 mb-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={!!creds.totpEnabled}
                          onChange={(e) => updateField(launcher.id, 'totpEnabled', e.target.checked)}
                          className="rounded"
                        />
                        Enable 2FA
                      </label>

                      {creds.totpEnabled && (
                        <div className="ml-4 space-y-2">
                          {launcher.id === 'steam' && (
                            <div className="text-yellow-400 text-xs bg-yellow-400/10 p-2 rounded">
                              Steam Guard requires scanning with the Steam Mobile App. Enter your
                              shared_secret from an already-linked authenticator or use the Steam
                              Desktop Authenticator tool to export it.
                            </div>
                          )}
                          <div>
                            <label className="block text-sm text-gray-300 mb-1">TOTP Secret</label>
                            <input
                              type="text"
                              value={creds.totp_secret || ''}
                              onChange={(e) => updateField(launcher.id, 'totp_secret', e.target.value)}
                              className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          </div>
                          {creds.saved && (
                            <button
                              onClick={() => loadQR(launcher)}
                              className="text-sm text-blue-400 hover:text-blue-300"
                            >
                              Or scan QR code
                            </button>
                          )}
                          {creds.qrUri && (
                            <div className="bg-white p-3 rounded inline-block">
                              <QRCodeSVG value={creds.qrUri} size={160} />
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}

                  {creds.error && <p className="text-red-400 text-sm mb-2">{creds.error}</p>}
                  {creds.saved && <p className="text-green-400 text-sm mb-2">Saved</p>}

                  {creds.testResult && (
                    <p className={`text-sm mb-2 ${creds.testResult.success ? 'text-green-400' : 'text-red-400'}`}>
                      {creds.testResult.success ? creds.testResult.message : creds.testResult.error}
                    </p>
                  )}

                  <div className="flex gap-2">
                    <button
                      onClick={() => saveCredentials(launcher)}
                      className="px-4 py-1.5 bg-blue-600 hover:bg-blue-700 text-white text-sm rounded transition-colors"
                    >
                      Save
                    </button>
                    {creds.saved && (
                      <button
                        onClick={() => testConnection(launcher)}
                        disabled={creds.testing}
                        className="px-4 py-1.5 bg-gray-600 hover:bg-gray-500 disabled:bg-gray-700 text-white text-sm rounded transition-colors"
                      >
                        {creds.testing ? 'Testing...' : 'Test Connection'}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="flex justify-between mt-8">
            <button
              onClick={() => setStep(2)}
              className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
            >
              Back
            </button>
            <button
              onClick={() => setStep(4)}
              disabled={!allSaved}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 disabled:bg-gray-700 disabled:cursor-not-allowed text-white font-medium rounded transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Step 4: Launcher Priority
  if (step === 4) {
    function handleDragEnd(event) {
      const { active, over } = event;
      if (active.id !== over?.id) {
        setSelectedLaunchers((items) => {
          const oldIndex = items.findIndex((i) => i.id === active.id);
          const newIndex = items.findIndex((i) => i.id === over.id);
          return arrayMove(items, oldIndex, newIndex);
        });
      }
    }

    async function savePriorities() {
      const priorities = selectedLaunchers.map((l, i) => ({ name: l.id, priority: i + 1 }));
      try {
        await fetch('/api/launchers/priority', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(priorities),
        });
        setStep(5);
      } catch {
        // Priority save failed — proceed anyway
        setStep(5);
      }
    }

    return (
      <div className="min-h-screen bg-gray-900 px-4 py-8">
        <div className="max-w-md mx-auto">
          <h2 className="text-2xl font-bold text-white mb-2">Launcher Priority</h2>
          <p className="text-gray-400 mb-6">
            Drag to set deduplication priority. The top launcher wins when the same game appears in multiple stores.
          </p>

          <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={handleDragEnd}>
            <SortableContext items={selectedLaunchers.map((l) => l.id)} strategy={verticalListSortingStrategy}>
              <div className="space-y-2">
                {selectedLaunchers.map((launcher, index) => (
                  <SortableItem key={launcher.id} launcher={launcher} index={index} />
                ))}
              </div>
            </SortableContext>
          </DndContext>

          <div className="flex justify-between mt-8">
            <button
              onClick={() => setStep(3)}
              className="px-4 py-2 text-gray-400 hover:text-white transition-colors"
            >
              Back
            </button>
            <button
              onClick={savePriorities}
              className="px-6 py-2 bg-blue-600 hover:bg-blue-700 text-white font-medium rounded transition-colors"
            >
              Next
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Step 5: Done (useEffect for side effects is at top level of component)
  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center px-4">
      <div className="text-center max-w-md">
        <h1 className="text-4xl font-bold text-white mb-4">You&apos;re All Set!</h1>
        <p className="text-gray-400">
          Gameshelf is ready. Your library is syncing now.
        </p>
      </div>
    </div>
  );
}
