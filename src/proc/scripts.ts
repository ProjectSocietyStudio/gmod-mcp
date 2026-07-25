import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Config } from "../config.js";
import { run } from "./run.js";
import type { RunResult } from "./run.js";

/** Chemins dérivés de la racine du repo. */
export function paths(config: Config) {
  const root = config.repoRoot;
  return {
    root,
    lint: join(root, "tools", "lint.sh"),
    start: join(root, "tools", "start-server.sh"),
    stop: join(root, "tools", "stop-server.sh"),
    sync: join(root, "tools", "sync-server-config.sh"),
    packageGma: join(root, "tools", "package-gma.sh"),
    stdoutLog: join(root, "srcds", "console.log"),
    gameLog: join(root, "srcds", "garrysmod", "console.log"),
    bootState: join(config.stateDir, "server-boot.json"),
  };
}

/**
 * Résout un addon (nom ou chemin) en dossier absolu.
 * Un nom simple est cherché sous `<root>/addons/<nom>`.
 */
export function resolveAddonDir(config: Config, addon: string): string {
  if (isAbsolute(addon) && existsSync(addon)) return addon;
  const asPath = resolve(config.repoRoot, addon);
  if (existsSync(asPath)) return asPath;
  return join(config.repoRoot, "addons", addon);
}

export interface BootState {
  /** Offset d'octet dans gameLog marquant le début du boot courant. */
  offset: number;
  startedAt: number;
  map?: string;
  gamemode?: string;
  tickrate?: number;
}

function fileSize(p: string): number {
  return existsSync(p) ? statSync(p).size : 0;
}

export function readBootState(config: Config): BootState | undefined {
  const p = paths(config).bootState;
  if (!existsSync(p)) return undefined;
  return JSON.parse(readFileSync(p, "utf8")) as BootState;
}

export function lintAddon(config: Config, addon: string): Promise<RunResult> {
  return run("bash", [paths(config).lint, resolveAddonDir(config, addon)], {
    cwd: config.repoRoot,
    timeoutMs: 180_000,
  });
}

export interface StartArgs {
  map?: string;
  gamemode?: string;
  tickrate?: number;
}

/**
 * Démarre le serveur. La frontière de boot est capturée AVANT le lancement
 * (taille courante du gameLog) : tout ce qui est ajouté ensuite appartient au
 * boot courant, sans course avec les premières écritures du serveur.
 */
export async function startServer(
  config: Config,
  { map, gamemode, tickrate }: StartArgs,
): Promise<{ result: RunResult; boot: BootState }> {
  const p = paths(config);
  const offset = fileSize(p.gameLog);

  const args = [p.start];
  if (map) args.push(map);
  if (gamemode) args.push(gamemode);
  if (tickrate !== undefined) args.push(String(tickrate));

  const result = await run("bash", args, { cwd: config.repoRoot, timeoutMs: 120_000 });

  const boot: BootState = {
    offset,
    startedAt: Date.now(),
    ...(map ? { map } : {}),
    ...(gamemode ? { gamemode } : {}),
    ...(tickrate !== undefined ? { tickrate } : {}),
  };
  writeFileSync(p.bootState, JSON.stringify(boot, null, 2));
  return { result, boot };
}

export function stopServer(config: Config): Promise<RunResult> {
  return run("bash", [paths(config).stop], { cwd: config.repoRoot, timeoutMs: 30_000 });
}

export function syncConfig(config: Config, check: boolean): Promise<RunResult> {
  const args = [paths(config).sync];
  if (check) args.push("--check");
  return run("bash", args, { cwd: config.repoRoot, timeoutMs: 60_000 });
}

export function packageAddon(config: Config, addon: string): Promise<RunResult> {
  return run("bash", [paths(config).packageGma, resolveAddonDir(config, addon)], {
    cwd: config.repoRoot,
    timeoutMs: 180_000,
  });
}

/**
 * Lit le log de jeu depuis la frontière de boot (ou tout, si `sinceBoot=false`
 * ou pas de boot connu). Lecture binaire puis décodage utf8 ; les octets NUL
 * sont conservés tels quels et nettoyés par le parser runtime.
 */
export function readGameLog(config: Config, sinceBoot: boolean): string {
  const p = paths(config);
  if (!existsSync(p.gameLog)) return "";
  const buf = readFileSync(p.gameLog);
  if (!sinceBoot) return buf.toString("utf8");
  const boot = readBootState(config);
  const start = boot ? Math.min(boot.offset, buf.length) : 0;
  return buf.subarray(start).toString("utf8");
}

export function readStdoutLog(config: Config): string {
  const p = paths(config);
  return existsSync(p.stdoutLog) ? readFileSync(p.stdoutLog).toString("utf8") : "";
}
