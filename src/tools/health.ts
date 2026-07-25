import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "../mcp/registry.js";
import { VERSION } from "../version.js";

/**
 * Health probe: proves the MCP handshake works and reports the daemon's view of its
 * environment -- the repo root it detected and whether the loop's scripts are present.
 * This is the first end-to-end check to run.
 */
export const healthTool = defineTool({
  name: "health",
  description:
    "gmod-mcp daemon status: version, detected repo root, presence of the tools/ scripts, state directory.",
  realm: "local",
  inputSchema: {},
  handler: (_args, ctx) => {
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
    };
  },
});
