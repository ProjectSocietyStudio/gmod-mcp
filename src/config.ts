import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
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

/** Markers that identify the root of the GMod repo. */
const REPO_MARKERS = ["tools/lint.sh", "CLAUDE.md"];

function looksLikeRepoRoot(dir: string): boolean {
  return REPO_MARKERS.some((m) => existsSync(join(dir, m)));
}

/** Walks up from `start` until it finds the repo root. */
export function findRepoRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (looksLikeRepoRoot(dir)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/**
 * Loads the effective configuration. The root is resolved in this order:
 * 1. `GMOD_MCP_REPO` (env)  2. the file's `repoRoot` field  3. walking up from cwd.
 */
export function loadConfig(cwd: string = process.cwd()): Config {
  const envRoot = process.env.GMOD_MCP_REPO;

  // Look for a config file first, using either the env root or the upward walk.
  const probeRoot = envRoot ?? findRepoRoot(cwd) ?? cwd;
  const configPath = join(probeRoot, ".gmod-mcp", "config.json");

  let fromFile: ConfigFile = ConfigFile.parse({});
  if (existsSync(configPath)) {
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    fromFile = ConfigFile.parse(raw);
  }

  const repoRoot = resolveRepoRoot(envRoot, fromFile.repoRoot, probeRoot);
  return {
    ...fromFile,
    repoRoot,
    stateDir: join(repoRoot, ".gmod-mcp"),
  };
}

function resolveRepoRoot(
  envRoot: string | undefined,
  fileRoot: string | undefined,
  fallback: string,
): string {
  const candidate = envRoot ?? fileRoot ?? fallback;
  return isAbsolute(candidate) ? candidate : resolve(fallback, candidate);
}
