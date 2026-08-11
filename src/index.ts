#!/usr/bin/env node
import { join } from "node:path";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { FileBridge } from "./bridge/filebridge.js";
import { loadConfig } from "./config.js";
import { AuditLog } from "./logger.js";
import { createMcpServer } from "./mcp/server.js";

/**
 * Handed to the client at connection time.
 *
 * With tool search, a client no longer loads every tool definition upfront: this prose
 * may be the only thing it reads before deciding whether to look for our tools at all.
 * So it says what the server is FOR and when to reach for it -- not how each tool works,
 * which the tool definitions already carry.
 */
const INSTRUCTIONS = `Live bridge to the Project Society Garry's Mod dev server, plus local addon tooling.

Reach for it to: observe a running srcds (players, entities, hooks, convars, timers,
net messages) and the connected client (panels, view, console, screenshots); act in the
world (spawn, teleport, freeze, set DarkRP money/job, force a hook); lint, patch, hot-reload
and validate addon Lua without restarting; read server or client logs since the last boot.

Realms: \`sv\` needs srcds running, \`cl\` also needs a human client connected, \`local\`
needs neither. Tools that mutate the world or a file are guarded and take confirm:true.
Use \`batch\` to run up to 32 sv steps in one round-trip instead of many calls.

It does NOT do offline map file work -- .vmf, .bsp, entity-lump patches, the Source
compilers. That is hammer-mcp.`;
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
  // version/repoRoot end up in the transport lock file, so a second daemon can name who
  // holds it instead of reporting a bare timeout.
  const bridge = new FileBridge({ dir: gmodDataDir, audit, version: VERSION, repoRoot: config.repoRoot });
  const transportState = bridge.status();
  if (!transportState.owns) {
    // stderr only -- stdout is the MCP protocol channel. The tools repeat this on every
    // call, which is where a human debugging a timeout will actually see it.
    process.stderr.write(
      `gmod-mcp: WARNING -- transport directory already owned by PID ${transportState.lockedBy?.pid ?? "?"}; ` +
        `bridge tools are disabled in this daemon (see ${transportState.lockPath})\n`,
    );
  }

  const registry = new ToolRegistry();
  registry.registerAll(allTools);
  registry.registerAll(await loadPlugins(config));

  const ctx: ToolContext = { config, audit, bridge, registry, patch: new PatchEngine(config) };
  const server = createMcpServer(registry, ctx, {
    name: "gmod-mcp",
    version: VERSION,
    instructions: INSTRUCTIONS,
  });

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
