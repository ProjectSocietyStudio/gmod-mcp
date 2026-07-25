# gmod_mcp_runlua (optionnel, DEV-ONLY)

Ajoute le handler `run_lua` au bridge : exécution de Lua arbitraire côté serveur,
gardée par confirmation (`confirm: true` côté MCP, `confirmed` propagé côté bridge).

**Pourquoi séparé du bridge principal** — `run_lua` utilise `CompileString`, une
exécution dynamique que `glua-audit` proscrit (à raison) pour tout addon vendable. Le
bridge principal `gmod_mcp_bridge` reste donc 100 % lint-clean ; cette extension, elle,
échoue volontairement `glua-audit` (`exec-dynamique`). C'est attendu.

**Ne jamais monter en production.** C'est un outil d'itération local.

## Activer

```bash
ln -s "$PWD/gmod-mcp/optional/gmod_mcp_runlua" ~/Workspace/gmod/addons/gmod_mcp_runlua
cd ~/Workspace/gmod && ./tools/sync-server-config.sh
# redémarrer le serveur
```

Nécessite le bridge principal (`addons/gmod_mcp_bridge`) chargé.
