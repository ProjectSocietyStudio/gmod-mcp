-- gmod_mcp_bridge -- CLIENT half. Transport is net messages relayed by the server:
-- the client receives realm=cl commands and sends results back over net, chunked for
-- large payloads such as screenshots. No HTTP, no configuration -- the client/server
-- net channel is native to GMod.
if not CLIENT then return end

GMODMCP = GMODMCP or {}
GMODMCP.Handlers = GMODMCP.Handlers or {}
GMODMCP.Version = GMODMCP.Version or "0.2.0"
GMODMCP.ASYNC = GMODMCP.ASYNC or {} -- sentinel: the handler will send its result later

local errorBuffer = {}

-- Sends a result back to the server, chunked AND SPREAD OVER TIME.
--
-- Measured 2026-07-25: the original version split payloads into 60000-byte chunks and
-- pushed them all in the SAME frame. A 1920x1080 screenshot is several hundred KB of
-- base64, which overflowed the client-to-server reliable channel ("send reliable stream
-- overflow", x899 in the player's console) and eventually timed the client out.
--
-- The trap is that the failure is PERSISTENT and SILENT from the tool's side: once the
-- channel is swamped, NO net message from that client gets through. Every realm=cl tool
-- therefore timed out after a single capture attempt, including ones whose payload fits
-- in one chunk (read_client_convars). The symptom accuses the wrong culprit -- the relay
-- looks broken when it has merely been flooded.
--
-- Two fixes, both required: chunks well below the net message's 64 KiB ceiling (that
-- ceiling is not the reliable buffer's), and one chunk per frame so the stream drains.
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
    if not isstring(args.class) then error("class (string) is required") end
    local flat = {}
    walk(vgui.GetWorldPanel(), 0, 32, flat)
    local found, matches = nil, 0
    for _, info in ipairs(flat) do
        if info.class == args.class then
            matches = matches + 1
            if not found then found = info end
        end
    end
    if not found then error("no panel of class " .. args.class) end
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
    -- render.Capture outside a render hook returns a black image, so capture on the next
    -- PostRender and unsubscribe immediately.
    hook.Add("PostRender", hookName, function()
        hook.Remove("PostRender", hookName)
        -- Explicit quality: the default produces a much heavier JPEG, and every KB is
        -- paid for in chunks on the reliable channel (see sendResult). 70 is still
        -- perfectly legible for checking a Derma layout.
        local ok, data = pcall(render.Capture, { format = "jpeg", quality = 70, x = 0, y = 0, w = w, h = h })
        if ok and isstring(data) then
            sendResult(cmd.id, true, { format = "jpeg", w = w, h = h, base64 = util.Base64Encode(data) })
        else
            sendResult(cmd.id, false, nil, "render.Capture failed: " .. tostring(data))
        end
    end)
    return GMODMCP.ASYNC
end

-- ------------------------------------------------------------ command intake ---
net.Receive("gmod_mcp_cl_cmd", function()
    local id = net.ReadString()
    local tool = net.ReadString()
    local args = util.JSONToTable(net.ReadString()) or {}
    local confirmed = net.ReadBool()
    local cmd = { id = id, tool = tool, args = args, confirmed = confirmed }

    local handler = GMODMCP.Handlers[tool]
    if not handler then
        sendResult(id, false, nil, "unknown client handler: " .. tostring(tool))
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

-- Client Lua errors, exposed through read_console. Pull model, never pushed.
hook.Add("OnLuaError", "gmod_mcp_bridge_cl.errors", function(err, realm, stack, name)
    errorBuffer[#errorBuffer + 1] = { error = err, realm = realm or "client", name = name, stack = stack }
    if #errorBuffer > 100 then table.remove(errorBuffer, 1) end
end)
