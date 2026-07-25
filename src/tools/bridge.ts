import { z } from "zod";
import { defineTool } from "../mcp/registry.js";
import type { AnyToolDef, ToolContext, ToolResult } from "../mcp/registry.js";

/**
 * Runs a bridge-side tool (sv or cl realm): pushes the command, waits for the
 * correlated result and normalises the output. Returns a readable error when the
 * bridge is not connected rather than throwing.
 */
async function callBridge(
  ctx: ToolContext,
  realm: "sv" | "cl",
  tool: string,
  args: Record<string, unknown>,
  confirmed: boolean,
): Promise<ToolResult> {
  if (!ctx.bridge) {
    return {
      ok: false,
      error:
        "bridge not connected: no gmod_mcp_bridge addon has polled the daemon -- is the GMod server running with the addon mounted?",
    };
  }
  try {
    const res = await ctx.bridge.enqueue(realm, tool, args, { confirmed });
    return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? "bridge-side failure" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Settings for defining a bridge tool. */
interface BridgeToolSpec {
  name: string;
  description: string;
  realm: "sv" | "cl";
  inputSchema: z.ZodRawShape;
  guarded?: boolean;
}

function bridgeTool(spec: BridgeToolSpec): AnyToolDef {
  return defineTool({
    name: spec.name,
    description: spec.description,
    realm: spec.realm,
    ...(spec.guarded ? { guarded: true } : {}),
    inputSchema: spec.inputSchema,
    // Guarded tools only reach this point once the MCP gate has allowed them.
    handler: (args: Record<string, unknown>, ctx) =>
      callBridge(ctx, spec.realm, spec.name, args, spec.guarded === true),
  });
}

/** Server introspection tools. The data contract lives on the Lua side. */
export const serverBridgeTools: AnyToolDef[] = [
  bridgeTool({
    name: "read_runtime",
    description:
      "Snapshot of server state: map, gamemode, CurTime, player and entity counts, uptime.",
    realm: "sv",
    inputSchema: {},
  }),
  bridgeTool({
    name: "read_players",
    description: "Lists players: name, SteamID, team/job, ping, position, health.",
    realm: "sv",
    inputSchema: {},
  }),
  bridgeTool({
    name: "read_entities",
    description: "Lists entities, filterable by class. Returns index, class, model and position.",
    realm: "sv",
    inputSchema: {
      class: z.string().optional(),
      limit: z.number().int().min(1).max(2000).default(200),
    },
  }),
  bridgeTool({
    name: "inspect_entity",
    description: "Details of one entity by index: class, model, health, owner, key-values.",
    realm: "sv",
    inputSchema: { index: z.number().int().nonnegative() },
  }),
  bridgeTool({
    name: "read_hooks",
    description: "Registered hooks (hook.GetTable), filterable by event. Returns event -> identifiers.",
    realm: "sv",
    inputSchema: { event: z.string().optional() },
  }),
  bridgeTool({
    name: "read_convars",
    description: "Valeurs de convars serveur. Sans `names`, renvoie un sous-ensemble usuel.",
    realm: "sv",
    inputSchema: { names: z.array(z.string()).optional() },
  }),
  bridgeTool({
    name: "read_net_messages",
    description: "Registered net messages (util.AddNetworkString) and whether a net.Receive exists.",
    realm: "sv",
    inputSchema: {},
  }),
  bridgeTool({
    name: "read_timers",
    description: "Timers created through timer.Create and tracked by the bridge. Timers predating it are invisible.",
    realm: "sv",
    inputSchema: {},
  }),
  bridgeTool({
    name: "run_console_command",
    description: "Runs a server console command (game.ConsoleCommand -- queued, around 0.25s of latency).",
    realm: "sv",
    inputSchema: { command: z.string().min(1) },
  }),
  bridgeTool({
    name: "send_debug",
    description: "Prints a message server-side, useful for marking the log or tracing.",
    realm: "sv",
    inputSchema: { message: z.string() },
  }),
  bridgeTool({
    name: "run_test",
    description:
      "Runs a GLua test file server-side and returns {passed, failed, results}. path is relative to lua/, e.g. 'myaddon/tests/x.lua'. The file returns a table { [name] = function(t) end }.",
    realm: "sv",
    inputSchema: { path: z.string().min(1) },
  }),
  bridgeTool({
    name: "run_lua",
    description:
      "GUARDED. Runs arbitrary Lua server-side (RunString) and returns the resulting value. Requires confirm:true. Audited.",
    realm: "sv",
    guarded: true,
    inputSchema: {
      code: z.string().min(1),
      confirm: z
        .boolean()
        .optional()
        .describe("Must be true: this is a sensitive, audited action. Otherwise the call is refused."),
    },
  }),
];

/**
 * CLIENT introspection tools. These need a real GMod client connected to the server
 * with the addon's client half loaded.
 */
export const clientBridgeTools: AnyToolDef[] = [
  bridgeTool({
    name: "read_panels",
    description: "Derma/VGUI panel tree (class, name, visibility, position, size), bounded by maxDepth.",
    realm: "cl",
    inputSchema: { maxDepth: z.number().int().min(0).max(32).default(6) },
  }),
  bridgeTool({
    name: "inspect_panel",
    description: "Details of the first panel of a given class, plus how many occur in the VGUI tree.",
    realm: "cl",
    inputSchema: { class: z.string().min(1) },
  }),
  bridgeTool({
    name: "capture_screen",
    description: "Captures the client's screen (base64 JPEG) on the next frame. Requires an active GMod client.",
    realm: "cl",
    inputSchema: {},
  }),
  bridgeTool({
    name: "read_console",
    description: "CLIENT Lua errors captured since load. GMod does not expose the console buffer itself.",
    realm: "cl",
    inputSchema: {},
  }),
  bridgeTool({
    name: "read_client_convars",
    description: "Client-side convar values. Without names, returns a common subset.",
    realm: "cl",
    inputSchema: { names: z.array(z.string()).optional() },
  }),
];
