import { z } from "zod";
import { defineTool } from "../mcp/registry.js";
import type { AnyToolDef, ToolContext, ToolResult } from "../mcp/registry.js";

/**
 * Exécute un outil côté bridge (realm sv/cl) : pousse la commande, attend le
 * résultat corrélé, et normalise la sortie. Renvoie une erreur lisible si le
 * bridge n'est pas connecté plutôt que de lever.
 */
async function callBridge(
  ctx: ToolContext,
  realm: "sv" | "cl",
  tool: string,
  args: Record<string, unknown>,
  confirmed: boolean,
): Promise<ToolResult> {
  if (!ctx.bridge) {
    return {
      ok: false,
      error:
        "bridge non connecté : aucun addon gmod_mcp_bridge n'a poll le daemon (le serveur GMod tourne-t-il, addon monté ?).",
    };
  }
  try {
    const res = await ctx.bridge.enqueue(realm, tool, args, { confirmed });
    return res.ok ? { ok: true, data: res.data } : { ok: false, error: res.error ?? "échec côté bridge" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Réglages de définition d'un outil bridge. */
interface BridgeToolSpec {
  name: string;
  description: string;
  realm: "sv" | "cl";
  inputSchema: z.ZodRawShape;
  guarded?: boolean;
}

function bridgeTool(spec: BridgeToolSpec): AnyToolDef {
  return defineTool({
    name: spec.name,
    description: spec.description,
    realm: spec.realm,
    ...(spec.guarded ? { guarded: true } : {}),
    inputSchema: spec.inputSchema,
    // Les outils gardés n'arrivent ici qu'une fois autorisés (gate MCP) ⇒ confirmed.
    handler: (args: Record<string, unknown>, ctx) =>
      callBridge(ctx, spec.realm, spec.name, args, spec.guarded === true),
  });
}

/** Outils d'introspection serveur (Phase 2). Le contrat de données vit côté Lua. */
export const serverBridgeTools: AnyToolDef[] = [
  bridgeTool({
    name: "read_runtime",
    description:
      "Instantané de l'état serveur : map, gamemode, CurTime, nombre de joueurs/entités, uptime.",
    realm: "sv",
    inputSchema: {},
  }),
  bridgeTool({
    name: "read_players",
    description: "Liste des joueurs : nom, SteamID, team/job, ping, position, santé.",
    realm: "sv",
    inputSchema: {},
  }),
  bridgeTool({
    name: "read_entities",
    description: "Liste des entités, filtrable par classe. Renvoie index/classe/model/position.",
    realm: "sv",
    inputSchema: {
      class: z.string().optional(),
      limit: z.number().int().min(1).max(2000).default(200),
    },
  }),
  bridgeTool({
    name: "inspect_entity",
    description: "Détail d'une entité par index : classe, model, santé, propriétaire, key-values.",
    realm: "sv",
    inputSchema: { index: z.number().int().nonnegative() },
  }),
  bridgeTool({
    name: "read_hooks",
    description: "Hooks enregistrés (hook.GetTable), filtrable par événement. Renvoie event -> identifiants.",
    realm: "sv",
    inputSchema: { event: z.string().optional() },
  }),
  bridgeTool({
    name: "read_convars",
    description: "Valeurs de convars serveur. Sans `names`, renvoie un sous-ensemble usuel.",
    realm: "sv",
    inputSchema: { names: z.array(z.string()).optional() },
  }),
  bridgeTool({
    name: "read_net_messages",
    description: "Messages net enregistrés (util.AddNetworkString) et présence d'un net.Receive.",
    realm: "sv",
    inputSchema: {},
  }),
  bridgeTool({
    name: "read_timers",
    description: "Timers créés via timer.Create et suivis par le bridge (les timers antérieurs sont invisibles).",
    realm: "sv",
    inputSchema: {},
  }),
  bridgeTool({
    name: "run_console_command",
    description: "Exécute une commande console serveur (game.ConsoleCommand — mise en file, ~0,25 s de latence).",
    realm: "sv",
    inputSchema: { command: z.string().min(1) },
  }),
  bridgeTool({
    name: "send_debug",
    description: "Imprime un message côté serveur (print) — utile pour marquer le log ou tracer.",
    realm: "sv",
    inputSchema: { message: z.string() },
  }),
  bridgeTool({
    name: "run_test",
    description:
      "Exécute un fichier de test GLua côté serveur (harnais describe/it) et renvoie {passed, failed, results}. path relatif à lua/, ex: 'monaddon/tests/x.lua'. Le fichier retourne une table { [nom] = function(t) end }.",
    realm: "sv",
    inputSchema: { path: z.string().min(1) },
  }),
  bridgeTool({
    name: "run_lua",
    description:
      "GARDÉ. Exécute du Lua arbitraire côté serveur (RunString) et renvoie la valeur retournée. Exige confirm:true. Journalisé.",
    realm: "sv",
    guarded: true,
    inputSchema: {
      code: z.string().min(1),
      confirm: z
        .boolean()
        .optional()
        .describe("Doit valoir true : action sensible, journalisée. Sinon l'appel est refusé."),
    },
  }),
];

/**
 * Outils d'introspection CLIENT (Phase 5). Nécessitent un vrai client GMod
 * connecté au serveur avec l'addon (moitié cl). Non prouvés dans l'atelier.
 */
export const clientBridgeTools: AnyToolDef[] = [
  bridgeTool({
    name: "read_panels",
    description: "Arbre des panels Derma/VGUI (classe, nom, visibilité, position, taille), borné par maxDepth.",
    realm: "cl",
    inputSchema: { maxDepth: z.number().int().min(0).max(32).default(6) },
  }),
  bridgeTool({
    name: "inspect_panel",
    description: "Détail du premier panel d'une classe donnée + nombre d'occurrences dans l'arbre VGUI.",
    realm: "cl",
    inputSchema: { class: z.string().min(1) },
  }),
  bridgeTool({
    name: "capture_screen",
    description: "Capture l'écran du client (JPEG base64) au prochain frame. Nécessite un client GMod actif.",
    realm: "cl",
    inputSchema: {},
  }),
  bridgeTool({
    name: "read_console",
    description: "Erreurs Lua CLIENT capturées (GMod n'expose pas le buffer console) depuis le chargement.",
    realm: "cl",
    inputSchema: {},
  }),
  bridgeTool({
    name: "read_client_convars",
    description: "Valeurs de convars côté client. Sans names, renvoie un sous-ensemble usuel.",
    realm: "cl",
    inputSchema: { names: z.array(z.string()).optional() },
  }),
];
