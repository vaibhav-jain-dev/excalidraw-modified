import { useCallback, useEffect, useMemo, useState } from "react";

import {
  ServerData,
  type RemoteSceneMeta,
  type RemoteSceneSummary,
} from "../../data/ServerData";

import "./Dashboard.scss";

const openScene = (id: string) => {
  window.location.href = `/#local=${id}`;
  window.location.reload();
};

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
        <div className="dash-modal-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="primary"
            onClick={() => onSave({ name, description, category })}
          >
            {isNew ? "Create & open" : "Save"}
          </button>
        </div>
      </div>
    </div>
  );
};

const SceneCard = ({
  scene,
  onOpen,
  onEdit,
  onDelete,
  onTogglePin,
}: {
  scene: RemoteSceneSummary;
  onOpen: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onTogglePin: () => void;
}) => (
  <div className="dash-card">
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
  const [categoryFilter, setCategoryFilter] = useState("");
  const [edit, setEdit] = useState<EditState | null>(null);

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

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return (scenes ?? []).filter((scene) => {
      if (categoryFilter && scene.category !== categoryFilter) {
        return false;
      }
      if (!needle) {
        return true;
      }
      return (
        scene.name.toLowerCase().includes(needle) ||
        scene.description.toLowerCase().includes(needle) ||
        scene.category.toLowerCase().includes(needle) ||
        scene.tags.some((tag) => tag.toLowerCase().includes(needle))
      );
    });
  }, [scenes, query, categoryFilter]);

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
            placeholder="Search title, description, category…"
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
              onOpen={() => openScene(scene.id)}
              onEdit={() =>
                setEdit({
                  id: scene.id,
                  name: scene.name,
                  description: scene.description,
                  category: scene.category,
                })
              }
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
    </div>
  );
};
