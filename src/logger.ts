import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Types d'entrées d'audit. Étendu au fil des phases. */
export type AuditKind =
  | "daemon_start"
  | "tool_call"
  | "tool_result"
  | "bridge_command"
  | "bridge_event"
  | "patch_apply"
  | "patch_revert"
  | "lua_exec"
  | "error";

export interface AuditEntry {
  ts: number;
  kind: AuditKind;
  sessionId?: string;
  commandId?: string;
  /** Charge utile libre, dépendante du `kind`. */
  data?: Record<string, unknown>;
}

/**
 * Journal d'audit append-only en JSONL. Une ligne = un événement, corrélable
 * par `sessionId` + `commandId`. Écrit dans `<stateDir>/logs/audit.jsonl`.
 *
 * Écriture synchrone volontaire : les volumes sont faibles et on veut la
 * garantie que rien n'est perdu si le daemon meurt juste après une action.
 */
export class AuditLog {
  private readonly file: string;

  constructor(stateDir: string) {
    const dir = join(stateDir, "logs");
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, "audit.jsonl");
  }

  record(entry: Omit<AuditEntry, "ts"> & { ts?: number }): void {
    const full: AuditEntry = { ts: entry.ts ?? Date.now(), ...entry };
    appendFileSync(this.file, JSON.stringify(full) + "\n");
  }

  get path(): string {
    return this.file;
  }
}
