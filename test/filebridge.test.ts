import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * reads, deletes, echoes and writes res/. Proves the protocol without GMod.
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
  it("round-trips command -> result through files", async () => {
    const res = await bridge.enqueue("sv", "read_players", { limit: 5 });
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ echo: "read_players", args: { limit: 5 } });
  });

  it("propage confirmed", async () => {
    const res = await bridge.enqueue("sv", "run_lua", { code: "x" }, { confirmed: true });
    expect((res.data as { confirmed: boolean }).confirmed).toBe(true);
  });

  it("routes the client realm too, relayed by the server addon)", async () => {
    const res = await bridge.enqueue("cl", "read_panels", {});
    expect(res.ok).toBe(true);
    expect(res.data).toMatchObject({ echo: "read_panels" });
  });

  it("emits the events dropped by the addon", async () => {
    const got = new Promise<EventEnvelope>((resolve) => bridge.once("event", resolve));
    writeFileSync(
      join(evtDir, "1.json"),
      JSON.stringify({ type: "lua_error", realm: "sv", ts: 1, payload: { msg: "boom" } }),
    );
    const ev = await got;
    expect(ev.type).toBe("lua_error");
    expect(ev.payload).toMatchObject({ msg: "boom" });
  });

  it("times out when no addon answers, and blames the link that is actually broken", async () => {
    const solo = new FileBridge({ dir: mkdtempSync(join(tmpdir(), "gmod-mcp-fb2-")), audit, commandTimeoutMs: 150 });
    // The command file is still in cmd/, so the diagnosis must be "nobody is polling" and
    // not the old catch-all that accused srcds while a second daemon ate the results.
    await expect(solo.enqueue("sv", "read_runtime", {})).rejects.toThrow(/never picked up/);
    await solo.close();
  });

  it("reports its transport state", () => {
    const s = bridge.status();
    expect(s.owns).toBe(true);
    expect(s.uncorrelatedResults).toBe(0);
    expect(typeof s.lastAddonContactMsAgo === "number").toBe(true);
  });
});

/**
 * The failure of 2026-07-25: two daemons on one transport directory. The protocol consumes
 * `res/`, so the second daemon deleted results the first was waiting for and every tool
 * timed out with a perfectly healthy game.
 */
describe("FileBridge single-instance lock", () => {
  const dir = mkdtempSync(join(tmpdir(), "gmod-mcp-lock-"));
  let first: FileBridge;

  beforeAll(() => {
    first = new FileBridge({ dir, audit, commandTimeoutMs: 200 });
  });
  afterAll(async () => {
    await first.close();
  });

  it("gives the directory to the first daemon only", async () => {
    const second = new FileBridge({ dir, audit, commandTimeoutMs: 200 });
    expect(first.status().owns).toBe(true);
    expect(second.status().owns).toBe(false);
    expect(second.status().lockedBy?.pid).toBe(process.pid);

    // Refused before writing anything: an unanswerable command would still run in the game.
    await expect(second.enqueue("sv", "read_runtime", {})).rejects.toThrow(/already owns the transport/);
    expect(readdirSync(join(dir, "cmd"))).toHaveLength(0);

    await second.close();
    // Closing the loser must not release the winner's lock.
    expect(existsSync(join(dir, "daemon.lock"))).toBe(true);
  });

  it("never deletes a res/ file it did not ask for", async () => {
    const foreign = join(dir, "res", "not-mine.json");
    writeFileSync(foreign, JSON.stringify({ id: "not-mine", ok: true, data: {} }));
    await new Promise((r) => setTimeout(r, 500)); // several scans
    expect(existsSync(foreign)).toBe(true);
    expect(first.status().uncorrelatedResults).toBeGreaterThan(0);
    rmSync(foreign, { force: true });
  });

  it("reclaims a lock left behind by a dead daemon", async () => {
    const dir2 = mkdtempSync(join(tmpdir(), "gmod-mcp-stale-"));
    // A process that has certainly exited: spawnSync returns its pid after it is reaped.
    const dead = spawnSync(process.execPath, ["-e", ""]).pid;
    writeFileSync(
      join(dir2, "daemon.lock"),
      JSON.stringify({ pid: dead, startedAt: new Date().toISOString() }),
    );
    const b = new FileBridge({ dir: dir2, audit, commandTimeoutMs: 100 });
    expect(b.status().owns).toBe(true);
    await b.close();
  });
});
