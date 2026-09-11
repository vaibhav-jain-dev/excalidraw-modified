/**
 * Read-side search orchestration: full-text (always available) blended with
 * vector similarity (when `sqlite-vec` loaded and Ollama can embed) via
 * reciprocal rank fusion. See `fts.ts` / `vector.ts` / `embeddings.ts` for the
 * pieces, and `store/scenes.ts` for how the indexes are kept up to date.
 */

import { getSceneSummary } from "../store/scenes.ts";
import { embedText } from "./embeddings.ts";
import { searchFts } from "./fts.ts";
import { isVectorSearchReady, searchSceneVectors } from "./vector.ts";

export type SearchMode = "fts" | "vector" | "hybrid";

export interface SearchResult {
  id: string;
  name: string;
  description: string;
  category: string;
  snippet?: string;
  score: number;
}

const RRF_K = 60;

export const searchScenes = async (
  query: string,
  mode: SearchMode = "hybrid",
  limit = 20,
): Promise<SearchResult[]> => {
  const q = query.trim();
  if (!q) {
    return [];
  }

  const ftsHits = mode === "vector" ? [] : searchFts(q, limit * 2);

  let vectorHits: ReturnType<typeof searchSceneVectors> = [];
  if (mode !== "fts" && isVectorSearchReady()) {
    const vector = await embedText(q);
    if (vector) {
      vectorHits = searchSceneVectors(vector, limit * 2);
    }
  }

  const fused = new Map<string, { score: number; snippet?: string }>();
  ftsHits.forEach((hit, rank) => {
    const entry = fused.get(hit.sceneId) ?? { score: 0 };
    entry.score += 1 / (RRF_K + rank + 1);
    entry.snippet = hit.snippet;
    fused.set(hit.sceneId, entry);
  });
  vectorHits.forEach((hit, rank) => {
    const entry = fused.get(hit.sceneId) ?? { score: 0 };
    entry.score += 1 / (RRF_K + rank + 1);
    fused.set(hit.sceneId, entry);
  });

  return [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score)
    .slice(0, limit)
    .map(([id, { score, snippet }]) => {
      const summary = getSceneSummary(id);
      if (!summary) {
        return null;
      }
      const result: SearchResult = {
        id: summary.id,
        name: summary.name,
        description: summary.description,
        category: summary.category,
        score,
      };
      if (snippet) {
        result.snippet = snippet;
      }
      return result;
    })
    .filter((result): result is SearchResult => result !== null);
};
