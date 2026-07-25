import { z } from "zod";
import { defineTool } from "../mcp/registry.js";
import type { AnyToolDef } from "../mcp/registry.js";
import { parseLintOutput } from "../parse/lint.js";
import { parseRuntimeLog } from "../parse/runtime.js";
import {
  lintAddon,
  packageAddon,
  readGameLog,
  readStdoutLog,
  startServer,
  stopServer,
  syncConfig,
} from "../proc/scripts.js";
import type { Finding } from "../schemas.js";

function tally(findings: Finding[]): { errors: number; warnings: number } {
  return {
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
  };
}

/** Tronque un texte long pour le renvoyer sans noyer l'agent. */
function clip(s: string, max = 8000): string {
  return s.length > max ? s.slice(0, max) + `\n…(${s.length - max} octets tronqués)` : s;
}

const lint = defineTool({
  name: "lint",
  description:
    "Lance tools/lint.sh sur un addon (nom ou chemin). Renvoie les findings structurés (fichier/ligne/règle) + code de sortie. exit 0 = propre.",
  realm: "local",
  inputSchema: { addon: z.string().min(1) },
  handler: async ({ addon }, ctx) => {
    const r = await lintAddon(ctx.config, addon);
    if (r.code === 2) {
      return { ok: false, exitCode: 2, error: r.stderr.trim() || "usage/dossier invalide", findings: [] };
    }
    const findings = parseLintOutput(r.stdout);
    return {
      ok: r.code === 0,
      exitCode: r.code,
      ...tally(findings),
      findings,
      raw: clip(r.stdout),
    };
  },
});

const startServerTool = defineTool({
  name: "start_server",
  description:
    "Démarre le serveur dédié via tools/start-server.sh [map] [gamemode] [tickrate] et enregistre la frontière de boot du log. Défauts du script : rp_nycity_day/darkrp/33.",
  realm: "local",
  inputSchema: {
    map: z.string().optional(),
    gamemode: z.string().optional(),
    tickrate: z.number().int().min(1).max(128).optional(),
  },
  handler: async (args, ctx) => {
    const { result, boot } = await startServer(ctx.config, args);
    return {
      ok: result.code === 0,
      exitCode: result.code,
      boot,
      stdout: clip(result.stdout),
      stderr: clip(result.stderr),
      note:
        result.code === 1
          ? "start-server.sh a refusé (serveur déjà démarré ? voir stderr)."
          : "Serveur lancé en arrière-plan. Laissez ~45 s puis read_logs.",
    };
  },
});

const stopServerTool = defineTool({
  name: "stop_server",
  description: "Arrête le serveur dédié via tools/stop-server.sh.",
  realm: "local",
  inputSchema: {},
  handler: async (_args, ctx) => {
    const r = await stopServer(ctx.config);
    return { ok: r.code === 0, exitCode: r.code, stdout: clip(r.stdout), stderr: clip(r.stderr) };
  },
});

const syncConfigTool = defineTool({
  name: "sync_config",
  description:
    "Réapplique server-config/ et (re)crée les symlinks via tools/sync-server-config.sh. check:true = compare sans écrire (--check).",
  realm: "local",
  inputSchema: { check: z.boolean().default(false) },
  handler: async ({ check }, ctx) => {
    const r = await syncConfig(ctx.config, check);
    return { ok: r.code === 0, exitCode: r.code, stdout: clip(r.stdout), stderr: clip(r.stderr) };
  },
});

const readLogs = defineTool({
  name: "read_logs",
  description:
    "Lit les logs du serveur. source=game (erreurs Lua, -condebug) ou stdout (wrapper). sinceBoot:true borne au boot courant. errorsOnly:true renvoie des findings runtime structurés.",
  realm: "local",
  inputSchema: {
    source: z.enum(["game", "stdout"]).default("game"),
    sinceBoot: z.boolean().default(true),
    errorsOnly: z.boolean().default(true),
  },
  handler: ({ source, sinceBoot, errorsOnly }, ctx) => {
    if (source === "stdout") {
      const text = readStdoutLog(ctx.config);
      return errorsOnly
        ? { source, findings: parseRuntimeLog(text) }
        : { source, text: clip(text, 20000) };
    }
    const text = readGameLog(ctx.config, sinceBoot);
    if (!errorsOnly) return { source, sinceBoot, text: clip(text, 20000) };
    const findings = parseRuntimeLog(text);
    return { source, sinceBoot, count: findings.length, findings };
  },
});

const packageTool = defineTool({
  name: "package",
  description:
    "Construit le .gma d'un addon via tools/package-gma.sh (lint d'abord, refus si échec). Sortie dans dist/.",
  realm: "local",
  inputSchema: { addon: z.string().min(1) },
  handler: async ({ addon }, ctx) => {
    const r = await packageAddon(ctx.config, addon);
    return { ok: r.code === 0, exitCode: r.code, stdout: clip(r.stdout), stderr: clip(r.stderr) };
  },
});

export const localTools: AnyToolDef[] = [
  lint,
  startServerTool,
  stopServerTool,
  syncConfigTool,
  readLogs,
  packageTool,
];
