import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Loader2, X, Plus, Pencil, RefreshCw, Upload, RotateCcw } from 'lucide-react';
import LauncherBadge from '../components/LauncherBadge';
import CachePanel from '../components/cache/CachePanel';

function formatPlaytime(minutes) {
  if (!minutes || minutes <= 0) return 'Never played';
  const hours = Math.round(minutes / 60);
  return hours > 0 ? `${hours} hours played` : `${minutes} minutes played`;
}

export default function GameDetail() {
  const { id } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [showFullDesc, setShowFullDesc] = useState(false);
  const [showTagInput, setShowTagInput] = useState(false);
  const [tagSearch, setTagSearch] = useState('');
  const [confirmRemoveTag, setConfirmRemoveTag] = useState(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState('');
  const [enriching, setEnriching] = useState(false);
  const [showDLC, setShowDLC] = useState(false);
  const [editingDescription, setEditingDescription] = useState(false);
  const [descriptionInput, setDescriptionInput] = useState('');
  const [uploadingCover, setUploadingCover] = useState(false);

  const { data: game, isLoading, error } = useQuery({
    queryKey: ['game', id],
    queryFn: () => fetch(`/api/games/${id}`, { credentials: 'same-origin' }).then(r => {
      if (!r.ok) throw new Error('Game not found');
      return r.json();
    }),
  });

  const { data: allTags } = useQuery({
    queryKey: ['tags'],
    queryFn: () => fetch('/api/tags', { credentials: 'same-origin' }).then(r => r.json()),
    enabled: !!game,
  });

  const userTags = game?.tags?.filter(t => !game.genres?.includes(t.name)) || [];

  async function updateGameTags(newTagIds) {
    await fetch(`/api/games/${id}/tags`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ tagIds: newTagIds }),
    });
    queryClient.invalidateQueries({ queryKey: ['game', id] });
    queryClient.invalidateQueries({ queryKey: ['gameFilters'] });
    queryClient.invalidateQueries({ queryKey: ['tags'] });
  }

  async function removeTag(tagId) {
    const remaining = userTags.filter(t => t.id !== tagId).map(t => t.id);
    await updateGameTags(remaining);
    setConfirmRemoveTag(null);
  }

  async function addTag(tagId) {
    const current = userTags.map(t => t.id);
    if (!current.includes(tagId)) {
      await updateGameTags([...current, tagId]);
    }
    setShowTagInput(false);
    setTagSearch('');
  }

  async function createAndAddTag(name) {
    const res = await fetch('/api/tags', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      const newTag = await res.json();
      await addTag(newTag.id);
    }
  }

  async function saveTitle() {
    if (!titleInput.trim()) return;
    const res = await fetch(`/api/games/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ title: titleInput.trim() }),
    });
    if (res.ok) {
      setEditingTitle(false);
      queryClient.invalidateQueries({ queryKey: ['game', id] });
      queryClient.invalidateQueries({ queryKey: ['games'] });
    }
  }

  async function reEnrich() {
    setEnriching(true);
    await fetch(`/api/metadata/re-enrich/${id}`, {
      method: 'POST',
      credentials: 'same-origin',
    });
    setEnriching(false);
    queryClient.invalidateQueries({ queryKey: ['game', id] });
    queryClient.invalidateQueries({ queryKey: ['games'] });
  }

  async function saveDescription() {
    const res = await fetch(`/api/games/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ description: descriptionInput }),
    });
    if (res.ok) {
      setEditingDescription(false);
      queryClient.invalidateQueries({ queryKey: ['game', id] });
    }
  }

  async function uploadCover(file) {
    setUploadingCover(true);
    const formData = new FormData();
    formData.append('cover', file);
    const res = await fetch(`/api/games/${id}/cover`, {
      method: 'POST',
      credentials: 'same-origin',
      body: formData,
    });
    setUploadingCover(false);
    if (res.ok) {
      queryClient.invalidateQueries({ queryKey: ['game', id] });
      queryClient.invalidateQueries({ queryKey: ['games'] });
    }
  }

  async function resetOverride(field) {
    await fetch(`/api/games/${id}/manual-override`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify({ field }),
    });
    queryClient.invalidateQueries({ queryKey: ['game', id] });
  }

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <Loader2 size={24} className="animate-spin text-gray-400" />
      </div>
    );
  }

  if (error || !game) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="text-center">
          <p className="text-gray-400 text-lg mb-4">Game not found</p>
          <button onClick={() => navigate(-1)} className="text-blue-400 hover:text-blue-300">Go back</button>
        </div>
      </div>
    );
  }

  const primaryEdition = game.editions?.find(e => e.is_display_edition);
  const heroUrl = game.hero_url || game.cover_url;

  return (
    <div className="min-h-screen bg-gray-900 text-white">
      {/* Hero banner */}
      <div className="relative h-64 md:h-80 overflow-hidden">
        {heroUrl ? (
          <>
            <img src={heroUrl} alt="" className="w-full h-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-gray-900 via-gray-900/60 to-transparent" />
          </>
        ) : (
          <div className="w-full h-full bg-gray-800" />
        )}

        {/* Back button */}
        <button
          onClick={() => navigate(-1)}
          className="absolute top-4 left-4 flex items-center gap-1 bg-black/50 text-white px-3 py-1.5 rounded-lg text-sm hover:bg-black/70"
        >
          <ArrowLeft size={16} /> Back
        </button>

        {/* Cover + title overlay */}
        <div className="absolute bottom-0 left-0 right-0 px-6 pb-4 flex items-end gap-4">
          <div className="relative group -mb-8 z-10">
            {game.cover_url ? (
              <img
                src={game.cover_url}
                alt={game.title}
                className="w-24 md:w-32 rounded-lg shadow-lg border-2 border-gray-700"
              />
            ) : (
              <div className="w-24 md:w-32 h-32 md:h-44 rounded-lg border-2 border-dashed border-gray-600 flex items-center justify-center bg-gray-800">
                <Upload size={20} className="text-gray-500" />
              </div>
            )}
            <label className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 rounded-lg cursor-pointer transition-opacity">
              {uploadingCover ? (
                <Loader2 size={20} className="animate-spin text-white" />
              ) : (
                <Upload size={20} className="text-white" />
              )}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={e => { if (e.target.files[0]) uploadCover(e.target.files[0]); }}
              />
            </label>
            {game.manual_cover === 1 && (
              <button
                onClick={() => resetOverride('cover')}
                className="absolute -top-2 -right-2 bg-gray-700 hover:bg-gray-600 rounded-full p-1 z-20"
                title="Reset to auto-enriched cover"
              >
                <RotateCcw size={10} className="text-gray-300" />
              </button>
            )}
          </div>
          <div className="pb-2">
            <div className="flex items-center gap-2">
              {editingTitle ? (
                <div className="flex items-center gap-2">
                  <input
                    type="text"
                    value={titleInput}
                    onChange={e => setTitleInput(e.target.value)}
                    onKeyDown={e => e.key === 'Enter' && saveTitle()}
                    autoFocus
                    className="text-2xl font-bold bg-gray-800 border border-gray-600 rounded px-2 py-1 text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <button onClick={saveTitle} className="text-green-400 hover:text-green-300 text-sm">Save</button>
                  <button onClick={() => setEditingTitle(false)} className="text-gray-400 hover:text-white text-sm">Cancel</button>
                </div>
              ) : (
                <>
                  <h1 className="text-2xl md:text-3xl font-bold">{game.title}</h1>
                  <button onClick={() => { setEditingTitle(true); setTitleInput(game.title); }} className="text-gray-500 hover:text-white"><Pencil size={14} /></button>
                  <button onClick={reEnrich} disabled={enriching} className="text-gray-500 hover:text-blue-400" title="Re-enrich metadata">
                    {enriching ? <Loader2 size={14} className="animate-spin" /> : <RefreshCw size={14} />}
                  </button>
                </>
              )}
            </div>
            <div className="flex items-center gap-2 text-sm text-gray-400 mt-1">
              {game.developer && <span>{game.developer}</span>}
              {game.developer && game.publisher && game.developer !== game.publisher && (
                <><span className="text-gray-600">|</span><span>{game.publisher}</span></>
              )}
              {game.release_year && <><span className="text-gray-600">|</span><span>{game.release_year}</span></>}
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="px-6 pt-12 pb-8 max-w-4xl">
        {/* Genre chips (read-only) + editable tag chips */}
        <div className="flex flex-wrap gap-2 mb-4">
          {game.genres?.map(g => (
            <span key={g} className="bg-blue-600/20 text-blue-400 px-2.5 py-1 rounded-full text-xs">{g}</span>
          ))}

          {userTags.map(t => (
            <span key={t.id} className="bg-gray-700 text-gray-300 px-2.5 py-1 rounded-full text-xs inline-flex items-center gap-1">
              {t.name}
              <button onClick={() => setConfirmRemoveTag(t)} className="hover:text-red-400"><X size={12} /></button>
            </span>
          ))}

          <div className="relative">
            <button onClick={() => setShowTagInput(!showTagInput)} className="bg-gray-700 hover:bg-gray-600 text-gray-400 px-2.5 py-1 rounded-full text-xs inline-flex items-center gap-1">
              <Plus size={12} /> Add tag
            </button>
            {showTagInput && (
              <div className="absolute top-full left-0 mt-1 bg-gray-800 border border-gray-600 rounded-lg shadow-lg z-20 w-48">
                <input
                  type="text"
                  placeholder="Search or create..."
                  value={tagSearch}
                  onChange={e => setTagSearch(e.target.value)}
                  autoFocus
                  className="w-full px-3 py-2 bg-transparent border-b border-gray-700 text-white text-xs focus:outline-none"
                />
                <div className="max-h-32 overflow-y-auto">
                  {(allTags || [])
                    .filter(t => !userTags.some(ut => ut.id === t.id) && !game.genres?.includes(t.name))
                    .filter(t => !tagSearch || t.name.toLowerCase().includes(tagSearch.toLowerCase()))
                    .map(t => (
                      <button key={t.id} onClick={() => addTag(t.id)} className="w-full text-left px-3 py-1.5 text-xs text-gray-300 hover:bg-gray-700">{t.name}</button>
                    ))}
                  {tagSearch.trim() && !(allTags || []).some(t => t.name.toLowerCase() === tagSearch.trim().toLowerCase()) && (
                    <button onClick={() => createAndAddTag(tagSearch.trim())} className="w-full text-left px-3 py-1.5 text-xs text-blue-400 hover:bg-gray-700">Create &quot;{tagSearch.trim()}&quot;</button>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Confirm tag removal dialog */}
        {confirmRemoveTag && (
          <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
            <div className="bg-gray-800 rounded-lg p-6 max-w-sm mx-4">
              <h3 className="text-white font-medium mb-2">Remove Tag</h3>
              <p className="text-gray-400 text-sm mb-4">Remove tag &quot;{confirmRemoveTag.name}&quot; from this game?</p>
              <div className="flex gap-2 justify-end">
                <button onClick={() => setConfirmRemoveTag(null)} className="px-3 py-1.5 bg-gray-700 hover:bg-gray-600 text-sm rounded">Cancel</button>
                <button onClick={() => removeTag(confirmRemoveTag.id)} className="px-3 py-1.5 bg-red-600 hover:bg-red-700 text-white text-sm rounded">Remove</button>
              </div>
            </div>
          </div>
        )}

        {/* Description */}
        <div className="mb-6">
          {editingDescription ? (
            <div>
              <textarea
                value={descriptionInput}
                onChange={e => setDescriptionInput(e.target.value)}
                rows={5}
                className="w-full bg-gray-800 border border-gray-600 rounded-lg px-3 py-2 text-gray-300 text-sm leading-relaxed focus:outline-none focus:ring-2 focus:ring-blue-500 resize-y"
                placeholder="Enter a description..."
                autoFocus
              />
              <div className="flex gap-2 mt-2">
                <button onClick={saveDescription} className="text-green-400 hover:text-green-300 text-sm">Save</button>
                <button onClick={() => setEditingDescription(false)} className="text-gray-400 hover:text-white text-sm">Cancel</button>
              </div>
            </div>
          ) : game.description ? (
            <div>
              <div className="flex items-start gap-2">
                <p className={`text-gray-300 text-sm leading-relaxed flex-1 ${!showFullDesc ? 'line-clamp-4' : ''}`}>
                  {game.description}
                </p>
                <button
                  onClick={() => { setEditingDescription(true); setDescriptionInput(game.description); }}
                  className="text-gray-500 hover:text-white flex-shrink-0 mt-0.5"
                >
                  <Pencil size={12} />
                </button>
              </div>
              <div className="flex items-center gap-2">
                {game.description.length > 200 && (
                  <button
                    onClick={() => setShowFullDesc(!showFullDesc)}
                    className="text-blue-400 text-sm mt-1 hover:text-blue-300"
                  >
                    {showFullDesc ? 'Show less' : 'Read more'}
                  </button>
                )}
                {game.manual_description === 1 && (
                  <button
                    onClick={() => resetOverride('description')}
                    className="text-gray-500 hover:text-amber-400 text-xs mt-1 inline-flex items-center gap-1"
                    title="Reset to auto-enriched description"
                  >
                    <RotateCcw size={10} /> Manual
                  </button>
                )}
              </div>
            </div>
          ) : (
            <button
              onClick={() => { setEditingDescription(true); setDescriptionInput(''); }}
              className="text-gray-500 hover:text-blue-400 text-sm inline-flex items-center gap-1"
            >
              <Plus size={14} /> Add description
            </button>
          )}
        </div>

        {/* Lancache cache status (F15) */}
        {game.editions?.length > 0 && <CachePanel editions={game.editions} />}

        {/* Versions & Editions */}
        {game.editions?.length > 0 && (
          <div>
            <h2 className="text-lg font-semibold mb-3">Versions & Editions</h2>
            <div className="space-y-2">
              {game.editions.map(edition => (
                <div
                  key={edition.id}
                  className={`flex items-center justify-between p-3 rounded-lg ${
                    edition.is_display_edition
                      ? 'bg-blue-900/30 border border-blue-700'
                      : 'bg-gray-800'
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <LauncherBadge
                      launcherName={edition.launcher_name}
                      displayName={edition.launcher_display_name}
                      primary={edition.is_display_edition}
                    />
                    <div>
                      <span className="text-white text-sm">{edition.edition_title || game.title}</span>
                      {edition.tier > 0 && (
                        <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-purple-800 text-purple-200">
                          {edition.tier_label}
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    {edition.playtime_minutes > 0 && (
                      <span className="text-gray-400 text-sm">{formatPlaytime(edition.playtime_minutes)}</span>
                    )}
                    {edition.launcher_url && (
                      <a
                        href={edition.launcher_url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={e => e.stopPropagation()}
                        className="text-xs text-blue-400 hover:text-blue-300"
                      >
                        View in store
                      </a>
                    )}
                    {!edition.is_display_edition && (
                      <button
                        onClick={async () => {
                          await fetch(`/api/games/${game.id}/display-edition`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            credentials: 'same-origin',
                            body: JSON.stringify({ edition_id: edition.id }),
                          });
                          queryClient.invalidateQueries({ queryKey: ['game', id] });
                          queryClient.invalidateQueries({ queryKey: ['games'] });
                        }}
                        className="text-xs text-gray-500 hover:text-blue-400"
                      >
                        Set as display
                      </button>
                    )}
                    {game.has_prefill_choice && !edition.is_prefill_edition && (
                      <button
                        onClick={async () => {
                          await fetch(`/api/games/${game.id}/prefill-edition`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            credentials: 'same-origin',
                            body: JSON.stringify({ edition_id: edition.id }),
                          });
                          queryClient.invalidateQueries({ queryKey: ['game', id] });
                        }}
                        className="text-xs text-gray-500 hover:text-blue-400"
                        title="Cache this launcher's copy instead of the default (Steam). Display edition is unchanged."
                      >
                        Prefill this edition
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* DLC & Content */}
        {game.dlc && game.dlc.length > 0 && (
          <div className="mt-6">
            <button
              onClick={() => setShowDLC(!showDLC)}
              className="text-lg font-semibold text-white mb-3 flex items-center gap-2"
            >
              DLC & Content ({game.dlc.length})
              <span className="text-sm text-gray-400">{showDLC ? '\u25BC' : '\u25B6'}</span>
            </button>
            {showDLC && (
              <div className="space-y-1">
                {game.dlc.map(item => (
                  <div key={item.id} className="flex items-center gap-3 p-2 bg-gray-800 rounded">
                    <LauncherBadge
                      launcherName={item.launcher_name}
                      displayName={item.launcher_display_name}
                      size="small"
                    />
                    <span className="text-gray-300 text-sm">{item.edition_title}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
