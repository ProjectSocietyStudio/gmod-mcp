import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Config } from "../config.js";
import { run } from "./run.js";
import type { RunResult } from "./run.js";

/** Paths derived from the repo root. */
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
 * Resolves an addon (name or path) to an absolute directory.
 * A bare name is looked up under `<root>/addons/<name>`.
 */
export function resolveAddonDir(config: Config, addon: string): string {
  if (isAbsolute(addon) && existsSync(addon)) return addon;
  const asPath = resolve(config.repoRoot, addon);
  if (existsSync(asPath)) return asPath;
  return join(config.repoRoot, "addons", addon);
}

export interface BootState {
  /** Byte offset into gameLog marking the start of the current boot. */
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
 * Starts the server. The boot boundary is captured BEFORE launching, as the current
 * size of gameLog: everything appended afterwards belongs to this boot, with no race
 * against the server's first writes.
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
 * Reads the game log from the boot boundary, or the whole file when `sinceBoot` is
 * false or no boot is known. Read as binary then decoded as utf8; NUL bytes are kept
 * as-is and cleaned up by the runtime parser.
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
