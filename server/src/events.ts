/**
 * Live collaboration between the editor and MCP: a Server-Sent Events stream
 * that broadcasts `scene-changed` whenever a scene is saved, plus a record of
 * which scene the editor currently has open (so a bot can target "active").
 */

export interface SceneChangedEvent {
  type: "scene-changed";
  id: string;
  version: number;
  source: string;
  /** the editor client that caused the save, so it can ignore its own echo */
  originClientId?: string;
}

type Listener = (event: SceneChangedEvent) => void;

const listeners = new Set<Listener>();

export const subscribeEvents = (listener: Listener): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

export const broadcastSceneChanged = (event: SceneChangedEvent): void => {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch {
      // a broken SSE connection must not stop the others
    }
  }
};

// ---------------------------------------------------------------------------
// active scene (what the editor has open right now)
// ---------------------------------------------------------------------------

const PRESENCE_TTL_MS = 90_000;

let active: { id: string; at: number; clientId?: string } | null = null;

export const reportPresence = (id: string, clientId?: string): void => {
  active = { id, at: Date.now(), clientId };
};

export const clearPresence = (id: string): void => {
  if (active?.id === id) {
    active = null;
  }
};

export const getActiveScene = (): { id: string; clientId?: string } | null => {
  if (active && Date.now() - active.at < PRESENCE_TTL_MS) {
    return { id: active.id, clientId: active.clientId };
  }
  return null;
};
