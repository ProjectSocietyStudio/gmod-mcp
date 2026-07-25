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
-- definition on the daemon side, so without this check a guarded step would ride in
-- without the confirmation its own gate demands. The daemon checks too; this is the half
-- that still holds if the daemon is ever wrong. The set lives in GMODMCP.Guarded, filled
-- in beside each handler, so adding a handler and forgetting the flag is a local mistake
-- rather than a silent hole here.

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

-- Resolves {"__step": n, "get": "index"} against an earlier step's data.
--
-- Without this, spawning something and then acting on it takes two round trips, because
-- the caller cannot know the EntIndex until the spawn has answered -- which is exactly
-- the round trip batching exists to remove.
--
-- It walks nested tables. A first version substituted only at the top level, which read
-- as a reasonable simplification and broke on the most natural use there is: force_hook
-- takes a list of tagged values, so the reference is always nested one deeper
-- ({"__ent": {"__step": 1, "get": "index"}}). The depth cap is a cycle guard, not a
-- design statement.
local MAX_REF_DEPTH = 8

local function resolveRefs(value, results, depth)
    if not istable(value) then return value end
    depth = depth or 0
    if depth > MAX_REF_DEPTH then error("argument nesting is too deep") end

    if value.__step ~= nil then
        local n = tonumber(value.__step)
        local ref = n and results[n]
        if not ref then error("__step " .. tostring(value.__step) .. ": no such earlier step") end
        if not ref.ok then error("__step " .. n .. " failed; cannot read its result") end
        if value.get == nil then return ref.data end
        if not istable(ref.data) then error("__step " .. n .. " returned no table to read `get` from") end
        local got = ref.data[value.get]
        if got == nil then error("__step " .. n .. " has no field '" .. tostring(value.get) .. "'") end
        return got
    end

    local out = {}
    for k, v in pairs(value) do
        out[k] = resolveRefs(v, results, depth + 1)
    end
    return out
end

local function runStep(step, confirmed, results)
    if not istable(step) or not isstring(step.tool) then
        return false, nil, "step must be a table with a string `tool`"
    end
    if GMODMCP.Guarded[step.tool] and not confirmed then
        return false, nil, "guarded tool in batch: " .. step.tool .. " requires confirmation"
    end

    local handler = GMODMCP.Handlers[step.tool]
    if not handler then
        return false, nil, "unknown handler: " .. step.tool
    end

    local resolved = step.args
    if resolved then
        local okRef, outcome = pcall(resolveRefs, resolved, results)
        if not okRef then return false, nil, tostring(outcome) end
        resolved = outcome
    end
    resolved = resolved or {}

    local fakeCmd = { id = step.tool, args = resolved, confirmed = confirmed }
    local ok, res = pcall(handler, resolved, fakeCmd)
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
        local ok, data, err = runStep(step, state.confirmed, state.results)

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

        -- The pause is what makes an act-then-look batch honest. Without it every step
        -- runs in the same tick, and engine effects that land at end of frame have not
        -- happened yet: Entity:Remove() is deferred, so a step reading the entity back
        -- still finds it valid and the agent concludes the removal failed.
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
