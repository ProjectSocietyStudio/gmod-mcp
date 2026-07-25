-- Example test file for the run_test engine. Executed server-side through include()
-- by the run_test handler. Pass the path "gmod_mcp_bridge/tests/self_test.lua".
--
-- A test file RETURNS a table { ["case name"] = function(t) ... end }.
-- It never runs by itself: it lives outside autorun/ and is only loaded on demand.
return {
    ["basic arithmetic"] = function(t)
        t.eq(1 + 1, 2)
        t.neq(1, 2)
    end,

    ["read_runtime renvoie la map"] = function(t)
        local rt = GMODMCP.Handlers.read_runtime()
        t.truthy(istable(rt))
        t.truthy(isstring(rt.map))
    end,

    ["read_players returns a numeric count"] = function(t)
        local rp = GMODMCP.Handlers.read_players()
        t.truthy(isnumber(rp.count))
    end,
}
