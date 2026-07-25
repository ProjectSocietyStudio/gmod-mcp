-- FILE transport inside GMod's DATA sandbox. The daemon and srcds
-- share a filesystem, so there is no network dependency. This was measured: GMod's
-- HTTP() does not reach a localhost daemon from a dedicated server.
--
-- Protocol: the daemon writes `gmod_mcp/cmd/<id>.json`; we read it, delete it (single
-- consumption), run the handler and write `gmod_mcp/res/<id>.json`. Events go out as
-- `gmod_mcp/evt/<n>.json`.
local BASE = "gmod_mcp/"
local CMD, RES, EVT = BASE .. "cmd/", BASE .. "res/", BASE .. "evt/"
local running = false
local seq = 0

local function ensureDirs()
    file.CreateDir(BASE)
    file.CreateDir(BASE .. "cmd")
    file.CreateDir(BASE .. "res")
    file.CreateDir(BASE .. "evt")
end

-- Writes a result for the daemon. Also used by the client relay.
function GMODMCP.WriteResult(id, tbl)
    file.Write(RES .. id .. ".json", util.TableToJSON(tbl))
end

-- Writes an already-serialised result (JSON reassembled from the client's net chunks).
function GMODMCP.WriteResultRaw(id, json)
    file.Write(RES .. id .. ".json", json)
end

-- Asynchronous event to the daemon (Lua errors, bridge_up, and so on).
function GMODMCP.SendEvent(etype, payload)
    seq = seq + 1
    local name = EVT .. os.time() .. "_" .. seq .. ".json"
    file.Write(name, util.TableToJSON({ type = etype, realm = "sv", ts = os.time(), payload = payload or {} }))
end

local function handle(cmd)
    local handler = GMODMCP.Handlers[cmd.tool]
    if not handler then
        return { id = cmd.id, ok = false, error = "handler inconnu: " .. tostring(cmd.tool) }
    end
    local ok, res = pcall(handler, cmd.args or {}, cmd)
    if ok then
        return { id = cmd.id, ok = true, data = res }
    end
    return { id = cmd.id, ok = false, error = tostring(res) }
end

local function poll()
    local files = file.Find(CMD .. "*.json", "DATA")
    if not files then return end
    for _, fn in ipairs(files) do
        local path = CMD .. fn
        local raw = file.Read(path, "DATA")
        file.Delete(path) -- consume exactly once, before running the handler
        local cmd = raw and util.JSONToTable(raw)
        if type(cmd) == "table" and cmd.id then
            if cmd.realm == "cl" and GMODMCP.RelayToClient then
                -- Client command: relayed over net; the result will arrive
                -- plus tard (net -> fichier res) via sv_client_relay.
                GMODMCP.RelayToClient(cmd)
            else
                file.Write(RES .. cmd.id .. ".json", util.TableToJSON(handle(cmd)))
            end
        end
    end
end

function GMODMCP.Start()
    if running then return end
    running = true
    ensureDirs()
    GMODMCP.Log("transport fichier actif -> data/" .. BASE)
    GMODMCP.SendEvent("bridge_up", { version = GMODMCP.Version, map = game.GetMap() })
    -- Fast poll: the file round-trip is local and near-instant.
    timer.Create("gmod_mcp_bridge_poll", 0.25, 0, poll)
end
