import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { batchTool } from "../src/tools/batch.js";
import { ToolRegistry } from "../src/mcp/registry.js";
import type { Bridge, EnqueueOptions } from "../src/bridge/types.js";
import type { ToolContext } from "../src/mcp/registry.js";
import { allTools } from "../src/tools/index.js";
import { makeConfig } from "./helpers.js";

interface Sent {
  realm: string;
  tool: string;
  args: Record<string, unknown>;
  opts: EnqueueOptions;
}

/** A bridge that records what it was asked to send instead of reaching srcds. */
class RecordingBridge extends EventEmitter implements Bridge {
  readonly sent: Sent[] = [];

  enqueue(
    realm: "sv" | "cl",
    tool: string,
    args: Record<string, unknown>,
    opts: EnqueueOptions = {},
  ) {
    this.sent.push({ realm, tool, args, opts });
    return Promise.resolve({ id: "1", ok: true as const, data: { count: 0, steps: [] } });
  }

  close() {
    return Promise.resolve();
  }
}

function makeCtx(bridge?: Bridge): ToolContext {
  const registry = new ToolRegistry();
  registry.registerAll(allTools);
  return {
    config: makeConfig(),
    audit: { record: () => undefined } as unknown as ToolContext["audit"],
    patch: {} as ToolContext["patch"],
    registry,
    ...(bridge ? { bridge } : {}),
  };
}

const run = (args: Record<string, unknown>, ctx: ToolContext) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  batchTool.handler({ stopOnError: true, settleMs: 0, ...args } as any, ctx);

describe("batch", () => {
  it("sends every step in a single bridge command", async () => {
    const bridge = new RecordingBridge();
    const res = await run(
      { steps: [{ tool: "read_runtime" }, { tool: "read_players" }, { tool: "read_hooks" }] },
      makeCtx(bridge),
    );

    expect(res["ok"]).toBe(true);
    expect(bridge.sent).toHaveLength(1);
    expect(bridge.sent[0]).toMatchObject({ realm: "sv", tool: "batch" });
    expect((bridge.sent[0]!.args["steps"] as unknown[]).length).toBe(3);
  });

  it("refuses a guarded step without confirmation", async () => {
    const bridge = new RecordingBridge();
    const res = await run({ steps: [{ tool: "read_runtime" }, { tool: "run_lua" }] }, makeCtx(bridge));

    expect(res["ok"]).toBe(false);
    expect(String(res["error"])).toContain("guarded");
    // The point of the check: nothing reached the game.
    expect(bridge.sent).toHaveLength(0);
  });

  it("allows a guarded step once the batch is confirmed, and marks the command confirmed", async () => {
    const bridge = new RecordingBridge();
    const res = await run({ steps: [{ tool: "run_lua", args: { code: "return 1" } }], confirm: true }, makeCtx(bridge));

    expect(res["ok"]).toBe(true);
    expect(bridge.sent[0]!.opts.confirmed).toBe(true);
  });

  it("refuses an unknown tool, naming the step", async () => {
    const res = await run({ steps: [{ tool: "read_runtime" }, { tool: "nope" }] }, makeCtx(new RecordingBridge()));
    expect(String(res["error"])).toContain("step 1");
    expect(String(res["error"])).toContain("nope");
  });

  it("refuses a local tool, which cannot run inside the game", async () => {
    const res = await run({ steps: [{ tool: "lint", args: { addon: "x" } }] }, makeCtx(new RecordingBridge()));
    expect(String(res["error"])).toContain("local tool");
  });

  it("refuses client-realm steps explicitly rather than silently dropping them", async () => {
    const res = await run({ steps: [{ tool: "capture_screen" }] }, makeCtx(new RecordingBridge()));
    expect(String(res["error"])).toContain("client-realm");
  });

  it("extends the timeout to cover its own settle pauses", async () => {
    const bridge = new RecordingBridge();
    await run(
      { steps: [{ tool: "read_runtime" }, { tool: "read_players" }], settleMs: 500 },
      makeCtx(bridge),
    );
    expect(bridge.sent[0]!.opts.timeoutMs).toBe(30_000 + 500 * 2);
  });

  it("reports a missing bridge instead of throwing", async () => {
    const res = await run({ steps: [{ tool: "read_runtime" }] }, makeCtx());
    expect(res["ok"]).toBe(false);
    expect(String(res["error"])).toContain("bridge not connected");
  });
});
