/**
 * Text-to-diagram: ask the local Ollama model to produce a semantic scene
 * graph directly from a prompt. Best-effort — returns `{ error }` (never
 * throws) when Ollama is unreachable or the model's output can't be salvaged
 * into a usable graph.
 */

import type { SemanticScene } from "./derive/semantic.ts";
import { generateText } from "./search/embeddings.ts";

const SYSTEM_PROMPT = `You turn a short description into a diagram. Output ONLY a JSON object — no prose, no markdown code fences — matching this shape:
{
  "nodes": [{"id": "a", "shape": "rectangle" | "ellipse" | "diamond", "text": "short label"}],
  "edges": [{"id": "e1", "from": "a", "to": "b", "text": "optional label"}],
  "texts": [{"id": "t1", "text": "a standalone note"}]
}
Rules:
- every edge's "from" and "to" must be an id that appears in "nodes"
- use short slug ids: a, b, c, ... for nodes; e1, e2, ... for edges
- keep every label under 6 words
- "diamond" is for decisions/branches, "ellipse" for start/end states, "rectangle" for everything else
- return between 2 and 12 nodes unless the prompt clearly calls for more
- return valid JSON and nothing else`;

const VALID_SHAPES = new Set(["rectangle", "ellipse", "diamond"]);

const extractJson = (raw: string): unknown | null => {
  try {
    return JSON.parse(raw);
  } catch {
    // the model sometimes wraps the object in prose or a code fence anyway
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
};

export type GenerateResult =
  | { scene: Partial<SemanticScene> }
  | { error: string };

export const generateSemanticFromPrompt = async (
  prompt: string,
): Promise<GenerateResult> => {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return { error: "prompt is empty" };
  }

  const raw = await generateText(trimmed, SYSTEM_PROMPT);
  if (!raw) {
    return {
      error:
        "The local model (Ollama) is unreachable, or the configured " +
        "generate model isn't installed. Set OLLAMA_HOST / " +
        "OLLAMA_GENERATE_MODEL, or supply the semantic graph yourself.",
    };
  }

  const parsed = extractJson(raw) as Record<string, unknown> | null;
  if (!parsed) {
    return { error: "the model did not return valid JSON" };
  }

  const rawNodes = Array.isArray(parsed.nodes) ? parsed.nodes : [];
  const nodeIds = new Set<string>();
  const nodes = rawNodes
    .filter(
      (node): node is Record<string, unknown> =>
        !!node &&
        typeof node === "object" &&
        typeof (node as any).id === "string" &&
        VALID_SHAPES.has((node as any).shape),
    )
    .map((node) => {
      nodeIds.add(node.id as string);
      return {
        id: node.id as string,
        shape: node.shape as "rectangle" | "ellipse" | "diamond",
        text: typeof node.text === "string" ? node.text : undefined,
      };
    });

  if (nodes.length === 0) {
    return { error: "the model's response had no usable nodes" };
  }

  const rawEdges = Array.isArray(parsed.edges) ? parsed.edges : [];
  const edges = rawEdges
    .filter(
      (edge): edge is Record<string, unknown> =>
        !!edge &&
        typeof edge === "object" &&
        nodeIds.has((edge as any).from) &&
        nodeIds.has((edge as any).to),
    )
    .map((edge, index) => ({
      id: typeof edge.id === "string" ? edge.id : `e${index}`,
      from: edge.from as string,
      to: edge.to as string,
      text: typeof edge.text === "string" ? edge.text : undefined,
    }));

  const rawTexts = Array.isArray(parsed.texts) ? parsed.texts : [];
  const texts = rawTexts
    .filter(
      (item): item is Record<string, unknown> =>
        !!item && typeof item === "object" && typeof (item as any).text === "string",
    )
    .map((item, index) => ({
      id: typeof item.id === "string" ? item.id : `t${index}`,
      text: item.text as string,
    }));

  return { scene: { nodes, edges, texts, sketches: [] } };
};
