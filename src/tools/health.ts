import { existsSync } from "node:fs";
import { join } from "node:path";
import { defineTool } from "../mcp/registry.js";
import { VERSION } from "../version.js";

/**
 * Sonde de santé : prouve le handshake MCP et rapporte la vue qu'a le daemon
 * de l'environnement (racine repo détectée, scripts de la boucle présents).
 * Sert de premier point de vérification bout-en-bout de la Phase 0.
 */
export const healthTool = defineTool({
  name: "health",
  description:
    "État du daemon gmod-mcp : version, racine du repo détectée, présence des scripts tools/, dossier d'état.",
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
