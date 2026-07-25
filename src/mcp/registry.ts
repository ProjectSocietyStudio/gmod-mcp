import type { z, ZodRawShape } from "zod";
import type { Bridge } from "../bridge/types.js";
import type { Config } from "../config.js";
import type { AuditLog } from "../logger.js";
import type { PatchEngine } from "../patch/engine.js";
import type { Realm } from "../schemas.js";

/** Context injected into every tool handler. */
export interface ToolContext {
  config: Config;
  audit: AuditLog;
  patch: PatchEngine;
  /** Present once the bridge transport has started (sv/cl realm tools). */
  bridge?: Bridge;
}

/** What a handler returns: a serialisable JSON object exposed to the agent. */
export type ToolResult = Record<string, unknown>;

/**
 * Definition of an MCP tool. The zod `shape` describes the inputs; the handler
 * receives arguments already validated and typed.
 *
 * `guarded: true` ⇒ l'appel exige `confirm: true` dans les args (ou le nom de
 * the tool appears in the config allowlist), otherwise it is refused without running.
 * Guarded tools MUST declare `confirm` in their `inputSchema`.
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

/** Preserves type inference at the definition site. */
export function defineTool<Shape extends ZodRawShape>(
  def: ToolDef<Shape>,
): ToolDef<Shape> {
  return def;
}

/** Shape-erased version, as stored in the registry. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef = ToolDef<any>;

/** In-memory tool registry, keyed by name. */
export class ToolRegistry {
  private readonly tools = new Map<string, AnyToolDef>();

  register(def: AnyToolDef): void {
    if (this.tools.has(def.name)) {
      throw new Error(`Tool already registered: ${def.name}`);
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
 * Decides whether a call to a guarded tool is allowed: when it is not guarded, when
 * `confirm === true`, or when its name is in the allowlist.
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
