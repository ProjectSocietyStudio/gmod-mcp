import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeServer } from "../src/bridge/server.js";
import { AuditLog } from "../src/logger.js";
import type { EventEnvelope } from "../src/schemas.js";

const audit = new AuditLog(mkdtempSync(join(tmpdir(), "gmod-mcp-test-")));
let bridge: BridgeServer;
let base: string;
const token = "test-token";

/**
 * Poller Lua simulé : long-poll, renvoie pour chaque commande un résultat qui
 * fait écho au tool/args/confirmed reçus. Reproduit ce que fera l'addon GLua.
 */
function startFakePoller(): { stop: () => void } {
  let running = true;
  void (async () => {
    while (running) {
      let commands: Array<{ id: string; tool: string; args: unknown; confirmed?: boolean }> = [];
      try {
        const resp = await fetch(`${base}/poll?realm=sv`, {
          headers: { "x-gmod-mcp-token": token },
        });
        commands = (await resp.json()).commands;
      } catch {
        break;
      }
      for (const c of commands) {
        await fetch(`${base}/result`, {
          method: "POST",
          headers: { "x-gmod-mcp-token": token, "content-type": "application/json" },
          body: JSON.stringify({
            id: c.id,
            ok: true,
            data: { echo: c.tool, args: c.args, confirmed: c.confirmed ?? false },
          }),
        });
      }
    }
  })();
  return { stop: () => (running = false) };
}

let poller: { stop: () => void };

beforeAll(async () => {
  bridge = new BridgeServer({ port: 0, token, audit, pollHoldMs: 300, commandTimeoutMs: 3000 });
  await bridge.listen(0);
  base = `http://127.0.0.1:${bridge.address()}`;
  poller = startFakePoller();
});

afterAll(async () => {
  poller.stop();
  await bridge.close();
});

describe("BridgeServer", () => {
  it("répond à /health sans token", async () => {
    const r = await fetch(`${base}/health`);
    expect(r.status).toBe(200);
    expect((await r.json()).ok).toBe(true);
  });

  it("rejette /poll sans token (401)", async () => {
    const r = await fetch(`${base}/poll?realm=sv`);
    expect(r.status).toBe(401);
  });

  it("fait l'aller-retour commande -> résultat", async () => {
    const res = await bridge.enqueue("sv", "read_players", { limit: 5 });
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ echo: "read_players", args: { limit: 5 } });
  });

  it("propage le flag confirmed jusqu'au handler", async () => {
    const res = await bridge.enqueue("sv", "run_lua", { code: "return 1" }, { confirmed: true });
    expect((res.data as { confirmed: boolean }).confirmed).toBe(true);
  });

  it("reçoit les événements postés par le bridge", async () => {
    const got = new Promise<EventEnvelope>((resolve) => bridge.once("event", resolve));
    await fetch(`${base}/event`, {
      method: "POST",
      headers: { "x-gmod-mcp-token": token, "content-type": "application/json" },
      body: JSON.stringify({ type: "lua_error", realm: "sv", ts: 1, payload: { msg: "boom" } }),
    });
    const ev = await got;
    expect(ev.type).toBe("lua_error");
    expect(ev.payload).toMatchObject({ msg: "boom" });
  });

  it("timeout si aucun realm ne répond", async () => {
    const solo = new BridgeServer({ port: 0, token, audit, commandTimeoutMs: 150 });
    await solo.listen(0);
    await expect(solo.enqueue("cl", "read_panels", {})).rejects.toThrow(/timeout/);
    await solo.close();
  });

  it("purge la commande expirée de la file (pas de commande périmée à la reconnexion)", async () => {
    const solo = new BridgeServer({ port: 0, token, audit, commandTimeoutMs: 120, pollHoldMs: 150 });
    await solo.listen(0);
    const soloBase = `http://127.0.0.1:${solo.address()}`;
    await expect(solo.enqueue("sv", "read_runtime", {})).rejects.toThrow(/timeout/);
    // Un poller qui arrive après l'expiration ne doit recevoir aucune commande.
    const r = await fetch(`${soloBase}/poll?realm=sv`, { headers: { "x-gmod-mcp-token": token } });
    expect((await r.json()).commands).toEqual([]);
    await solo.close();
  });
});
