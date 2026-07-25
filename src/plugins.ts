import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import type { Config } from "./config.js";
import type { AnyToolDef } from "./mcp/registry.js";

/**
 * Charge les plugins déclarés dans la config. Chaque plugin est un module ESM qui
 * exporte `tools: AnyToolDef[]`. Un plugin défaillant est signalé sur stderr mais
 * n'empêche pas le démarrage (extensibilité sans fragilité).
 *
 * Contrat plugin :
 *   export const tools = [ defineTool({ ... }), ... ];
 */
export async function loadPlugins(config: Config): Promise<AnyToolDef[]> {
  const collected: AnyToolDef[] = [];
  for (const spec of config.plugins) {
    const abs = isAbsolute(spec) ? spec : resolve(config.repoRoot, spec);
    try {
      const mod = (await import(pathToFileURL(abs).href)) as { tools?: unknown };
      if (!Array.isArray(mod.tools)) {
        process.stderr.write(`gmod-mcp: plugin ${spec} n'exporte pas \`tools\` (tableau) — ignoré\n`);
        continue;
      }
      collected.push(...(mod.tools as AnyToolDef[]));
      process.stderr.write(`gmod-mcp: plugin chargé ${spec} (+${mod.tools.length} outils)\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`gmod-mcp: échec du plugin ${spec} — ${message}\n`);
    }
  }
  return collected;
}
