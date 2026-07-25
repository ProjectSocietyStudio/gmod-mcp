-- gmod_mcp_bridge — pont serveur entre le serveur GMod et le daemon gmod-mcp.
--
-- Realm : SERVEUR uniquement (Phase 2). Aucun net message, aucune surface client :
-- les commandes arrivent du daemon local via long-poll HTTP authentifié par token
-- sur 127.0.0.1. C'est un OUTIL DE DÉVELOPPEMENT — à ne jamais monter en production.
if not SERVER then return end

GMODMCP = GMODMCP or {}
GMODMCP.Handlers = GMODMCP.Handlers or {}
GMODMCP.Version = "0.2.0"

function GMODMCP.Log(msg)
    print("[gmod-mcp] " .. tostring(msg))
end

local base = "gmod_mcp_bridge/server/"
include(base .. "sv_transport.lua")
include(base .. "sv_handlers.lua")
include(base .. "sv_test.lua")
include(base .. "sv_client_relay.lua")
include(base .. "sv_errors.lua")

-- Démarrer après InitPostEntity : les cvars de server.cfg sont alors appliquées
-- (les autoruns s'exécutent AVANT server.cfg — piège mesuré du projet).
hook.Add("InitPostEntity", "gmod_mcp_bridge.start", function()
    GMODMCP.Start()
end)
