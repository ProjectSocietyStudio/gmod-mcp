import { z } from "zod";
import { defineTool } from "../mcp/registry.js";
import type { AnyToolDef } from "../mcp/registry.js";
import { touchAddon, touchFile } from "../proc/reload.js";
import { validate } from "../validate/engine.js";

function clip(s: string, max = 8000): string {
  return s.length > max ? s.slice(0, max) + `\n…(${s.length - max} octets tronqués)` : s;
}

const patchFile = defineTool({
  name: "patch_file",
  description:
    "Remplace le contenu d'un fichier (dans le repo) après sauvegarde. Renvoie un id de patch (pour restore_patch) et le diff unifié. rationale explique le changement.",
  realm: "local",
  inputSchema: {
    file: z.string().min(1).describe("Chemin relatif au repo GMod."),
    content: z.string().describe("Nouveau contenu intégral du fichier."),
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
  description: "Annule un patch (restaure l'état d'avant) via son id.",
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
    "Déclenche l'auto-refresh Lua d'un fichier (bump mtime). Best-effort : couvre l'édition ; nouveaux fichiers/autoruns exigent un restart.",
  realm: "local",
  inputSchema: { file: z.string().min(1) },
  handler: ({ file }, ctx) => ({ ok: touchFile(ctx.config, file), file }),
});

const reloadAddon = defineTool({
  name: "reload_addon",
  description:
    "Touche tous les .lua d'un addon pour l'auto-refresh. Best-effort ; un restart reste nécessaire pour les changements structurels.",
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
    "Une itération complète : [patch optionnel] -> reload (ou note restart) -> validate. Renvoie le patch appliqué et le verdict. Le cœur de la boucle edit→observe→corrige.",
  realm: "local",
  inputSchema: {
    addon: z.string().min(1),
    file: z.string().optional().describe("Fichier à patcher (avec content)."),
    content: z.string().optional().describe("Nouveau contenu du fichier."),
    rationale: z.string().optional(),
    reload: z.boolean().default(true).describe("Toucher les fichiers pour l'auto-refresh après patch."),
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
