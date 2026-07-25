import type { Config } from "../config.js";
import { parseLintOutput } from "../parse/lint.js";
import { parseRuntimeLog } from "../parse/runtime.js";
import { lintAddon, readGameLog } from "../proc/scripts.js";
import type { Finding } from "../schemas.js";

export interface Verdict {
  ok: boolean;
  lint: { exitCode: number | null; errors: number; warnings: number; findings: Finding[] };
  runtime: { errors: number; findings: Finding[] };
  summary: string;
}

/**
 * Verdict de la boucle : lance lint sur l'addon et lit les erreurs runtime du
 * current boot. `ok` requires zero lint errors AND zero runtime errors.
 *
 * Static analysis is not enough, which is why game log errors are aggregated too,
 * bounded to the current boot.
 */
export async function validate(config: Config, addon: string): Promise<Verdict> {
  const lintRes = await lintAddon(config, addon);
  const lintFindings = lintRes.code === 2 ? [] : parseLintOutput(lintRes.stdout);
  const lintErrors = lintFindings.filter((f) => f.severity === "error").length;
  const lintWarnings = lintFindings.filter((f) => f.severity === "warning").length;

  // Runtime errors are server-wide, so they are narrowed to the addon under test by
  // path -- otherwise another addon's bug would fail this verdict unfairly.
  const addonName = addon.replace(/^addons\//, "").replace(/\/$/, "").split("/").pop() ?? addon;
  const runtimeFindings = parseRuntimeLog(readGameLog(config, true)).filter(
    (f) => f.file.includes(`addons/${addonName}/`) || f.file.includes(`${addonName}/`),
  );
  const runtimeErrors = runtimeFindings.filter((f) => f.severity === "error").length;

  const ok = lintRes.code === 0 && runtimeErrors === 0;
  const summary = ok
    ? "propre : lint vert, aucune erreur runtime sur ce boot"
    : `failed: ${lintErrors} lint error(s), ${runtimeErrors} runtime error(s)`;

  return {
    ok,
    lint: { exitCode: lintRes.code, errors: lintErrors, warnings: lintWarnings, findings: lintFindings },
    runtime: { errors: runtimeErrors, findings: runtimeFindings },
    summary,
  };
}
