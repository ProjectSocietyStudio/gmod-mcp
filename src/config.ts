import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";

/**
 * Config projet, chargée depuis `<repoRoot>/.gmod-mcp/config.json` si présent,
 * sinon valeurs par défaut. Tout est optionnel dans le fichier : on complète.
 */
export const ConfigFile = z.object({
  /** Racine du repo GMod (contient tools/, addons/, srcds/). */
  repoRoot: z.string().optional(),
  /** Addons ciblés par défaut pour lint/reload. */
  addons: z.array(z.string()).default([]),
  /** Outils autorisés sans confirmation. Vide = politique par défaut. */
  toolAllowlist: z.array(z.string()).default([]),
  /** Modules ESM de plugins à charger (chemins relatifs au repo). Chacun exporte `tools`. */
  plugins: z.array(z.string()).default([]),
});
export type ConfigFile = z.infer<typeof ConfigFile>;

export interface Config extends ConfigFile {
  repoRoot: string;
  /** Dossier d'état runtime du daemon : `<repoRoot>/.gmod-mcp`. */
  stateDir: string;
}

/** Marqueurs qui identifient la racine du repo GMod. */
const REPO_MARKERS = ["tools/lint.sh", "CLAUDE.md"];

function looksLikeRepoRoot(dir: string): boolean {
  return REPO_MARKERS.some((m) => existsSync(join(dir, m)));
}

/** Remonte l'arborescence depuis `start` jusqu'à trouver la racine du repo. */
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
 * Charge la config effective. Ordre de résolution de la racine :
 * 1. `GMOD_MCP_REPO` (env)  2. champ `repoRoot` du fichier  3. remontée depuis cwd.
 */
export function loadConfig(cwd: string = process.cwd()): Config {
  const envRoot = process.env.GMOD_MCP_REPO;

  // On cherche d'abord un fichier de config via la racine env ou la remontée.
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
