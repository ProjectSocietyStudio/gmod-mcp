import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";

interface McpConfig {
  mcpServers?: Record<string, unknown>;
}

/** Chemin absolu de l'entrée du serveur MCP (dist/index.js), à côté de ce module. */
function serverEntry(): string {
  return fileURLToPath(new URL("./index.js", import.meta.url));
}

/**
 * Écrit/fusionne l'entrée gmod-mcp dans `<repoRoot>/.mcp.json` (scope projet,
 * versionnable et partageable). Préserve les autres serveurs déjà déclarés.
 * Renvoie le chemin écrit et l'entrée posée.
 */
export function installProject(config: Config): { path: string; entry: unknown } {
  const path = join(config.repoRoot, ".mcp.json");
  let current: McpConfig = {};
  if (existsSync(path)) {
    try {
      current = JSON.parse(readFileSync(path, "utf8")) as McpConfig;
    } catch {
      current = {};
    }
  }
  const entry = {
    command: "node",
    args: [serverEntry()],
    env: { GMOD_MCP_REPO: config.repoRoot },
  };
  const next: McpConfig = {
    ...current,
    mcpServers: { ...current.mcpServers, "gmod-mcp": entry },
  };
  writeFileSync(path, JSON.stringify(next, null, 2) + "\n");
  return { path, entry };
}

/** Point d'entrée de la sous-commande `gmod-mcp install`. */
export function runInstall(config: Config): void {
  const { path, entry } = installProject(config);
  const e = entry as { args: string[] };
  process.stdout.write(
    [
      `gmod-mcp installé (scope projet) : ${path}`,
      "",
      "Claude Code chargera le serveur au prochain démarrage dans ce repo.",
      "Équivalent en ligne de commande :",
      `  claude mcp add gmod-mcp -e GMOD_MCP_REPO=${config.repoRoot} -- node ${e.args[0]}`,
      "",
      "Pense à builder d'abord : (cd gmod-mcp && pnpm install && pnpm build)",
      "",
    ].join("\n"),
  );
}
