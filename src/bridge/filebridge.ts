import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditLog } from "../logger.js";
import { EventEnvelope, ResultEnvelope } from "../schemas.js";
import type { CommandEnvelope } from "../schemas.js";
import { acquireTransportLock, lockConflictMessage, releaseTransportLock } from "./lock.js";
import type { LockState } from "./lock.js";
import type { Bridge, BridgeStatus, EnqueueOptions } from "./types.js";

interface Pending {
  tool: string;
  realm: "sv" | "cl";
  resolve: (r: ResultEnvelope) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

export interface FileBridgeOptions {
  /** Directory shared with srcds: `<repoRoot>/srcds/garrysmod/data/gmod_mcp`. */
  dir: string;
  audit: AuditLog;
  scanIntervalMs?: number;
  commandTimeoutMs?: number;
  /**
   * How long a `res/` file that matches no command of ours is left alone before being
   * reaped. Long enough that a slow correlation is never mistaken for an orphan.
   */
  orphanGraceMs?: number;
  /** Recorded in the lock file so a conflict message can name the version. */
  version?: string;
  /** Recorded in the lock file. */
  repoRoot?: string;
  /**
   * Skip the single-instance lock. For tests, which run several bridges on private
   * temporary directories where contention is meaningless.
   */
  lock?: boolean;
}

/**
 * **File**-based bridge transport inside GMod's DATA sandbox: the daemon and srcds
 * share a filesystem, so there is no network dependency -- unlike `HTTP()`, which was
 * measured not to reach a localhost daemon from srcds.
 *
 * Protocol: the daemon writes `cmd/<id>.json` (atomically, via .tmp then rename); the
 * addon reads it, runs it, writes `res/<id>.json` and deletes the command. Events
 * arrive as `evt/<n>.json`. The daemon scans `res/` and `evt/` on an interval.
 *
 * Both realms share the same file channel: `cl` commands are relayed by the server
 * addon to the client over net messages, and the result comes back in `res/`. The
 * client therefore never needs to share the disk.
 *
 * ONE DAEMON PER DIRECTORY, enforced by a lock (see `lock.ts`). The protocol consumes
 * `res/`, so a second daemon reading the same directory deletes results the first one is
 * waiting for. It took forty minutes of debugging the game to find that the fault was a
 * third process, so the transport now refuses to share and says so.
 */
export class FileBridge extends EventEmitter implements Bridge {
  private readonly dir: string;
  private readonly cmdDir: string;
  private readonly resDir: string;
  private readonly evtDir: string;
  private readonly audit: AuditLog;
  private readonly commandTimeoutMs: number;
  private readonly orphanGraceMs: number;
  private readonly pending = new Map<string, Pending>();
  private readonly scanner?: NodeJS.Timeout;
  private readonly lock: LockState;
  /** False when the lock was bypassed (tests): nothing to release on the way out. */
  private readonly locking: boolean;

  /**
   * Commands we gave up on, kept so their late result is recognised as OURS and deleted
   * on sight instead of ageing out as an orphan.
   */
  private readonly abandoned = new Map<string, number>();
  /** `res/` files matching nothing of ours, with the time we first saw them. */
  private readonly unclaimed = new Map<string, number>();
  private uncorrelatedResults = 0;
  private lastAddonContact: number | undefined;

  constructor(opts: FileBridgeOptions) {
    super();
    this.audit = opts.audit;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 30_000;
    this.orphanGraceMs = opts.orphanGraceMs ?? Math.max(60_000, this.commandTimeoutMs * 2);
    this.dir = opts.dir;
    this.cmdDir = join(opts.dir, "cmd");
    this.resDir = join(opts.dir, "res");
    this.evtDir = join(opts.dir, "evt");
    for (const d of [this.cmdDir, this.resDir, this.evtDir]) mkdirSync(d, { recursive: true });

    this.locking = opts.lock !== false;
    this.lock = !this.locking
      ? { path: join(opts.dir, "daemon.lock"), held: true }
      : acquireTransportLock(opts.dir, {
          version: opts.version ?? "unknown",
          repoRoot: opts.repoRoot ?? opts.dir,
        });

    // No lock, no scanner: a daemon that does not own the directory must not read, and
    // above all must not delete, anything in it.
    if (this.lock.held) {
      this.scanner = setInterval(() => this.scan(), opts.scanIntervalMs ?? 150);
      // Do not keep the process alive just for this timer.
      this.scanner.unref?.();
    }
  }

  /** Readable relay state, for `health`. Guessing at this cost the original debugging. */
  status(): BridgeStatus {
    return {
      transportDir: this.dir,
      owns: this.lock.held,
      lockPath: this.lock.path,
      ...(this.lock.owner ? { lockedBy: this.lock.owner } : {}),
      inFlight: [...this.pending.values()].map((p) => `${p.realm}:${p.tool}`),
      uncorrelatedResults: this.uncorrelatedResults,
      ...(this.lastAddonContact === undefined
        ? { lastAddonContactMsAgo: null }
        : { lastAddonContactMsAgo: Date.now() - this.lastAddonContact }),
    };
  }

  enqueue(
    realm: "sv" | "cl",
    tool: string,
    args: Record<string, unknown>,
    opts: EnqueueOptions = {},
  ): Promise<ResultEnvelope> {
    // Refuse before writing anything: a command we cannot collect the result of would
    // still run in the game, and its orphan result would confuse the daemon that owns
    // the directory.
    if (!this.lock.held) {
      return Promise.reject(new Error(lockConflictMessage(this.lock, this.dir)));
    }

    // sv and cl share the channel; the server addon routes cl commands to the client.
    const id = randomUUID();
    const cmd: CommandEnvelope = { id, tool, args, realm, ...(opts.confirmed ? { confirmed: true } : {}) };
    const timeoutMs = opts.timeoutMs ?? this.commandTimeoutMs;

    const promise = new Promise<ResultEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Remember it: a result arriving after this is still ours to clean up.
        this.abandoned.set(id, Date.now());
        const message = this.describeTimeout(id, tool, realm, timeoutMs);
        this.safeDelete(join(this.cmdDir, `${id}.json`)); // drop the unconsumed command
        reject(new Error(message));
      }, timeoutMs);
      this.pending.set(id, { tool, realm, resolve, reject, timer });
    });

    // Atomic write: .tmp then rename, so the addon never reads a partial file.
    const tmp = join(this.cmdDir, `${id}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(cmd));
    renameSync(tmp, join(this.cmdDir, `${id}.json`));
    this.audit.record({ kind: "bridge_command", commandId: id, data: { realm, tool, args } });
    return promise;
  }

  /**
   * Says WHICH link broke, because the old message named the one that almost never does.
   * "is srcds running with the addon mounted?" sent a debugging session checking a running
   * server three times while the real cause was a second daemon.
   *
   * The command file still sitting in `cmd/` is the discriminator: nobody polled. Gone
   * means the addon took it and the answer is what went missing.
   */
  private describeTimeout(id: string, tool: string, realm: "sv" | "cl", timeoutMs: number): string {
    const stillQueued = existsSync(join(this.cmdDir, `${id}.json`));
    if (stillQueued) {
      return (
        `timeout: ${tool} was never picked up after ${timeoutMs}ms -- its command file is still in ` +
        `cmd/, so no bridge addon is polling. Check that srcds is running and that ` +
        `"[gmod-mcp] file transport active" appears in the game console.`
      );
    }

    const parts = [
      `timeout: the bridge consumed ${tool} but no result came back after ${timeoutMs}ms ` +
        `(the addon IS polling -- the command file was taken).`,
    ];
    if (realm === "cl") {
      parts.push(
        "This is a client-realm tool: the server relayed it over net and the client did not answer. " +
          "A frozen or still-chunking GMod client looks exactly like this.",
      );
    }
    if (this.uncorrelatedResults > 0) {
      parts.push(
        `WARNING: ${this.uncorrelatedResults} result file(s) in res/ matched no command of ours. ` +
          "Another gmod-mcp daemon is very likely sharing this directory and deleting our results " +
          "(ps -eo pid,etime,args | grep gmod-mcp/dist/index.js).",
      );
    }
    return parts.join(" ");
  }

  private scan(): void {
    const now = Date.now();
    const present = this.safeList(this.resDir);
    for (const name of present) {
      if (!name.endsWith(".json")) continue;
      const id = name.slice(0, -".json".length);
      const path = join(this.resDir, name);

      const p = this.pending.get(id);
      if (!p) {
        // Ours, but already timed out: sweep it and stay quiet -- the caller has its error.
        if (this.abandoned.delete(id)) {
          this.lastAddonContact = now;
          this.safeDelete(path);
          continue;
        }
        this.reapUnclaimed(name, now);
        continue;
      }

      const parsed = this.readJson(path);
      if (!parsed) continue; // file still being written; retry on the next scan
      const res = ResultEnvelope.safeParse(parsed);
      this.safeDelete(path);
      this.lastAddonContact = now;
      clearTimeout(p.timer);
      this.pending.delete(id);
      if (!res.success || res.data.id !== id) {
        // Never leave the caller on a 30s timeout for a file we did read: a malformed
        // envelope is a bug in the addon, and saying so beats silence.
        p.reject(new Error(`malformed result envelope for ${p.tool} in res/${name}`));
        continue;
      }
      p.resolve(res.data);
    }

    // A file another daemon deleted must not stay on our books.
    const listed = new Set(present);
    for (const name of this.unclaimed.keys()) {
      if (!listed.has(name)) this.unclaimed.delete(name);
    }
    for (const [id, at] of this.abandoned) {
      if (now - at > this.orphanGraceMs * 5) this.abandoned.delete(id);
    }

    // Events
    for (const name of this.safeList(this.evtDir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.evtDir, name);
      const parsed = this.readJson(path);
      if (!parsed) continue;
      this.safeDelete(path);
      this.lastAddonContact = now;
      const ev = EventEnvelope.safeParse(parsed);
      if (!ev.success) continue;
      this.audit.record({ kind: "bridge_event", data: { type: ev.data.type, realm: ev.data.realm, payload: ev.data.payload } });
      this.emit("event", ev.data);
    }
  }

  /**
   * A `res/` file we did not ask for is left alone for a grace period, then reaped.
   *
   * Deleting it on sight is the behaviour that turned coexistence into an outage: the file
   * belonged to another daemon's in-flight command, and destroying it produced a timeout
   * that pointed at the game. Leaving it forever is not an option either -- an addon that
   * answers after a caller has gone would litter the directory for the rest of the map --
   * so the compromise is a delay far longer than any correlation takes.
   */
  private reapUnclaimed(name: string, now: number): void {
    const seen = this.unclaimed.get(name);
    if (seen === undefined) {
      this.unclaimed.set(name, now);
      this.uncorrelatedResults += 1;
      return;
    }
    if (now - seen < this.orphanGraceMs) return;
    this.unclaimed.delete(name);
    this.safeDelete(join(this.resDir, name));
  }

  private safeList(dir: string): string[] {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  }

  private readJson(path: string): unknown {
    try {
      return JSON.parse(readFileSync(path, "utf8"));
    } catch {
      return undefined;
    }
  }

  private safeDelete(path: string): void {
    try {
      rmSync(path, { force: true });
    } catch {
      /* ignore */
    }
  }

  close(): Promise<void> {
    if (this.scanner) clearInterval(this.scanner);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("bridge closed"));
    }
    this.pending.clear();
    if (this.locking) releaseTransportLock(this.lock);
    return Promise.resolve();
  }
}
