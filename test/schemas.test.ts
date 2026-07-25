import { describe, expect, it } from "vitest";
import {
  CommandEnvelope,
  EventEnvelope,
  Finding,
  ResultEnvelope,
  Session,
} from "../src/schemas.js";
import { ConfigFile } from "../src/config.js";
import { isCallAllowed } from "../src/mcp/registry.js";
import type { AnyToolDef } from "../src/mcp/registry.js";

describe("schemas", () => {
  it("CommandEnvelope applique les défauts (args={})", () => {
    const cmd = CommandEnvelope.parse({ id: "c1", tool: "read_players", realm: "sv" });
    expect(cmd.args).toEqual({});
    expect(cmd.confirmed).toBeUndefined();
  });

  it("ResultEnvelope corrèle par id", () => {
    const res = ResultEnvelope.parse({ id: "c1", ok: true, data: { count: 3 } });
    expect(res.ok).toBe(true);
    expect(res.id).toBe("c1");
  });

  it("EventEnvelope exige un type et un realm", () => {
    const ev = EventEnvelope.parse({ type: "lua_error", realm: "sv", ts: 1, payload: {} });
    expect(ev.type).toBe("lua_error");
    expect(() => EventEnvelope.parse({ type: "", realm: "sv", ts: 1 })).toThrow();
  });

  it("Finding accepte lint et runtime", () => {
    const lint = Finding.parse({
      source: "lint",
      file: "sv_main.lua",
      line: 12,
      severity: "error",
      rule: "net-security",
      message: "message non enregistré",
    });
    expect(lint.source).toBe("lint");
    const runtime = Finding.parse({
      source: "runtime",
      file: "cl_main.lua",
      severity: "error",
      message: "attempt to index nil",
      stack: "stack traceback: ...",
    });
    expect(runtime.stack).toContain("traceback");
  });

  it("Session applique les tableaux par défaut", () => {
    const s = Session.parse({ id: "s1", task: "fix hud", createdAt: 0 });
    expect(s.files).toEqual([]);
    expect(s.patches).toEqual([]);
    expect(s.findings).toEqual([]);
  });
});

describe("ConfigFile", () => {
  it("remplit les défauts sur un objet vide", () => {
    const c = ConfigFile.parse({});
    expect(c.addons).toEqual([]);
    expect(c.toolAllowlist).toEqual([]);
  });
});

describe("isCallAllowed (gate de confirmation)", () => {
  const guarded = { name: "run_lua", guarded: true } as unknown as AnyToolDef;
  const plain = { name: "read_players", guarded: false } as unknown as AnyToolDef;

  it("laisse passer les outils non gardés", () => {
    expect(isCallAllowed(plain, {}, [])).toBe(true);
  });

  it("refuse un outil gardé sans confirm", () => {
    expect(isCallAllowed(guarded, {}, [])).toBe(false);
  });

  it("laisse passer un outil gardé avec confirm:true", () => {
    expect(isCallAllowed(guarded, { confirm: true }, [])).toBe(true);
  });

  it("laisse passer un outil gardé présent dans l'allowlist", () => {
    expect(isCallAllowed(guarded, {}, ["run_lua"])).toBe(true);
  });
});
