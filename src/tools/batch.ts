import { z } from "zod";
import { defineTool } from "../mcp/registry.js";
import type { AnyToolDef, ToolContext, ToolResult } from "../mcp/registry.js";

const MAX_STEPS = 32;
const MAX_SETTLE_MS = 2_000;

/** Headroom over the settle pauses, so a batch is not killed by its own delays. */
const BASE_TIMEOUT_MS = 30_000;

const Step = z.object({
  tool: z.string().min(1),
  args: z.record(z.unknown()).optional(),
});
type Step = z.infer<typeof Step>;

/**
 * Resolves each step against the registry and refuses the batch outright when a step is
 * unusable.
 *
 * The guard check is the important one. `isCallAllowed` gates per tool definition, and
 * `batch` is a single unguarded definition -- so without this a `run_lua` step would ride
 * in and bypass the confirmation its own gate demands. The Lua runner repeats the check;
 * neither side trusts the other.
 */
function validateSteps(
  steps: Step[],
  confirmed: boolean,
  ctx: ToolContext,
): { realm: "sv" | "cl"; error?: undefined } | { realm?: undefined; error: string } {
  if (!ctx.registry) return { error: "registry unavailable: batch cannot resolve its steps" };

  const realms = new Set<string>();
  for (const [i, step] of steps.entries()) {
    const def = ctx.registry.get(step.tool);
    if (!def) return { error: `step ${i}: unknown tool "${step.tool}"` };
    if (def.realm === "local") {
      return {
        error: `step ${i}: "${step.tool}" is a local tool -- a batch runs inside the game, so only sv and cl tools can be steps`,
      };
    }
    if (def.guarded && !confirmed) {
      return { error: `step ${i}: "${step.tool}" is guarded -- pass confirm:true to the batch` };
    }
    realms.add(def.realm);
  }

  if (realms.has("cl")) {
    return {
      error:
        "client-realm steps are not supported yet: a batch runs inside the server addon and cl tools are relayed over net. Call them individually for now.",
    };
  }
  return { realm: "sv" };
}

export const batchTool = defineTool({
  name: "batch",
  description:
    "Runs up to 32 server tools in ONE bridge round trip instead of one per call. A round trip costs about 0.4s, so any act-then-look sequence is dominated by transport unless it is batched. Each step reports its own ok/data/error; a step failing is data, not a transport error. settleMs pauses between steps so a step observes what the previous one did.",
  realm: "sv",
  inputSchema: {
    steps: z.array(Step).min(1).max(MAX_STEPS),
    stopOnError: z
      .boolean()
      .default(true)
      .describe("Stop at the first failing step and mark the rest skipped."),
    settleMs: z
      .number()
      .int()
      .min(0)
      .max(MAX_SETTLE_MS)
      .default(0)
      .describe("Pause between steps, in ms. Needed when a step must observe the previous one."),
    confirm: z
      .boolean()
      .optional()
      .describe("Required if any step is a guarded tool. Applies to every step."),
  },
  handler: async ({ steps, stopOnError, settleMs, confirm }, ctx): Promise<ToolResult> => {
    if (!ctx.bridge) {
      return {
        ok: false,
        error:
          "bridge not connected: no gmod_mcp_bridge addon has polled the daemon -- is the GMod server running with the addon mounted?",
      };
    }

    const confirmed = confirm === true;
    const check = validateSteps(steps, confirmed, ctx);
    if (check.error) return { ok: false, error: check.error };

    try {
      const res = await ctx.bridge.enqueue(
        "sv",
        "batch",
        { steps, stopOnError, settleMs },
        { confirmed, timeoutMs: BASE_TIMEOUT_MS + settleMs * steps.length },
      );
      if (!res.ok) return { ok: false, error: res.error ?? "bridge-side failure" };
      return { ok: true, data: res.data };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  },
});

export const batchTools: AnyToolDef[] = [batchTool];
