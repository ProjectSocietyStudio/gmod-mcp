import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AuditLog } from "../logger.js";
import { EventEnvelope, ResultEnvelope } from "../schemas.js";
import type { CommandEnvelope } from "../schemas.js";
import type { Bridge } from "./types.js";

interface Pending {
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
}

/**
 * Transport bridge par **fichiers** dans le sandbox DATA de GMod — le daemon et
 * srcds share a filesystem, so there is no network dependency -- unlike `HTTP()`,
 * which was measured not to reach a localhost daemon from srcds.
 *
 * Protocol: the daemon writes `cmd/<id>.json` (atomically, via .tmp then rename); the
 * addon reads it, runs it, writes `res/<id>.json` and deletes the command. Events
 * arrivent en `evt/<n>.json`. Le daemon scanne `res/` et `evt/` par intervalle.
 *
 * Both realms share the same file channel: `cl` commands are relayed by the server
 * addon to the client over net messages, and the result comes back in `res/`. The
 * client therefore never needs to share the disk.
 */
export class FileBridge extends EventEmitter implements Bridge {
  private readonly cmdDir: string;
  private readonly resDir: string;
  private readonly evtDir: string;
  private readonly audit: AuditLog;
  private readonly commandTimeoutMs: number;
  private readonly pending = new Map<string, Pending>();
  private readonly scanner: NodeJS.Timeout;

  constructor(opts: FileBridgeOptions) {
    super();
    this.audit = opts.audit;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 30_000;
    this.cmdDir = join(opts.dir, "cmd");
    this.resDir = join(opts.dir, "res");
    this.evtDir = join(opts.dir, "evt");
    for (const d of [this.cmdDir, this.resDir, this.evtDir]) mkdirSync(d, { recursive: true });
    this.scanner = setInterval(() => this.scan(), opts.scanIntervalMs ?? 150);
    // Do not keep the process alive just for this timer.
    this.scanner.unref?.();
  }

  enqueue(
    realm: "sv" | "cl",
    tool: string,
    args: Record<string, unknown>,
    opts: { confirmed?: boolean } = {},
  ): Promise<ResultEnvelope> {
    // sv and cl share the channel; the server addon routes cl commands to the client.
    const id = randomUUID();
    const cmd: CommandEnvelope = { id, tool, args, realm, ...(opts.confirmed ? { confirmed: true } : {}) };

    const promise = new Promise<ResultEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.safeDelete(join(this.cmdDir, `${id}.json`)); // drop the unconsumed command
        reject(new Error(`timeout: no result for ${tool} after ${this.commandTimeoutMs}ms -- is srcds running with the addon mounted?`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });

    // Atomic write: .tmp then rename, so the addon never reads a partial file.
    const tmp = join(this.cmdDir, `${id}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(cmd));
    renameSync(tmp, join(this.cmdDir, `${id}.json`));
    this.audit.record({ kind: "bridge_command", commandId: id, data: { realm, tool, args } });
    return promise;
  }

  private scan(): void {
    // Results
    for (const name of this.safeList(this.resDir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.resDir, name);
      const parsed = this.readJson(path);
      if (!parsed) continue; // file still being written; retry on the next scan
      const res = ResultEnvelope.safeParse(parsed);
      this.safeDelete(path);
      if (!res.success) continue;
      const p = this.pending.get(res.data.id);
      if (p) {
        clearTimeout(p.timer);
        this.pending.delete(res.data.id);
        p.resolve(res.data);
      }
    }
    // Events
    for (const name of this.safeList(this.evtDir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.evtDir, name);
      const parsed = this.readJson(path);
      if (!parsed) continue;
      this.safeDelete(path);
      const ev = EventEnvelope.safeParse(parsed);
      if (!ev.success) continue;
      this.audit.record({ kind: "bridge_event", data: { type: ev.data.type, realm: ev.data.realm, payload: ev.data.payload } });
      this.emit("event", ev.data);
    }
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
    clearInterval(this.scanner);
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("bridge closed"));
    }
    this.pending.clear();
    return Promise.resolve();
  }
}
