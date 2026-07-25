import type { AnyToolDef } from "../mcp/registry.js";
import { clientBridgeTools, serverBridgeTools } from "./bridge.js";
import { devTools } from "./dev.js";
import { healthTool } from "./health.js";
import { localTools } from "./local.js";

/** Every tool registered at startup. */
export const allTools: AnyToolDef[] = [
  healthTool,
  ...localTools,
  ...serverBridgeTools,
  ...clientBridgeTools,
  ...devTools,
];

/** @deprecated alias historique — utiliser allTools. */
export const phase0Tools = allTools;
