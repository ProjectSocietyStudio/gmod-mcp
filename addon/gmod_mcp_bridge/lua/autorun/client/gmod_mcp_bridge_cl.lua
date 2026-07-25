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

-- One chunk per frame is the safe default. The real budget is the reliable buffer, not
-- the chunk size, and a small payload has headroom to go faster -- but the failure mode
-- here is the persistent, silent, misattributing one already burned into the README, so
-- raising it is a live experiment rather than a redeploy.
local perFrame = CreateClientConVar("gmod_mcp_chunks_per_frame", "1", true, false,
    "Chunks per frame when answering the bridge. Raise cautiously: overflowing the reliable channel silently kills every client tool.", 1, 8)

local function sendResult(id, ok, data, err)
    local payload = util.TableToJSON({ id = id, ok = ok, data = data, error = err })
    local total = math.max(1, math.ceil(#payload / CHUNK))
    local rate = math.Clamp(perFrame:GetInt(), 1, 8)

    local i = 0
    local timerName = "gmod_mcp_send_" .. id
    timer.Create(timerName, 0, math.ceil(total / rate), function()
        for _ = 1, rate do
            if i >= total then return end
            i = i + 1
            net.Start("gmod_mcp_cl_res")
            net.WriteString(id)
            net.WriteUInt(i, 16)
            net.WriteUInt(total, 16)
            net.WriteString(string.sub(payload, (i - 1) * CHUNK + 1, i * CHUNK))
            net.SendToServer()
        end
    end)
end

-- ----------------------------------------------------------------- handlers ---
local H = GMODMCP.Handlers

local function panelInfo(panel)
    -- GetPos is PARENT-RELATIVE, so nested panels all report (0,0)-ish coordinates that
    -- cannot aim a click or a capture region -- which is exactly what the panel tools are
    -- for. screen_x/screen_y are the absolute ones; keep x/y too, since a layout question
    -- is usually about the offset within the parent.
    local x, y = panel:GetPos()
    local w, h = panel:GetSize()
    local sx, sy = panel:LocalToScreen(0, 0)
    return {
        class = panel:GetClassName(),
        name = panel:GetName(),
        visible = panel:IsVisible(),
        x = x, y = y, w = w, h = h,
        screen_x = sx, screen_y = sy,
        -- A panel with mouse input disabled will never answer a synthetic click, and that
        -- looks identical to a click that missed.
        mouse_input = panel:IsMouseInputEnabled(),
    }
end

-- IsVisible() reports the panel's own flag and says nothing about its ancestors, so a
-- flat tree is mostly panels belonging to a closed menu -- the spawn menu alone accounts
-- for a hundred of them. on_screen carries the ancestors' visibility down the walk, which
-- is what "can I click this" actually depends on.
local function walk(panel, depth, maxDepth, out, parentVisible)
    if not IsValid(panel) or depth > maxDepth then return end
    local info = panelInfo(panel)
    info.depth = depth
    info.on_screen = parentVisible and info.visible or false
    out[#out + 1] = info
    for _, child in ipairs(panel:GetChildren()) do
        walk(child, depth + 1, maxDepth, out, info.on_screen)
    end
end

H.read_panels = function(args)
    local maxDepth = isnumber(args.maxDepth) and args.maxDepth or 6
    local out = {}
    walk(vgui.GetWorldPanel(), 0, maxDepth, out, true)
    return { count = #out, panels = out }
end

H.inspect_panel = function(args)
    if not isstring(args.class) then error("class (string) is required") end
    local flat = {}
    walk(vgui.GetWorldPanel(), 0, 32, flat, true)
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

H.capture_screen = function(args, cmd)
    -- Every byte of a screenshot is paid for in chunks on the reliable channel, and at
    -- one chunk per frame a full 1920x1080 JPEG is 50-90 frames -- seconds, dominating any
    -- act-then-look loop. Half scale at quality 60 is 4-6x cheaper and still perfectly
    -- legible for checking a Derma layout. Ask for scale 1 when reading small text.
    local scale = math.Clamp(tonumber(args.scale) or 0.5, 0.1, 1)
    local quality = math.Clamp(math.floor(tonumber(args.quality) or 60), 1, 100)

    -- A region is free: render.Capture takes it natively, no render target involved.
    -- Paired with inspect_panel's x/y/w/h it turns "show me that panel" into 2-3 chunks.
    local rx, ry, rw, rh = 0, 0, ScrW(), ScrH()
    if istable(args.region) then
        rx = math.Clamp(math.floor(tonumber(args.region.x) or 0), 0, ScrW())
        ry = math.Clamp(math.floor(tonumber(args.region.y) or 0), 0, ScrH())
        rw = math.Clamp(math.floor(tonumber(args.region.w) or ScrW()), 1, ScrW() - rx)
        rh = math.Clamp(math.floor(tonumber(args.region.h) or ScrH()), 1, ScrH() - ry)
    end

    local hookName = "gmod_mcp_capture_" .. cmd.id
    -- render.Capture outside a render hook returns a black image, so capture on the next
    -- PostRender and unsubscribe immediately.
    hook.Add("PostRender", hookName, function()
        hook.Remove("PostRender", hookName)

        local ok, data
        if scale >= 1 then
            ok, data = pcall(render.Capture,
                { format = "jpeg", quality = quality, x = rx, y = ry, w = rw, h = rh })
        else
            -- render.Capture cannot scale, but a render target can: draw the framebuffer
            -- into a smaller RT and capture that.
            local tw, th = math.max(1, math.floor(rw * scale)), math.max(1, math.floor(rh * scale))
            ok, data = pcall(function()
                render.UpdateScreenEffectTexture()
                local rt = GetRenderTarget("gmod_mcp_capture_" .. tw .. "x" .. th, tw, th)
                render.PushRenderTarget(rt)
                render.Clear(0, 0, 0, 255)
                local mat = Material("pp/copy")
                mat:SetTexture("$basetexture", render.GetScreenEffectTexture())
                render.SetMaterial(mat)
                render.DrawScreenQuad()
                local out = render.Capture({ format = "jpeg", quality = quality, x = 0, y = 0, w = tw, h = th })
                render.PopRenderTarget()
                return out
            end)
            rw, rh = math.max(1, math.floor(rw * scale)), math.max(1, math.floor(rh * scale))
        end

        if ok and isstring(data) then
            -- inline=true: without it Base64Encode inserts an RFC 2045 newline every 76
            -- characters, each of which is then JSON-escaped -- pure overhead on a channel
            -- whose cost is the whole problem.
            cmd.done(true, { format = "jpeg", w = rw, h = rh, quality = quality, base64 = util.Base64Encode(data, true) })
        else
            -- render.Capture returns nil while the escape menu is open. Naming that beats
            -- a nil dereference the caller has to guess at.
            cmd.done(false, nil, "render.Capture failed (is the escape menu open?): " .. tostring(data))
        end
    end)
    return GMODMCP.ASYNC
end

-- ------------------------------------------------------------ command intake ---
-- One-shot completion closure. Handlers answer through cmd.done rather than reaching for
-- sendResult directly, so an asynchronous one composes instead of hardcoding where its
-- result goes. Armed once: a second call would send a result for an id the daemon has
-- already resolved and dropped.
local function makeDone(id)
    local fired = false
    return function(ok, data, err)
        if fired then return end
        fired = true
        sendResult(id, ok and true or false, data, err)
    end
end

net.Receive("gmod_mcp_cl_cmd", function()
    local id = net.ReadString()
    local tool = net.ReadString()
    local args = util.JSONToTable(net.ReadString()) or {}
    local confirmed = net.ReadBool()
    local cmd = { id = id, tool = tool, args = args, confirmed = confirmed, done = makeDone(id) }

    local handler = GMODMCP.Handlers[tool]
    if not handler then
        cmd.done(false, nil, "unknown client handler: " .. tostring(tool))
        return
    end
    local ok, res = pcall(handler, args, cmd)
    if not ok then
        cmd.done(false, nil, tostring(res))
        return
    end
    if res ~= GMODMCP.ASYNC then
        cmd.done(true, res)
    end
end)

-- Client Lua errors, exposed through read_console. Pull model, never pushed.
hook.Add("OnLuaError", "gmod_mcp_bridge_cl.errors", function(err, realm, stack, name)
    errorBuffer[#errorBuffer + 1] = { error = err, realm = realm or "client", name = name, stack = stack }
    if #errorBuffer > 100 then table.remove(errorBuffer, 1) end
end)

-- ------------------------------------------------------- acting and looking ---
-- Loaded after gmod_mcp_bridge_input.lua defines GMODMCP.Input (alphabetical order in
-- autorun/client puts _cl before _input, so resolve the table lazily inside the handlers
-- rather than caching it here).

--- What the player is pointed at, which is what most act-then-look steps actually need.
--- A screenshot answers "is the door open" in seconds and several hundred KB; this
--- answers "am I aimed at the door" in one chunk.
H.read_view = function()
    local ply = LocalPlayer()
    if not IsValid(ply) then error("no local player") end

    local I = GMODMCP.Input or {}
    local ang = ply:EyeAngles()
    local tr = ply:GetEyeTrace()
    local wep = ply:GetActiveWeapon()
    local hovered = vgui.GetHoveredPanel()
    local focus = vgui.GetKeyboardFocus()
    local mx, my = input.GetCursorPos()

    return {
        pos = { ply:GetPos():Unpack() },
        eye_pos = { ply:EyePos():Unpack() },
        eye_ang = { ang.p, ang.y, ang.r },
        health = ply:Health(),
        armor = ply:Armor(),
        alive = ply:Alive(),
        weapon = IsValid(wep) and wep:GetClass() or nil,
        aim = IsValid(tr.Entity) and {
            class = tr.Entity:GetClass(),
            index = tr.Entity:EntIndex(),
            distance = math.Round(tr.StartPos:Distance(tr.HitPos)),
            hitpos = { tr.HitPos:Unpack() },
        } or { hit_world = tr.Hit },
        cursor = { x = mx, y = my, visible = vgui.CursorVisible() },
        -- Positive confirmation that a click would land somewhere, instead of inferring
        -- it from pixels afterwards.
        hovered = IsValid(hovered) and hovered:GetClassName() or nil,
        keyboard_focus = IsValid(focus) and focus:GetClassName() or nil,
        input_mode = I.mode or "off",
        input_locked_for = I.deadline and math.max(0, math.Round(I.deadline - RealTime(), 1)) or 0,
        screen = { w = ScrW(), h = ScrH() },
    }
end

--- Multi-frame click. The cursor must already be where the click lands BEFORE the press
--- fires: vgui.GetHoveredPanel is documented as lagging a frame, so moving and pressing
--- in the same frame is the first reason a synthetic click does nothing.
local function clickSequence(cmd, x, y, code)
    input.SetCursorPos(x, y)
    local hookName = "gmod_mcp_click_" .. cmd.id
    local frame = 0
    -- Built here rather than inside the hook: it runs once, but a table literal in a
    -- per-frame hook is a habit the perf lint is right to flag.
    local result = { clicked = { x = x, y = y } }

    hook.Add("Think", hookName, function()
        frame = frame + 1
        if frame == 1 then
            local panel = vgui.GetHoveredPanel()
            result.hovered = IsValid(panel) and panel:GetClassName() or nil
            gui.InternalMousePressed(code)
        elseif frame >= 2 then
            hook.Remove("Think", hookName)
            gui.InternalMouseReleased(code)
            cmd.done(true, result)
        end
    end)
end

local MOUSE_CODES = { left = MOUSE_LEFT, right = MOUSE_RIGHT, middle = MOUSE_MIDDLE }

local ACTIONS = {}

ACTIONS.mode = function(args) return { mode = GMODMCP.Input.SetMode(args.mode or "off") } end
ACTIONS.reset = function() GMODMCP.Input.Reset() return { mode = "off" } end

ACTIONS.move = function(args)
    GMODMCP.Input.SetMode("world")
    GMODMCP.Input.Move(args.forward, args.side, args.up, args.duration or 0.5)
    return { forward = args.forward or 0, side = args.side or 0, up = args.up or 0 }
end

ACTIONS.look = function(args)
    GMODMCP.Input.SetMode("world")
    GMODMCP.Input.Aim(args.pitch, args.yaw, args.duration or 0.3)
    return { pitch = GMODMCP.Input.aim.p, yaw = GMODMCP.Input.aim.y }
end

ACTIONS.look_at = function(args)
    if not istable(args.pos) then error("pos [x, y, z] is required for look_at") end
    GMODMCP.Input.SetMode("world")
    GMODMCP.Input.AimAt(Vector(tonumber(args.pos[1]) or 0, tonumber(args.pos[2]) or 0, tonumber(args.pos[3]) or 0), args.duration or 0.3)
    return { pitch = GMODMCP.Input.aim.p, yaw = GMODMCP.Input.aim.y }
end

ACTIONS.press = function(args)
    if not isnumber(args.key) then error("key (IN_ bit value) is required for press") end
    GMODMCP.Input.SetMode("world")
    GMODMCP.Input.Hold(args.key, args.duration or 0.2)
    return { held = args.key, seconds = args.duration or 0.2 }
end

ACTIONS.release = function(args)
    if not isnumber(args.key) then error("key (IN_ bit value) is required for release") end
    GMODMCP.Input.Release(args.key)
    return { released = args.key }
end

ACTIONS.move_cursor = function(args)
    GMODMCP.Input.SetMode("ui")
    input.SetCursorPos(math.floor(tonumber(args.x) or 0), math.floor(tonumber(args.y) or 0))
    return { x = tonumber(args.x) or 0, y = tonumber(args.y) or 0 }
end

ACTIONS.click = function(args, cmd)
    local code = MOUSE_CODES[args.button or "left"]
    if not code then error("button must be left, right or middle") end
    GMODMCP.Input.SetMode("ui")
    clickSequence(cmd, math.floor(tonumber(args.x) or 0), math.floor(tonumber(args.y) or 0), code)
    return GMODMCP.ASYNC
end

ACTIONS.type = function(args)
    if not isstring(args.text) then error("text (string) is required for type") end
    -- InternalKeyTyped takes an ASCII code and reaches whatever holds keyboard focus.
    -- InternalKeyCodeTyped takes a KEY_ enum instead, which a DTextEntry ignores.
    for i = 1, #args.text do
        gui.InternalKeyTyped(string.byte(args.text, i))
    end
    local focus = vgui.GetKeyboardFocus()
    return { typed = #args.text, keyboard_focus = IsValid(focus) and focus:GetClassName() or nil }
end

ACTIONS.key_ui = function(args)
    if not isnumber(args.key) then error("key (KEY_ enum) is required for key_ui") end
    gui.InternalKeyCodePressed(args.key)
    gui.InternalKeyCodeTyped(args.key)
    gui.InternalKeyCodeReleased(args.key)
    return { key = args.key }
end

ACTIONS.scroll = function(args)
    gui.InternalMouseWheeled(math.floor(tonumber(args.delta) or 0))
    return { delta = tonumber(args.delta) or 0 }
end

ACTIONS.select_weapon = function(args)
    if not isstring(args.weapon) then error("weapon (class) is required for select_weapon") end
    local wep = LocalPlayer():GetWeapon(args.weapon)
    -- input.SelectWeapon, not CUserCmd:SelectWeapon: the latter may not take effect while
    -- the current command is in prediction.
    if not IsValid(wep) then error("not carrying weapon: " .. args.weapon) end
    input.SelectWeapon(wep)
    return { weapon = args.weapon }
end

ACTIONS.say = function(args)
    if not isstring(args.text) then error("text (string) is required for say") end
    -- Goes through GM:PlayerSay server-side, exactly as a human typing it would. Driving
    -- the chatbox UI is a different test; this is the one that exercises commands.
    RunConsoleCommand("say", args.text)
    return { said = args.text }
end

H.client_input = function(args, cmd)
    if not isstring(args.action) then error("action (string) is required") end
    local fn = ACTIONS[args.action]
    if not fn then
        local names = {}
        for name in pairs(ACTIONS) do names[#names + 1] = name end
        table.sort(names)
        error("unknown action '" .. args.action .. "'; expected one of: " .. table.concat(names, ", "))
    end
    return fn(args, cmd)
end
