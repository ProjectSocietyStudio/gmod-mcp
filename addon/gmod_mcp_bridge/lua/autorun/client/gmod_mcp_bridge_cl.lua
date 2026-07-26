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

-- Hard ceiling on how much one result may push up the reliable channel.
--
-- Measured 2026-07-25, the hard way: a full-screen capture at quality 80 came to 424 KB,
-- 62 chunks, and timed the client out of the server -- the exact failure the chunking
-- above was written to fix, reached from the other direction. A full-screen q70 capture
-- (100 KB, 15 chunks) had gone through fine minutes earlier, so the ceiling sits between
-- them; 48 is under the smallest known-bad figure with room to spare. Refusing loudly
-- beats disconnecting the human: the caller can lower scale or quality, and the default
-- half-scale capture is about six chunks.
local MAX_CHUNKS = 48

-- Results are chunked ONE AT A TIME.
--
-- Each result used to get its own timer, so several in flight summed on the same reliable
-- channel and the per-frame pacing stopped meaning anything -- three concurrent results
-- at one chunk each per frame is three chunks per frame. That is easy to reach: a caller
-- that retries a command it thinks was lost has two captures in flight, and the second is
-- what tips the channel over. A single drain keeps the pacing true however many commands
-- arrive at once.
local queue = {}
local draining = false

local function drain()
    if draining or #queue == 0 then return end
    draining = true

    timer.Create("gmod_mcp_drain", 0, 0, function()
        -- The netchannel dies before the timer does. Without this the remaining chunks
        -- keep firing into nothing, which is what "Client sending to server with no
        -- netchannel!" in the client console means.
        if not IsValid(LocalPlayer()) then
            queue = {}
            draining = false
            timer.Remove("gmod_mcp_drain")
            return
        end

        local rate = math.Clamp(perFrame:GetInt(), 1, 8)
        for _ = 1, rate do
            local job = queue[1]
            if not job then
                draining = false
                timer.Remove("gmod_mcp_drain")
                return
            end
            job.sent = job.sent + 1
            net.Start("gmod_mcp_cl_res")
            net.WriteString(job.id)
            net.WriteUInt(job.sent, 16)
            net.WriteUInt(job.total, 16)
            net.WriteString(string.sub(job.payload, (job.sent - 1) * CHUNK + 1, job.sent * CHUNK))
            net.SendToServer()
            if job.sent >= job.total then table.remove(queue, 1) end
        end
    end)
end

local function sendResult(id, ok, data, err)
    local payload = util.TableToJSON({ id = id, ok = ok, data = data, error = err })
    local total = math.max(1, math.ceil(#payload / CHUNK))

    if total > MAX_CHUNKS then
        payload = util.TableToJSON({
            id = id,
            ok = false,
            error = string.format(
                "result too large: %d KB would need %d chunks (limit %d). Lower scale or quality, or capture a region.",
                math.floor(#payload / 1024), total, MAX_CHUNKS),
        })
        total = math.max(1, math.ceil(#payload / CHUNK))
    end

    queue[#queue + 1] = { id = id, payload = payload, total = total, sent = 0 }
    drain()
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
-- flat tree is mostly panels belonging to a closed menu -- measured on a live client,
-- 1408 panels of which 5 were on screen, the spawn menu accounting for most of the rest.
-- on_screen carries the ancestors' visibility down the walk, which is what "can I click
-- this" actually depends on.
--
-- The walk keeps the PANEL HANDLE beside its info: every targeting tool below has to call
-- methods on the match (GetText, RequestFocus, SetText), and a serialised info table
-- cannot be called. Handles never leave the addon -- infosOf strips them before a result
-- goes near util.TableToJSON.
local function collect(panel, depth, maxDepth, out, parentVisible)
    if not IsValid(panel) or depth > maxDepth then return end
    local info = panelInfo(panel)
    info.depth = depth
    info.on_screen = parentVisible and info.visible or false
    out[#out + 1] = { panel = panel, info = info }
    for _, child in ipairs(panel:GetChildren()) do
        collect(child, depth + 1, maxDepth, out, info.on_screen)
    end
end

local function infosOf(entries)
    local out = {}
    for i = 1, #entries do out[i] = entries[i].info end
    return out
end

-- ------------------------------------------------------------ panel targeting ---
-- A panel's NAME and its CLASS are different strings, and the useful one is the name.
-- vgui.Create("R_UI_Button") builds a registered table on top of a base class, and
-- Panel:GetClassName returns the BASE -- "Label" for anything derived from DButton,
-- "Panel" for a plain container. Measured on a live client: DButton/Label,
-- SpawnIcon/Label, DTextEntry/TextEntry, DTree_Node/Panel. So `inspect_panel
-- class:"R_UI_Button"` could only ever answer "no panel of class R_UI_Button" while the
-- tree held several of them, and searching by class was the whole of the old API.
--
-- vgui.Create's third argument is the name and DEFAULTS TO THE CLASSNAME, which is why
-- GetName carries the registered name unless the caller overrode it (echat does:
-- "echat.textentry").

-- Fields checked when a panel has no readable text through the API.
--
-- Painted text is invisible to GetText and GetValue: R_UI_Button calls SetText("") in
-- Init and draws self.label from Paint, so a kit button displaying "ÉCROUER" answers "".
-- This fallback is inelegant, and it is the difference between "the button that says
-- ÉCROUER" being addressable and not.
local TEXT_FIELDS = { "label", "text", "title" }

--- Text a panel DISPLAYS, best effort. Returns the text and where it came from.
local function panelText(panel)
    -- pcall: Panel:GetText exists on every panel but only Label/TextEntry derivatives
    -- answer it, and the others raise rather than return nil.
    if isfunction(panel.GetText) then
        local ok, value = pcall(panel.GetText, panel)
        if ok and isstring(value) and value ~= "" then return value, "GetText" end
    end
    if isfunction(panel.GetValue) then
        local ok, value = pcall(panel.GetValue, panel)
        if ok and isstring(value) and value ~= "" then return value, "GetValue" end
    end
    for _, key in ipairs(TEXT_FIELDS) do
        local value = panel[key]
        if isstring(value) and value ~= "" then return value, "." .. key end
    end
    return nil, nil
end

local function hasTarget(args)
    return isstring(args.name) or isstring(args.class) or isstring(args.contains)
end

--- Filters a collected tree by name, class and displayed text.
--- Returns the matches honouring `onScreen`, and how many matched the criteria at all.
---
--- onScreen defaults to TRUE: an invisible panel cannot be clicked, and the flat tree is
--- overwhelmingly closed menus, so the default has to be the useful one.
local function matchTarget(args, entries)
    local all, shown = {}, {}
    local needle = isstring(args.contains) and string.lower(args.contains) or nil
    for _, entry in ipairs(entries) do
        local info = entry.info
        local ok = true
        if isstring(args.name) and info.name ~= args.name then ok = false end
        if ok and isstring(args.class) and info.class ~= args.class then ok = false end
        if ok and needle then
            local text = panelText(entry.panel)
            ok = text ~= nil and string.find(string.lower(text), needle, 1, true) ~= nil
        end
        if ok then
            all[#all + 1] = entry
            if info.on_screen then shown[#shown + 1] = entry end
        end
    end
    if args.onScreen == false then return all, #all end
    return shown, #all
end

--- Whole VGUI tree, as {panel, info} pairs. Depth 32 is the practical ceiling: the
--- deepest live tree measured (spawn menu open) reached 17.
local function wholeTree()
    local entries = {}
    collect(vgui.GetWorldPanel(), 0, 32, entries, true)
    return entries
end

--- Resolves exactly one target panel from an already-collected tree, or raises something
--- the caller can act on. `index` picks among several matches, `contains` narrows by
--- displayed text. Returns the panel, its info, how many matched, and the matches.
local function resolveIn(args, entries)
    if not hasTarget(args) then
        error("a target needs name (registered vgui name, e.g. R_UI_Button), class (VGUI base, e.g. Label) or contains (displayed text)")
    end
    local matches, total = matchTarget(args, entries)
    if #matches == 0 then
        error(string.format(
            "no panel matched name=%s class=%s contains=%s. %d matched the criteria but are off screen (pass onScreen:false to include them). NAMES are the registered vgui names (R_CharCreate, R_UI_Button); CLASSES are the VGUI bases (Panel, Label, TextEntry) -- searching a kit panel by class never matches.",
            tostring(args.name), tostring(args.class), tostring(args.contains), total - #matches))
    end
    local index = math.floor(tonumber(args.index) or 1)
    local chosen = matches[index]
    if not chosen then
        error(string.format("index %d out of range: %d panel(s) matched (use `contains` to narrow by displayed text)", index, #matches))
    end
    return chosen.panel, chosen.info, total, matches
end

--- resolveIn against a freshly collected tree, for callers that need nothing else.
local function resolveTarget(args)
    return resolveIn(args, wholeTree())
end

--- Compact form of a match, for listing alternatives without a second round trip.
local function briefOf(entry)
    local info = entry.info
    return {
        name = info.name,
        class = info.class,
        depth = info.depth,
        screen_x = info.screen_x,
        screen_y = info.screen_y,
        w = info.w,
        h = info.h,
        text = panelText(entry.panel),
    }
end

H.read_panels = function(args)
    local maxDepth = isnumber(args.maxDepth) and args.maxDepth or 6
    local out = {}
    collect(vgui.GetWorldPanel(), 0, maxDepth, out, true)
    return { count = #out, panels = infosOf(out) }
end

H.inspect_panel = function(args)
    local panel, info, total, matches = resolveIn(args, wholeTree())
    info.text, info.text_source = panelText(panel)
    -- Whether THIS panel holds keyboard focus, because "the characters went nowhere" is
    -- the most common client-side failure and this is the fact that explains it.
    info.has_focus = vgui.GetKeyboardFocus() == panel

    -- The other matches, so choosing an index does not cost a second round trip.
    local brief = {}
    for i = 1, math.min(#matches, 16) do brief[i] = briefOf(matches[i]) end

    return {
        match = info,
        total_matches = #matches,
        total_matching_criteria = total,
        matches = brief,
    }
end

-- Reading the interface as TEXT.
--
-- Before this the only way to know what a screen displayed was capture_screen: a whole
-- proof session asserted budgets, attribute values and trait costs by eye on compressed
-- JPEG, which is not an assertion and cannot survive a resolution change. Text is two
-- orders of magnitude cheaper -- a capture travels in 7 KB chunks paced one per frame --
-- but only while the dump stays small, so the defaults are narrow on purpose: one named
-- subtree, on-screen only, and only panels that actually carry text.
--
-- `depth` is relative to the root and the list is depth-first, so the parent chain is
-- recoverable from the ordering alone. That matters for a form: the DTextEntry that
-- follows the DLabel "Prénom" is the prénom field, and nothing else identifies it.
H.read_panel_text = function(args)
    local rootPanel, rootInfo = vgui.GetWorldPanel(), nil
    if isstring(args.root) then
        local entries = wholeTree()
        -- Name first, class second: a name is what a kit registers and what a caller has
        -- in hand. Trying only one of the two would fail on half the panels in the tree.
        local byName = matchTarget({ name = args.root, onScreen = args.onScreen }, entries)
        local chosen = byName[math.floor(tonumber(args.index) or 1)]
        if not chosen then
            local byClass = matchTarget({ class = args.root, onScreen = args.onScreen }, entries)
            chosen = byClass[math.floor(tonumber(args.index) or 1)]
        end
        if not chosen then
            error("no panel named or classed '" .. args.root .. "' (names are the registered vgui names; pass onScreen:false to include hidden panels)")
        end
        rootPanel, rootInfo = chosen.panel, chosen.info
    end

    local maxDepth = isnumber(args.maxDepth) and args.maxDepth or 8
    local limit = math.floor(tonumber(args.limit) or 120)
    local onlyText = args.onlyText ~= false
    local onScreen = args.onScreen ~= false

    local entries = {}
    collect(rootPanel, 0, maxDepth, entries, rootInfo == nil or rootInfo.on_screen)

    local out, truncated = {}, 0
    for _, entry in ipairs(entries) do
        local info = entry.info
        if info.on_screen or not onScreen then
            local text, source = panelText(entry.panel)
            if text or not onlyText then
                if #out >= limit then
                    truncated = truncated + 1
                else
                    out[#out + 1] = {
                        depth = info.depth,
                        name = info.name,
                        class = info.class,
                        text = text,
                        text_source = source,
                        screen_x = info.screen_x,
                        screen_y = info.screen_y,
                        w = info.w,
                        h = info.h,
                    }
                end
            end
        end
    end

    return {
        root = rootInfo or { name = "WorldPanel", class = vgui.GetWorldPanel():GetClassName() },
        count = #out,
        truncated = truncated,
        considered = #entries,
        panels = out,
    }
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
        -- it from pixels afterwards. The NAME is the addressable one -- a class of
        -- "Label" identifies nothing, while "R_UI_Button" is what a target names.
        hovered = IsValid(hovered) and hovered:GetClassName() or nil,
        hovered_name = IsValid(hovered) and hovered:GetName() or nil,
        keyboard_focus = IsValid(focus) and focus:GetClassName() or nil,
        keyboard_focus_name = IsValid(focus) and focus:GetName() or nil,
        -- What the focused field currently holds: "did my text land" without a capture.
        keyboard_focus_text = IsValid(focus) and panelText(focus) or nil,
        input_mode = I.mode or "off",
        input_locked_for = I.deadline and math.max(0, math.Round(I.deadline - RealTime(), 1)) or 0,
        screen = { w = ScrW(), h = ScrH() },
    }
end

--- Runs fn on the NEXT frame and answers the command with what it returns.
---
--- Focus and hover are both resolved a frame late in vgui, so "do X, then observe X"
--- inside one frame is the single most common reason a synthetic gesture appears to do
--- nothing. A frame costs ~15ms against a 400ms round trip: never worth saving.
local function afterFrame(cmd, fn)
    local hookName = "gmod_mcp_frame_" .. cmd.id
    hook.Add("Think", hookName, function()
        hook.Remove("Think", hookName)
        local ok, res = pcall(fn)
        if ok then cmd.done(true, res) else cmd.done(false, nil, tostring(res)) end
    end)
end

--- Frames spent settling before the press. See clickSequence.
local SETTLE_FRAMES = 2

--- Multi-frame click, self-sufficient: it moves the cursor, lets hover settle, presses,
--- then releases.
---
--- An isolated `click` used to do nothing and the SAME click preceded by `move_cursor`
--- worked; three clicks were lost before anyone suspected the tool rather than the
--- coordinates. Two things were happening, and both need a frame. vgui.GetHoveredPanel
--- lags a frame, so pressing in the frame the cursor moved hits whatever was hovered
--- before. And `click` switches the input mode to "ui", which turns the screen clicker
--- on -- the cursor only becomes real to vgui on the following frame, and enabling it
--- can move the cursor, which is why the position is re-asserted on every settle frame
--- rather than set once.
local function clickSequence(cmd, x, y, code, target)
    input.SetCursorPos(x, y)
    local hookName = "gmod_mcp_click_" .. cmd.id
    local frame = 0
    -- Built here rather than inside the hook: it runs once, but a table literal in a
    -- per-frame hook is a habit the perf lint is right to flag.
    local result = { clicked = { x = x, y = y }, target = target }

    hook.Add("Think", hookName, function()
        frame = frame + 1
        if frame <= SETTLE_FRAMES then
            input.SetCursorPos(x, y)
        elseif frame == SETTLE_FRAMES + 1 then
            local panel = vgui.GetHoveredPanel()
            result.hovered = IsValid(panel) and panel:GetClassName() or nil
            result.hovered_name = IsValid(panel) and panel:GetName() or nil
            gui.InternalMousePressed(code)
        else
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

--- Clicks a panel by NAME (or class, or displayed text) instead of by pixel. A named
--- click survives a resolution change; a pixel computed from a three-second-old JPEG
--- does not, and every click of the proof session was one of those.
ACTIONS.click = function(args, cmd)
    local code = MOUSE_CODES[args.button or "left"]
    if not code then error("button must be left, right or middle") end

    local x, y, target
    if hasTarget(args) then
        local panel, info = resolveTarget(args)
        local sx, sy = panel:LocalToScreen(0, 0)
        local w, h = panel:GetSize()
        x, y = math.floor(sx + w * 0.5), math.floor(sy + h * 0.5)
        -- Reported, not refused: a container with mouse input off still lets the click
        -- through to a child. But a panel that will never answer a click looks exactly
        -- like a click that missed, so the fact has to travel with the result.
        target = { name = info.name, class = info.class, screen_x = sx, screen_y = sy,
                   w = w, h = h, mouse_input = info.mouse_input, text = panelText(panel) }
    else
        x, y = math.floor(tonumber(args.x) or 0), math.floor(tonumber(args.y) or 0)
    end

    GMODMCP.Input.SetMode("ui")
    clickSequence(cmd, x, y, code, target)
    return GMODMCP.ASYNC
end

--- Sends the characters and reports where they landed.
local function typeInto(args, target, panel)
    -- InternalKeyTyped takes an ASCII code and reaches whatever holds keyboard focus.
    -- InternalKeyCodeTyped takes a KEY_ enum instead, which a DTextEntry ignores.
    for i = 1, #args.text do
        gui.InternalKeyTyped(string.byte(args.text, i))
    end
    local focus = vgui.GetKeyboardFocus()
    return {
        typed = #args.text,
        target = target,
        -- The field read back: the only honest answer to "did it work". `typed: 12` was
        -- reported by the old action while nothing whatsoever had been entered.
        value = IsValid(panel) and panelText(panel) or nil,
        keyboard_focus = IsValid(focus) and focus:GetClassName() or nil,
        keyboard_focus_name = IsValid(focus) and focus:GetName() or nil,
    }
end

--- Character-by-character typing. Exercises the panel's key handlers, which set_text
--- deliberately does not -- but it needs the field to hold keyboard focus, so give it a
--- target unless something already has focus.
ACTIONS.type = function(args, cmd)
    if not isstring(args.text) then error("text (string) is required for type") end
    if not hasTarget(args) then return typeInto(args, nil, nil) end

    local panel, info = resolveTarget(args)
    -- The panel system only owns the keyboard in "ui" mode; in "world" mode the engine
    -- routes keys to the game and the focused entry never sees them.
    GMODMCP.Input.SetMode("ui")
    if isfunction(panel.RequestFocus) then panel:RequestFocus() end
    -- Focus lands a frame later. Typing in the same frame is how the original action
    -- reported `typed: 12, keyboard_focus: "Panel"` with an empty field.
    afterFrame(cmd, function() return typeInto(args, info, panel) end)
    return GMODMCP.ASYNC
end

-- Writing a value into a field -- THE blocking gap, and the reason a character could not
-- be created for a whole session.
--
-- A synthetic click does not give keyboard focus to a DTextEntry, so `type` reported
-- `typed: N` and `keyboard_focus: "Panel"` while the characters went nowhere. Verified
-- twice on R_CharCreate. So go through the API the panel exposes instead of pretending
-- to be a keyboard.
--
-- Panel:SetText, NOT DTextEntry:SetValue: SetValue is documented not to change the text
-- while the entry is being typed in, and RequestFocus above puts it in exactly that
-- state. SetValue's other half -- calling OnValueChange -- is reproduced explicitly.

--- Calls one notification if the panel has it, recording whether it ran or raised.
local function fireOne(fired, panel, name, ...)
    local fn = panel[name]
    if not isfunction(fn) then return false end
    local ok, err = pcall(fn, panel, ...)
    fired[#fired + 1] = ok and name or (name .. " raised: " .. tostring(err))
    return ok
end

--- Fires the change notifications a real keystroke would, once each.
---
--- This is the half that is easy to skip and impossible to notice: a silent SetText
--- leaves every validation, every enable/disable of a submit button and every convar
--- binding in its previous state, so the field reads as filled and the form still
--- refuses. The order mirrors the real path: TextEntry:OnTextChanged is what the engine
--- calls, DTextEntry implements it by updating the bound convar and -- when
--- SetUpdateOnType is on -- calling OnValueChange. So OnValueChange is only called here
--- when OnTextChanged did not already do it, otherwise validation would run twice.
--- OnChange belongs to no DTextEntry but custom entries define it.
local function notifyChange(panel, text, alsoEnter)
    local fired = {}
    local textChanged = fireOne(fired, panel, "OnTextChanged")
    local updateOnType = isfunction(panel.GetUpdateOnType) and panel:GetUpdateOnType() == true
    if not (textChanged and updateOnType) then
        fireOne(fired, panel, "OnValueChange", text)
    end
    fireOne(fired, panel, "OnChange", text)
    -- Many forms only validate or submit on Enter. Opt-in: it can send a chat line.
    if alsoEnter then fireOne(fired, panel, "OnEnter", text) end
    return fired
end

ACTIONS.set_text = function(args)
    if not isstring(args.text) then error("text (string) is required for set_text") end
    local panel, info = resolveTarget(args)
    if not isfunction(panel.SetText) then
        error("panel " .. tostring(info.name) .. " (" .. tostring(info.class) .. ") has no SetText -- it is not a text field")
    end

    local before = panelText(panel)
    -- The input mode is deliberately NOT switched: this path needs no keyboard, and
    -- turning the screen clicker on would put a cursor on a human's screen for nothing.
    if args.focus ~= false and isfunction(panel.RequestFocus) then panel:RequestFocus() end
    panel:SetText(args.text)
    if isfunction(panel.SetCaretPos) then pcall(panel.SetCaretPos, panel, #args.text) end
    local fired = notifyChange(panel, args.text, args.enter == true)

    local focus = vgui.GetKeyboardFocus()
    return {
        target = info,
        text = args.text,
        previous = before,
        -- Read back through the same accessor the UI uses: this is the assertion.
        value = panelText(panel),
        fired = fired,
        has_focus = focus == panel,
        keyboard_focus_name = IsValid(focus) and focus:GetName() or nil,
    }
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
