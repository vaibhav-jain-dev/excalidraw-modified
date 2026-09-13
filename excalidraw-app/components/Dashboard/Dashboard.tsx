import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ServerData,
  type RemoteSceneMeta,
  type RemoteSceneSummary,
  type RemoteVersionInfo,
} from "../../data/ServerData";
import { routeToScene } from "../../data/route";

import "./Dashboard.scss";

const openScene = (id: string) => routeToScene(id);

const formatDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return iso.slice(0, 10);
  }
};

const formatDateTime = (iso: string) => {
  try {
    return new Date(iso).toLocaleString(undefined, {
      day: "numeric",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return iso;
  }
};

type EditState = {
  id: string | null;
  name: string;
  description: string;
  category: string;
};

const EMPTY_EDIT: EditState = {
  id: null,
  name: "",
  description: "",
  category: "",
};

const MetaDialog = ({
  edit,
  categories,
  onCancel,
  onSave,
}: {
  edit: EditState;
  categories: string[];
  onCancel: () => void;
  onSave: (meta: RemoteSceneMeta) => void;
}) => {
  const [name, setName] = useState(edit.name);
  const [description, setDescription] = useState(edit.description);
  const [category, setCategory] = useState(edit.category);
  const [temporary, setTemporary] = useState(false);
  const isNew = edit.id === null;

  return (
    <div className="dash-modal-backdrop" onClick={onCancel}>
      <div className="dash-modal" onClick={(event) => event.stopPropagation()}>
        <h2>{isNew ? "New drawing" : "Edit details"}</h2>
        <label>
          Title
          <input
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Untitled"
          />
        </label>
        <label>
          Description
          <textarea
            value={description}
            rows={3}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="What is this drawing about?"
          />
        </label>
        <label>
          Category
          <input
            value={category}
            list="dash-categories"
            onChange={(event) => setCategory(event.target.value)}
            placeholder="e.g. architecture"
          />
          <datalist id="dash-categories">
            {categories.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
        </label>
        {isNew && (
          <label className="dash-check">
            <input
              type="checkbox"
              checked={temporary}
              onChange={(event) => setTemporary(event.target.checked)}
            />
            Temporary — auto-deletes when idle 15 min / after 1 hour
          </label>
        )}
        <div className="dash-modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => onSave({ name, description, category, temporary })}
          >
            {isNew ? "Create & open" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
};

const VersionHistory = ({
  sceneId,
  sceneName,
  onClose,
  onOpenVersion,
}: {
  sceneId: string;
  sceneName: string;
  onClose: () => void;
  onOpenVersion: () => Promise<RemoteVersionInfo[]>;
}) => {
  const [versions, setVersions] = useState<RemoteVersionInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyVersion, setBusyVersion] = useState<number | null>(null);

  const load = useCallback(async () => {
    try {
      setVersions(await onOpenVersion());
    } catch (err: any) {
      setError(err?.message ?? "Could not load version history.");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="dash-modal-backdrop" onClick={onClose}>
      <div
        className="dash-modal dash-history"
        onClick={(event) => event.stopPropagation()}
      >
        <h2>History — {sceneName || "Untitled"}</h2>
        {error && <div className="dash-error">{error}</div>}
        {versions === null ? (
          <p className="dash-empty-inline">Loading…</p>
        ) : versions.length === 0 ? (
          <p className="dash-empty-inline">No saved versions yet.</p>
        ) : (
          <ul className="dash-history-list">
            {versions.map((version, index) => (
              <li key={version.version}>
                <div className="dash-history-info">
                  <span className="dash-history-version">
                    v{version.version}
                    {index === 0 && (
                      <span className="dash-history-latest">latest</span>
                    )}
                    {version.pinned && (
                      <span className="dash-history-pinned">pinned</span>
                    )}
                  </span>
                  <span className="dash-history-meta">
                    {formatDateTime(version.createdAt)} · {version.elementCount}{" "}
                    items · {version.source}
                  </span>
                </div>
                <div className="dash-history-actions">
                  <button
                    type="button"
                    disabled={index === 0 || busyVersion !== null}
                    onClick={async () => {
                      if (
                        !window.confirm(
                          `Restore v${version.version}? This becomes the new latest version — nothing is lost.`,
                        )
                      ) {
                        return;
                      }
                      setBusyVersion(version.version);
                      try {
                        await ServerData.restoreVersion(
                          sceneId,
                          version.version,
                        );
                        await load();
                      } finally {
                        setBusyVersion(null);
                      }
                    }}
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    disabled={busyVersion !== null}
                    onClick={async () => {
                      setBusyVersion(version.version);
                      try {
                        await ServerData.pinVersion(
                          sceneId,
                          version.version,
                          !version.pinned,
                        );
                        await load();
                      } finally {
                        setBusyVersion(null);
                      }
                    }}
                  >
                    {version.pinned ? "Unpin" : "Pin"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <div className="dash-modal-actions">
          <button type="button" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
};

const SceneCard = ({
  scene,
  selected,
  onOpen,
  onEdit,
  onHistory,
  onDelete,
  onTogglePin,
  onToggleSelect,
}: {
  scene: RemoteSceneSummary;
  selected: boolean;
  onOpen: () => void;
  onEdit: () => void;
  onHistory: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
  onToggleSelect: () => void;
}) => (
  <div className={`dash-card${selected ? " dash-card-selected" : ""}`}>
    <label
      className="dash-card-select"
      onClick={(event) => event.stopPropagation()}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggleSelect}
        aria-label={`Select ${scene.name || "Untitled"}`}
      />
    </label>
    <button
      type="button"
      className="dash-card-thumb"
      onClick={onOpen}
      aria-label={`Open ${scene.name}`}
    >
      {scene.hasThumbnail ? (
        <img
          src={ServerData.thumbnailUrl(scene.id, scene.updatedAt)}
          alt=""
          loading="lazy"
        />
      ) : (
        <span className="dash-card-thumb-empty">No preview yet</span>
      )}
      {scene.pinned && <span className="dash-card-pin">★</span>}
    </button>
    <div className="dash-card-body">
      <div className="dash-card-title" onClick={onOpen}>
        {scene.name || "Untitled"}
      </div>
      {scene.description && (
        <div className="dash-card-desc">{scene.description}</div>
      )}
      <div className="dash-card-meta">
        {scene.temporary && (
          <span className="dash-card-temp" title="Auto-deletes when idle">
            temporary
          </span>
        )}
        {scene.category && (
          <span className="dash-card-cat">{scene.category}</span>
        )}
        <span>{scene.elementCount} items</span>
        <span>·</span>
        <span>{formatDate(scene.updatedAt)}</span>
      </div>
      <div className="dash-card-actions">
        <button type="button" onClick={onOpen}>
          Open
        </button>
        <button type="button" onClick={onEdit}>
          Edit
        </button>
        <button
          type="button"
          disabled={scene.latestVersion === 0}
          onClick={onHistory}
        >
          History
        </button>
        <button type="button" onClick={onTogglePin}>
          {scene.pinned ? "Unpin" : "Pin"}
        </button>
        <button type="button" className="danger" onClick={onDelete}>
          Delete
        </button>
      </div>
    </div>
  </div>
);

export const Dashboard = () => {
  const [scenes, setScenes] = useState<RemoteSceneSummary[] | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [searchIds, setSearchIds] = useState<string[] | null>(null);
  const [categoryFilter, setCategoryFilter] = useState("");
  const [edit, setEdit] = useState<EditState | null>(null);
  const [historyFor, setHistoryFor] = useState<RemoteSceneSummary | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [list, cats] = await Promise.all([
        ServerData.listScenes(),
        ServerData.listCategories(),
      ]);
      setScenes(list);
      setCategories(cats);
      setError(null);
    } catch (err: any) {
      setError(err?.message ?? "Could not reach the local server.");
      setScenes([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // server-side full-text (+ embedding, when available) search, debounced;
  // falls back to a plain client-side filter if the request fails
  useEffect(() => {
    const needle = query.trim();
    if (!needle) {
      setSearchIds(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      try {
        const results = await ServerData.search(needle);
        if (!cancelled) {
          setSearchIds(results.map((result) => result.id));
        }
      } catch {
        if (!cancelled) {
          setSearchIds(null);
        }
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);

  const visible = useMemo(() => {
    const all = scenes ?? [];
    const needle = query.trim().toLowerCase();
    let filtered = all;
    if (needle) {
      filtered =
        searchIds !== null
          ? all.filter((scene) => searchIds.includes(scene.id))
          : all.filter(
              (scene) =>
                scene.name.toLowerCase().includes(needle) ||
                scene.description.toLowerCase().includes(needle) ||
                scene.category.toLowerCase().includes(needle) ||
                scene.tags.some((tag) => tag.toLowerCase().includes(needle)),
            );
    }
    if (categoryFilter) {
      filtered = filtered.filter((scene) => scene.category === categoryFilter);
    }
    return filtered;
  }, [scenes, query, searchIds, categoryFilter]);

  const handleSaveMeta = async (meta: RemoteSceneMeta) => {
    const target = edit;
    setEdit(null);
    if (!target) {
      return;
    }
    try {
      if (target.id === null) {
        const created = await ServerData.createScene(meta);
        openScene(created.id);
        return;
      }
      await ServerData.updateMeta(target.id, meta);
      await refresh();
    } catch (err: any) {
      setError(err?.message ?? "Save failed.");
    }
  };

  const handleDelete = async (scene: RemoteSceneSummary) => {
    if (!window.confirm(`Delete "${scene.name || "Untitled"}"?`)) {
      return;
    }
    await ServerData.deleteScene(scene.id);
    await refresh();
  };

  const handleTogglePin = async (scene: RemoteSceneSummary) => {
    await ServerData.updateMeta(scene.id, { pinned: !scene.pinned });
    await refresh();
  };

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  };

  const clearSelection = () => setSelected(new Set());

  const downloadFile = (blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  };

  const handleSaveSelected = async () => {
    const targets = (scenes ?? []).filter((scene) => selected.has(scene.id));
    if (targets.length === 0) {
      return;
    }
    setSaving(true);
    try {
      for (const scene of targets) {
        if (!scene.hasThumbnail) {
          continue;
        }
        try {
          const response = await fetch(
            ServerData.thumbnailUrl(scene.id, scene.updatedAt),
          );
          if (!response.ok) {
            continue;
          }
          const blob = await response.blob();
          const safeName = (scene.name || "untitled")
            .replace(/[^a-z0-9-_ ]/gi, "_")
            .trim();
          downloadFile(blob, `${safeName || "untitled"}.png`);
          // give the browser a beat between downloads so it doesn't
          // treat them as a popup flood and block them
          await new Promise((resolve) => window.setTimeout(resolve, 200));
        } catch (err: any) {
          setError(
            err?.message ?? "Could not save one of the selected drawings.",
          );
        }
      }
    } finally {
      setSaving(false);
      clearSelection();
    }
  };

  return (
    <div className="dash">
      <header className="dash-header">
        <div className="dash-header-row">
          <h1>Drawings</h1>
          <button
            type="button"
            className="primary"
            onClick={() => setEdit({ ...EMPTY_EDIT })}
          >
            + New drawing
          </button>
        </div>
        <div className="dash-toolbar">
          <input
            className="dash-search"
            type="search"
            placeholder="Search title, description, category, contents…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <select
            value={categoryFilter}
            onChange={(event) => setCategoryFilter(event.target.value)}
          >
            <option value="">All categories</option>
            {categories.map((category) => (
              <option key={category} value={category}>
                {category}
              </option>
            ))}
          </select>
        </div>
        {selected.size > 0 && (
          <div className="dash-selection-bar">
            <span>{selected.size} selected</span>
            <button type="button" onClick={clearSelection} disabled={saving}>
              Clear
            </button>
            <button
              type="button"
              className="primary"
              onClick={handleSaveSelected}
              disabled={saving}
            >
              {saving ? "Saving…" : "Save selected"}
            </button>
          </div>
        )}
      </header>

      {error && <div className="dash-error">{error}</div>}

      {scenes === null ? (
        <div className="dash-empty">Loading…</div>
      ) : visible.length === 0 ? (
        <div className="dash-empty">
          {scenes.length === 0
            ? "No drawings yet. Create one to get started."
            : "Nothing matches your filters."}
        </div>
      ) : (
        <div className="dash-grid">
          {visible.map((scene) => (
            <SceneCard
              key={scene.id}
              scene={scene}
              selected={selected.has(scene.id)}
              onToggleSelect={() => toggleSelect(scene.id)}
              onOpen={() => openScene(scene.id)}
              onEdit={() =>
                setEdit({
                  id: scene.id,
                  name: scene.name,
                  description: scene.description,
                  category: scene.category,
                })
              }
              onHistory={() => setHistoryFor(scene)}
              onDelete={() => handleDelete(scene)}
              onTogglePin={() => handleTogglePin(scene)}
            />
          ))}
        </div>
      )}

      {edit && (
        <MetaDialog
          edit={edit}
          categories={categories}
          onCancel={() => setEdit(null)}
          onSave={handleSaveMeta}
        />
      )}

      {historyFor && (
        <VersionHistory
          sceneId={historyFor.id}
          sceneName={historyFor.name}
          onClose={() => {
            setHistoryFor(null);
            void refresh();
          }}
          onOpenVersion={() => ServerData.listVersions(historyFor.id)}
        />
      )}
    </div>
  );
};
