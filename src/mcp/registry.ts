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
  /**
   * The registry itself, for tools that reason about other tools -- `batch` resolves
   * each step's realm and guarded flag from it rather than trusting the caller.
   */
  registry?: ToolRegistry;
}

/** What a handler returns: a serialisable JSON object exposed to the agent. */
export type ToolResult = Record<string, unknown>;

/**
 * An image the agent should actually SEE, carried under `IMAGE_KEY` in a ToolResult.
 *
 * Without this, a screenshot comes back as base64 inside a text block: the model is
 * billed for every byte and still cannot look at the picture. The failure is silent --
 * the tool returns, the tests pass, and the "see" half of an act/see loop quietly does
 * nothing. `createMcpServer` lifts the key out of the JSON body and emits a real image
 * content block, so the payload is never billed twice.
 */
export interface ToolImage {
  /** Base64 payload, with no `data:` prefix. */
  data: string;
  /** MIME type, e.g. `image/jpeg`. */
  mimeType: string;
}

export const IMAGE_KEY = "_image";

export function isToolImage(value: unknown): value is ToolImage {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["data"] === "string" && typeof v["mimeType"] === "string";
}

/**
 * Definition of an MCP tool. The zod `shape` describes the inputs; the handler
 * receives arguments already validated and typed.
 *
 * `guarded: true` means the call requires `confirm: true` in its args (or the tool's
 * name in the config allowlist), otherwise it is refused without running.
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
