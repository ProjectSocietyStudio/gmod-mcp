import { z } from "zod";
import { defineTool } from "../mcp/registry.js";
import type { AnyToolDef } from "../mcp/registry.js";
import { touchAddon, touchFile } from "../proc/reload.js";
import { validate } from "../validate/engine.js";

function clip(s: string, max = 8000): string {
  return s.length > max ? s.slice(0, max) + `\n...(${s.length - max} bytes truncated)` : s;
}

const patchFile = defineTool({
  name: "patch_file",
  description:
    "Replaces a file's contents (inside the repo) after backing it up. Returns a patch id for restore_patch, plus the unified diff. rationale explains the change.",
  realm: "local",
  inputSchema: {
    file: z.string().min(1).describe("Chemin relatif au repo GMod."),
    content: z.string().describe("The file's complete new contents."),
    rationale: z.string().min(1).describe("Pourquoi ce changement."),
  },
  handler: async ({ file, content, rationale }, ctx) => {
    const patch = await ctx.patch.applyFile(file, content, rationale);
    ctx.audit.record({ kind: "patch_apply", data: { id: patch.id, file: patch.file, rationale } });
    return { ok: true, id: patch.id, file: patch.file, diff: clip(patch.diff) };
  },
});

const restorePatch = defineTool({
  name: "restore_patch",
  description: "Reverts a patch by id, restoring the previous state.",
  realm: "local",
  inputSchema: { id: z.string().min(1) },
  handler: ({ id }, ctx) => {
    const r = ctx.patch.restore(id);
    ctx.audit.record({ kind: "patch_revert", data: { id, file: r.file, action: r.action } });
    return r;
  },
});

const reloadFile = defineTool({
  name: "reload_file",
  description:
    "Triggers GMod's Lua autorefresh for a file by bumping its mtime. Best-effort: it covers edits, while new files and autoruns still need a restart.",
  realm: "local",
  inputSchema: { file: z.string().min(1) },
  handler: ({ file }, ctx) => ({ ok: touchFile(ctx.config, file), file }),
});

const reloadAddon = defineTool({
  name: "reload_addon",
  description:
    "Touches every .lua file of an addon to trigger autorefresh. Best-effort; structural changes still need a restart.",
  realm: "local",
  inputSchema: { addon: z.string().min(1) },
  handler: ({ addon }, ctx) => ({ ok: true, touched: touchAddon(ctx.config, addon) }),
});

const validateTool = defineTool({
  name: "validate",
  description:
    "Verdict de la boucle : lint de l'addon + erreurs runtime du boot courant. ok=true si lint vert ET aucune erreur runtime.",
  realm: "local",
  inputSchema: { addon: z.string().min(1) },
  handler: async ({ addon }, ctx) => ({ ...(await validate(ctx.config, addon)) }),
});

const runIteration = defineTool({
  name: "run_iteration",
  description:
    "One full iteration: optional patch -> reload (or a restart note) -> validate. Returns the applied patch and the verdict. This is the core of the edit/observe/fix loop.",
  realm: "local",
  inputSchema: {
    addon: z.string().min(1),
    file: z.string().optional().describe("File to patch, together with content."),
    content: z.string().optional().describe("Nouveau contenu du fichier."),
    rationale: z.string().optional(),
    reload: z.boolean().default(true).describe("Touch files to trigger autorefresh after patching."),
  },
  handler: async ({ addon, file, content, rationale, reload }, ctx) => {
    let patch: { id: string; file: string } | undefined;
    if (file && content !== undefined) {
      const p = await ctx.patch.applyFile(file, content, rationale ?? "run_iteration");
      ctx.audit.record({ kind: "patch_apply", data: { id: p.id, file: p.file } });
      patch = { id: p.id, file: p.file };
    }
    let touched = 0;
    if (reload) touched = touchAddon(ctx.config, addon);
    const verdict = await validate(ctx.config, addon);
    return { patch, reloaded: touched, verdict };
  },
});

export const devTools: AnyToolDef[] = [
  patchFile,
  restorePatch,
  reloadFile,
  reloadAddon,
  validateTool,
  runIteration,
];
