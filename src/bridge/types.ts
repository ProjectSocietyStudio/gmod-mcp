import type { EventEmitter } from "node:events";
import type { ResultEnvelope } from "../schemas.js";

/** Per-command options shared by every bridge transport. */
export interface EnqueueOptions {
  confirmed?: boolean;
  /**
   * Overrides the transport's default round-trip timeout. Probes want to fail fast
   * rather than stall a caller for the full default when srcds is simply down; long
   * batches want the opposite.
   */
  timeoutMs?: number;
}

/**
 * The interface every bridge transport implements. The sv/cl tools depend only on
 * this, so the transport can change without touching them.
 * Emits `"event"` (EventEnvelope) for asynchronous events coming from the game.
 */
export interface Bridge extends EventEmitter {
  enqueue(
    realm: "sv" | "cl",
    tool: string,
    args: Record<string, unknown>,
    opts?: EnqueueOptions,
  ): Promise<ResultEnvelope>;
  close(): Promise<void>;
}
