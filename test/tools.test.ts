import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { clientBridgeTools, serverBridgeTools } from "../src/tools/bridge.js";
import { isCallAllowed } from "../src/mcp/registry.js";
import type { Bridge } from "../src/bridge/types.js";
import type { AnyToolDef, ToolContext } from "../src/mcp/registry.js";
import { makeConfig } from "./helpers.js";

/**
 * Handler-level coverage for the bridge tools. Everything under them was tested --
 * transport, parsers, schemas -- but no test had ever called a tool, so the layer that
 * decides what an agent actually sees was the only untested one.
 */

/** A bridge that always fails with a fixed message, counting the attempts. */
class FailingBridge extends EventEmitter implements Bridge {
  attempts = 0;
  constructor(private readonly message: string) {
    super();
  }

  enqueue() {
    this.attempts += 1;
    return Promise.reject(new Error(this.message));
  }

  close() {
    return Promise.resolve();
  }
}

function ctxWith(bridge: Bridge | undefined, clientWaitMs = 0): ToolContext {
  return {
    config: makeConfig({ clientWaitMs }),
    audit: { record: () => undefined } as unknown as ToolContext["audit"],
    patch: {} as ToolContext["patch"],
    ...(bridge ? { bridge } : {}),
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const call = (def: AnyToolDef, ctx: ToolContext, args: Record<string, unknown> = {}) =>
  def.handler(args as any, ctx);

const bridgeTools = [...serverBridgeTools, ...clientBridgeTools];

describe("bridge tools without a bridge", () => {
  for (const def of bridgeTools) {
    it(`${def.name} names the missing bridge instead of throwing`, async () => {
      const res = await call(def, ctxWith(undefined));
      expect(res["ok"]).toBe(false);
      expect(String(res["error"])).toContain("bridge not connected");
    });
  }
});

describe("guarded tools", () => {
  const guarded = bridgeTools.filter((d) => d.guarded);

  it("run_lua is the guarded one", () => {
    expect(guarded.map((d) => d.name)).toEqual(["run_lua"]);
  });

  for (const def of guarded) {
    it(`${def.name} is refused without confirm and without an allowlist`, () => {
      expect(isCallAllowed(def, {}, [])).toBe(false);
      expect(isCallAllowed(def, { confirm: true }, [])).toBe(true);
      expect(isCallAllowed(def, {}, [def.name])).toBe(true);
    });

    it(`${def.name} declares confirm, so the gate is reachable`, () => {
      expect(Object.keys(def.inputSchema)).toContain("confirm");
    });
  }
});

describe("client-realm retry", () => {
  it("retries while the client is merely absent, and says how long it waited", async () => {
    const bridge = new FailingBridge("no client connected (realm=cl tool)");
    const res = await call(clientBridgeTools[0]!, ctxWith(bridge, 120));

    expect(bridge.attempts).toBeGreaterThan(1);
    expect(String(res["error"])).toContain("retried for 120ms");
  });

  it("does not retry a real failure, even in the client realm", async () => {
    const bridge = new FailingBridge("class (string) is required");
    await call(clientBridgeTools[0]!, ctxWith(bridge, 500));
    expect(bridge.attempts).toBe(1);
  });

  it("never retries a server-realm call: srcds does not come and go", async () => {
    const bridge = new FailingBridge("timeout: no result for read_runtime after 30000ms");
    await call(serverBridgeTools[0]!, ctxWith(bridge, 500));
    expect(bridge.attempts).toBe(1);
  });
});
