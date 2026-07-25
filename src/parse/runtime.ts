import type { Finding } from "../schemas.js";

/**
 * Jeu de motifs d'erreur Lua, repris tel quel de `tools/server-log.sh:26`.
 * Relying on `[ERROR]` alone would miss most of the shapes these take.
 */
export const LUA_ERROR_PATTERN =
  /\[ERROR\]|Couldn.t include file|attempt to (index|call|compare|perform|concatenate)|stack traceback|Lua Error|bad argument|Timer Error|Hook .* Failed|ErrorNoHalt|\.lua:[0-9]+:/;

/** Extracts `file.lua` and the line number from an error message, when present. */
const FILE_LINE = /([\w./\\-]+\.lua):(\d+)/;

/**
 * Parses a game log block (already sliced to the right boot) into runtime findings.
 * Une ligne matchant le PATTERN devient un finding ; les lignes `stack traceback`
 * that immediately follow are collected into the current finding's `stack`.
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
      // Continuation line of a stack trace already open (indented).
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
