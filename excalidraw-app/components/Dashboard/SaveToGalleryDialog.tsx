import { useCallback, useEffect, useState } from "react";

import { exportToBlob } from "@excalidraw/excalidraw";
import { getNonDeletedElements } from "@excalidraw/element";

import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";

import { ServerData, type RemoteSceneSummary } from "../../data/ServerData";
import { routeToScene } from "../../data/route";
import { setActiveLocalSceneId } from "../../data/localScene";
import { pickThumbnailElements } from "../../data/thumbnail";

import "./Dashboard.scss";

const THUMBNAIL_MAX_DIMENSION = 480;

/**
 * Save-as gallery: same thumbnail-grid look as the Dashboard, but for picking
 * *where* to save the currently open drawing — either overwriting an
 * existing one or creating a new entry. Existing scenes auto-save as you
 * draw; this is only for pointing the current canvas at a different scene.
 */
export const SaveToGalleryDialog = ({
  excalidrawAPI,
  onClose,
}: {
  excalidrawAPI: ExcalidrawImperativeAPI;
  onClose: () => void;
}) => {
  const [scenes, setScenes] = useState<RemoteSceneSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setScenes(await ServerData.listScenes());
    } catch (err: any) {
      setError(err?.message ?? "Could not reach the local server.");
      setScenes([]);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const currentSnapshot = () => ({
    elements: excalidrawAPI.getSceneElementsIncludingDeleted(),
    appState: excalidrawAPI.getAppState(),
    files: excalidrawAPI.getFiles(),
  });

  const uploadThumbnail = async (id: string) => {
    const { elements, appState, files } = currentSnapshot();
    try {
      const blob = await exportToBlob({
        elements: pickThumbnailElements(getNonDeletedElements(elements))
          .elements,
        appState: { ...appState, exportBackground: true, exportScale: 1 },
        files,
        maxWidthOrHeight: THUMBNAIL_MAX_DIMENSION,
        mimeType: "image/png",
      });
      if (blob && blob.size > 0) {
        await ServerData.uploadThumbnail(id, blob);
      }
    } catch {
      // best-effort; the periodic autosave will refresh the thumbnail anyway
    }
  };

  const saveInto = async (id: string) => {
    setBusyId(id);
    try {
      const { elements, appState, files } = currentSnapshot();
      await ServerData.saveScene(id, elements, appState, files);
      await uploadThumbnail(id);
      setActiveLocalSceneId(id);
      onClose();
      routeToScene(id);
    } catch (err: any) {
      setError(err?.message ?? "Save failed.");
      setBusyId(null);
    }
  };

  const saveAsNew = async () => {
    setBusyId("__new__");
    try {
      const created = await ServerData.createScene({});
      await saveInto(created.id);
    } catch (err: any) {
      setError(err?.message ?? "Save failed.");
      setBusyId(null);
    }
  };

  return (
    <div className="dash-modal-backdrop" onClick={onClose}>
      <div
        className="dash-modal dash-save-gallery"
        onClick={(event) => event.stopPropagation()}
      >
        <h2>Save to…</h2>
        <p className="dash-empty-inline">
          Pick a drawing to overwrite with the current canvas, or save it as a
          new one.
        </p>
        {error && <div className="dash-error">{error}</div>}
        <div className="dash-save-grid">
          <button
            type="button"
            className="dash-save-tile dash-save-tile-new"
            disabled={busyId !== null}
            onClick={saveAsNew}
          >
            {busyId === "__new__" ? "Saving…" : "+ New drawing"}
          </button>
          {scenes === null ? (
            <p className="dash-empty-inline">Loading…</p>
          ) : (
            scenes.map((scene) => (
              <button
                type="button"
                key={scene.id}
                className="dash-save-tile"
                disabled={busyId !== null}
                onClick={() => {
                  if (
                    window.confirm(
                      `Overwrite "${
                        scene.name || "Untitled"
                      }" with the current canvas?`,
                    )
                  ) {
                    void saveInto(scene.id);
                  }
                }}
              >
                <span className="dash-save-thumb">
                  {scene.hasThumbnail ? (
                    <img
                      src={ServerData.thumbnailUrl(scene.id, scene.updatedAt)}
                      alt=""
                      loading="lazy"
                    />
                  ) : (
                    <span className="dash-card-thumb-empty">No preview</span>
                  )}
                </span>
                <span className="dash-save-name">
                  {busyId === scene.id ? "Saving…" : scene.name || "Untitled"}
                </span>
              </button>
            ))
          )}
        </div>
        <div className="dash-modal-actions">
          <button type="button" onClick={onClose} disabled={busyId !== null}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
