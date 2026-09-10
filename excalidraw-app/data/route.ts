/**
 * URL routing for the local-first app.
 *
 * The dashboard lives at `/`; an open drawing at `/d/<id>` — a real,
 * bookmarkable path that survives being served under a sub-path or behind a
 * proxy (unlike a `#hash`), and lets each browser window hold a different
 * drawing. `#local=<id>` and `#json=…` / `#room=…` still work: the first is
 * rewritten to `/d/<id>`, the rest fall through to the editor as before.
 */

const SCENE_PATH = /^\/d\/([\w-]+)\/?$/;
const LEGACY_HASH = /^#local=([\w-]+)/;

/** Id of the drawing named by the current URL, or `null` for the dashboard. */
export const getRouteSceneId = (): string | null => {
  const pathMatch = window.location.pathname.match(SCENE_PATH);
  if (pathMatch) {
    return pathMatch[1];
  }
  const hashMatch = window.location.hash.match(LEGACY_HASH);
  return hashMatch ? hashMatch[1] : null;
};

/** Whether the URL points at the editor (a scene id, a share/collab link, …). */
export const isEditorRoute = (): boolean =>
  getRouteSceneId() !== null ||
  !!window.location.search ||
  (!!window.location.hash && window.location.hash !== "#");

export const routeToScene = (id: string): void => {
  window.location.assign(`/d/${encodeURIComponent(id)}`);
};

export const routeToDashboard = (): void => {
  window.location.assign("/");
};

/** Rewrite a legacy `#local=<id>` URL to `/d/<id>` in place (no reload). */
export const normalizeLegacyRoute = (): boolean => {
  const hashMatch = window.location.hash.match(LEGACY_HASH);
  if (hashMatch && !window.location.pathname.match(SCENE_PATH)) {
    window.history.replaceState(null, "", `/d/${hashMatch[1]}`);
    return true;
  }
  return false;
};
