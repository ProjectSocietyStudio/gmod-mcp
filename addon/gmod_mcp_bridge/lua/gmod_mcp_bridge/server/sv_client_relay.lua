-- Server/client relay. realm=cl commands arrive from the daemon over the file
-- channel and are forwarded to the client as a net message; the client runs them and
-- sends the result back over net, chunked for large payloads such as screenshots. The
-- server reassembles the chunks and writes res/ for the daemon.
--
-- No HTTP: the client/server net channel is native to GMod.
util.AddNetworkString("gmod_mcp_cl_cmd")
util.AddNetworkString("gmod_mcp_cl_res")

-- Target: the player matching a given SteamID, otherwise the first HUMAN connected.
--
-- Bots are skipped, and the distinction is not cosmetic: a bot is a real Player entity with a
-- valid SteamID64, so it satisfies every check this function used to make -- but it has no client,
-- so it can never answer a realm=cl command. Picking one meant the daemon waited out its own
-- timeout and blamed srcds, which was fine. r-harness creates bots on purpose, so the first one
-- spawned would have silently become "the client" of the bridge.
--
-- An explicit args.player still wins, bot or not: asking for a specific player by SteamID is a
-- deliberate act, and failing it silently would be worse than letting it time out.
local function targetPlayer(args)
    if istable(args) and isstring(args.player) then
        for _, ply in ipairs(player.GetAll()) do
            if ply:SteamID() == args.player or ply:SteamID64() == args.player then return ply end
        end
    end
    for _, ply in ipairs(player.GetAll()) do
        if not ply:IsBot() then return ply end
    end
    return nil
end

-- Reassembly of chunked client results, and the commands still awaiting one.
--
-- Both are keyed by command id so a disconnect can resolve them. Without this, a client
-- that crashed or timed out mid-answer left the daemon waiting for a result that could
-- never arrive: the tool only failed once its own timeout expired, and the half-received
-- chunks stayed in memory forever. An agent iterating with a human in the game hits this
-- every time that human crashes, so the failure has to be immediate and named.
--
-- Both are also swept on a timer. Completion and PlayerDisconnected cover the cases where
-- something happens; they do NOT cover the daemon giving up on its side, which drops the
-- command and stops caring while this table keeps the entry forever. That was a slow leak
-- when every command was one tool call; batching multiplies client ids, so it needs a
-- sweep rather than a note.
local chunks = {}
local pending = {}
local rlReset, rlCount = 0, 0

-- UNDER the daemon's default 30s round-trip timeout, on purpose.
--
-- A client that never answers used to be reported by the daemon's own timeout, which knows
-- nothing about why: it said "is srcds running with the addon mounted?" while srcds was
-- fine and the client was frozen. Failing here first means the caller gets the real
-- sentence, and gets it in 20s rather than 30.
--
-- Preventive, not a fix for anything observed: the blockage of 2026-07-25 was two daemons
-- deleting each other's results, not an abandoned client request.
local CLIENT_TIMEOUT = 20

-- Past this, nobody is waiting on the daemon side either, so writing a result would only
-- leave an orphan file in res/. Kept above CLIENT_TIMEOUT so the explicit failure wins.
local STALE_AFTER = 45

local function resolveFailure(id, err)
    chunks[id] = nil
    pending[id] = nil
    GMODMCP.WriteResult(id, { id = id, ok = false, error = err })
end

-- Readable relay state, folded into read_runtime. The relay had no observable state at
-- all, so a stuck channel and a healthy idle one looked identical from the daemon.
function GMODMCP.RelayState()
    local now = RealTime()
    local waiting, oldest, tool = 0, 0, nil
    for _, rec in pairs(pending) do
        waiting = waiting + 1
        local age = now - rec.at
        if age > oldest then
            oldest = age
            tool = rec.tool
        end
    end
    local partial = 0
    for _ in pairs(chunks) do
        partial = partial + 1
    end
    return {
        waiting = waiting,
        oldest_seconds = math.Round(oldest, 1),
        oldest_tool = tool,
        partial_transfers = partial,
        client_timeout = CLIENT_TIMEOUT,
    }
end

function GMODMCP.RelayToClient(cmd)
    local ply = targetPlayer(cmd.args)
    if not IsValid(ply) then
        -- Distinct from a disconnect mid-command: nobody was there to begin with. The
        -- daemon retries on both, but the wording tells the operator which happened.
        GMODMCP.WriteResult(cmd.id, { id = cmd.id, ok = false, error = "no client connected (realm=cl tool)" })
        return
    end
    pending[cmd.id] = { ply = ply, at = RealTime(), tool = cmd.tool }
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
    for id, rec in pairs(pending) do
        if rec.ply == ply or not IsValid(rec.ply) then
            resolveFailure(id, "client disconnected before answering (realm=cl tool)")
        end
    end
end)

-- Two jobs, both about a client that stopped answering:
--
-- 1. Past CLIENT_TIMEOUT, fail the command EXPLICITLY. Silence here becomes the daemon's
--    generic 30s timeout, which cannot name the client and historically accused srcds.
--    Any half-received chunks go with it -- a partial reassembly is not a result, and
--    keeping it only means a later retry appears to complete a transfer it never made.
-- 2. Past STALE_AFTER, nobody is waiting any more: drop the entry without writing, since
--    the result file would be an orphan in res/.
--
-- Runs at 2s so CLIENT_TIMEOUT means roughly what it says.
timer.Create("gmod_mcp_bridge.relay_sweep", 2, 0, function()
    local now = RealTime()
    for id, rec in pairs(pending) do
        local age = now - rec.at
        if age > STALE_AFTER then
            chunks[id] = nil
            pending[id] = nil
        elseif age > CLIENT_TIMEOUT then
            local got = chunks[id]
            local progress = got and string.format(" (%d/%d chunks received, discarded)", got.got, got.total) or ""
            resolveFailure(id, string.format(
                "the client did not answer in %ds%s -- realm=cl tool '%s'. The game client is frozen, hung in a render hook, or its net channel is saturated; srcds itself is fine.",
                CLIENT_TIMEOUT, progress, tostring(rec.tool)))
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

    -- No pending command means we already failed this id (client timeout, disconnect) or
    -- never sent it. Accumulating its chunks would rebuild a result nobody can correlate,
    -- so an interrupted transfer is dropped rather than half-kept.
    if not pending[id] then
        chunks[id] = nil
        return
    end

    local rec = chunks[id]
    if not rec then
        rec = { parts = {}, total = total, got = 0 }
        chunks[id] = rec
    end
    -- A second answer for the same id declaring a different length cannot be reassembled
    -- with the first. Start over on the new one instead of concatenating two payloads.
    if rec.total ~= total then
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
