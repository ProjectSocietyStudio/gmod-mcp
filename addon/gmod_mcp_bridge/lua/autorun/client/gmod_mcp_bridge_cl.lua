-- gmod_mcp_bridge — moitié CLIENT. Transport par NET messages via le serveur
-- (relais) : le client reçoit les commandes realm=cl du serveur et renvoie le
-- résultat en net (chunké pour les gros payloads type screenshot). Aucun HTTP,
-- aucune config — le canal net client<->serveur est natif GMod.
--
-- Non prouvé dans l'atelier (aucun client GMod ici) ; signatures/realms conformes
-- au wiki, à valider sur un vrai client connecté au serveur.
if not CLIENT then return end

GMODMCP = GMODMCP or {}
GMODMCP.Handlers = GMODMCP.Handlers or {}
GMODMCP.Version = GMODMCP.Version or "0.2.0"
GMODMCP.ASYNC = GMODMCP.ASYNC or {} -- sentinelle : le handler enverra son résultat plus tard

local errorBuffer = {}

-- Renvoie un résultat au serveur, chunké ET ÉTALÉ DANS LE TEMPS.
--
-- Mesuré le 25/07/2026 : la version d'origine découpait en chunks de 60 000 octets et
-- les poussait tous dans la MÊME frame. Un screenshot 1920x1080 en base64 pèse plusieurs
-- centaines de Ko — le canal fiable client->serveur saturait avec
-- « send reliable stream overflow » (x899 dans la console du joueur).
--
-- Le piège est que la panne est PERSISTANTE et SILENCIEUSE côté outil : une fois le
-- canal saturé, plus AUCUN message net du client ne passe. Tous les outils realm=cl
-- tombaient donc en timeout après une seule tentative de capture, y compris ceux dont le
-- payload tient en un chunk (read_client_convars). Le symptôme désigne le mauvais
-- coupable : on croit que le relais client est cassé alors qu'il a juste été noyé.
--
-- Deux corrections, les deux nécessaires : des chunks bien plus petits que la limite de
-- 64 KiB du message net (la limite du message n'est pas celle du tampon fiable), et un
-- chunk par frame pour laisser le flux se vider.
local CHUNK = 7000

local function sendResult(id, ok, data, err)
    local payload = util.TableToJSON({ id = id, ok = ok, data = data, error = err })
    local total = math.max(1, math.ceil(#payload / CHUNK))

    local i = 0
    local timerName = "gmod_mcp_send_" .. id
    timer.Create(timerName, 0, total, function()
        i = i + 1
        net.Start("gmod_mcp_cl_res")
        net.WriteString(id)
        net.WriteUInt(i, 16)
        net.WriteUInt(total, 16)
        net.WriteString(string.sub(payload, (i - 1) * CHUNK + 1, i * CHUNK))
        net.SendToServer()
    end)
end

-- ----------------------------------------------------------------- handlers ---
local H = GMODMCP.Handlers

local function panelInfo(panel)
    local x, y = panel:GetPos()
    local w, h = panel:GetSize()
    return { class = panel:GetClassName(), name = panel:GetName(), visible = panel:IsVisible(), x = x, y = y, w = w, h = h }
end

local function walk(panel, depth, maxDepth, out)
    if not IsValid(panel) or depth > maxDepth then return end
    local info = panelInfo(panel)
    info.depth = depth
    out[#out + 1] = info
    for _, child in ipairs(panel:GetChildren()) do
        walk(child, depth + 1, maxDepth, out)
    end
end

H.read_panels = function(args)
    local maxDepth = isnumber(args.maxDepth) and args.maxDepth or 6
    local out = {}
    walk(vgui.GetWorldPanel(), 0, maxDepth, out)
    return { count = #out, panels = out }
end

H.inspect_panel = function(args)
    if not isstring(args.class) then error("class (string) requis") end
    local flat = {}
    walk(vgui.GetWorldPanel(), 0, 32, flat)
    local found, matches = nil, 0
    for _, info in ipairs(flat) do
        if info.class == args.class then
            matches = matches + 1
            if not found then found = info end
        end
    end
    if not found then error("aucun panel de classe " .. args.class) end
    return { match = found, total_matches = matches }
end

H.read_client_convars = function(args)
    local names = istable(args.names) and args.names or { "cl_drawhud", "mat_queue_mode", "cl_showfps" }
    local out = {}
    for _, name in ipairs(names) do
        local cv = GetConVar(name)
        out[name] = cv and cv:GetString() or nil
    end
    return out
end

H.read_console = function()
    return { count = #errorBuffer, errors = errorBuffer }
end

H.capture_screen = function(_, cmd)
    local w, h = ScrW(), ScrH()
    local hookName = "gmod_mcp_capture_" .. cmd.id
    -- render.Capture hors d'un hook de rendu renvoie une image noire : on capture
    -- au prochain PostRender puis on se désabonne.
    hook.Add("PostRender", hookName, function()
        hook.Remove("PostRender", hookName)
        -- quality explicite : le défaut produit un JPEG bien plus lourd, et chaque Ko se
        -- paie en chunks sur le canal fiable (cf. sendResult). 70 reste largement lisible
        -- pour vérifier une mise en page Derma.
        local ok, data = pcall(render.Capture, { format = "jpeg", quality = 70, x = 0, y = 0, w = w, h = h })
        if ok and isstring(data) then
            sendResult(cmd.id, true, { format = "jpeg", w = w, h = h, base64 = util.Base64Encode(data) })
        else
            sendResult(cmd.id, false, nil, "render.Capture a échoué: " .. tostring(data))
        end
    end)
    return GMODMCP.ASYNC
end

-- --------------------------------------------------------- réception commandes ---
net.Receive("gmod_mcp_cl_cmd", function()
    local id = net.ReadString()
    local tool = net.ReadString()
    local args = util.JSONToTable(net.ReadString()) or {}
    local confirmed = net.ReadBool()
    local cmd = { id = id, tool = tool, args = args, confirmed = confirmed }

    local handler = GMODMCP.Handlers[tool]
    if not handler then
        sendResult(id, false, nil, "handler client inconnu: " .. tostring(tool))
        return
    end
    local ok, res = pcall(handler, args, cmd)
    if not ok then
        sendResult(id, false, nil, tostring(res))
        return
    end
    if res ~= GMODMCP.ASYNC then
        sendResult(id, true, res)
    end
end)

-- Erreurs Lua client, exposées via read_console (pas de push, modèle pull).
hook.Add("OnLuaError", "gmod_mcp_bridge_cl.errors", function(err, realm, stack, name)
    errorBuffer[#errorBuffer + 1] = { error = err, realm = realm or "client", name = name, stack = stack }
    if #errorBuffer > 100 then table.remove(errorBuffer, 1) end
end)
