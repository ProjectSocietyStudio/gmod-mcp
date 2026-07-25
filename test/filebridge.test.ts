import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FileBridge } from "../src/bridge/filebridge.js";
import { AuditLog } from "../src/logger.js";
import type { EventEnvelope } from "../src/schemas.js";

const dataDir = mkdtempSync(join(tmpdir(), "gmod-mcp-fb-"));
const audit = new AuditLog(mkdtempSync(join(tmpdir(), "gmod-mcp-fbaudit-")));
let bridge: FileBridge;
const cmdDir = join(dataDir, "cmd");
const resDir = join(dataDir, "res");
const evtDir = join(dataDir, "evt");

/**
 * Faux addon en Node : reproduit exactement ce que fait le GLua — scanne cmd/,
 * lit, supprime, exécute (écho), écrit res/. Prouve le protocole sans GMod.
 */
function startFakeAddon(): { stop: () => void } {
  const timer = setInterval(() => {
    let files: string[] = [];
    try {
      files = readdirSync(cmdDir);
    } catch {
      return;
    }
    for (const fn of files) {
      if (!fn.endsWith(".json")) continue;
      const path = join(cmdDir, fn);
      let cmd: { id: string; tool: string; args: unknown; confirmed?: boolean };
      try {
        cmd = JSON.parse(readFileSync(path, "utf8"));
      } catch {
        continue;
      }
      rmSync(path, { force: true });
      writeFileSync(
        join(resDir, `${cmd.id}.json`),
        JSON.stringify({ id: cmd.id, ok: true, data: { echo: cmd.tool, args: cmd.args, confirmed: cmd.confirmed ?? false } }),
      );
    }
  }, 50);
  return { stop: () => clearInterval(timer) };
}

let addon: { stop: () => void };

beforeAll(() => {
  bridge = new FileBridge({ dir: dataDir, audit, scanIntervalMs: 40, commandTimeoutMs: 3000 });
  addon = startFakeAddon();
});

afterAll(async () => {
  addon.stop();
  await bridge.close();
});

describe("FileBridge", () => {
  it("fait l'aller-retour commande -> résultat par fichiers", async () => {
    const res = await bridge.enqueue("sv", "read_players", { limit: 5 });
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ echo: "read_players", args: { limit: 5 } });
  });

  it("propage confirmed", async () => {
    const res = await bridge.enqueue("sv", "run_lua", { code: "x" }, { confirmed: true });
    expect((res.data as { confirmed: boolean }).confirmed).toBe(true);
  });

  it("route aussi le realm client (relayé par l'addon serveur)", async () => {
    const res = await bridge.enqueue("cl", "read_panels", {});
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ echo: "read_panels" });
  });

  it("émet les événements déposés par l'addon", async () => {
    const got = new Promise<EventEnvelope>((resolve) => bridge.once("event", resolve));
    writeFileSync(
      join(evtDir, "1.json"),
      JSON.stringify({ type: "lua_error", realm: "sv", ts: 1, payload: { msg: "boom" } }),
    );
    const ev = await got;
    expect(ev.type).toBe("lua_error");
    expect(ev.payload).toMatchObject({ msg: "boom" });
  });

  it("timeout si aucun addon ne répond", async () => {
    const solo = new FileBridge({ dir: mkdtempSync(join(tmpdir(), "gmod-mcp-fb2-")), audit, commandTimeoutMs: 150 });
    await expect(solo.enqueue("sv", "read_runtime", {})).rejects.toThrow(/timeout/);
    await solo.close();
  });
});
