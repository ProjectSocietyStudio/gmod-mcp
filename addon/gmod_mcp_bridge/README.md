# gmod_mcp_bridge

Pont **serveur** entre le serveur GMod et le daemon `gmod-mcp`. Expose l'état runtime
(joueurs, entités, hooks, convars, messages net, timers) et permet des actions
(commande console, debug) à l'agent IA, via long-poll HTTP local authentifié par token.

**Outil de développement — à ne jamais monter en production.** Realm serveur uniquement
(Phase 2) : aucun net message, aucune surface client. Les commandes viennent du daemon
local sur `127.0.0.1`, pas des joueurs.

## Fonctionnement

1. Le daemon `gmod-mcp` démarre et écrit `garrysmod/data/gmod_mcp/bridge.json` (url + token).
2. À `InitPostEntity`, l'addon lit ce contrat et lance un long-poll `HTTP()` vers le daemon
   (`GET /poll?realm=sv`).
3. Chaque commande reçue est dispatchée vers un handler nommé (`lua/gmod_mcp_bridge/server/
   sv_handlers.lua`) ; le résultat repart en `POST /result`.
4. Les erreurs Lua serveur (`OnLuaError`) remontent en `POST /event`.

## Installation

Monté par symlink comme les autres addons :

```bash
cd ~/Workspace/gmod && ./tools/sync-server-config.sh
```

## Vérifier

```bash
./tools/lint.sh addons/gmod_mcp_bridge   # doit être vert (4 passes)
```

## run_lua

L'exécution de Lua arbitraire n'est **pas** incluse ici (elle échouerait `glua-audit`).
Voir l'extension optionnelle `gmod-mcp/optional/gmod_mcp_runlua`.
