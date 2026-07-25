import { z } from "zod";
import { defineTool } from "../mcp/registry.js";
import type { AnyToolDef, ToolContext, ToolResult } from "../mcp/registry.js";

/**
 * Tools that ACT on the world rather than read it, so an agent can set up the situation
 * it needs to observe instead of asking a human to do it.
 *
 * All of them are guarded. `client_input` deliberately is not -- it is bounded in Lua
 * instead, because a confirmation clicked two hundred times is not a safety property.
 * These are different: they are rare, they change persistent state, and one of them can
 * move money.
 */

/** A position or angle, as JSON cannot carry a Vector. */
const Triple = z.array(z.number()).length(3);

/** Entity index, or a player's SteamID / SteamID64 / exact name. */
const Target = z.union([z.number().int().nonnegative(), z.string().min(1)]);

const CONFIRM = z
  .boolean()
  .optional()
  .describe("Must be true: this changes the running game and is audited. Otherwise the call is refused.");

async function callBridge(
  ctx: ToolContext,
  tool: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  if (!ctx.bridge) {
    return {
      ok: false,
      error:
        "bridge not connected: no gmod_mcp_bridge addon has polled the daemon -- is the GMod server running with the addon mounted?",
    };
  }
  try {
    const res = await ctx.bridge.enqueue("sv", tool, args, { confirmed: true });
    return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? "bridge-side failure" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

const spawnEntity = defineTool({
  name: "spawn_entity",
  description:
    "GUARDED. Creates and spawns an entity at a position. Returns its EntIndex, which the other world tools take as a target. Requires confirm:true.",
  realm: "sv",
  guarded: true,
  inputSchema: {
    class: z.string().min(1).describe("Entity class, e.g. prop_physics or spawned_money."),
    pos: Triple.describe("World position [x, y, z]."),
    ang: Triple.optional().describe("Angles [pitch, yaw, roll]."),
    model: z.string().optional().describe("Model path; required by prop_physics."),
    freeze: z.boolean().default(false).describe("Disable physics motion once spawned."),
    confirm: CONFIRM,
  },
  handler: ({ class: cls, pos, ang, model, freeze }, ctx) =>
    callBridge(ctx, "spawn_entity", { class: cls, pos, ang, model, freeze }),
});

const worldEdit = defineTool({
  name: "world_edit",
  description:
    "GUARDED. Acts on one entity or player: remove, teleport, set_ang, freeze, unfreeze, set_health, set_armor, give, strip. target is an entity index or a player's SteamID/name. Requires confirm:true.",
  realm: "sv",
  guarded: true,
  inputSchema: {
    action: z.enum([
      "remove",
      "teleport",
      "set_ang",
      "freeze",
      "unfreeze",
      "set_health",
      "set_armor",
      "give",
      "strip",
    ]),
    target: Target,
    pos: Triple.optional().describe("Destination for teleport."),
    ang: Triple.optional().describe("Angles for set_ang."),
    value: z.number().optional().describe("Amount for set_health and set_armor."),
    weapon: z.string().optional().describe("Weapon class for give."),
    confirm: CONFIRM,
  },
  handler: ({ action, target, pos, ang, value, weapon }, ctx) =>
    callBridge(ctx, "world_edit", { action, target, pos, ang, value, weapon }),
});

const setPlayerState = defineTool({
  name: "set_player_state",
  description:
    "GUARDED, DarkRP. Sets a player's money, job, salary or RP name. Money is in INTEGER CENTS (1.50$ is 150) and goes through the r-capitalism ledger when it is loaded, so the audited invariant stays intact. Fails with a named error when DarkRP is absent. Requires confirm:true.",
  realm: "sv",
  guarded: true,
  inputSchema: {
    target: Target,
    money_cents: z
      .number()
      .int()
      .optional()
      .describe("Absolute balance in integer cents. The ledger records the delta as an issue or a burn."),
    job: z
      .union([z.string(), z.number().int()])
      .optional()
      .describe("Job command (e.g. 'police'), job name, or team index."),
    salary: z.number().int().optional(),
    rpname: z.string().optional(),
    confirm: CONFIRM,
  },
  handler: ({ target, money_cents, job, salary, rpname }, ctx) =>
    callBridge(ctx, "set_player_state", { target, money_cents, job, salary, rpname }),
});

const forceHook = defineTool({
  name: "force_hook",
  description:
    "GUARDED. Runs hook.Run(name, ...) to exercise a gamemode path without reproducing the situation. JSON cannot carry an Entity, so arguments may be tagged: {\"__ent\": 3}, {\"__ply\": \"STEAM_0:1:2\"}, {\"__vec\": [x,y,z]}, {\"__ang\": [p,y,r]}. Requires confirm:true.",
  realm: "sv",
  guarded: true,
  inputSchema: {
    name: z.string().min(1).describe("Hook name, e.g. PlayerSpawn."),
    args: z.array(z.unknown()).default([]).describe("Positional arguments, tagged where they are game objects."),
    confirm: CONFIRM,
  },
  handler: ({ name, args }, ctx) => callBridge(ctx, "force_hook", { name, args }),
});

export const worldTools: AnyToolDef[] = [spawnEntity, worldEdit, setPlayerState, forceHook];
