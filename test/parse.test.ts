import { describe, expect, it } from "vitest";
import { parseLintOutput } from "../src/parse/lint.js";
import { parseRuntimeLog } from "../src/parse/runtime.js";

const LINT_SAMPLE = `
\x1b[1m── 3/4 glua-check (API & realms)\x1b[0m
lua/autorun/server/sv_main.lua:12: [ERROR] realm-violation — \`render.SetColor\` is Client-only, called without a guard
lua/autorun/server/sv_main.lua:40: [WARNING] api-unknown — \`Player:AddMoneys\` inconnu

glua-check : 3 fichier(s), 1 erreur(s), 1 avertissement(s)

\x1b[1m── 4/4 glua-audit (security & performance)\x1b[0m
lua/autorun/server/sv_net.lua:7: [ERROR] net-no-string — net message not registered through util.AddNetworkString
glua-audit : 3 fichier(s), 1 erreur(s), 0 avertissement(s)

\x1b[32m✔ ...\x1b[0m
`;

describe("parseLintOutput", () => {
  const findings = parseLintOutput(LINT_SAMPLE);

  it("decompose le format stable fichier:ligne: [SEV] regle - msg", () => {
    const first = findings[0]!;
    expect(first).toMatchObject({
      source: "lint",
      file: "lua/autorun/server/sv_main.lua",
      line: 12,
      severity: "error",
      rule: "realm-violation",
    });
    expect(first.message).toContain("Client-only");
  });

  it("mappe les severites et compte", () => {
    expect(findings).toHaveLength(3);
    expect(findings.filter((f) => f.severity === "error")).toHaveLength(2);
    expect(findings.filter((f) => f.severity === "warning")).toHaveLength(1);
  });

  it("ignore les lignes de resume", () => {
    expect(findings.some((f) => f.message.includes("fichier(s)"))).toBe(false);
  });
});

const RUNTIME_SAMPLE = `
Loading gamemode...
[ERROR] lua/autorun/server/sv_main.lua:12: attempt to index nil value 'ply'
stack traceback:
  1. fn - lua/autorun/server/sv_main.lua:12
  2. unknown - lua/includes/modules/hook.lua:96
Timer Error: bad argument #1 to 'foo'
Everything is fine here.
`;

describe("parseRuntimeLog", () => {
  const findings = parseRuntimeLog(RUNTIME_SAMPLE);

  it("detecte les erreurs Lua multi-formes", () => {
    expect(findings.length).toBeGreaterThanOrEqual(2);
    expect(findings.every((f) => f.source === "runtime")).toBe(true);
  });

  it("extrait fichier et ligne quand presents", () => {
    const indexErr = findings.find((f) => f.message.includes("attempt to index"))!;
    expect(indexErr.file).toBe("lua/autorun/server/sv_main.lua");
    expect(indexErr.line).toBe(12);
  });

  it("agrege la stack traceback dans le finding courant", () => {
    const indexErr = findings.find((f) => f.message.includes("attempt to index"))!;
    expect(indexErr.stack).toContain("stack traceback");
    expect(indexErr.stack).toContain("hook.lua:96");
  });

  it("ne remonte rien sur une ligne saine", () => {
    expect(findings.some((f) => f.message.includes("fine here"))).toBe(false);
  });

  it("nettoie les octets NUL", () => {
    const NUL = String.fromCharCode(0);
    const withNul = `attempt to call ${NUL}method${NUL}\n`;
    const [f] = parseRuntimeLog(withNul);
    expect(f?.message).not.toContain(NUL);
    expect(f?.message).toContain("attempt to call");
  });
});
