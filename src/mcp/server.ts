import { randomUUID } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolContext, ToolRegistry } from "./registry.js";
import { isCallAllowed } from "./registry.js";

function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text }], ...(isError ? { isError } : {}) };
}

/**
 * Construit le serveur MCP et y branche tous les outils du registre.
 * Chaque handler est enveloppé : audit (call/result/error) + gate de confirmation
 * pour les outils gardés. Le résultat est renvoyé en JSON texte (consommable par
 * l'agent) — pas de socket, transport stdio branché par l'appelant.
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
          const msg = `Outil gardé « ${def.name} » : passez confirm:true (action sensible, journalisée).`;
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
          return textResult(JSON.stringify(result, null, 2));
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          ctx.audit.record({
            kind: "error",
            commandId,
            data: { tool: def.name, error: message },
          });
          return textResult(`Erreur ${def.name}: ${message}`, true);
        }
      },
    );
  }

  return server;
}
