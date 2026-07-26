import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { clientBridgeTools, serverBridgeTools } from "../src/tools/bridge.js";
import { worldTools } from "../src/tools/world.js";
import type { AnyToolDef } from "../src/mcp/registry.js";

/**
 * The TS tool definitions and the Lua handlers are two halves of one contract with
 * nothing enforcing agreement between them. When they drift the tool does not crash --
 * the key simply never arrives and the handler takes its default branch forever.
 *
 * read_timers was a live instance: `inputSchema: {}` on the TS side, `args.names`
 * required on the Lua side, so the tool could only ever return its "pass names[]" note.
 * Four static lint passes could not see it. This test can.
 */
const addonRoot = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "addon",
  "gmod_mcp_bridge",
  "lua",
);

const LUA_SOURCES: Record<"sv" | "cl", string[]> = {
  sv: [
    join(addonRoot, "gmod_mcp_bridge", "server", "sv_handlers.lua"),
    join(addonRoot, "gmod_mcp_bridge", "server", "sv_world.lua"),
  ],
  cl: [join(addonRoot, "autorun", "client", "gmod_mcp_bridge_cl.lua")],
};

/** Maps `H.<name> = function(...)` to the argument keys that body reads. */
function argKeysByHandler(source: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  // A body runs to its closing `end` at column zero. Slicing to the next handler
  // instead would swallow whatever sits between them -- world_edit's action table, for
  // one -- and blame those reads on the preceding handler.
  const starts = [...source.matchAll(/^H\.(\w+)\s*=\s*function/gm)];
  starts.forEach((match) => {
    const name = match[1]!;
    const from = match.index!;
    const close = source.slice(from).search(/^end$/m);
    const to = close === -1 ? source.length : from + close;
    const body = source.slice(from, to);
    const keys = new Set([...body.matchAll(/\bargs\.(\w+)/g)].map((m) => m[1]!));
    out.set(name, keys);
  });
  return out;
}

function declaredKeys(def: AnyToolDef): Set<string> {
  return new Set(Object.keys(def.inputSchema as z.ZodRawShape));
}

describe("TS inputSchema matches the Lua handlers", () => {
  const bridgeTools = [...serverBridgeTools, ...clientBridgeTools, ...worldTools];

  for (const realm of ["sv", "cl"] as const) {
    for (const path of LUA_SOURCES[realm]) {
      const file = path.split("/").pop()!;
      const source = readFileSync(path, "utf8");
      const luaHandlers = argKeysByHandler(source);

      it(`${file}: exposes handlers`, () => {
        expect(luaHandlers.size).toBeGreaterThan(0);
      });

      for (const [name, read] of luaHandlers) {
        const def = bridgeTools.find((t) => t.name === name && t.realm === realm);
        // list_handlers is a bridge internal with no tool of its own.
        if (!def) continue;

        it(`${name}: every args key the Lua reads is declared in TS`, () => {
          const declared = declaredKeys(def);
          // `player` targets the relay, not the handler, so it is legal everywhere.
          const missing = [...read].filter((k) => k !== "player" && !declared.has(k));
          expect(missing).toEqual([]);
        });
      }

      // Helpers outside a handler body -- world_edit's per-action table, for instance --
      // read args too, and per-handler scoping cannot see them. Checking the file as a
      // whole is coarser but catches the drift that matters: a key nothing declares.
      it(`${file}: every args key read anywhere is declared by some tool in this file`, () => {
        const declaredHere = new Set(
          [...luaHandlers.keys()]
            .flatMap((n) => bridgeTools.filter((t) => t.name === n && t.realm === realm))
            .flatMap((t) => [...declaredKeys(t)]),
        );
        const readAnywhere = new Set([...source.matchAll(/\bargs\.(\w+)/g)].map((m) => m[1]!));
        const orphans = [...readAnywhere].filter((k) => k !== "player" && !declaredHere.has(k));
        expect(orphans).toEqual([]);
      });
    }
  }

  it("read_timers declares names -- the key its handler requires", () => {
    const def = serverBridgeTools.find((t) => t.name === "read_timers");
    expect(declaredKeys(def!)).toContain("names");
  });

  /**
   * `client_input` multiplexes on `action`, so its enum is a second contract with the Lua
   * ACTIONS table -- and a looser one than the argument keys: an action the TS enum omits
   * is unreachable (zod refuses the call before it is sent), while one the Lua lacks
   * fails only after a full client round trip, with a list of what it does have.
   */
  it("client_input's action enum is exactly the Lua ACTIONS table", () => {
    const source = readFileSync(LUA_SOURCES.cl[0]!, "utf8");
    const luaActions = [...source.matchAll(/^ACTIONS\.(\w+)\s*=\s*function/gm)].map((m) => m[1]!);
    const def = clientBridgeTools.find((t) => t.name === "client_input")!;
    const shape = def.inputSchema as z.ZodRawShape;
    const action = shape["action"] as z.ZodEnum<[string, ...string[]]>;

    expect(luaActions.length).toBeGreaterThan(0);
    expect([...action.options].sort()).toEqual([...luaActions].sort());
  });
});
