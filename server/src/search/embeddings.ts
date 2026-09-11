/**
 * Ollama client for embeddings (semantic search) and text-to-diagram
 * generation. Entirely best-effort: if Ollama isn't running, doesn't have the
 * model, or the server wasn't started with embedding support, callers get
 * `null`/an error and fall back to full-text search — nothing here is load
 * bearing for the rest of the app.
 */

import { config } from "../config.ts";

let embeddingsWarned = false;

/** Embed one string. Returns `null` on any failure (logged once). */
export const embedText = async (text: string): Promise<number[] | null> => {
  try {
    const response = await fetch(`${config.ollamaHost}/api/embeddings`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: config.ollamaEmbedModel, prompt: text }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text()}`);
    }
    const data = (await response.json()) as { embedding?: number[] };
    if (!Array.isArray(data.embedding) || data.embedding.length === 0) {
      throw new Error("no embedding in response");
    }
    return data.embedding;
  } catch (error) {
    if (!embeddingsWarned) {
      embeddingsWarned = true;
      console.warn(
        `Ollama embeddings unavailable (model "${config.ollamaEmbedModel}" at ` +
          `${config.ollamaHost}) — search falls back to full-text only.`,
        (error as Error).message ?? error,
      );
    }
    return null;
  }
};

/** Whether the last `embedText` attempt worked, for a quick health check. */
export const embeddingsLastWorked = (): boolean => !embeddingsWarned;

let generateWarned = false;

/**
 * Ask the local model to produce a semantic scene graph (JSON) for a prompt.
 * Returns the raw text response, or `null` if Ollama is unreachable.
 */
export const generateText = async (
  prompt: string,
  system?: string,
): Promise<string | null> => {
  try {
    const response = await fetch(`${config.ollamaHost}/api/generate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: config.ollamaGenerateModel,
        prompt,
        system,
        stream: false,
        format: "json",
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text()}`);
    }
    const data = (await response.json()) as { response?: string };
    return data.response ?? null;
  } catch (error) {
    if (!generateWarned) {
      generateWarned = true;
      console.warn(
        `Ollama generate unavailable (model "${config.ollamaGenerateModel}" at ` +
          `${config.ollamaHost}):`,
        (error as Error).message ?? error,
      );
    }
    return null;
  }
};
