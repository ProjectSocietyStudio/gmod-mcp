import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/** Audit entry kinds. */
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
  /** Free-form payload, shaped by `kind`. */
  data?: Record<string, unknown>;
}

/**
 * Append-only JSONL audit log. One line is one event, correlated by `sessionId`
 * and `commandId`. Written to `<stateDir>/logs/audit.jsonl`.
 *
 * Writes are synchronous on purpose: volumes are low, and we want the guarantee
 * that nothing is lost if the daemon dies right after an action.
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
