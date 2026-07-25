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
 * Marker the engine prints once per startup. Used to find the boot boundary from the
 * log's own content, which is the only method that works when the daemon did not start
 * the server itself.
 */
const BOOT_MARKER = "Initializing Steam libraries";

/**
 * Byte offset of the last boot marker in the log, or undefined when none is present.
 * Searched over the raw bytes: the game log contains NUL bytes, and decoding it as utf8
 * first would be both wasteful and lossy.
 */
function lastBootMarkerOffset(buf: Buffer): number | undefined {
  const idx = buf.lastIndexOf(BOOT_MARKER, undefined, "utf8");
  return idx === -1 ? undefined : idx;
}

/**
 * Reads the game log from the boot boundary, or the whole file when `sinceBoot` is
 * false. Read as binary then decoded as utf8; NUL bytes are kept as-is and cleaned up
 * by the runtime parser.
 *
 * The boundary is taken from the LOG ITSELF, falling back to the offset recorded by
 * startServer. The recorded offset alone is not trustworthy: it is only written when
 * the daemon starts the server, so any other start -- a shell invocation of
 * start-server.sh, a service unit, a manual restart -- leaves it pointing into a
 * previous run.
 *
 * That failure was silent and actively misleading. `sinceBoot: true` would return
 * errors from an earlier boot as though they were current, which is precisely the trap
 * this function exists to prevent: garrysmod/console.log accumulates across restarts,
 * unlike srcds/console.log which is truncated on each start.
 *
 * When both are available the later one wins. A recorded offset can legitimately sit
 * past the last marker -- the daemon captures the file size before launching, and the
 * engine prints the marker shortly after -- so taking the maximum keeps the tighter,
 * more recent bound in either direction.
 */
export function readGameLog(config: Config, sinceBoot: boolean): string {
  const p = paths(config);
  if (!existsSync(p.gameLog)) return "";
  const buf = readFileSync(p.gameLog);
  if (!sinceBoot) return buf.toString("utf8");

  const marker = lastBootMarkerOffset(buf);
  const recorded = readBootState(config)?.offset;

  const candidates = [marker, recorded].filter(
    (n): n is number => typeof n === "number" && n >= 0 && n <= buf.length,
  );
  const start = candidates.length > 0 ? Math.max(...candidates) : 0;

  return buf.subarray(start).toString("utf8");
}

export function readStdoutLog(config: Config): string {
  const p = paths(config);
  return existsSync(p.stdoutLog) ? readFileSync(p.stdoutLog).toString("utf8") : "";
}
