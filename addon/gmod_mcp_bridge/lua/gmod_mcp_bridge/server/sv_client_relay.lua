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

function GMODMCP.RelayToClient(cmd)
    local ply = targetPlayer(cmd.args)
    if not IsValid(ply) then
        GMODMCP.WriteResult(cmd.id, { id = cmd.id, ok = false, error = "no client connected (realm=cl tool)" })
        return
    end
    net.Start("gmod_mcp_cl_cmd")
    net.WriteString(cmd.id)
    net.WriteString(cmd.tool)
    net.WriteString(util.TableToJSON(cmd.args or {}))
    net.WriteBool(cmd.confirmed == true)
    net.Send(ply)
end

-- Reassembly of chunked client results.
local chunks = {}
local rlReset, rlCount = 0, 0

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
        GMODMCP.WriteResultRaw(id, table.concat(rec.parts))
    end
end)
