-- gmod_mcp_runlua -- OPTIONAL, DEVELOPMENT-ONLY extension to the bridge.
--
-- Adds the `run_lua` handler: arbitrary server-side Lua execution, gated behind an
-- explicit confirmation. It is kept out of the main bridge because dynamic execution
-- (CompileString) is -- rightly -- forbidden by glua-audit for any addon meant to be
-- sold. NEVER mount this on a production server.
--
-- To enable: symlink this folder into your server's addons/ directory,
-- or copy it into garrysmod/addons/. Requires the main bridge to be loaded.
if not SERVER then return end

if not GMODMCP or not GMODMCP.Handlers then
    ErrorNoHalt("[gmod-mcp] gmod_mcp_runlua loaded without the main bridge -- ignored\n")
    return
end

GMODMCP.Guarded = GMODMCP.Guarded or {}
GMODMCP.Guarded.run_lua = true

GMODMCP.Handlers.run_lua = function(args, cmd)
    -- Second gate: the daemon only sets confirmed=true after a human approves.
    if not cmd.confirmed then error("run_lua refused: confirmation required") end
    if not isstring(args.code) then error("code (string) is required") end

    local fn = CompileString(args.code, "gmod_mcp/run_lua", false)
    if not isfunction(fn) then error("compilation: " .. tostring(fn)) end

    GMODMCP.Log("run_lua executed (" .. #args.code .. " bytes)")
    local packed = { pcall(fn) }
    local ok = table.remove(packed, 1)
    if not ok then error(packed[1]) end
    return { returned = packed }
end

GMODMCP.Log("extension run_lua active (DEV-ONLY)")
