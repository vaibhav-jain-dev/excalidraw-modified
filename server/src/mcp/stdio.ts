/**
 * MCP over stdio — for `claude mcp add excalidraw-local -- node <path>/stdio.ts`
 * and other stdio clients. Shares the data directory with the HTTP server.
 */

import { createInterface } from "node:readline";

import { handleMcpMessage } from "./server.ts";

const rl = createInterface({ input: process.stdin });

rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) {
    return;
  }
  let message: unknown;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  try {
    const response = await handleMcpMessage(message as never);
    if (response !== null) {
      process.stdout.write(`${JSON.stringify(response)}\n`);
    }
  } catch (error) {
    process.stderr.write(`mcp stdio error: ${String(error)}\n`);
  }
});
