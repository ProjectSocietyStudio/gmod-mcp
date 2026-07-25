import { describe, expect, it } from "vitest";
import { successResult } from "../src/mcp/server.js";
import { IMAGE_KEY, isToolImage } from "../src/mcp/registry.js";
import { clientBridgeTools } from "../src/tools/bridge.js";

describe("image content blocks", () => {
  it("returns a lone text block when there is no image", () => {
    const res = successResult({ ok: true, count: 2 });
    expect(res.content).toHaveLength(1);
    expect(res.content[0]).toMatchObject({ type: "text" });
  });

  it("emits the image as an image block, not as text", () => {
    const res = successResult({ ok: true, [IMAGE_KEY]: { data: "QUJD", mimeType: "image/jpeg" } });
    expect(res.content).toHaveLength(2);
    expect(res.content[1]).toEqual({ type: "image", data: "QUJD", mimeType: "image/jpeg" });
  });

  it("keeps the payload out of the text block, so it is not billed twice", () => {
    const res = successResult({ ok: true, [IMAGE_KEY]: { data: "QUJD", mimeType: "image/jpeg" } });
    const text = (res.content[0] as { text: string }).text;
    expect(text).not.toContain("QUJD");
    expect(text).not.toContain(IMAGE_KEY);
    expect(JSON.parse(text)).toEqual({ ok: true });
  });

  it("ignores a malformed image rather than emitting an invalid block", () => {
    const res = successResult({ ok: true, [IMAGE_KEY]: { data: 42 } });
    expect(res.content).toHaveLength(1);
    expect(isToolImage({ data: 42 })).toBe(false);
  });
});

describe("capture_screen", () => {
  const captureScreen = clientBridgeTools.find((t) => t.name === "capture_screen");

  it("is still registered under its own name", () => {
    expect(captureScreen).toBeDefined();
  });

  it("moves the bridge's base64 into an image block and keeps the metadata", async () => {
    // A fake bridge standing in for the client half: no srcds, no GMod client.
    const bridge = {
      enqueue: () =>
        Promise.resolve({
          id: "x",
          ok: true as const,
          data: { format: "jpeg", w: 1920, h: 1080, base64: "QUJD" },
        }),
      close: () => Promise.resolve(),
      on: () => undefined,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await captureScreen!.handler({}, { bridge, config: { clientWaitMs: 0 } } as any);

    expect(res[IMAGE_KEY]).toEqual({ data: "QUJD", mimeType: "image/jpeg" });
    expect(res["data"]).toEqual({ format: "jpeg", w: 1920, h: 1080 });
  });
});
