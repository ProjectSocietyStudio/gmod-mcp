import { AuditLog as CoreAuditLog } from "@rolists/mcp-core";

/**
 * Audit entry kinds. Widens the shared base with this server's own vocabulary: it drives
 * a live engine over a file bridge and rewrites addon sources, where hammer-mcp drives a
 * toolchain.
 */
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

/**
 * Append-only JSONL audit log. One line is one event, correlated by `sessionId`
 * and `commandId`. Written to `<stateDir>/logs/audit.jsonl`.
 *
 * Writes are synchronous on purpose: volumes are low, and we want the guarantee
 * that nothing is lost if the daemon dies right after an action.
 */
export class AuditLog extends CoreAuditLog<AuditKind> {}

export type { AuditEntry } from "@rolists/mcp-core";
