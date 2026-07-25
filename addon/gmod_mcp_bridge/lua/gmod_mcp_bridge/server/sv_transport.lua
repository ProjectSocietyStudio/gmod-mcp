-- Transport par FICHIERS dans le sandbox DATA de GMod. Le daemon et srcds
-- partagent le filesystem, donc aucune dépendance réseau — mesuré : le HTTP() de
-- GMod ne joint pas le daemon localhost depuis un serveur dédié.
--
-- Protocole : le daemon écrit `gmod_mcp/cmd/<id>.json` ; on le lit, on le supprime
-- (consommation unique), on exécute le handler, on écrit `gmod_mcp/res/<id>.json`.
-- Les événements partent en `gmod_mcp/evt/<n>.json`.
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

-- Écrit un résultat pour le daemon (utilisé aussi par le relais client).
function GMODMCP.WriteResult(id, tbl)
    file.Write(RES .. id .. ".json", util.TableToJSON(tbl))
end

-- Écrit un résultat déjà sérialisé (JSON réassemblé depuis les chunks net client).
function GMODMCP.WriteResultRaw(id, json)
    file.Write(RES .. id .. ".json", json)
end

-- Événement asynchrone vers le daemon (erreurs Lua, bridge_up, etc.).
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
        file.Delete(path) -- consommer une seule fois, avant exécution
        local cmd = raw and util.JSONToTable(raw)
        if type(cmd) == "table" and cmd.id then
            if cmd.realm == "cl" and GMODMCP.RelayToClient then
                -- Commande client : relayée au client par net ; le résultat arrivera
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
    -- Poll rapide : le round-trip fichier est local et quasi instantané.
    timer.Create("gmod_mcp_bridge_poll", 0.25, 0, poll)
end
