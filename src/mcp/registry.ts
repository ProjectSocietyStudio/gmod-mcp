import type { z, ZodRawShape } from "zod";
import type { Bridge } from "../bridge/types.js";
import type { Config } from "../config.js";
import type { AuditLog } from "../logger.js";
import type { PatchEngine } from "../patch/engine.js";
import type { Realm } from "../schemas.js";

/** Contexte injecté à chaque handler d'outil. Étendu au fil des phases. */
export interface ToolContext {
  config: Config;
  audit: AuditLog;
  patch: PatchEngine;
  /** Présent une fois le transport bridge démarré (outils realms sv/cl). */
  bridge?: Bridge;
}

/** Ce qu'un handler renvoie : un objet JSON sérialisable exposé à l'agent. */
export type ToolResult = Record<string, unknown>;

/**
 * Définition d'un outil MCP. La `shape` zod décrit les entrées ; le handler
 * reçoit les args déjà validés/typés.
 *
 * `guarded: true` ⇒ l'appel exige `confirm: true` dans les args (ou le nom de
 * l'outil dans l'allowlist de la config), sinon il est refusé sans exécution.
 * Les outils gardés DOIVENT déclarer `confirm` dans leur `inputSchema`.
 */
export interface ToolDef<Shape extends ZodRawShape = ZodRawShape> {
  name: string;
  description: string;
  realm: Realm;
  guarded?: boolean;
  inputSchema: Shape;
  handler: (
    args: z.infer<z.ZodObject<Shape>>,
    ctx: ToolContext,
  ) => Promise<ToolResult> | ToolResult;
}

/** Conserve l'inférence de types au site de définition. */
export function defineTool<Shape extends ZodRawShape>(
  def: ToolDef<Shape>,
): ToolDef<Shape> {
  return def;
}

/** Version à shape effacée, telle que stockée dans le registre. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef = ToolDef<any>;

/** Registre en mémoire des outils, indexés par nom. */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDef>();

  register(def: AnyToolDef): void {
    if (this.tools.has(def.name)) {
      throw new Error(`Outil déjà enregistré : ${def.name}`);
    }
    this.tools.set(def.name, def);
  }

  registerAll(defs: AnyToolDef[]): void {
    for (const d of defs) this.register(d);
  }

  get(name: string): AnyToolDef | undefined {
    return this.tools.get(name);
  }

  list(): AnyToolDef[] {
    return [...this.tools.values()];
  }
}

/**
 * Décide si un appel à un outil gardé est autorisé.
 * Autorisé si non-gardé, ou `confirm === true`, ou nom dans l'allowlist.
 */
export function isCallAllowed(
  def: AnyToolDef,
  args: Record<string, unknown>,
  allowlist: readonly string[],
): boolean {
  if (!def.guarded) return true;
  if (args["confirm"] === true) return true;
  return allowlist.includes(def.name);
}
