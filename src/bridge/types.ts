import type { EventEmitter } from "node:events";
import type { ResultEnvelope } from "../schemas.js";

/**
 * Interface commune des transports bridge (HTTP ou fichier). Les outils sv/cl
 * ne dépendent que de ceci — on peut changer de transport sans les toucher.
 * Émet `"event"` (EventEnvelope) pour les événements asynchrones du jeu.
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
