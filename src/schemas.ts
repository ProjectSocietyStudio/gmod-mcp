import { z } from "zod";

/**
 * Realm ciblé par une commande ou porté par un événement.
 * `local` = action côté daemon (lint, start-server, logs...), pas côté GMod.
 */
export const Realm = z.enum(["sv", "cl", "local"]);
export type Realm = z.infer<typeof Realm>;

export const Severity = z.enum(["error", "warning", "info"]);
export type Severity = z.infer<typeof Severity>;

/**
 * Enveloppe de commande daemon -> bridge (Phase 2+).
 * `confirmed` n'est posé par le daemon qu'après approbation humaine explicite
 * pour les outils gardés (ex. run_lua).
 */
export const CommandEnvelope = z.object({
  id: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.unknown()).default({}),
  realm: Realm,
  confirmed: z.boolean().optional(),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelope>;

/** Résultat bridge -> daemon, corrélé par `id`. */
export const ResultEnvelope = z.object({
  id: z.string().min(1),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().optional(),
});
export type ResultEnvelope = z.infer<typeof ResultEnvelope>;

/** Événement async bridge -> daemon (erreurs Lua, lignes de log, net...). */
export const EventEnvelope = z.object({
  type: z.string().min(1),
  realm: Realm,
  ts: z.number(),
  payload: z.record(z.unknown()).default({}),
});
export type EventEnvelope = z.infer<typeof EventEnvelope>;

/**
 * Finding unifié : sortie de lint statique OU erreur runtime parsée depuis les logs.
 * C'est la forme que consomment l'agent et la validation engine.
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

/** Un patch appliqué à un fichier, avec sa justification et son cycle de vie. */
export const Patch = z.object({
  id: z.string().min(1),
  file: z.string(),
  diff: z.string(),
  rationale: z.string(),
  appliedAt: z.number(),
  revertedAt: z.number().optional(),
});
export type Patch = z.infer<typeof Patch>;

/** Contexte d'une itération de dev. */
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
