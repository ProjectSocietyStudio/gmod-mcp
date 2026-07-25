import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import type { AuditLog } from "../logger.js";
import { EventEnvelope, ResultEnvelope } from "../schemas.js";
import type { CommandEnvelope, EventEnvelope as EventT } from "../schemas.js";

/** Realms qui parlent au bridge (le realm `local` ne passe pas par ici). */
type BridgeRealm = "sv" | "cl";

const HEADER_TOKEN = "x-gmod-mcp-token";

export interface BridgeOptions {
  port: number;
  token: string;
  audit: AuditLog;
  /** Durée de maintien d'un long-poll sans commande (ms). */
  pollHoldMs?: number;
  /** Délai avant abandon d'une commande sans résultat (ms). */
  commandTimeoutMs?: number;
}

interface Pending {
  resolve: (r: ResultEnvelope) => void;
  reject: (e: Error) => void;
  timer: NodeJS.Timeout;
}

interface Waiter {
  res: ServerResponse;
  timer: NodeJS.Timeout;
}

/**
 * Serveur HTTP du bridge, bind 127.0.0.1 uniquement. Les addons GLua font du
 * long-poll (`GET /poll?realm=sv`), exécutent les commandes reçues, et renvoient
 * les résultats (`POST /result`) et événements (`POST /event`). Le daemon pousse
 * des commandes via `enqueue()` et attend le résultat corrélé par `id`.
 *
 * Émet les événements sous le nom `"event"` (payload EventEnvelope).
 */
export class BridgeServer extends EventEmitter {
  private readonly server: Server;
  private readonly token: string;
  private readonly audit: AuditLog;
  private readonly pollHoldMs: number;
  private readonly commandTimeoutMs: number;

  private readonly queues: Record<BridgeRealm, CommandEnvelope[]> = { sv: [], cl: [] };
  private readonly waiters: Record<BridgeRealm, Waiter[]> = { sv: [], cl: [] };
  private readonly pending = new Map<string, Pending>();

  constructor(opts: BridgeOptions) {
    super();
    this.token = opts.token;
    this.audit = opts.audit;
    this.pollHoldMs = opts.pollHoldMs ?? 25_000;
    this.commandTimeoutMs = opts.commandTimeoutMs ?? 30_000;
    this.server = createServer((req, res) => void this.handle(req, res));
  }

  listen(port: number, host = "127.0.0.1"): Promise<void> {
    return new Promise((resolve) => this.server.listen(port, host, resolve));
  }

  /** Port réellement lié (utile quand on écoute sur 0 pour les tests). */
  address(): number | undefined {
    const a = this.server.address();
    return a && typeof a === "object" ? a.port : undefined;
  }

  async close(): Promise<void> {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("bridge fermé"));
    }
    this.pending.clear();
    for (const realm of ["sv", "cl"] as const) {
      for (const w of this.waiters[realm]) {
        clearTimeout(w.timer);
        w.res.end(JSON.stringify({ commands: [] }));
      }
      this.waiters[realm] = [];
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  /**
   * Pousse une commande vers un realm et attend son résultat. Rejette si aucun
   * résultat n'arrive dans `commandTimeoutMs` (bridge absent ou handler bloqué).
   */
  enqueue(
    realm: BridgeRealm,
    tool: string,
    args: Record<string, unknown>,
    opts: { confirmed?: boolean } = {},
  ): Promise<ResultEnvelope> {
    const id = randomUUID();
    const cmd: CommandEnvelope = {
      id,
      tool,
      args,
      realm,
      ...(opts.confirmed ? { confirmed: true } : {}),
    };

    const promise = new Promise<ResultEnvelope>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        // Retirer aussi de la file : sinon un addon qui (re)connecte recevrait une
        // commande périmée dont le résultat serait ensuite jeté (id inconnu).
        const q = this.queues[realm];
        const qi = q.findIndex((c) => c.id === id);
        if (qi >= 0) q.splice(qi, 1);
        reject(new Error(`timeout: aucun résultat du realm ${realm} pour ${tool} (${this.commandTimeoutMs}ms)`));
      }, this.commandTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });

    this.audit.record({ kind: "bridge_command", commandId: id, data: { realm, tool, args } });

    const waiter = this.waiters[realm].shift();
    if (waiter) {
      clearTimeout(waiter.timer);
      waiter.res.end(JSON.stringify({ commands: [cmd] }));
    } else {
      this.queues[realm].push(cmd);
    }
    return promise;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      const url = new URL(req.url ?? "/", "http://127.0.0.1");

      if (req.method === "GET" && url.pathname === "/health") {
        return this.json(res, 200, { ok: true });
      }

      if ((req.headers[HEADER_TOKEN] ?? "") !== this.token) {
        return this.json(res, 401, { error: "token invalide" });
      }

      if (req.method === "GET" && url.pathname === "/poll") {
        return this.handlePoll(url, res);
      }
      if (req.method === "POST" && url.pathname === "/result") {
        return this.handleResult(await readJson(req), res);
      }
      if (req.method === "POST" && url.pathname === "/event") {
        return this.handleEvent(await readJson(req), res);
      }
      return this.json(res, 404, { error: "route inconnue" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.json(res, 400, { error: message });
    }
  }

  private handlePoll(url: URL, res: ServerResponse): void {
    const realm = url.searchParams.get("realm");
    if (realm !== "sv" && realm !== "cl") {
      return this.json(res, 400, { error: "realm doit être sv ou cl" });
    }
    const queued = this.queues[realm];
    if (queued.length > 0) {
      const commands = queued.splice(0, queued.length);
      return this.json(res, 200, { commands });
    }
    // Long-poll : on maintient la réponse ouverte jusqu'à une commande ou timeout.
    const timer = setTimeout(() => {
      const i = this.waiters[realm].findIndex((w) => w.res === res);
      if (i >= 0) this.waiters[realm].splice(i, 1);
      this.json(res, 200, { commands: [] });
    }, this.pollHoldMs);
    this.waiters[realm].push({ res, timer });
  }

  private handleResult(body: unknown, res: ServerResponse): void {
    const parsed = ResultEnvelope.safeParse(body);
    if (!parsed.success) return this.json(res, 400, { error: "result mal formé" });
    const result = parsed.data;
    const pending = this.pending.get(result.id);
    if (!pending) return this.json(res, 200, { ok: true, note: "id inconnu ou expiré" });
    clearTimeout(pending.timer);
    this.pending.delete(result.id);
    pending.resolve(result);
    return this.json(res, 200, { ok: true });
  }

  private handleEvent(body: unknown, res: ServerResponse): void {
    const parsed = EventEnvelope.safeParse(body);
    if (!parsed.success) return this.json(res, 400, { error: "event mal formé" });
    const event: EventT = parsed.data;
    this.audit.record({ kind: "bridge_event", data: { type: event.type, realm: event.realm, payload: event.payload } });
    this.emit("event", event);
    return this.json(res, 200, { ok: true });
  }

  private json(res: ServerResponse, status: number, body: unknown): void {
    const text = JSON.stringify(body);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(text);
  }
}

/** Lit et parse un corps JSON, borné à 1 Mo. */
async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Large limite : les résultats capture_screen (JPEG base64) dépassent 1 Mo.
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 32_000_000) throw new Error("corps trop volumineux");
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
