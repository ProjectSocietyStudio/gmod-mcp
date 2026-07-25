-- gmod_mcp_runlua — extension OPTIONNELLE et DEV-ONLY du bridge.
--
-- Ajoute le handler `run_lua` : exécution de Lua arbitraire côté serveur, gardée
-- par confirmation. Isolé du bridge principal parce que l'exécution dynamique
-- (CompileString) est — à juste titre — proscrite par glua-audit pour tout addon
-- destiné à la vente. Ne JAMAIS monter en production.
--
-- Activation : symlink ce dossier dans addons/ puis ./tools/sync-server-config.sh,
-- ou copie-le dans garrysmod/addons/. Nécessite le bridge principal chargé.
if not SERVER then return end

if not GMODMCP or not GMODMCP.Handlers then
    ErrorNoHalt("[gmod-mcp] gmod_mcp_runlua chargé sans le bridge principal — ignoré\n")
    return
end

GMODMCP.Handlers.run_lua = function(args, cmd)
    -- Double garde : le daemon ne pose confirmed=true qu'après validation humaine.
    if not cmd.confirmed then error("run_lua refusé : confirmation requise") end
    if not isstring(args.code) then error("code (string) requis") end

    local fn = CompileString(args.code, "gmod_mcp/run_lua", false)
    if not isfunction(fn) then error("compilation: " .. tostring(fn)) end

    GMODMCP.Log("run_lua exécuté (" .. #args.code .. " octets)")
    local packed = { pcall(fn) }
    local ok = table.remove(packed, 1)
    if not ok then error(packed[1]) end
    return { returned = packed }
end

GMODMCP.Log("extension run_lua active (DEV-ONLY)")
