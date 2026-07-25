import type { AnyToolDef } from "../mcp/registry.js";
import { batchTools } from "./batch.js";
import { clientBridgeTools, serverBridgeTools } from "./bridge.js";
import { devTools } from "./dev.js";
import { healthTool } from "./health.js";
import { localTools } from "./local.js";
import { worldTools } from "./world.js";

/** Every tool registered at startup. */
export const allTools: AnyToolDef[] = [
  healthTool,
  ...localTools,
  ...serverBridgeTools,
  ...clientBridgeTools,
  ...devTools,
  ...batchTools,
  ...worldTools,
];
