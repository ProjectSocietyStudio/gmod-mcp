import { z } from "zod";

/**
 * The realm a command targets, or that an event comes from.
 * `local` means a daemon-side action (lint, start-server, logs), not a GMod one.
 */
export const Realm = z.enum(["sv", "cl", "local"]);
export type Realm = z.infer<typeof Realm>;

export const Severity = z.enum(["error", "warning", "info"]);
export type Severity = z.infer<typeof Severity>;

/**
 * Enveloppe de commande daemon -> bridge (Phase 2+).
 * `confirmed` is only set by the daemon after explicit human approval, and only for
 * guarded tools such as run_lua.
 */
export const CommandEnvelope = z.object({
  id: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  realm: Realm,
  confirmed: z.boolean().optional(),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;

/** Bridge to daemon result, correlated by `id`. */
export const ResultEnvelope = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type ResultEnvelope = z.infer<typeof ResultEnvelope>;

/** Asynchronous bridge to daemon event (Lua errors, log lines, net messages). */
export const EventEnvelope = z.object({
  type: z.string().min(1),
  realm: Realm,
  ts: z.number(),
  payload: z.record(z.unknown()).default({}),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/**
 * Unified finding: either static lint output or a runtime error parsed from the logs.
 * This is the shape the agent and the validation engine consume.
 */
export const Finding = z.object({
  source: z.enum(["lint", "runtime"]),
  file: z.string(),
  line: z.number().int().nonnegative().optional(),
  severity: Severity,
  rule: z.string().optional(),
  message: z.string(),
  stack: z.string().optional(),
});
export type Finding = z.infer<typeof Finding>;

/** A patch applied to a file, with its rationale and lifecycle. */
export const Patch = z.object({
  id: z.string().min(1),
  file: z.string(),
  diff: z.string(),
  rationale: z.string(),
  appliedAt: z.number(),
  revertedAt: z.number().optional(),
});
export type Patch = z.infer<typeof Patch>;

/** Context of a development iteration. */
export const Session = z.object({
  id: z.string().min(1),
  task: z.string(),
  files: z.array(z.string()).default([]),
  patches: z.array(Patch).default([]),
  bootId: z.string().optional(),
  findings: z.array(Finding).default([]),
  createdAt: z.number(),
});
export type Session = z.infer<typeof Session>;
