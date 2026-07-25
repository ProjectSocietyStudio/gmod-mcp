import { pathToFileURL } from "node:url";
import { isAbsolute, resolve } from "node:path";
import type { Config } from "./config.js";
import type { AnyToolDef } from "./mcp/registry.js";

/**
 * Loads the plugins declared in the config. Each plugin is an ESM module exporting
 * `tools: AnyToolDef[]`. A failing plugin is reported on stderr but does not block
 * startup -- extensibility without fragility.
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
        process.stderr.write(`gmod-mcp: plugin ${spec} does not export a \`tools\` array -- ignored\n`);
        continue;
      }
      collected.push(...(mod.tools as AnyToolDef[]));
      process.stderr.write(`gmod-mcp: loaded plugin ${spec} (+${mod.tools.length} tools)\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`gmod-mcp: plugin ${spec} failed -- ${message}\n`);
    }
  }
  return collected;
}
