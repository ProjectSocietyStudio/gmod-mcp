import type { EventEmitter } from "node:events";
import type { ResultEnvelope } from "../schemas.js";

/**
 * Interface commune des transports bridge (HTTP ou fichier). Les outils sv/cl
 * depend only on this, so the transport can change without touching them.
 * Emits `"event"` (EventEnvelope) for asynchronous events coming from the game.
 */
export interface Bridge extends EventEmitter {
  enqueue(
    realm: "sv" | "cl",
    tool: string,
    args: Record<string, unknown>,
    opts?: { confirmed?: boolean },
  ): Promise<ResultEnvelope>;
  close(): Promise<void>;
}
