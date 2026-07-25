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
 * boot courant. `ok` exige zéro erreur de lint ET zéro erreur runtime.
 *
 * Le statique ne suffit pas (règle du projet) : c'est pourquoi on agrège aussi
 * les erreurs du log de jeu, bornées à la frontière de boot.
 */
export async function validate(config: Config, addon: string): Promise<Verdict> {
  const lintRes = await lintAddon(config, addon);
  const lintFindings = lintRes.code === 2 ? [] : parseLintOutput(lintRes.stdout);
  const lintErrors = lintFindings.filter((f) => f.severity === "error").length;
  const lintWarnings = lintFindings.filter((f) => f.severity === "warning").length;

  // Les erreurs runtime sont serveur-wide ; on les restreint à l'addon testé via
  // son chemin (sinon un bug d'un autre addon ferait échouer ce verdict à tort).
  const addonName = addon.replace(/^addons\//, "").replace(/\/$/, "").split("/").pop() ?? addon;
  const runtimeFindings = parseRuntimeLog(readGameLog(config, true)).filter(
    (f) => f.file.includes(`addons/${addonName}/`) || f.file.includes(`${addonName}/`),
  );
  const runtimeErrors = runtimeFindings.filter((f) => f.severity === "error").length;

  const ok = lintRes.code === 0 && runtimeErrors === 0;
  const summary = ok
    ? "propre : lint vert, aucune erreur runtime sur ce boot"
    : `échec : ${lintErrors} erreur(s) lint, ${runtimeErrors} erreur(s) runtime`;

  return {
    ok,
    lint: { exitCode: lintRes.code, errors: lintErrors, warnings: lintWarnings, findings: lintFindings },
    runtime: { errors: runtimeErrors, findings: runtimeFindings },
    summary,
  };
}
