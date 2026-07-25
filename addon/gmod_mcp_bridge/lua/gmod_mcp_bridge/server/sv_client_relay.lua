-- Server/client relay. realm=cl commands arrive from the daemon over the file
-- channel and are forwarded to the client as a net message; the client runs them and
-- sends the result back over net, chunked for large payloads such as screenshots. The
-- server reassembles the chunks and writes res/ for the daemon.
--
-- No HTTP: the client/server net channel is native to GMod.
util.AddNetworkString("gmod_mcp_cl_cmd")
util.AddNetworkString("gmod_mcp_cl_res")

-- Target: the player matching a given SteamID, otherwise the first one connected.
local function targetPlayer(args)
    if istable(args) and isstring(args.player) then
        for _, ply in ipairs(player.GetAll()) do
            if ply:SteamID() == args.player or ply:SteamID64() == args.player then return ply end
        end
    end
    return player.GetAll()[1]
end

-- Reassembly of chunked client results, and the commands still awaiting one.
--
-- Both are keyed by command id so a disconnect can resolve them. Without this, a client
-- that crashed or timed out mid-answer left the daemon waiting for a result that could
-- never arrive: the tool only failed once its own timeout expired, and the half-received
-- chunks stayed in memory forever. An agent iterating with a human in the game hits this
-- every time that human crashes, so the failure has to be immediate and named.
local chunks = {}
local pending = {}
local rlReset, rlCount = 0, 0

local function resolveFailure(id, err)
    chunks[id] = nil
    pending[id] = nil
    GMODMCP.WriteResult(id, { id = id, ok = false, error = err })
end

function GMODMCP.RelayToClient(cmd)
    local ply = targetPlayer(cmd.args)
    if not IsValid(ply) then
        -- Distinct from a disconnect mid-command: nobody was there to begin with. The
        -- daemon retries on both, but the wording tells the operator which happened.
        GMODMCP.WriteResult(cmd.id, { id = cmd.id, ok = false, error = "no client connected (realm=cl tool)" })
        return
    end
    pending[cmd.id] = ply
    net.Start("gmod_mcp_cl_cmd")
    net.WriteString(cmd.id)
    net.WriteString(cmd.tool)
    net.WriteString(util.TableToJSON(cmd.args or {}))
    net.WriteBool(cmd.confirmed == true)
    net.Send(ply)
end

-- A client that leaves can no longer answer. Fail its in-flight commands now rather than
-- making the daemon wait out a timeout, and drop the partial chunks it will never finish.
hook.Add("PlayerDisconnected", "gmod_mcp_bridge.relay_cleanup", function(ply)
    for id, target in pairs(pending) do
        if target == ply or not IsValid(target) then
            resolveFailure(id, "client disconnected before answering (realm=cl tool)")
        end
    end
end)

net.Receive("gmod_mcp_cl_res", function(_, ply)
    if not IsValid(ply) then return end
    -- Generous rate limit, sized to let legitimate chunking through.
    local now = CurTime()
    if now ~= rlReset then rlReset = now; rlCount = 0 end
    rlCount = rlCount + 1
    if rlCount > 2000 then return end

    local id = net.ReadString()
    local seq = net.ReadUInt(16)
    local total = net.ReadUInt(16)
    local part = net.ReadString()
    if not isnumber(seq) or not isnumber(total) then return end
    if total < 1 or total > 4096 or seq < 1 or seq > total then return end

    local rec = chunks[id]
    if not rec then
        rec = { parts = {}, total = total, got = 0 }
        chunks[id] = rec
    end
    if not rec.parts[seq] then
        rec.parts[seq] = part
        rec.got = rec.got + 1
    end
    if rec.got >= rec.total then
        chunks[id] = nil
        pending[id] = nil
        GMODMCP.WriteResultRaw(id, table.concat(rec.parts))
    end
end)
