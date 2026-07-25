-- Batch execution: several tools in ONE bridge round trip.
--
-- Why this exists: the addon polls at 0.25s and the daemon scans at 0.15s, so a round
-- trip costs ~0.4s. Any loop that acts and then looks -- move, then read the view, then
-- capture -- pays that per gesture and stops being usable. Tightening the poll is the
-- wrong fix; carrying N steps in one command is the right one.
--
-- Handlers are looked up in GMODMCP.Handlers by name. That is a table index, not
-- CompileString, so this file stays clean under glua-audit's dynamic-execution rule.
local MAX_STEPS = 32
local MAX_SETTLE = 2000

-- Guarded tools must not become reachable through a batch. `batch` is a single unguarded
-- definition on the daemon side, so without this check a run_lua step would ride in
-- without the confirmation its own gate demands. The daemon checks too; this is the half
-- that still holds if the daemon is ever wrong.
local GUARDED = { run_lua = true }

local function finish(state)
    state.done(true, {
        count = #state.results,
        steps = state.results,
        aborted_at = state.abortedAt,
    })
end

-- Marks every step from `from` onwards as skipped, so the caller sees the whole shape of
-- the batch rather than a truncated list it has to interpret.
local function skipRest(state, from)
    for i = from, #state.steps do
        state.results[#state.results + 1] = {
            i = i,
            tool = state.steps[i] and state.steps[i].tool or nil,
            ok = false,
            skipped = true,
        }
    end
end

local function runStep(step, confirmed)
    if not istable(step) or not isstring(step.tool) then
        return false, nil, "step must be a table with a string `tool`"
    end
    if GUARDED[step.tool] and not confirmed then
        return false, nil, "guarded tool in batch: " .. step.tool .. " requires confirmation"
    end

    local handler = GMODMCP.Handlers[step.tool]
    if not handler then
        return false, nil, "unknown handler: " .. step.tool
    end

    local fakeCmd = { id = step.tool, args = step.args or {}, confirmed = confirmed }
    local ok, res = pcall(handler, step.args or {}, fakeCmd)
    if not ok then return false, nil, tostring(res) end

    -- A handler that answers later cannot be sequenced here: it would need a per-step
    -- continuation, and silently recording the sentinel as data would be worse than
    -- saying so. No server handler does this today.
    if res == GMODMCP.ASYNC then
        return false, nil, "handler " .. step.tool .. " is asynchronous; not supported inside a server batch"
    end
    return true, res, nil
end

local function advance(state)
    while state.i < #state.steps do
        state.i = state.i + 1
        local step = state.steps[state.i]
        local ok, data, err = runStep(step, state.confirmed)

        state.results[#state.results + 1] = {
            i = state.i,
            tool = istable(step) and step.tool or nil,
            ok = ok,
            data = ok and data or nil,
            error = err,
        }

        if not ok and state.stopOnError then
            state.abortedAt = state.i
            skipRest(state, state.i + 1)
            return finish(state)
        end

        -- The pause is what makes an act-then-look batch honest: without it the next
        -- step observes the frame before the previous one landed.
        if state.settle > 0 and state.i < #state.steps then
            timer.Simple(state.settle / 1000, function() advance(state) end)
            return
        end
    end
    finish(state)
end

GMODMCP.Handlers.batch = function(args, cmd)
    if not istable(args.steps) then error("steps (array) is required") end
    local n = #args.steps
    if n < 1 then error("steps must not be empty") end
    if n > MAX_STEPS then error("too many steps: " .. n .. " > " .. MAX_STEPS) end

    local settle = isnumber(args.settleMs) and math.Clamp(args.settleMs, 0, MAX_SETTLE) or 0

    advance({
        steps = args.steps,
        i = 0,
        results = {},
        settle = settle,
        stopOnError = args.stopOnError ~= false, -- default true
        confirmed = cmd.confirmed == true,
        done = cmd.done,
    })
    return GMODMCP.ASYNC
end
