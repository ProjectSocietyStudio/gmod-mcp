-- Handlers d'introspection, indexés par nom d'outil. Chaque handler reçoit
-- (args, cmd) et renvoie une table sérialisable. Une erreur (via error()) est
-- capturée par le dispatch et renvoyée comme résultat en échec.
--
-- run_lua (exécution Lua arbitraire) n'est PAS ici : il vit dans l'addon optionnel
-- gmod_mcp_runlua, isolé car l'exécution dynamique est proscrite par glua-audit.
local H = GMODMCP.Handlers

H.read_runtime = function()
    return {
        map = game.GetMap(),
        gamemode = engine.ActiveGamemode(),
        curtime = CurTime(),
        tickinterval = engine.TickInterval(),
        players = player.GetCount(),
        maxplayers = game.MaxPlayers(),
        entities = #ents.GetAll(),
        bridge_version = GMODMCP.Version,
    }
end

H.read_players = function()
    local out = {}
    for _, ply in ipairs(player.GetAll()) do
        out[#out + 1] = {
            name = ply:Nick(),
            steamid = ply:SteamID(),
            steamid64 = ply:SteamID64(),
            team = ply:Team(),
            teamname = team.GetName(ply:Team()),
            ping = ply:Ping(),
            health = ply:Health(),
            armor = ply:Armor(),
            alive = ply:Alive(),
            pos = { ply:GetPos():Unpack() },
        }
    end
    return { count = #out, players = out }
end

H.read_entities = function(args)
    local filter = isstring(args.class) and args.class or nil
    local limit = isnumber(args.limit) and args.limit or 200
    local out = {}
    for _, ent in ipairs(ents.GetAll()) do
        if not IsValid(ent) then continue end
        if filter and ent:GetClass() ~= filter then continue end
        out[#out + 1] = {
            index = ent:EntIndex(),
            class = ent:GetClass(),
            model = ent:GetModel(),
            pos = { ent:GetPos():Unpack() },
        }
        if #out >= limit then break end
    end
    return { count = #out, entities = out }
end

H.inspect_entity = function(args)
    local ent = Entity(args.index or -1)
    if not IsValid(ent) then error("entité invalide: " .. tostring(args.index)) end
    local owner = ent:GetOwner()
    return {
        index = ent:EntIndex(),
        class = ent:GetClass(),
        model = ent:GetModel(),
        health = ent:Health(),
        maxhealth = ent:GetMaxHealth(),
        pos = { ent:GetPos():Unpack() },
        owner = IsValid(owner) and owner:GetClass() or nil,
        is_player = ent:IsPlayer(),
        is_weapon = ent:IsWeapon(),
    }
end

H.read_hooks = function(args)
    local wanted = isstring(args.event) and args.event or nil
    local out = {}
    for event, hooks in pairs(hook.GetTable()) do
        if wanted and event ~= wanted then continue end
        local ids = {}
        for id in pairs(hooks) do
            ids[#ids + 1] = isstring(id) and id or tostring(id)
        end
        out[event] = ids
    end
    return out
end

H.read_convars = function(args)
    local names = istable(args.names) and args.names or {
        "sv_gravity", "sv_turbophysics", "sv_hibernate_think", "sv_cheats",
        "sv_allowcslua", "sbox_maxprops", "hostname", "gamemode",
    }
    local out = {}
    for _, name in ipairs(names) do
        local cv = GetConVar(name)
        out[name] = cv and cv:GetString() or nil
    end
    return out
end

H.read_net_messages = function()
    -- GMod n'expose pas de compteur ; on balaie le pool des chaînes réseau et on
    -- s'arrête après une série de trous.
    local out, misses = {}, 0
    for id = 1, 8192 do
        local name = util.NetworkIDToString(id)
        if isstring(name) and name ~= "" then
            out[#out + 1] = name
            misses = 0
        else
            misses = misses + 1
            if misses >= 128 then break end
        end
    end
    return { count = #out, strings = out }
end

H.read_timers = function(args)
    -- GMod n'énumère pas les timers ; fournir names[] pour les inspecter.
    if not istable(args.names) then
        return { note = "GMod n'énumère pas les timers — passez names[] pour interroger des timers précis." }
    end
    local out = {}
    for _, name in ipairs(args.names) do
        local exists = timer.Exists(name)
        out[name] = {
            exists = exists,
            timeleft = exists and timer.TimeLeft(name) or nil,
            reps = exists and timer.RepsLeft(name) or nil,
        }
    end
    return out
end

H.run_console_command = function(args)
    if not isstring(args.command) then error("command (string) requis") end
    game.ConsoleCommand(args.command .. "\n")
    return { queued = true, note = "game.ConsoleCommand est mis en file (~0,25 s avant relecture)" }
end

H.send_debug = function(args)
    GMODMCP.Log(tostring(args.message or ""))
    return { printed = true }
end
