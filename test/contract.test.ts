import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { clientBridgeTools, serverBridgeTools } from "../src/tools/bridge.js";
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

const LUA_SOURCES: Record<"sv" | "cl", string> = {
  sv: join(addonRoot, "gmod_mcp_bridge", "server", "sv_handlers.lua"),
  cl: join(addonRoot, "autorun", "client", "gmod_mcp_bridge_cl.lua"),
};

/** Maps `H.<name> = function(...)` to the argument keys that body reads. */
function argKeysByHandler(source: string): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  // Split on handler definitions; each body runs to the next one or to end of file.
  const starts = [...source.matchAll(/^H\.(\w+)\s*=\s*function/gm)];
  starts.forEach((match, i) => {
    const name = match[1]!;
    const from = match.index!;
    const to = i + 1 < starts.length ? starts[i + 1]!.index! : source.length;
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
  const bridgeTools = [...serverBridgeTools, ...clientBridgeTools];

  for (const realm of ["sv", "cl"] as const) {
    const source = readFileSync(LUA_SOURCES[realm], "utf8");
    const luaHandlers = argKeysByHandler(source);

    it(`finds handlers in the ${realm} Lua source`, () => {
      expect(luaHandlers.size).toBeGreaterThan(0);
    });

    for (const def of bridgeTools.filter((t) => t.realm === realm)) {
      const read = luaHandlers.get(def.name);
      // run_lua lives in the optional extension, not in this file.
      if (!read) continue;

      it(`${def.name}: every args key the Lua reads is declared in TS`, () => {
        const declared = declaredKeys(def);
        // `player` targets the relay, not the handler, so it is legal everywhere.
        const missing = [...read].filter((k) => k !== "player" && !declared.has(k));
        expect(missing).toEqual([]);
      });
    }
  }

  it("read_timers declares names -- the key its handler requires", () => {
    const def = serverBridgeTools.find((t) => t.name === "read_timers");
    expect(declaredKeys(def!)).toContain("names");
  });
});
