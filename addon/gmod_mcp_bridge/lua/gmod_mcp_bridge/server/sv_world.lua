-- Acting on the world, as opposed to reading it. Every handler here is reachable only
-- through a guarded tool: the daemon refuses the call without an explicit confirmation.
--
-- These exist so an agent can set up the situation it needs to observe -- put a prop
-- there, move a player onto it, give them a weapon -- instead of asking a human to do it
-- and then reading the result.
local H = GMODMCP.Handlers

-- Everything in this file changes the running game, so none of it may run unconfirmed --
-- including as a step inside a batch.
for _, name in ipairs({ "spawn_entity", "world_edit", "set_player_state", "force_hook" }) do
    GMODMCP.Guarded[name] = true
end

-- ------------------------------------------------------------------ resolving ---

-- A target is an entity index (number) or a player identified by SteamID, SteamID64 or
-- name (string). Names are last and exact: a partial match would silently act on the
-- wrong player, which is worse than failing.
local function resolve(target)
    if isnumber(target) then
        local ent = Entity(target)
        if not IsValid(ent) then error("invalid entity index: " .. target) end
        return ent
    end
    if isstring(target) then
        for _, ply in ipairs(player.GetAll()) do
            if ply:SteamID() == target or ply:SteamID64() == target or ply:Nick() == target then
                return ply
            end
        end
        error("no player matching: " .. target)
    end
    error("target must be an entity index (number) or a player SteamID/name (string)")
end

local function resolvePlayer(target)
    local ent = resolve(target)
    if not ent:IsPlayer() then error("target is not a player: " .. tostring(target)) end
    return ent
end

local function toVector(v, label)
    if not istable(v) then error((label or "pos") .. " must be [x, y, z]") end
    return Vector(tonumber(v[1]) or 0, tonumber(v[2]) or 0, tonumber(v[3]) or 0)
end

local function toAngle(v, label)
    if not istable(v) then error((label or "ang") .. " must be [pitch, yaw, roll]") end
    return Angle(tonumber(v[1]) or 0, tonumber(v[2]) or 0, tonumber(v[3]) or 0)
end

local function describe(ent)
    return {
        index = ent:EntIndex(),
        class = ent:GetClass(),
        pos = { ent:GetPos():Unpack() },
        health = ent:Health(),
        is_player = ent:IsPlayer(),
    }
end

-- --------------------------------------------------------------------- spawn ---

H.spawn_entity = function(args)
    if not isstring(args.class) then error("class (string) is required") end

    local ent = ents.Create(args.class)
    if not IsValid(ent) then
        -- ents.Create returns NULL for a class the server does not know. Saying so beats
        -- letting the next line fail on an indexing error.
        error("unknown or non-creatable entity class: " .. args.class)
    end

    ent:SetPos(toVector(args.pos))
    if args.ang then ent:SetAngles(toAngle(args.ang)) end
    if isstring(args.model) then ent:SetModel(args.model) end
    ent:Spawn()
    ent:Activate()

    if args.freeze then
        local phys = ent:GetPhysicsObject()
        if IsValid(phys) then phys:EnableMotion(false) end
    end

    return describe(ent)
end

-- ------------------------------------------------------------------ world_edit ---

-- One action per key. Each takes the resolved entity plus the raw args, so the shapes
-- stay honest instead of every field being optional in one flat schema.
local ACTIONS = {}

ACTIONS.remove = function(ent)
    if ent:IsPlayer() then error("refusing to remove a player") end
    local before = describe(ent)
    ent:Remove()
    return { removed = before }
end

ACTIONS.teleport = function(ent, args)
    local pos = toVector(args.pos)
    ent:SetPos(pos)
    -- A player keeps their velocity through SetPos and will slide or take fall damage
    -- from a teleport they did not jump into.
    if ent:IsPlayer() then ent:SetVelocity(-ent:GetVelocity()) end
    return describe(ent)
end

ACTIONS.set_ang = function(ent, args)
    local ang = toAngle(args.ang)
    if ent:IsPlayer() then ent:SetEyeAngles(ang) else ent:SetAngles(ang) end
    return describe(ent)
end

ACTIONS.freeze = function(ent)
    local phys = ent:GetPhysicsObject()
    if not IsValid(phys) then error("entity has no physics object to freeze") end
    phys:EnableMotion(false)
    return { frozen = true, index = ent:EntIndex() }
end

ACTIONS.unfreeze = function(ent)
    local phys = ent:GetPhysicsObject()
    if not IsValid(phys) then error("entity has no physics object to unfreeze") end
    phys:EnableMotion(true)
    phys:Wake()
    return { frozen = false, index = ent:EntIndex() }
end

ACTIONS.set_health = function(ent, args)
    local hp = tonumber(args.value)
    if not hp then error("value (number) is required for set_health") end
    ent:SetHealth(hp)
    return describe(ent)
end

ACTIONS.set_armor = function(ent, args)
    local armor = tonumber(args.value)
    if not armor then error("value (number) is required for set_armor") end
    local ply = ent
    if not ply:IsPlayer() then error("set_armor targets a player") end
    ply:SetArmor(armor)
    return { index = ply:EntIndex(), armor = ply:Armor() }
end

ACTIONS.give = function(ent, args)
    if not ent:IsPlayer() then error("give targets a player") end
    if not isstring(args.weapon) then error("weapon (string) is required for give") end
    local wep = ent:Give(args.weapon)
    if not IsValid(wep) then error("unknown weapon class: " .. args.weapon) end
    return { given = args.weapon, index = wep:EntIndex() }
end

ACTIONS.strip = function(ent)
    if not ent:IsPlayer() then error("strip targets a player") end
    ent:StripWeapons()
    return { stripped = true }
end

H.world_edit = function(args)
    if not isstring(args.action) then error("action (string) is required") end
    local fn = ACTIONS[args.action]
    if not fn then
        local names = {}
        for name in pairs(ACTIONS) do names[#names + 1] = name end
        table.sort(names)
        error("unknown action '" .. args.action .. "'; expected one of: " .. table.concat(names, ", "))
    end
    return fn(resolve(args.target), args)
end

-- -------------------------------------------------------------- player state ---

-- Money goes through the r-capitalism ledger when it is loaded.
--
-- That ledger holds an audited invariant: sum(balances) == issued - burned, checked at
-- boot. A raw addMoney from here would move a balance without an entry and put the drift
-- permanently off zero -- a debugging tool quietly corrupting the thing being debugged.
-- Amounts are integer cents throughout the server economy: 1.50$ is 150.
local function setMoney(ply, cents, out)
    if not isnumber(cents) then error("money_cents must be a number (integer cents: 1.50$ is 150)") end
    cents = math.Round(cents)

    if R and R.Capitalism and R.Capitalism.Issue then
        local delta = cents - (ply:getDarkRPVar("money") or 0)
        if delta == 0 then
            out.money = { unchanged = true, cents = cents }
            return
        end
        local ok, info
        if delta > 0 then
            ok, info = R.Capitalism.Issue(ply, delta, "gmod_mcp_bridge:set_player_state")
        else
            ok, info = R.Capitalism.Burn(ply, -delta, "gmod_mcp_bridge:set_player_state")
        end
        if not ok then error("ledger refused the change: " .. tostring(info)) end
        out.money = { via = "r-capitalism", delta_cents = delta, cents = cents }
        return
    end

    if not ply.addMoney then error("neither r-capitalism nor DarkRP is loaded: cannot set money") end
    ply:addMoney(cents - (ply:getDarkRPVar("money") or 0))
    out.money = { via = "darkrp", cents = cents, warning = "r-capitalism not loaded: this change is unledgered" }
end

local function setJob(ply, job, out)
    if not DarkRP or not RPExtraTeams then error("DarkRP is not loaded: cannot set a job") end

    local wanted
    if isnumber(job) then
        wanted = job
    else
        for index, tbl in ipairs(RPExtraTeams) do
            if tbl.command == job or tbl.name == job then wanted = index break end
        end
    end
    if not wanted or not RPExtraTeams[wanted] then error("unknown job: " .. tostring(job)) end

    ply:changeTeam(wanted, true)
    out.job = { team = ply:Team(), name = team.GetName(ply:Team()) }
end

H.set_player_state = function(args)
    local ply = resolvePlayer(args.target)
    local out = { steamid = ply:SteamID(), name = ply:Nick() }

    if args.money_cents ~= nil then setMoney(ply, args.money_cents, out) end
    if args.job ~= nil then setJob(ply, args.job, out) end

    if args.salary ~= nil then
        if not ply.setSelfDarkRPVar then error("DarkRP is not loaded: cannot set a salary") end
        ply:setSelfDarkRPVar("salary", math.Round(tonumber(args.salary) or 0))
        out.salary = ply:getDarkRPVar("salary")
    end

    if args.rpname ~= nil then
        if not ply.setRPName then error("DarkRP is not loaded: cannot set an RP name") end
        ply:setRPName(tostring(args.rpname))
        out.rpname = ply:getDarkRPVar("rpname")
    end

    return out
end

-- ---------------------------------------------------------------- force_hook ---

-- JSON cannot express an Entity, a Player or a Vector, so arguments carry a tag. Passing
-- the raw table through instead would hand the gamemode a table where it expects a
-- Player, and the failure would surface deep inside someone else's addon.
local function decodeArg(v)
    if not istable(v) then return v end
    if v.__ent ~= nil then
        local ent = Entity(tonumber(v.__ent) or -1)
        if not IsValid(ent) then error("__ent: invalid entity index " .. tostring(v.__ent)) end
        return ent
    end
    if v.__ply ~= nil then return resolvePlayer(tostring(v.__ply)) end
    if v.__vec ~= nil then return toVector(v.__vec, "__vec") end
    if v.__ang ~= nil then return toAngle(v.__ang, "__ang") end
    return v
end

H.force_hook = function(args)
    if not isstring(args.name) then error("name (string) is required") end

    local decoded = {}
    local given = istable(args.args) and args.args or {}
    for i = 1, #given do
        decoded[i] = decodeArg(given[i])
    end

    local packed = { pcall(hook.Run, args.name, unpack(decoded, 1, #given)) }
    local ok = table.remove(packed, 1)
    if not ok then error(packed[1]) end

    -- A hook returning nothing is the normal case, not a failure: most hooks are
    -- notifications and only the blocking ones answer.
    return { hook = args.name, argc = #given, returned = packed }
end
