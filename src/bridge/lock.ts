import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Single-instance lock on the file transport directory.
 *
 * WHY THIS EXISTS. The transport is a shared directory (`srcds/garrysmod/data/gmod_mcp`)
 * and the protocol is "the daemon consumes `res/`". Two daemons therefore consume each
 * other's results: whichever scans first reads, correlates against ITS OWN pending map,
 * finds nothing, and deletes the file. The command really ran, the result really was
 * written, and the caller still gets a timeout. Measured 2026-07-25: a second Claude Code
 * session opened on the same repo started a second daemon, and from that minute every
 * bridge tool in the first session timed out -- while srcds was healthy and the addon
 * mounted, which is exactly what the old timeout message accused. Neither reconnecting the
 * game client nor restarting the server changed anything, because the interfering state
 * lived in a third process.
 *
 * A lock rather than partitioning (each daemon tagging its own files). Partitioning would
 * let both coexist in the directory, but the two would still fight over the single game
 * client -- one daemon's `client_input` moving the cursor the other is about to click, one
 * capture's chunks pacing against another's on the same reliable channel. Two agents
 * driving one game is not a state worth making comfortable; it is worth naming.
 *
 * The lock is advisory and PID-based: a daemon killed without releasing leaves a stale
 * file, which the next start reclaims after checking the PID is gone. That is the only
 * failure mode that must not need a human.
 */
const LOCK_NAME = "daemon.lock";

/** Whoever wrote the lock file. */
export interface LockOwner {
  pid: number;
  startedAt: string;
  version?: string;
  repoRoot?: string;
}

export interface LockState {
  /** Absolute path of the lock file, so an error message can name it. */
  path: string;
  /** True when THIS process owns the transport. */
  held: boolean;
  /** The live owner, when the lock could not be taken. */
  owner?: LockOwner;
}

function readOwner(path: string): LockOwner | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<LockOwner>;
    if (typeof parsed.pid === "number" && Number.isFinite(parsed.pid)) {
      return {
        pid: parsed.pid,
        startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "unknown",
        ...(typeof parsed.version === "string" ? { version: parsed.version } : {}),
        ...(typeof parsed.repoRoot === "string" ? { repoRoot: parsed.repoRoot } : {}),
      };
    }
  } catch {
    /* unreadable or truncated: treated as stale below */
  }
  return undefined;
}

/**
 * Is that PID still around? `EPERM` counts as alive -- the process exists, it simply is
 * not ours to signal. Reclaiming a lock on that basis would be the bug this file prevents.
 */
function isAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Takes the lock, or reports who holds it. Never throws on contention: the caller starts
 * in a degraded mode that can explain itself, which a hard exit cannot -- an MCP server
 * that fails to boot only ever says so on stderr, where nobody debugging a timeout looks.
 */
export function acquireTransportLock(
  dir: string,
  meta: { version: string; repoRoot: string },
): LockState {
  const path = join(dir, LOCK_NAME);
  const body = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    version: meta.version,
    repoRoot: meta.repoRoot,
  });

  // Two passes: the first may find a stale file to reclaim, the second must then win or
  // lose for real. Looping further would spin on a live owner.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      // "wx": exclusive create. The atomicity is the whole mechanism.
      writeFileSync(path, body, { flag: "wx" });
      return { path, held: true };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const owner = readOwner(path);
      if (owner && isAlive(owner.pid)) return { path, held: false, owner };
      // Stale (dead PID, or a file we cannot parse): the previous daemon was killed
      // without releasing. Drop it and try once more.
      try {
        unlinkSync(path);
      } catch {
        /* someone else reclaimed it first; the next attempt settles who owns it */
      }
    }
  }
  return { path, held: false };
}

/** Releases the lock, but only if the file still names us: never steal on the way out. */
export function releaseTransportLock(state: LockState): void {
  if (!state.held) return;
  const owner = readOwner(state.path);
  if (owner && owner.pid !== process.pid) return;
  try {
    unlinkSync(state.path);
  } catch {
    /* already gone */
  }
}

/** The message every tool shows when another daemon owns the transport. */
export function lockConflictMessage(state: LockState, dir: string): string {
  const who = state.owner
    ? `PID ${state.owner.pid}, started ${state.owner.startedAt}`
    : "an unidentified process";
  return [
    `another gmod-mcp daemon already owns the transport directory (${who}).`,
    `Two daemons sharing ${dir} consume each other's result files, so EVERY bridge tool`,
    `times out even though srcds is running and the addon is mounted.`,
    `This daemon therefore left the directory untouched.`,
    `Diagnose with: ps -eo pid,etime,args | grep gmod-mcp/dist/index.js`,
    `-- more than one line means two Claude Code sessions are open on this repo.`,
    `Close the other session, or delete ${state.path} if that PID is gone.`,
  ].join(" ");
}
