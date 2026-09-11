/**
 * One-way projection of the semantic graph to Mermaid flowchart syntax — the
 * most compact, LLM-native view for a graph-shaped scene. Not parsed back;
 * bots read/write scenes through `semantic.ts` instead.
 */

import type { SemanticNode, SemanticScene } from "./semantic.ts";

const shapeWrap = (node: SemanticNode): [string, string] => {
  switch (node.shape) {
    case "diamond":
      return ["{", "}"];
    case "ellipse":
      return ["((", "))"];
    default:
      return ["[", "]"];
  }
};

const sanitize = (text: string): string =>
  text.replace(/"/g, "'").replace(/[\r\n]+/g, " ").trim();

const mermaidId = (id: string): string => `n${id.replace(/[^a-zA-Z0-9_]/g, "_")}`;

export const isGraphShaped = (scene: SemanticScene): boolean =>
  scene.nodes.length > 0 || scene.edges.length > 0;

export const toMermaid = (scene: SemanticScene): string => {
  const lines = ["flowchart TD"];

  for (const node of scene.nodes) {
    const [open, close] = shapeWrap(node);
    const label = sanitize(node.text || node.id);
    lines.push(`    ${mermaidId(node.id)}${open}"${label}"${close}`);
  }

  for (const edge of scene.edges) {
    const arrow = edge.style === "line" ? "---" : "-->";
    const label = edge.text ? `|"${sanitize(edge.text)}"|` : "";
    lines.push(
      `    ${mermaidId(edge.from)} ${arrow}${label} ${mermaidId(edge.to)}`,
    );
  }

  for (const text of scene.texts) {
    lines.push(`    %% ${sanitize(text.text)}`);
  }

  return `${lines.join("\n")}\n`;
};
