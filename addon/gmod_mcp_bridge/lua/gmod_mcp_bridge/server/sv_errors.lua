-- Captures server Lua errors and forwards them to the daemon as events. This is a
-- second net alongside the daemon's log parsing: OnLuaError can miss errors, since the
-- engine throttles it past 5 errors per second.
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
