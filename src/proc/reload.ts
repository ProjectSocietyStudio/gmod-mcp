import { existsSync, readdirSync, statSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "../config.js";
import { resolveAddonDir } from "./scripts.js";

/**
 * Bumps mtime to trigger GMod's Lua autorefresh, which reloads changed files. This is
 * best-effort: autorefresh covers editing
 * existing files; new files and autoruns still need a restart
 * -- it is up to the caller (validation, iteration) to decide.
 */
export function touchFile(config: Config, file: string): boolean {
  const abs = resolve(config.repoRoot, file);
  if (!existsSync(abs)) return false;
  const now = new Date();
  utimesSync(abs, now, now);
  return true;
}

/** Recursively touches every .lua file of an addon. Returns how many were touched. */
export function touchAddon(config: Config, addon: string): number {
  const dir = resolveAddonDir(config, addon);
  if (!existsSync(dir)) return 0;
  let count = 0;
  const now = new Date();
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const p = join(d, entry);
      const st = statSync(p);
      if (st.isDirectory()) {
        walk(p);
      } else if (entry.endsWith(".lua")) {
        utimesSync(p, now, now);
        count++;
      }
    }
  };
  walk(dir);
  return count;
}
