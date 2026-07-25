import type { Finding, Severity } from "../schemas.js";
import { stripAnsi } from "../proc/run.js";

/**
 * Stable format emitted by glua-check.py:158 and glua-audit.py:
 *   `fichier:ligne: [SEVERITE] regle — msg`
 * (the separator is an em dash surrounded by spaces).
 */
const PRIMARY =
  /^(?<file>[^:\n]+):(?<line>\d+): \[(?<sev>[A-Z]+)\] (?<rule>\S+) — (?<msg>.*)$/;

/** Generic fallback: any line referencing `xxx.lua:N` (glualint, language server). */
const GENERIC = /(?<file>[^\s:]+\.lua):(?<line>\d+):?\s*(?<msg>.*)$/;

/** Section header produced by lint.sh:27 (`-- 3/4 glua-check ...`). */
const SECTION = /^──\s*(?<title>.+?)\s*$/;

function toSeverity(raw: string): Severity {
  const s = raw.toUpperCase();
  if (s.startsWith("ERR")) return "error";
  if (s.startsWith("WARN")) return "warning";
  return "info";
}

/** Devine le nom de passe courant depuis un titre de section. */
function passOf(title: string): string {
  const t = title.toLowerCase();
  if (t.includes("glualint")) return "glualint";
  if (t.includes("language-server")) return "lua-language-server";
  if (t.includes("glua-check")) return "glua-check";
  if (t.includes("glua-audit")) return "glua-audit";
  return "lint";
}

/**
 * Parses `tools/lint.sh` output into structured findings. Lines in the stable format
 * (glua-check, glua-audit) are fully decomposed; the other passes (glualint, language
 * server) are caught by the generic `file.lua:line` fallback. Summary lines are
 * ignored.
 */
export function parseLintOutput(raw: string): Finding[] {
  const findings: Finding[] = [];
  let pass = "lint";

  for (const line of stripAnsi(raw).split("\n")) {
    const sec = SECTION.exec(line);
    if (sec?.groups) {
      pass = passOf(sec.groups["title"] ?? "");
      continue;
    }
    if (/^(glua-check|glua-audit)\s*:/.test(line.trim())) continue; // summary lines

    const p = PRIMARY.exec(line);
    if (p?.groups) {
      findings.push({
        source: "lint",
        file: p.groups["file"]!,
        line: Number(p.groups["line"]),
        severity: toSeverity(p.groups["sev"]!),
        rule: p.groups["rule"],
        message: p.groups["msg"]!.trim(),
      });
      continue;
    }

    const g = GENERIC.exec(line);
    if (g?.groups && line.includes(".lua:")) {
      findings.push({
        source: "lint",
        file: g.groups["file"]!,
        line: Number(g.groups["line"]),
        severity: "warning",
        rule: pass,
        message: g.groups["msg"]!.trim() || line.trim(),
      });
    }
  }

  return findings;
}
