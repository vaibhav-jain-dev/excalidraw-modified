/**
 * Glue between the editor and the excalidraw-local server for a scene opened via
 * `#local=<id>`. Keeps the id of the currently-open local scene and pushes
 * debounced saves + thumbnails to the server as the user draws. IndexedDB
 * (`LocalData`) stays the offline cache; the server is the source of truth.
 */

import { exportToBlob } from "@excalidraw/excalidraw";
import { debounce } from "@excalidraw/common";
import { getNonDeletedElements } from "@excalidraw/element";

import type { OrderedExcalidrawElement } from "@excalidraw/element/types";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";

import { ServerData } from "./ServerData";

const SAVE_DEBOUNCE_MS = 1000;
const THUMBNAIL_DEBOUNCE_MS = 4000;
const THUMBNAIL_MAX_DIMENSION = 480;

let activeLocalSceneId: string | null = null;

export const getActiveLocalSceneId = (): string | null => activeLocalSceneId;

export const setActiveLocalSceneId = (id: string | null): void => {
  activeLocalSceneId = id;
};

const pushSave = debounce(
  (
    id: string,
    elements: readonly OrderedExcalidrawElement[],
    appState: Partial<AppState>,
    files: BinaryFiles,
  ) => {
    void ServerData.saveScene(id, elements, appState, files).catch((error) => {
      console.warn("excalidraw-local: scene save failed", error);
    });
  },
  SAVE_DEBOUNCE_MS,
);

const pushThumbnail = debounce(
  async (
    id: string,
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    try {
      const blob = await exportToBlob({
        elements: getNonDeletedElements(elements),
        appState: {
          ...appState,
          exportBackground: true,
          exportScale: 1,
        },
        files,
        maxWidthOrHeight: THUMBNAIL_MAX_DIMENSION,
        mimeType: "image/png",
      });
      if (blob && blob.size > 0) {
        await ServerData.uploadThumbnail(id, blob);
      }
    } catch (error) {
      console.warn("excalidraw-local: thumbnail update failed", error);
    }
  },
  THUMBNAIL_DEBOUNCE_MS,
);

/** Call from the editor's `onChange` — no-ops unless a `#local=` scene is open. */
export const syncActiveLocalScene = (
  elements: readonly OrderedExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
): void => {
  if (!activeLocalSceneId) {
    return;
  }
  pushSave(activeLocalSceneId, elements, appState, files);
  pushThumbnail(activeLocalSceneId, elements, appState, files);
};

/** Flush any pending save immediately (e.g. before unload / navigation). */
export const flushActiveLocalScene = (): void => {
  pushSave.flush();
};
