import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { readGameLog } from "../src/proc/scripts.js";
import { makeConfig } from "./helpers.js";

const BOOT = "Initializing Steam libraries for LAN server\n";
// The engine also prints this mid-boot, after addons mount. It must NOT be mistaken for
// a boot boundary, or the start of the boot -- where load-time errors live -- is lost.
const WORKSHOP = "Initializing Steam libraries for Workshop..\n";

/**
 * Builds a repo whose game log holds two boots, optionally with a recorded boot offset
 * as startServer would have written it.
 */
function makeRepo(recordedOffset?: number): Config {
  const repoRoot = mkdtempSync(join(tmpdir(), "gmod-mcp-log-"));
  const stateDir = join(repoRoot, ".gmod-mcp");
  mkdirSync(join(repoRoot, "srcds", "garrysmod"), { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  writeFileSync(
    join(repoRoot, "srcds", "garrysmod", "console.log"),
    BOOT + "[ERROR] stale failure from the previous run\n" + BOOT + "all quiet\n" + WORKSHOP,
  );

  if (recordedOffset !== undefined) {
    writeFileSync(
      join(stateDir, "server-boot.json"),
      JSON.stringify({ offset: recordedOffset, startedAt: 0 }),
    );
  }

  return makeConfig({ repoRoot, stateDir });
}

describe("readGameLog", () => {
  it("returns the whole log when sinceBoot is false", () => {
    const log = readGameLog(makeRepo(), false);
    expect(log).toContain("stale failure");
    expect(log).toContain("all quiet");
  });

  // The regression this guards: garrysmod/console.log accumulates across restarts, and
  // the recorded offset is only written when the daemon starts the server itself. A
  // manual start left it pointing into an earlier boot, so sinceBoot returned old
  // errors as though they were current -- silently, and looking entirely plausible.
  it("bounds to the last boot even with no recorded offset", () => {
    const log = readGameLog(makeRepo(), true);
    expect(log).not.toContain("stale failure");
    expect(log).toContain("all quiet");
  });

  it("does not mistake the mid-boot Workshop line for a boot boundary", () => {
    // Matching the bare "Initializing Steam libraries" prefix would land here and drop
    // everything before it, including any error raised while addons were loading.
    const log = readGameLog(makeRepo(), true);
    expect(log).toContain("all quiet");
  });

  it("ignores a recorded offset left behind by an earlier boot", () => {
    const log = readGameLog(makeRepo(0), true);
    expect(log).not.toContain("stale failure");
  });

  it("keeps a recorded offset that is tighter than the marker", () => {
    // startServer records the file size before launching, so its offset can legitimately
    // sit past the marker. The later of the two bounds is the correct one.
    const afterMarker = (BOOT + "[ERROR] stale failure from the previous run\n" + BOOT).length;
    const log = readGameLog(makeRepo(afterMarker), true);
    expect(log).toBe("all quiet\n" + WORKSHOP);
  });

  it("falls back to the whole log when the offset is past the end", () => {
    // A truncated or rotated log must not silently yield nothing.
    const log = readGameLog(makeRepo(999_999), true);
    expect(log).toContain("all quiet");
  });
});
