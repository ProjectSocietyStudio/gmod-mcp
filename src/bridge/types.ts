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
 * Readable transport state, surfaced by `health`.
 *
 * It exists because the failure that motivated it was invisible: every tool timing out
 * with a healthy game, and no way to see whether the daemon owned its channel, what it was
 * waiting on, or whether someone else was eating its results. A relay you cannot look at
 * is a relay you debug by guessing.
 */
export interface BridgeStatus {
  transportDir: string;
  /** False when another daemon holds the transport lock: nothing will work. */
  owns: boolean;
  lockPath: string;
  lockedBy?: { pid: number; startedAt: string; version?: string };
  /** In-flight commands, as `realm:tool`. */
  inFlight: string[];
  /**
   * Cumulative count of `res/` files that matched no command of ours. Anything above zero
   * on a single-daemon setup means a second daemon is sharing the directory.
   */
  uncorrelatedResults: number;
  /** Age of the last result or event read, or null if the addon has never answered. */
  lastAddonContactMsAgo: number | null;
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
  /** Optional: transports built for tests do not report state. */
  status?(): BridgeStatus;
}
