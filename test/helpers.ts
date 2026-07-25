import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../src/config.js";

/**
 * A complete Config rooted at a fresh temporary directory.
 *
 * Shared so that adding a field to Config breaks in one place rather than silently
 * leaving fixtures short of it -- which is exactly what happened while test/ sat outside
 * the typecheck: `plugins` had been missing from these fixtures without anyone noticing.
 */
export function makeConfig(overrides: Partial<Config> = {}): Config {
  const repoRoot = overrides.repoRoot ?? mkdtempSync(join(tmpdir(), "gmod-mcp-"));
  return {
    repoRoot,
    stateDir: join(repoRoot, ".gmod-mcp"),
    addons: [],
    toolAllowlist: [],
    plugins: [],
    clientWaitMs: 0,
    ...overrides,
  };
}
