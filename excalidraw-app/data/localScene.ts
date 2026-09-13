/**
 * Glue between the editor and the excalidraw-local server for a scene opened via
 * `#local=<id>`. Keeps the id of the currently-open local scene and pushes
 * debounced saves + thumbnails to the server as the user draws. IndexedDB
 * (`LocalData`) stays the offline cache; the server is the source of truth.
 */

import { CaptureUpdateAction, exportToBlob } from "@excalidraw/excalidraw";
import { debounce } from "@excalidraw/common";
import { getNonDeletedElements } from "@excalidraw/element";
import { restoreElements } from "@excalidraw/excalidraw/data/restore";

import type { OrderedExcalidrawElement } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawImperativeAPI,
} from "@excalidraw/excalidraw/types";

import { CLIENT_ID, ServerData } from "./ServerData";
import { pickThumbnailElements } from "./thumbnail";

const SAVE_DEBOUNCE_MS = 1200;
const THUMBNAIL_DEBOUNCE_MS = 5000;
const THUMBNAIL_MAX_DIMENSION = 480;

/** run heavy work off the interaction path so drawing stays smooth */
const whenIdle = (fn: () => void) => {
  if (typeof requestIdleCallback === "function") {
    requestIdleCallback(fn, { timeout: 2000 });
  } else {
    setTimeout(fn, 0);
  }
};

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
    whenIdle(() => {
      void ServerData.saveScene(id, elements, appState, files).catch(
        (error) => {
          console.warn("excalidraw-local: scene save failed", error);
        },
      );
    });
  },
  SAVE_DEBOUNCE_MS,
);

const pushThumbnail = debounce(
  (
    id: string,
    elements: readonly OrderedExcalidrawElement[],
    appState: AppState,
    files: BinaryFiles,
  ) => {
    whenIdle(async () => {
      try {
        const blob = await exportToBlob({
          elements: pickThumbnailElements(getNonDeletedElements(elements))
            .elements,
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
    });
  },
  THUMBNAIL_DEBOUNCE_MS,
);

/** set while applying a change that came from the server, so we don't echo it back */
let applyingRemote = false;

/** Call from the editor's `onChange` — no-ops unless a `#local=` scene is open. */
export const syncActiveLocalScene = (
  elements: readonly OrderedExcalidrawElement[],
  appState: AppState,
  files: BinaryFiles,
): void => {
  if (!activeLocalSceneId || applyingRemote) {
    return;
  }
  pushSave(activeLocalSceneId, elements, appState, files);
  pushThumbnail(activeLocalSceneId, elements, appState, files);
};

/** Flush any pending save immediately (e.g. before unload / navigation). */
export const flushActiveLocalScene = (): void => {
  pushSave.flush();
};

// ---------------------------------------------------------------------------
// live sync — MCP / another tab edits the scene the user has open
// ---------------------------------------------------------------------------

let stopSync: (() => void) | null = null;

/**
 * Announce the open scene to the server and subscribe to `scene-changed`
 * events, so an edit made through MCP (or the HTTP API, or another tab) shows
 * up in this editor immediately. Our own saves are filtered out by client id.
 */
export const startLocalSceneSync = (api: ExcalidrawImperativeAPI): void => {
  stopLocalSceneSync();
  const id = activeLocalSceneId;
  if (!id) {
    return;
  }

  void ServerData.reportPresence(id);
  const presenceTimer = window.setInterval(() => {
    if (activeLocalSceneId) {
      void ServerData.reportPresence(activeLocalSceneId);
    }
  }, 20_000);

  const source = new EventSource("/api/events");
  source.onmessage = async (event) => {
    let payload: {
      type?: string;
      id?: string;
      originClientId?: string;
    };
    try {
      payload = JSON.parse(event.data);
    } catch {
      return;
    }
    if (
      payload.type !== "scene-changed" ||
      payload.id !== activeLocalSceneId ||
      payload.originClientId === CLIENT_ID
    ) {
      return;
    }
    try {
      const remote = await ServerData.getScene(payload.id);
      applyingRemote = true;
      api.updateScene({
        elements: restoreElements(remote.elements ?? [], null, {
          repairBindings: true,
        }),
        captureUpdate: CaptureUpdateAction.NEVER,
      });
      if (remote.files) {
        api.addFiles(Object.values(remote.files));
      }
    } catch (error) {
      console.warn("excalidraw-local: live update failed", error);
    } finally {
      window.setTimeout(() => {
        applyingRemote = false;
      }, 0);
    }
  };

  stopSync = () => {
    window.clearInterval(presenceTimer);
    source.close();
  };
};

export const stopLocalSceneSync = (): void => {
  stopSync?.();
  stopSync = null;
};
