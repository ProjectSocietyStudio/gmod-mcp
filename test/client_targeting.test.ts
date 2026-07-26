import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { clientBridgeTools } from "../src/tools/bridge.js";
import type { AnyToolDef } from "../src/mcp/registry.js";

/**
 * Lot 1 of docs/2026-07-25-autonomie-client-design.md: naming a panel instead of guessing
 * a pixel, asserting text instead of reading a JPEG, and typing into a field at all.
 *
 * The Lua half runs in the game and cannot be executed here, so these tests hold the two
 * things that CAN drift silently: the argument surface an agent is allowed to send (zod
 * refuses anything undeclared before it ever reaches the client) and the presence of the
 * handlers and behaviours the tool descriptions promise.
 */
const CL_SOURCE = readFileSync(
  join(
    dirname(fileURLToPath(import.meta.url)),
    "..",
    "addon",
    "gmod_mcp_bridge",
    "lua",
    "autorun",
    "client",
    "gmod_mcp_bridge_cl.lua",
  ),
  "utf8",
);

const byName = (name: string): AnyToolDef => {
  const def = clientBridgeTools.find((t) => t.name === name);
  if (!def) throw new Error(`no client tool named ${name}`);
  return def;
};

const objectOf = (def: AnyToolDef) => z.object(def.inputSchema as z.ZodRawShape);

describe("3.2 -- naming a panel instead of a class", () => {
  const def = byName("inspect_panel");

  it("accepts a name, a text filter and an index, none of which existed", () => {
    const parsed = objectOf(def).parse({ name: "R_UI_Button", contains: "ÉCROUER", index: 2 });
    expect(parsed["name"]).toBe("R_UI_Button");
    expect(parsed["contains"]).toBe("ÉCROUER");
    expect(parsed["index"]).toBe(2);
  });

  it("no longer REQUIRES a class: searching a kit panel by class never matched", () => {
    expect(() => objectOf(def).parse({ name: "R_CharCreate" })).not.toThrow();
  });

  it("hides off-screen panels by default -- a live tree was 1408 panels, 5 on screen", () => {
    expect(objectOf(def).parse({ name: "x" })["onScreen"]).toBe(true);
    expect(objectOf(def).parse({ name: "x", onScreen: false })["onScreen"]).toBe(false);
  });

  it("the Lua matcher compares GetName, not only GetClassName", () => {
    expect(CL_SOURCE).toMatch(/info\.name ~= args\.name/);
    expect(CL_SOURCE).toMatch(/info\.class ~= args\.class/);
  });

  it("a target with no criterion is refused in Lua rather than matching everything", () => {
    expect(CL_SOURCE).toMatch(/if not hasTarget\(args\) then\s*\n\s*error\(/);
  });
});

describe("3.3 -- reading the interface as text", () => {
  const def = byName("read_panel_text");

  it("is a client-realm tool", () => {
    expect(def.realm).toBe("cl");
  });

  it("defaults to a narrow dump: text-bearing, on-screen, depth-limited, capped", () => {
    const parsed = objectOf(def).parse({});
    expect(parsed).toMatchObject({ maxDepth: 8, onlyText: true, onScreen: true, limit: 120 });
  });

  it("takes a root so a subtree can be dumped instead of the screen", () => {
    expect(objectOf(def).parse({ root: "R_CharCreate" })["root"]).toBe("R_CharCreate");
  });

  it("reads painted labels too: a kit button answers '' to GetText", () => {
    expect(CL_SOURCE).toMatch(/local TEXT_FIELDS = \{ "label", "text", "title" \}/);
    expect(CL_SOURCE).toMatch(/H\.read_panel_text = function/);
  });

  it("counts what it dropped instead of silently truncating", () => {
    expect(CL_SOURCE).toMatch(/truncated = truncated \+ 1/);
  });
});

describe("3.1 -- putting a value in a field", () => {
  const def = byName("client_input");
  const shape = def.inputSchema as z.ZodRawShape;

  it("exposes set_text as an action", () => {
    const action = shape["action"] as z.ZodEnum<[string, ...string[]]>;
    expect(action.options).toContain("set_text");
  });

  it("declares the target keys set_text and type need", () => {
    for (const key of ["name", "class", "contains", "index", "onScreen", "text", "focus", "enter"]) {
      expect(Object.keys(shape)).toContain(key);
    }
  });

  it("sets the text through Panel:SetText, not DTextEntry:SetValue", () => {
    // SetValue is documented not to change the text while the entry is being typed in,
    // which is exactly the state RequestFocus leaves it in.
    expect(CL_SOURCE).toMatch(/panel:SetText\(args\.text\)/);
    expect(CL_SOURCE).not.toMatch(/panel:SetValue\(/);
  });

  it("fires the change notification, so validation does not stay in its previous state", () => {
    expect(CL_SOURCE).toMatch(/fireOne\(fired, panel, "OnTextChanged"\)/);
    expect(CL_SOURCE).toMatch(/fireOne\(fired, panel, "OnValueChange", text\)/);
    expect(CL_SOURCE).toMatch(/fireOne\(fired, panel, "OnChange", text\)/);
  });

  it("does not fire OnValueChange twice when OnTextChanged already did", () => {
    expect(CL_SOURCE).toMatch(/if not \(textChanged and updateOnType\) then/);
  });

  it("keeps OnEnter opt-in: on a chat entry it would send the line", () => {
    expect(CL_SOURCE).toMatch(/if alsoEnter then fireOne\(fired, panel, "OnEnter", text\) end/);
  });

  it("reads the field back, since `typed: N` was reported over an empty field", () => {
    expect(CL_SOURCE).toMatch(/value = panelText\(panel\)/);
  });

  it("gives a targeted `type` a frame before typing, because focus lands late", () => {
    expect(CL_SOURCE).toMatch(/afterFrame\(cmd, function\(\) return typeInto\(args, info, panel\) end\)/);
  });
});

describe("3.4 -- a click that suffices on its own", () => {
  it("settles hover for two frames and re-asserts the cursor on each", () => {
    expect(CL_SOURCE).toMatch(/local SETTLE_FRAMES = 2/);
    expect(CL_SOURCE).toMatch(/if frame <= SETTLE_FRAMES then\s*\n\s*input\.SetCursorPos\(x, y\)/);
  });

  it("presses after the settle frames and releases on the one after", () => {
    expect(CL_SOURCE).toMatch(/elseif frame == SETTLE_FRAMES \+ 1 then/);
    expect(CL_SOURCE).toMatch(/gui\.InternalMouseReleased\(code\)/);
  });

  it("resolves a named target to the centre of its screen rectangle", () => {
    expect(CL_SOURCE).toMatch(/math\.floor\(sx \+ w \* 0\.5\), math\.floor\(sy \+ h \* 0\.5\)/);
  });

  it("stops telling callers to move_cursor first", () => {
    const description = byName("client_input").description;
    expect(description).toMatch(/self-sufficient/);
    expect(description).toMatch(/no `move_cursor` is needed first/);
  });
});
