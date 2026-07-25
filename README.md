# gmod-mcp

Serveur **MCP local-first** pour le développement assisté par IA d'addons Garry's Mod.
Se branche dans Claude Code comme `claude-in-chrome` : les agents découvrent les outils
MCP et itèrent seuls — lint → boot → observation runtime → patch → validation. **Pas d'app
web, pas d'UI.**

Deux paquets :
- **`gmod-mcp`** (ce dossier) — serveur MCP en TypeScript/Node, transport **stdio**.
- **`gmod_mcp_bridge`** (`addons/gmod_mcp_bridge`) — addon GLua qui expose l'état
  serveur via un **transport fichier** dans le sandbox DATA de GMod (le daemon et srcds
  partagent le filesystem — aucun réseau). Mesuré : le `HTTP()` de GMod ne joint pas le
  daemon localhost depuis un serveur dédié, d'où le choix fichier (prouvé live sur DarkRP).

## Ce que ça permet

Parler à l'IA de l'addon en langage naturel, pendant qu'elle voit l'état réel du jeu :
_« pourquoi ce net message ne part jamais ? »_, _« corrige cette erreur »_, _« teste ce
menu »_. L'agent lint, boote le serveur, lit les erreurs Lua structurées, patche, recharge,
revalide — en boucle.

## Installation

```bash
cd gmod-mcp
pnpm install && pnpm build

# Enregistre le serveur dans Claude Code (scope projet, versionnable) :
node dist/index.js install
#   -> écrit <repoRoot>/.mcp.json

# Monte l'addon bridge dans le serveur dédié :
cd .. && ./tools/sync-server-config.sh
```

Alternative CLI : `claude mcp add gmod-mcp -e GMOD_MCP_REPO=<repoRoot> -- node <abs>/dist/index.js`.

Le daemon détecte la racine du repo (marqueurs `tools/lint.sh`, `CLAUDE.md`) en remontant
depuis le cwd, ou via `GMOD_MCP_REPO`, ou via `.gmod-mcp/config.json`.

## Transport (serveur)

Le daemon écrit `srcds/garrysmod/data/gmod_mcp/cmd/<id>.json` (atomique) ; l'addon le lit,
l'exécute, écrit `res/<id>.json`, supprime le cmd. Les événements (erreurs Lua, bridge_up)
arrivent en `evt/<n>.json`. Le daemon scanne `res/`+`evt/` par intervalle. Pas de token, pas
de port, pas de contrat. **Prouvé live** (DarkRP/rp_nycity_day/tick 33) : `read_runtime`,
`read_players`, `read_convars`, `read_hooks`, `read_entities`, `run_console_command`, `run_test`
(3/3).

Le realm **client** (cl) passe par un **relais serveur** : le daemon écrit une commande cl (même
canal fichier) ; l'addon serveur la route au client par net message ; le client exécute et renvoie
en net **chunké** (≤60 KB/msg, réassemblé côté serveur → `res/`). Zéro HTTP, marche quelle que soit
la machine du client tant qu'il est **connecté au serveur**. Routage daemon→serveur prouvé live ; le
maillon client (net→client→net) exige un vrai client GMod connecté — à valider par l'utilisateur.
Cible : premier joueur, ou `args.player` (SteamID). `capture_screen` = JPEG base64 chunké.

## Boucle d'itération

`edit → lint → (boot) → observe → patch → reload → validate → répéter`. Le daemon réutilise
`tools/lint.sh` / `start-server.sh` / `server-log.sh` (parse `fichier:ligne:` + codes de
sortie) et encode les pièges du projet : frontière de boot du `console.log`, `InitPostEntity`,
latence `game.ConsoleCommand`, lecture NUL-safe.

## Catalogue d'outils (31)

**Local (daemon)** — vérifiés dans l'atelier
: `health`, `lint`, `start_server`, `stop_server`, `sync_config`, `read_logs`, `package`,
`patch_file`, `restore_patch`, `reload_file`, `reload_addon`, `validate`, `run_iteration`.

**Serveur (via bridge)** — vérifiés (le serveur tourne dans l'atelier)
: `read_runtime`, `read_players`, `read_entities`, `inspect_entity`, `read_hooks`,
`read_convars`, `read_net_messages`, `read_timers`, `run_console_command`, `send_debug`,
`run_test`, `run_lua` (gardé, extension optionnelle).

**Client (via bridge)** — **non prouvés dans l'atelier** (aucun client GMod ici)
: `read_panels`, `inspect_panel`, `capture_screen`, `read_console`, `read_client_convars`.

## Sécurité

- Outils gardés (`run_lua`) : exigent `confirm: true` ou une présence dans `toolAllowlist` ;
  sinon refusés sans exécution. Chaque appel, résultat, patch et Lua exécuté est journalisé
  dans `<repoRoot>/.gmod-mcp/logs/audit.jsonl`.
- `patch_file` est verrouillé à la racine du repo (refus hors périmètre).
- Aucun port réseau : le transport serveur est par fichiers dans DATA (local au disque), la
  couche MCP est en stdio. La frontière de confiance est le filesystem local.
- `run_lua` (exécution Lua arbitraire) vit dans l'extension **optionnelle**
  `optional/gmod_mcp_runlua`, isolée car `glua-audit` proscrit l'exécution dynamique. Le
  bridge principal reste 100 % lint-clean. **Dev-only, jamais en production.**

## Config projet — `<repoRoot>/.gmod-mcp/config.json`

Toutes les clés sont optionnelles (voir `config.example.json`) :

```json
{
  "repoRoot": ".",
  "bridgePort": 27700,
  "bridgeToken": "",
  "addons": ["gmod_mcp_bridge"],
  "toolAllowlist": [],
  "plugins": []
}
```

`bridgeToken` vide ⇒ généré à chaque démarrage. Pour un token stable (client GMod qui doit
le retrouver entre redémarrages), fixe-le ici.

## Plugins

Extensibilité par modules ESM déclarés dans `plugins`. Chaque module exporte `tools` :

```js
// mon_plugin.mjs
export const tools = [
  { name: "mon_outil", description: "…", realm: "local", inputSchema: {}, handler: () => ({ ok: true }) },
];
```

Un plugin défaillant est signalé sur stderr sans bloquer le démarrage.

## Le bridge client (Phase 5) — à tester sur ton client

Le client ne peut pas lire le contrat du daemon (il est dans le `data/` du serveur) : le
**token transite serveur→client par net message**, l'**URL** vient de la convar client
`gmod_mcp_url` (défaut `http://127.0.0.1:27700`). Hypothèse : daemon, serveur et client
**co-localisés** (localhost). Ce code respecte les signatures/realms du wiki mais n'a jamais
tourné ici — à valider sur un vrai client GMod.

## Développement

```bash
pnpm test        # vitest (30 tests : schémas, parsers, bridge, patch)
pnpm typecheck
pnpm build
./tools/lint.sh addons/gmod_mcp_bridge   # 4 passes, doit être vert
```
