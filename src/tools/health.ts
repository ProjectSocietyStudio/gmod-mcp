import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "../mcp/registry.js";
import type { ToolContext } from "../mcp/registry.js";
import { clientBridgeTools, serverBridgeTools } from "./bridge.js";
import { VERSION } from "../version.js";

/** Short: a probe must report "srcds is down" quickly, not stall for the full default. */
const PROBE_TIMEOUT_MS = 3_000;

/**
 * Asks the addon which handlers it registered, and diffs that against what the daemon
 * declares.
 *
 * The two halves are one contract with nothing enforcing agreement. A tool declared here
 * but missing there fails with "unknown handler" only after a full round trip, and an
 * include left out of gmod_mcp_bridge.lua registers nothing while raising nothing --
 * the same silent-failure family as a camelCase addon directory. Surfacing it costs one
 * cheap call.
 */
async function probeBridge(ctx: ToolContext): Promise<Record<string, unknown>> {
  if (!ctx.bridge) return { ok: false, error: "bridge transport not started" };

  try {
    const res = await ctx.bridge.enqueue("sv", "list_handlers", {}, {
      timeoutMs: PROBE_TIMEOUT_MS,
    });
    if (!res.ok) return { ok: false, error: res.error ?? "bridge-side failure" };

    const data = (res.data ?? {}) as { handlers?: unknown; version?: unknown };
    const registered = new Set(Array.isArray(data.handlers) ? (data.handlers as string[]) : []);

    // Client tools are relayed by the server addon but registered on the client, so the
    // server's handler table legitimately does not list them.
    const missing = serverBridgeTools.map((t) => t.name).filter((n) => !registered.has(n));

    return {
      ok: true,
      addonVersion: data.version,
      registered: [...registered].sort(),
      missingServerHandlers: missing,
      clientToolsDeclared: clientBridgeTools.map((t) => t.name),
    };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Health probe: proves the MCP handshake works and reports the daemon's view of its
 * environment -- the repo root it detected and whether the loop's scripts are present.
 * This is the first end-to-end check to run.
 */
export const healthTool = defineTool({
  name: "health",
  description:
    "gmod-mcp daemon status: version, detected repo root, presence of the tools/ scripts, state directory. Also probes the addon (3s) and reports any server handler the daemon declares but the game has not registered.",
  realm: "local",
  inputSchema: {},
  handler: async (_args, ctx) => {
    const { repoRoot, stateDir } = ctx.config;
    const scripts = ["lint.sh", "start-server.sh", "server-log.sh", "package-gma.sh"];
    const toolsPresent = Object.fromEntries(
      scripts.map((s) => [s, existsSync(join(repoRoot, "tools", s))]),
    );
    return {
      ok: true,
      version: VERSION,
      node: process.version,
      repoRoot,
      stateDir,
      toolsPresent,
      bridge: await probeBridge(ctx),
    };
  },
});
