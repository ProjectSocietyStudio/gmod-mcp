import type {
  AnyToolDef as CoreAnyToolDef,
  BaseToolContext,
  ToolDef as CoreToolDef,
} from "@projectsociety/mcp-core";
import { makeToolkit, ToolRegistry as CoreToolRegistry } from "@projectsociety/mcp-core";
import type { ZodRawShape } from "zod";
import type { Bridge } from "../bridge/types.js";
import type { Config } from "../config.js";
import type { AuditLog } from "../logger.js";
import type { PatchEngine } from "../patch/engine.js";
import type { Realm } from "../schemas.js";

/** Context injected into every tool handler. */
export interface ToolContext extends BaseToolContext {
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

/** This server's tool definition: sv/cl/local realms, bridge and patch engine in context. */
export type ToolDef<Shape extends ZodRawShape = ZodRawShape> = CoreToolDef<
  ToolContext,
  Realm,
  Shape
>;

/** Shape-erased version, as stored in the registry. */
export type AnyToolDef = CoreAnyToolDef<ToolContext, Realm>;

/** In-memory tool registry, keyed by name. */
export class ToolRegistry extends CoreToolRegistry<ToolContext, Realm> {}

const toolkit = makeToolkit<ToolContext, Realm>();

/** Preserves type inference at the definition site. */
export const defineTool = toolkit.defineTool;

export {
  clip,
  IMAGE_KEY,
  isCallAllowed,
  isToolImage,
  type ToolImage,
  type ToolResult,
} from "@projectsociety/mcp-core";
