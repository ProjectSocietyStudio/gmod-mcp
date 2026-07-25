import { existsSync, readdirSync, statSync, utimesSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Config } from "../config.js";
import { resolveAddonDir } from "./scripts.js";

/**
 * Bump du mtime pour déclencher l'auto-refresh Lua de GMod (le serveur recharge
 * les fichiers modifiés). Best-effort : l'auto-refresh couvre l'édition de
 * fichiers existants ; les nouveaux fichiers ou les autoruns exigent un restart
 * — c'est à l'appelant (validation/itération) de le décider.
 */
export function touchFile(config: Config, file: string): boolean {
  const abs = resolve(config.repoRoot, file);
  if (!existsSync(abs)) return false;
  const now = new Date();
  utimesSync(abs, now, now);
  return true;
}

/** Touche récursivement tous les .lua d'un addon. Renvoie le nombre touché. */
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
