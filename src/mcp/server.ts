import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext, ToolRegistry, ToolResult } from "./registry.js";
import { IMAGE_KEY, isCallAllowed, isToolImage } from "./registry.js";

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError } : {}) };
}

/**
 * Turns a handler's result into MCP content. A result carrying `_image` is split: the
 * rest of the object goes out as JSON text, the image as a real image block. Emitting it
 * as text would bill the model for base64 it cannot see.
 */
export function successResult(result: ToolResult): CallToolResult {
  const image = result[IMAGE_KEY];
  if (!isToolImage(image)) return textResult(JSON.stringify(result, null, 2));

  const rest = { ...result };
  delete rest[IMAGE_KEY];
  return {
    content: [
      { type: "text", text: JSON.stringify(rest, null, 2) },
      { type: "image", data: image.data, mimeType: image.mimeType },
    ],
  };
}

/**
 * Builds the MCP server and wires every tool in the registry into it.
 * Every handler is wrapped with auditing (call/result/error) and a confirmation gate
 * for guarded tools. Results come back as JSON text for the agent to consume. No
 * socket: the caller wires up the stdio transport.
 */
export function createMcpServer(
  registry: ToolRegistry,
  ctx: ToolContext,
  meta: { name: string; version: string },
): McpServer {
  const server = new McpServer({ name: meta.name, version: meta.version });

  for (const def of registry.list()) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.inputSchema,
        annotations: { title: def.name },
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const commandId = randomUUID();
        ctx.audit.record({
          kind: "tool_call",
          commandId,
          data: { tool: def.name, realm: def.realm, args },
        });

        if (!isCallAllowed(def, args, ctx.config.toolAllowlist)) {
          const msg = `Guarded tool "${def.name}": pass confirm:true (sensitive action, audited).`;
          ctx.audit.record({
            kind: "tool_result",
            commandId,
            data: { tool: def.name, ok: false, error: msg },
          });
          return textResult(msg, true);
        }

        try {
          const result = await def.handler(args, ctx);
          ctx.audit.record({
            kind: "tool_result",
            commandId,
            data: { tool: def.name, ok: true },
          });
          return successResult(result);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.audit.record({
            kind: "error",
            commandId,
            data: { tool: def.name, error: message },
          });
          return textResult(`${def.name} failed: ${message}`, true);
        }
      },
    );
  }

  return server;
}
