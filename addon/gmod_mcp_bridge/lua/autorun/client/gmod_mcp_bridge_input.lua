-- gmod_mcp_bridge -- synthetic input, so an agent can act in the game rather than only
-- read it.
--
-- THIS FILE MUST LIVE IN lua/autorun/client/. Only that directory is networked to clients
-- automatically; a module under lua/gmod_mcp_bridge/client/ would need an explicit
-- AddCSLuaFile and, without one, simply never arrives -- no error on either side, just a
-- handler that is not there. Same family as a camelCase addon directory on a Linux server.
--
-- It drives a real human's machine, so every effect is bounded IN LUA rather than behind a
-- confirmation prompt: a prompt clicked two hundred times is not a safety property. Holds
-- expire, a wall-clock deadline resets everything, and `gmod_mcp_release` in the console
-- gives the human their controls back without involving the agent.
if not CLIENT then return end

GMODMCP = GMODMCP or {}
GMODMCP.Input = GMODMCP.Input or {}

local I = GMODMCP.Input

--- Longest a single hold or scripted aim may last. Anything longer is a stuck input.
local MAX_DURATION = 5
--- How long the whole scripted-input session may last before it resets itself.
local MAX_SESSION = 30

I.mode = I.mode or "off"
I.buttons = I.buttons or {}   -- [IN_ bit] = expiry (RealTime), math.huge until released
I.move = I.move or { forward = 0, side = 0, up = 0, until_ = 0 }
I.aim = I.aim or { p = 0, y = 0, until_ = 0 }
I.deadline = I.deadline or 0

--- Angle reused across ticks. CreateMove runs at cmdrate, so allocating here would churn.
local scriptedAngle = Angle(0, 0, 0)

local function clampDuration(seconds)
    return math.Clamp(tonumber(seconds) or 0, 0, MAX_DURATION)
end

local function touchSession()
    I.deadline = RealTime() + MAX_SESSION
end

function I.Reset()
    I.buttons = {}
    I.move = { forward = 0, side = 0, up = 0, until_ = 0 }
    I.aim = { p = 0, y = 0, until_ = 0 }
    I.deadline = 0
    if I.mode == "ui" then gui.EnableScreenClicker(false) end
    I.mode = "off"
end

-- world drives CreateMove; ui hands input to vgui. They are mutually exclusive: the wiki
-- is explicit that while the screen clicker is on, the vgui system takes the input over
-- and some CUserCmd functions return wrong values.
function I.SetMode(mode)
    if mode ~= "off" and mode ~= "world" and mode ~= "ui" then
        error("mode must be off, world or ui")
    end
    if mode == I.mode then return I.mode end

    if I.mode == "ui" then gui.EnableScreenClicker(false) end
    if mode == "ui" then gui.EnableScreenClicker(true) end
    I.mode = mode
    if mode == "off" then I.Reset() else touchSession() end
    return I.mode
end

function I.Hold(bit, seconds)
    if not isnumber(bit) then error("key must be an IN_ bit value") end
    I.buttons[bit] = RealTime() + clampDuration(seconds)
    touchSession()
end

function I.Release(bit)
    I.buttons[bit] = nil
end

function I.Move(forward, side, up, seconds)
    I.move = {
        forward = tonumber(forward) or 0,
        side = tonumber(side) or 0,
        up = tonumber(up) or 0,
        until_ = RealTime() + clampDuration(seconds),
    }
    touchSession()
end

function I.Aim(pitch, yaw, seconds)
    -- Beyond +-89 the view flips over; the wiki says to clamp and so does every gamemode
    -- that has ever shipped a scripted camera.
    I.aim = {
        p = math.Clamp(tonumber(pitch) or 0, -89, 89),
        y = tonumber(yaw) or 0,
        until_ = RealTime() + clampDuration(seconds),
    }
    touchSession()
end

function I.AimAt(pos, seconds)
    local ply = LocalPlayer()
    if not IsValid(ply) then error("no local player") end
    local ang = (pos - ply:EyePos()):Angle()
    I.Aim(ang.p, ang.y, seconds)
end

-- --------------------------------------------------------------------- hooks ---

hook.Add("CreateMove", "gmod_mcp_bridge.input", function(cmd)
    if I.mode ~= "world" then return end

    local now = RealTime()
    if I.deadline > 0 and now > I.deadline then
        I.Reset()
        return
    end

    for bit, expiry in pairs(I.buttons) do
        if now > expiry then
            I.buttons[bit] = nil
        else
            -- AddKey, never SetButtons: SetButtons would clobber the keys the human is
            -- genuinely holding, and this is their machine.
            cmd:AddKey(bit)
        end
    end

    -- Buttons alone do not move the player. The bitflag is what gamemodes and animations
    -- read; the movement code reads these. Setting only one of the two produces a
    -- half-working result that looks like a physics bug.
    if now <= I.move.until_ then
        cmd:SetForwardMove(I.move.forward)
        cmd:SetSideMove(I.move.side)
        cmd:SetUpMove(I.move.up)
    end

    if now <= I.aim.until_ then
        scriptedAngle.p = I.aim.p
        scriptedAngle.y = I.aim.y
        scriptedAngle.r = 0
        cmd:SetViewAngles(scriptedAngle)
    end
end)

-- Suppresses the human's mouse ONLY while a scripted aim is running. Returning true
-- unconditionally would take their mouse away for the session and trip glua-audit's
-- blocking-hook rule; the engine would also keep accumulating deltas and fight the
-- scripted angle, which reads as jitter.
hook.Add("InputMouseApply", "gmod_mcp_bridge.mouse", function()
    if I.mode == "world" and RealTime() <= I.aim.until_ then return true end
end)

hook.Add("ShutDown", "gmod_mcp_bridge.input_reset", function()
    I.Reset()
end)

-- The escape hatch that does not depend on the daemon being alive.
concommand.Add("gmod_mcp_release", function()
    I.Reset()
    print("[gmod-mcp] scripted input released")
end)
