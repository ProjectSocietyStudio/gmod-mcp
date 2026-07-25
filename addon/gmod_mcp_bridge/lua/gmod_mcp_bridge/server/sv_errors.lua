-- Capture des erreurs Lua serveur et remontée au daemon en événement. Double
-- filet avec le parse de log côté daemon : OnLuaError peut manquer des erreurs
-- (protection anti-spam au-delà de 5 erreurs/seconde, cf. wiki).
hook.Add("OnLuaError", "gmod_mcp_bridge.errors", function(err, realm, stack, name, id)
    if not GMODMCP.SendEvent then return end
    GMODMCP.SendEvent("lua_error", {
        error = err,
        realm = realm or "server",
        stack = stack,
        name = name,
        workshopid = id,
    })
end)
