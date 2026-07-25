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
  /** Dossier partagé avec srcds : `<repoRoot>/srcds/garrysmod/data/gmod_mcp`. */
  dir: string;
  audit: AuditLog;
  scanIntervalMs?: number;
  commandTimeoutMs?: number;
}

/**
 * Transport bridge par **fichiers** dans le sandbox DATA de GMod — le daemon et
 * srcds partagent le filesystem, donc aucune dépendance réseau (contrairement à
 * `HTTP()` qui, mesuré, ne joint pas le daemon localhost depuis srcds).
 *
 * Protocole : le daemon écrit `cmd/<id>.json` (atomique via .tmp+rename) ; l'addon
 * le lit, l'exécute, écrit `res/<id>.json`, et supprime le cmd. Les événements
 * arrivent en `evt/<n>.json`. Le daemon scanne `res/` et `evt/` par intervalle.
 *
 * Les deux realms passent par le même canal fichier : les commandes `cl` sont
 * routées par l'addon serveur vers le client via net messages (relais), puis le
 * résultat revient dans `res/` — le client n'a pas besoin de partager le disque.
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
    // Ne pas empêcher le process de sortir à cause du timer.
    this.scanner.unref?.();
  }

  enqueue(
    realm: "sv" | "cl",
    tool: string,
    args: Record<string, unknown>,
    opts: { confirmed?: boolean } = {},
  ): Promise<ResultEnvelope> {
    // sv et cl passent par le même canal ; l'addon serveur route les cl vers le client.
    const id = randomUUID();
    const cmd: CommandEnvelope = { id, tool, args, realm, ...(opts.confirmed ? { confirmed: true } : {}) };

    const promise = new Promise<ResultEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.safeDelete(join(this.cmdDir, `${id}.json`)); // purge la commande non consommée
        reject(new Error(`timeout: aucun résultat pour ${tool} (${this.commandTimeoutMs}ms) — srcds tourne, addon monté ?`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });

    // Écriture atomique : .tmp puis rename, pour que l'addon ne lise jamais un fichier partiel.
    const tmp = join(this.cmdDir, `${id}.json.tmp`);
    writeFileSync(tmp, JSON.stringify(cmd));
    renameSync(tmp, join(this.cmdDir, `${id}.json`));
    this.audit.record({ kind: "bridge_command", commandId: id, data: { realm, tool, args } });
    return promise;
  }

  private scan(): void {
    // Résultats
    for (const name of this.safeList(this.resDir)) {
      if (!name.endsWith(".json")) continue;
      const path = join(this.resDir, name);
      const parsed = this.readJson(path);
      if (!parsed) continue; // fichier en cours d'écriture : on réessaiera au prochain scan
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
    // Événements
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
      p.reject(new Error("bridge fermé"));
    }
    this.pending.clear();
    return Promise.resolve();
  }
}
