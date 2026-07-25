import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { PatchEngine } from "../src/patch/engine.js";

function makeConfig(): Config {
  const repoRoot = mkdtempSync(join(tmpdir(), "gmod-mcp-repo-"));
  return {
    repoRoot,
    stateDir: join(repoRoot, ".gmod-mcp"),
    addons: [],
    toolAllowlist: [],
  };
}

describe("PatchEngine", () => {
  it("applies a patch, writes the file and produces a diff", async () => {
    const config = makeConfig();
    const engine = new PatchEngine(config);
    const patch = await engine.applyFile("addons/x/lua/a.lua", "print('v1')\n", "init");
    expect(existsSync(join(config.repoRoot, "addons/x/lua/a.lua"))).toBe(true);
    expect(readFileSync(join(config.repoRoot, patch.file), "utf8")).toBe("print('v1')\n");
    expect(patch.diff).toContain("v1");
    expect(patch.rationale).toBe("init");
  });

  it("restores the previous state of a modified file", async () => {
    const config = makeConfig();
    const engine = new PatchEngine(config);
    await engine.applyFile("f.lua", "old\n", "create");
    const p2 = await engine.applyFile("f.lua", "new\n", "change");
    expect(readFileSync(join(config.repoRoot, "f.lua"), "utf8")).toBe("new\n");
    const r = engine.restore(p2.id);
    expect(r.ok).toBe(true);
    expect(readFileSync(join(config.repoRoot, "f.lua"), "utf8")).toBe("old\n");
  });

  it("restores a file created by the patch by emptying it", async () => {
    const config = makeConfig();
    const engine = new PatchEngine(config);
    const p = await engine.applyFile("brand_new.lua", "content\n", "create");
    engine.restore(p.id);
    expect(readFileSync(join(config.repoRoot, "brand_new.lua"), "utf8")).toBe("");
  });

  it("refuse une cible hors du repo", async () => {
    const config = makeConfig();
    const engine = new PatchEngine(config);
    await expect(engine.applyFile("../evil.lua", "x", "r")).rejects.toThrow(/out of scope/);
  });

  it("throws on an unknown patch id", () => {
    const config = makeConfig();
    const engine = new PatchEngine(config);
    expect(() => engine.restore("nope")).toThrow(/inconnu/);
  });
});
