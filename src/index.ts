#!/usr/bin/env node
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileBridge } from "./bridge/filebridge.js";
import { loadConfig } from "./config.js";
import { AuditLog } from "./logger.js";
import { createMcpServer } from "./mcp/server.js";
import { ToolRegistry } from "./mcp/registry.js";
import type { ToolContext } from "./mcp/registry.js";
import { PatchEngine } from "./patch/engine.js";
import { loadPlugins } from "./plugins.js";
import { runInstall } from "./install.js";
import { allTools } from "./tools/index.js";
import { VERSION } from "./version.js";

/**
 * Entry point of the gmod-mcp MCP server (stdio transport, local-first).
 * Launched by Claude Code, so nothing may go to stdout (that is the protocol
 * channel) -- diagnostics go to stderr only. The server bridge runs over files inside
 * GMod's DATA sandbox (`FileBridge`). No network: GMod's `HTTP()` was measured not to
 * reach a localhost daemon from srcds.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  // `install` subcommand: write .mcp.json and exit without starting the server.
  if (process.argv[2] === "install") {
    runInstall(config);
    return;
  }

  const audit = new AuditLog(config.stateDir);
  audit.record({ kind: "daemon_start", data: { version: VERSION, repoRoot: config.repoRoot } });

  // File-based bridge transport, shared with srcds through GMod's DATA sandbox.
  const gmodDataDir = join(config.repoRoot, "srcds", "garrysmod", "data", "gmod_mcp");
  const bridge = new FileBridge({ dir: gmodDataDir, audit });

  const registry = new ToolRegistry();
  registry.registerAll(allTools);
  registry.registerAll(await loadPlugins(config));

  const ctx: ToolContext = { config, audit, bridge, registry, patch: new PatchEngine(config) };
  const server = createMcpServer(registry, ctx, { name: "gmod-mcp", version: VERSION });

  const shutdown = () => {
    void bridge.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `gmod-mcp ${VERSION} ready -- repoRoot=${config.repoRoot} bridge=file(${gmodDataDir}) tools=${registry.list().length}\n`,
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`gmod-mcp: failed to start -- ${message}\n`);
  process.exit(1);
});
