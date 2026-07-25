-- gmod_mcp_bridge -- the server-side bridge between a GMod server and the gmod-mcp
-- daemon.
--
-- Commands arrive over a file channel inside GMod's DATA sandbox: the daemon and srcds
-- share a filesystem, so no network is involved. Client-realm commands are relayed on
-- from here over net messages (see sv_client_relay.lua).
--
-- This is a DEVELOPMENT TOOL. Never mount it on a production server.
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

-- Start after InitPostEntity, once server.cfg has been applied. Addon autoruns run
-- BEFORE server.cfg, so anything reading a cvar at load time gets the engine default
-- rather than the owner's setting -- a trap measured the hard way.
hook.Add("InitPostEntity", "gmod_mcp_bridge.start", function()
    GMODMCP.Start()
end)
