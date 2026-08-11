import { loadConfig as coreLoadConfig } from "@projectsociety/mcp-core";
import { z } from "zod";

/**
 * Project configuration, loaded from `<repoRoot>/.gmod-mcp/config.json` when present,
 * otherwise defaults. Every field in the file is optional and gets filled in.
 */
export const ConfigFile = z.object({
  /** Root of the GMod repo (contains tools/, addons/, srcds/). */
  repoRoot: z.string().optional(),
  /** Addons targeted by default for lint and reload. */
  addons: z.array(z.string()).default([]),
  /**
   * How long a client-realm call keeps retrying while the client is absent, in ms.
   * The realm needs a human connected, and humans crash and reconnect; retrying lets an
   * agent resume when they come back instead of failing the moment they drop. 0 fails
   * fast. Server-realm calls ignore this: srcds does not come and go.
   */
  clientWaitMs: z.number().int().min(0).max(600_000).default(30_000),
  /** Tools allowed without confirmation. Empty means the default policy. */
  toolAllowlist: z.array(z.string()).default([]),
  /** Plugin ESM modules to load, relative to the repo root. Each exports `tools`. */
  plugins: z.array(z.string()).default([]),
});
export type ConfigFile = z.infer<typeof ConfigFile>;

export interface Config extends ConfigFile {
  repoRoot: string;
  /** The daemon's runtime state directory: `<repoRoot>/.gmod-mcp`. */
  stateDir: string;
}

/**
 * Loads the effective configuration. The root is resolved in this order:
 * 1. `GMOD_MCP_REPO` (env)  2. the file's `repoRoot` field  3. walking up from cwd.
 */
export function loadConfig(cwd: string = process.cwd()): Config {
  return coreLoadConfig(
    { envVar: "GMOD_MCP_REPO", stateDirName: ".gmod-mcp", schema: ConfigFile },
    cwd,
  );
}

export { findRepoRoot } from "@projectsociety/mcp-core";
