import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "./config.js";

interface McpConfig {
  mcpServers?: Record<string, unknown>;
}

/** Absolute path to the MCP server entry point (dist/index.js), next to this module. */
function serverEntry(): string {
  return fileURLToPath(new URL("./index.js", import.meta.url));
}

/**
 * Writes or merges the gmod-mcp entry into `<repoRoot>/.mcp.json` (project scope, so
 * it can be committed and shared). Other declared servers are preserved. Returns the
 * path written and the entry that was set.
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

/** Entry point of the `gmod-mcp install` subcommand. */
export function runInstall(config: Config): void {
  const { path, entry } = installProject(config);
  const e = entry as { args: string[] };
  process.stdout.write(
    [
      `gmod-mcp installed (project scope): ${path}`,
      "",
      "Claude Code will load the server the next time it starts in this repo.",
      "Command-line equivalent:",
      `  claude mcp add gmod-mcp -e GMOD_MCP_REPO=${config.repoRoot} -- node ${e.args[0]}`,
      "",
      "Remember to build first: (cd gmod-mcp && pnpm install && pnpm build)",
      "",
    ].join("\n"),
  );
}
