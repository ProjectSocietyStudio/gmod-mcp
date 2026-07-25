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
 * Point d'entrée du serveur MCP gmod-mcp (transport stdio, local-first).
 * Lancé par Claude Code — donc : rien sur stdout (canal du protocole), logs sur
 * stderr uniquement. Le bridge serveur passe par des fichiers dans le sandbox DATA
 * de GMod (`FileBridge`) — pas de réseau : mesuré, `HTTP()` de GMod ne joint pas le
 * daemon localhost depuis srcds.
 */
async function main(): Promise<void> {
  const config = loadConfig();

  // Sous-commande `install` : écrit .mcp.json puis sort, sans démarrer le serveur.
  if (process.argv[2] === "install") {
    runInstall(config);
    return;
  }

  const audit = new AuditLog(config.stateDir);
  audit.record({ kind: "daemon_start", data: { version: VERSION, repoRoot: config.repoRoot } });

  // Transport bridge par fichiers, partagé avec srcds via le sandbox DATA de GMod.
  const gmodDataDir = join(config.repoRoot, "srcds", "garrysmod", "data", "gmod_mcp");
  const bridge = new FileBridge({ dir: gmodDataDir, audit });

  const registry = new ToolRegistry();
  registry.registerAll(allTools);
  registry.registerAll(await loadPlugins(config));

  const ctx: ToolContext = { config, audit, bridge, patch: new PatchEngine(config) };
  const server = createMcpServer(registry, ctx, { name: "gmod-mcp", version: VERSION });

  const shutdown = () => {
    void bridge.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  const transport = new StdioServerTransport();
  await server.connect(transport);
  process.stderr.write(
    `gmod-mcp ${VERSION} prêt — repoRoot=${config.repoRoot} bridge=fichier(${gmodDataDir}) outils=${registry.list().length}\n`,
  );
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.stack ?? err.message : String(err);
  process.stderr.write(`gmod-mcp: échec au démarrage — ${message}\n`);
  process.exit(1);
});
