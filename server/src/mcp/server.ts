/**
 * A minimal Model Context Protocol server — JSON-RPC 2.0, no SDK.
 *
 * `handleMcpMessage` processes one request/notification and returns the
 * response (or `null` for a notification). Wire it to `POST /mcp` for the
 * Streamable HTTP transport, or to stdin/stdout lines for stdio.
 */

import { TOOL_BY_NAME, TOOLS } from "./tools.ts";

const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "excalidraw-local", version: "0.2.0" };

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, any>;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

const ok = (
  id: JsonRpcRequest["id"],
  result: unknown,
): JsonRpcResponse => ({ jsonrpc: "2.0", id: id ?? null, result });

const err = (
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id: id ?? null,
  error: { code, message },
});

export const handleMcpMessage = async (
  message: JsonRpcRequest,
): Promise<JsonRpcResponse | null> => {
  const isNotification = message.id === undefined;

  switch (message.method) {
    case "initialize":
      return ok(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions:
          "Work with Excalidraw drawings through the compact semantic scene " +
          "graph (nodes, edges, texts, sketches). Use get_scene before " +
          "editing so ids line up.",
      });

    case "notifications/initialized":
    case "notifications/cancelled":
      return null;

    case "ping":
      return ok(message.id, {});

    case "tools/list":
      return ok(message.id, {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({
          name,
          description,
          inputSchema,
        })),
      });

    case "tools/call": {
      const name = message.params?.name;
      const tool = typeof name === "string" && TOOL_BY_NAME.get(name);
      if (!tool) {
        return err(message.id, -32602, `Unknown tool: ${name}`);
      }
      try {
        const result = await tool.handler(message.params?.arguments ?? {});
        return ok(message.id, result);
      } catch (error) {
        return ok(message.id, {
          content: [{ type: "text", text: `Tool error: ${String(error)}` }],
          isError: true,
        });
      }
    }

    default:
      return isNotification
        ? null
        : err(message.id, -32601, `Method not found: ${message.method}`);
  }
};

/** Process a POST /mcp body (a single message or a batch). */
export const handleMcpHttp = async (
  body: unknown,
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> => {
  if (Array.isArray(body)) {
    const responses = (
      await Promise.all(body.map((m) => handleMcpMessage(m as JsonRpcRequest)))
    ).filter((r): r is JsonRpcResponse => r !== null);
    return responses.length ? responses : null;
  }
  return handleMcpMessage(body as JsonRpcRequest);
};
