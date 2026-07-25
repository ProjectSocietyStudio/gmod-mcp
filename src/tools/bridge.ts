import { z } from "zod";
import { defineTool, IMAGE_KEY } from "../mcp/registry.js";
import type { AnyToolDef, ToolContext, ToolResult } from "../mcp/registry.js";

/**
 * Failures that mean "the client is not there right now" rather than "this call is
 * wrong". Only these are retried: a bad argument or a raising handler must fail at once.
 */
const CLIENT_ABSENT = /no client connected|client disconnected before answering|^timeout: no result/;

const RETRY_INTERVAL_MS = 2_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs a bridge-side tool (sv or cl realm): pushes the command, waits for the
 * correlated result and normalises the output. Returns a readable error when the
 * bridge is not connected rather than throwing.
 *
 * Client-realm calls retry while the client is simply absent, for up to
 * `config.clientWaitMs`. The realm depends on a human being connected, and humans crash,
 * alt-tab and reconnect. Without this an agent mid-iteration got a hard failure the
 * moment its human dropped, and had no way to tell "come back and I will continue" from
 * "this call is broken" -- so it either gave up or hammered the tool blindly.
 *
 * Server-realm calls are never retried: srcds does not come and go mid-session, so a
 * failure there is a real one and hiding it behind retries would only delay the report.
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

  const deadline = Date.now() + (realm === "cl" ? ctx.config.clientWaitMs : 0);
  let attempts = 0;

  for (;;) {
    attempts += 1;
    let error: string;
    try {
      const res = await ctx.bridge.enqueue(realm, tool, args, { confirmed });
      if (res.ok) return { ok: true, data: res.data };
      error = res.error ?? "bridge-side failure";
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    const retryable = CLIENT_ABSENT.test(error);
    if (!retryable || Date.now() >= deadline) {
      // Say how long we waited, so the caller can tell a genuinely absent client from
      // a call that never had a chance.
      const waited = attempts > 1 ? ` (retried for ${ctx.config.clientWaitMs}ms, ${attempts} attempts)` : "";
      return { ok: false, error: error + waited };
    }

    await sleep(Math.min(RETRY_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
}

/** Settings for defining a bridge tool. */
interface BridgeToolSpec {
  name: string;
  description: string;
  realm: "sv" | "cl";
  inputSchema: z.ZodRawShape;
  guarded?: boolean;
  /** Post-processes a successful result, e.g. to lift out an image content block. */
  transform?: (result: ToolResult) => ToolResult;
}

function bridgeTool(spec: BridgeToolSpec): AnyToolDef {
  return defineTool({
    name: spec.name,
    description: spec.description,
    realm: spec.realm,
    ...(spec.guarded ? { guarded: true } : {}),
    inputSchema: spec.inputSchema,
    // Guarded tools only reach this point once the MCP gate has allowed them.
    handler: async (args: Record<string, unknown>, ctx) => {
      const res = await callBridge(ctx, spec.realm, spec.name, args, spec.guarded === true);
      return res.ok && spec.transform ? spec.transform(res) : res;
    },
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
    description:
      "State of named timers: exists, time left, repetitions left. GMod cannot enumerate timers, so `names` is required to get anything back.",
    realm: "sv",
    inputSchema: { names: z.array(z.string()).optional() },
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
    description:
      "Captures the client's screen on the next frame and returns it as a viewable image. Requires an active GMod client.",
    realm: "cl",
    inputSchema: {},
    // Lift the base64 into an image content block. Left in the JSON body it would be
    // billed as text and still be invisible to the model -- see IMAGE_KEY.
    transform: (res) => {
      const data = (res["data"] as Record<string, unknown> | undefined) ?? {};
      const base64 = data["base64"];
      if (typeof base64 !== "string") return res;
      const { base64: _omit, ...meta } = data;
      return { ...res, data: meta, [IMAGE_KEY]: { data: base64, mimeType: "image/jpeg" } };
    },
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
