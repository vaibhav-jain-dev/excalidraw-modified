import os from "node:os";
import path from "node:path";

/**
 * All runtime configuration for the local-first server, resolved from env vars
 * with sensible defaults. Nothing here touches the filesystem — see `paths.ts`
 * and `db.ts` for that.
 */

const resolveDir = (value: string | undefined, fallback: string): string =>
  value && value.trim() ? path.resolve(value.trim()) : fallback;

const num = (value: string | undefined, fallback: number): number => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
};

const dataDir = resolveDir(
  process.env.EXCALIDRAW_LOCAL_DATA_DIR,
  path.join(os.homedir(), ".excalidraw-local"),
);

export const config = {
  /** Port the API/MCP/static server listens on. Vite proxies `/api` here in dev. */
  port: num(process.env.LOCAL_SERVER_PORT, 3057),
  host: process.env.LOCAL_SERVER_HOST ?? "127.0.0.1",

  /** Root of all persisted data: `index.db`, `scenes/`, `files/`, `thumbs/`. */
  dataDir,

  /** Built Excalidraw app to serve at `/` in production (`yarn build`). */
  appBuildDir: resolveDir(
    process.env.EXCALIDRAW_LOCAL_APP_DIR,
    path.resolve(import.meta.dirname, "../../excalidraw-app/build"),
  ),
  serveApp: process.env.EXCALIDRAW_LOCAL_SERVE_APP !== "false",

  /** Non-pinned versions kept per scene; older ones are pruned on save. */
  maxVersionsPerScene: num(process.env.EXCALIDRAW_LOCAL_MAX_VERSIONS, 30),

  /** Max request body — scenes with inlined image data can be large. */
  bodyLimitBytes: num(
    process.env.EXCALIDRAW_LOCAL_BODY_LIMIT,
    48 * 1024 * 1024,
  ),

  logLevel: process.env.LOG_LEVEL ?? "info",

  /** Ollama server used for embeddings (search) and text-to-diagram generation. */
  ollamaHost: process.env.OLLAMA_HOST ?? "http://localhost:11434",
  ollamaEmbedModel: process.env.OLLAMA_EMBED_MODEL ?? "nomic-embed-text",
  ollamaGenerateModel: process.env.OLLAMA_GENERATE_MODEL ?? "llama3.2",
  /** Must match the chosen embed model's output size (nomic-embed-text: 768). */
  embedDim: num(process.env.EXCALIDRAW_LOCAL_EMBED_DIM, 768),

  /** Headless Chromium for server-side PNG rendering (get_scene_image, no
   * client-rendered thumbnail yet). Auto-detected if unset. */
  chromePath: process.env.CHROME_PATH?.trim() || null,
  /** Origin the render browser navigates to — defaults to this server, which
   * only works once `yarn build` has produced an app for it to serve. */
  renderAppOrigin:
    process.env.EXCALIDRAW_LOCAL_RENDER_ORIGIN?.trim() ||
    `http://127.0.0.1:${num(process.env.LOCAL_SERVER_PORT, 3057)}`,
} as const;
