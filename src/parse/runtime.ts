import type { Finding } from "../schemas.js";

/**
 * Jeu de motifs d'erreur Lua, repris tel quel de `tools/server-log.sh:26`.
 * Se fier au seul `[ERROR]` laisserait passer la majorité des formes.
 */
export const LUA_ERROR_PATTERN =
  /\[ERROR\]|Couldn.t include file|attempt to (index|call|compare|perform|concatenate)|stack traceback|Lua Error|bad argument|Timer Error|Hook .* Failed|ErrorNoHalt|\.lua:[0-9]+:/;

/** Extrait `fichier.lua` et la ligne d'un message d'erreur, si présents. */
const FILE_LINE = /([\w./\\-]+\.lua):(\d+)/;

/**
 * Parse un bloc de log de jeu (déjà découpé au bon boot) en findings runtime.
 * Une ligne matchant le PATTERN devient un finding ; les lignes `stack traceback`
 * qui suivent immédiatement sont agrégées dans `stack` du finding courant.
 */
export function parseRuntimeLog(text: string): Finding[] {
  const findings: Finding[] = [];
  let current: Finding | undefined;

  for (const rawLine of text.split("\n")) {
    const line = rawLine.replace(/\0/g, "").trimEnd();
    if (!line) continue;

    const isStack = /stack traceback/i.test(line);
    if (isStack && current) {
      current.stack = current.stack ? current.stack + "\n" + line : line;
      continue;
    }

    if (!LUA_ERROR_PATTERN.test(line)) {
      // Ligne de continuation d'une stack déjà ouverte (indentée).
      if (current?.stack && /^\s+\d+\.|^\s+\[/.test(rawLine)) {
        current.stack += "\n" + line;
      }
      continue;
    }

    const fl = FILE_LINE.exec(line);
    current = {
      source: "runtime",
      file: fl?.[1] ?? "?",
      ...(fl?.[2] ? { line: Number(fl[2]) } : {}),
      severity: "error",
      message: line,
      ...(isStack ? { stack: line } : {}),
    };
    findings.push(current);
  }

  return findings;
}
