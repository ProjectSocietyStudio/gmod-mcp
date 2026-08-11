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
    description: "Server convar values. Without `names`, returns a common subset.",
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
    description:
      "Runs a server console command (game.ConsoleCommand -- queued, around 0.25s of latency). " +
      "Read the result back in a SEPARATE call: the command has not run when this one returns.",
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
      "GUARDED. Runs arbitrary Lua server-side (RunString) and returns the resulting value. " +
      "Requires confirm:true. Audited. " +
      "WARNING: console commands are QUEUED. A snippet that calls RunConsoleCommand or " +
      "game.ConsoleCommand and then reads the cvar back in the same snippet reads the OLD " +
      "value -- the command runs after this execution ends, so the read is not a failure, it " +
      "is simply early. Split it into two calls, or use `batch` with settleMs between the " +
      "steps.",
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
    description: "Derma/VGUI panel tree: class, name, visibility, size, position both parent-relative (x/y) and absolute (screen_x/screen_y), whether mouse input is enabled, and on_screen. Filter on on_screen: `visible` is the panel's own flag only, so a flat tree is mostly panels belonging to closed menus. Use screen_x/screen_y to aim a click or a capture region -- x/y are relative to the parent and are (0,0) for most nested panels.",
    realm: "cl",
    inputSchema: { maxDepth: z.number().int().min(0).max(32).default(6) },
  }),
  bridgeTool({
    name: "inspect_panel",
    description:
      "Finds a panel by NAME, class and/or displayed text, and returns its screen rectangle, its text, whether it holds keyboard focus, and the other matches. NAME is the registered vgui name (R_CharCreate, R_UI_Button, echat.textentry) and is what you want: `class` is the VGUI base the panel derives from, so a kit panel's class reads Label or Panel and searching by class can never find it. Off-screen panels are excluded unless onScreen:false -- a live tree measured 1408 panels of which 5 were on screen.",
    realm: "cl",
    inputSchema: {
      name: z.string().min(1).optional().describe("Registered vgui name, e.g. R_UI_Button. Exact match."),
      class: z.string().min(1).optional().describe("VGUI base class, e.g. Label, Panel, TextEntry. Exact match."),
      contains: z
        .string()
        .min(1)
        .optional()
        .describe("Substring of the panel's displayed text, case-insensitive -- 'the button that says ÉCROUER'."),
      index: z.number().int().min(1).default(1).describe("Which match to return when several qualify."),
      onScreen: z
        .boolean()
        .default(true)
        .describe("Keep only panels whose whole ancestry is visible. false includes closed menus."),
    },
  }),
  bridgeTool({
    name: "read_panel_text",
    description:
      "Dumps what the interface DISPLAYS, as text: name, class, screen rectangle and text content of each panel under a named root. Use this instead of capture_screen to assert a value -- a capture travels in 7KB chunks paced one per frame, and a number read off a compressed JPEG is not an assertion. Text comes from GetText, GetValue, or a .label/.text/.title field (kit buttons paint their label and answer '' to GetText). The list is depth-first with depth relative to the root, so the parent chain is recoverable from the ordering: the DTextEntry that follows the DLabel 'Prénom' is that field. capture_screen remains the tool for anything visual -- z-order, overlap, a missing glyph.",
    realm: "cl",
    inputSchema: {
      root: z
        .string()
        .min(1)
        .optional()
        .describe("Panel to dump from, matched as a NAME first then as a class. Omitted, dumps the whole screen."),
      index: z.number().int().min(1).default(1).describe("Which root when several match."),
      maxDepth: z.number().int().min(0).max(32).default(8).describe("Depth below the root."),
      onlyText: z.boolean().default(true).describe("Skip panels carrying no text. false dumps the structure too."),
      onScreen: z.boolean().default(true).describe("Skip panels whose ancestry is hidden."),
      limit: z.number().int().min(1).max(1000).default(120).describe("Maximum entries; the rest are counted in `truncated`."),
    },
  }),
  bridgeTool({
    name: "capture_screen",
    description:
      "Captures the client's screen on the next frame and returns it as a viewable image. Every byte travels in 7KB chunks paced by frame, so a full-resolution capture takes seconds and dominates any act-then-look loop: the default half scale at quality 60 is 4-6x cheaper and still legible for a Derma layout. Pass region (from read_panels' screen_x/screen_y) to capture just one panel. A capture that would exceed the client's channel budget is refused with its size rather than sent: a full-screen quality-80 capture measured 424KB and timed the client out of the server. Requires an active GMod client.",
    realm: "cl",
    inputSchema: {
      scale: z
        .number()
        .min(0.1)
        .max(1)
        .default(0.5)
        .describe("Downscale factor applied on the client before encoding. Use 1 to read small text."),
      quality: z.number().int().min(1).max(100).default(60).describe("JPEG quality."),
      region: z
        .object({ x: z.number().int(), y: z.number().int(), w: z.number().int(), h: z.number().int() })
        .optional()
        .describe("Screen region to capture. Free: render.Capture takes it natively."),
    },
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
    name: "read_view",
    description:
      "What the client sees and is pointed at: eye position and angles, aim trace (class, index, distance, hit position), health, weapon, cursor position and visibility, the hovered panel, the panel holding keyboard focus, and the current scripted-input mode. This is the cheap half of an act-then-look loop -- one chunk, no image -- and answers 'am I aimed at the door' without a screenshot.",
    realm: "cl",
    inputSchema: {},
  }),
  bridgeTool({
    name: "client_input",
    description:
      "Drives the connected GMod client: movement, aim, keys, Derma clicks, typing, chat. Modal -- 'world' drives movement through CreateMove, 'ui' hands input to the panel system, and the two are mutually exclusive; the action switches mode for you. Durations are SECONDS (CreateMove runs at the client's cmdrate, so tick counts are not a duration), clamped to 5s, and everything resets after 30s or on `gmod_mcp_release` in the client console. To fill a form use `set_text` (targets a field by name and fires its change notification); `type` sends real keystrokes and needs a target or an already-focused field. `click` takes a NAMED target as well as x/y and is self-sufficient -- it moves the cursor, waits for hover to settle, presses and releases, so no `move_cursor` is needed first. Follow with read_view or read_panel_text to see the effect.",
    realm: "cl",
    inputSchema: {
      action: z.enum([
        "move",
        "look",
        "look_at",
        "press",
        "release",
        "click",
        "move_cursor",
        "type",
        "set_text",
        "key_ui",
        "scroll",
        "select_weapon",
        "say",
        "mode",
        "reset",
      ]),
      forward: z.number().optional().describe("move: forward speed, negative for backward."),
      side: z.number().optional().describe("move: strafe speed."),
      up: z.number().optional().describe("move: vertical speed (swimming, ladders)."),
      pitch: z.number().optional().describe("look: pitch, clamped to +-89."),
      yaw: z.number().optional().describe("look: yaw."),
      pos: z.array(z.number()).length(3).optional().describe("look_at: world position to aim at."),
      key: z
        .number()
        .int()
        .optional()
        .describe("press/release: IN_ bit (IN_ATTACK 1, IN_JUMP 2, IN_DUCK 4, IN_FORWARD 8, IN_BACK 16, IN_USE 32, IN_MOVELEFT 512, IN_MOVERIGHT 1024, IN_ATTACK2 2048, IN_RELOAD 8192, IN_SPEED 131072). key_ui: a KEY_ enum instead."),
      x: z.number().int().optional().describe("click/move_cursor: screen X. Ignored when a named target is given."),
      y: z.number().int().optional().describe("click/move_cursor: screen Y. Ignored when a named target is given."),
      button: z.enum(["left", "right", "middle"]).optional().describe("click: which mouse button."),
      text: z
        .string()
        .optional()
        .describe("set_text: the value to put in the field. type: characters to send. say: chat message."),
      name: z
        .string()
        .optional()
        .describe(
          "click/type/set_text: target the panel with this registered vgui name (R_UI_Button, DTextEntry). Not the class -- a kit panel's class is its VGUI base.",
        ),
      class: z.string().optional().describe("click/type/set_text: target by VGUI base class (Label, TextEntry, Panel)."),
      contains: z
        .string()
        .optional()
        .describe("click/type/set_text: narrow the target to panels whose displayed text contains this (case-insensitive)."),
      index: z.number().int().min(1).optional().describe("click/type/set_text: which match to act on when several qualify."),
      onScreen: z
        .boolean()
        .optional()
        .describe("click/type/set_text: default true, only panels whose whole ancestry is visible. false reaches hidden ones."),
      focus: z
        .boolean()
        .optional()
        .describe("set_text: default true, calls RequestFocus first so the field's own focus logic runs."),
      enter: z
        .boolean()
        .optional()
        .describe("set_text: also fire the field's OnEnter, for forms that only validate or submit on Enter. Off by default -- on a chat entry it sends the line."),
      delta: z.number().int().optional().describe("scroll: wheel delta."),
      weapon: z.string().optional().describe("select_weapon: weapon class the player is carrying."),
      mode: z.enum(["off", "world", "ui"]).optional().describe("mode: which input mode to switch to."),
      duration: z
        .number()
        .min(0)
        .max(5)
        .optional()
        .describe("Seconds to hold a key, a movement or a scripted aim. Clamped to 5."),
    },
  }),
  bridgeTool({
    name: "read_client_convars",
    description: "Client-side convar values. Without names, returns a common subset.",
    realm: "cl",
    inputSchema: { names: z.array(z.string()).optional() },
  }),
];
