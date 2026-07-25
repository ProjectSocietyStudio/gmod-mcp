-- Moteur de test minimal exécuté côté serveur. Un fichier de test est un module
-- GLua qui RETOURNE une table { ["nom du cas"] = function(t) ... end }. Il est
-- chargé via include() — autorisé par glua-audit, contrairement à CompileString.
--
-- Le paramètre `t` porte les assertions ; une assertion échouée lève (error), ce
-- que pcall capture pour transformer en résultat d'échec structuré.
local function makeT()
    return {
        eq = function(a, b)
            if a ~= b then error("attendu " .. tostring(b) .. ", obtenu " .. tostring(a), 2) end
        end,
        neq = function(a, b)
            if a == b then error("valeurs égales inattendues: " .. tostring(a), 2) end
        end,
        truthy = function(v)
            if not v then error("valeur falsy, attendue truthy", 2) end
        end,
        falsy = function(v)
            if v then error("valeur truthy, attendue falsy", 2) end
        end,
        fail = function(msg)
            error(msg or "échec explicite", 2)
        end,
    }
end

GMODMCP.Handlers.run_test = function(args)
    if not isstring(args.path) then error("path (string) requis, relatif à lua/") end

    local cases = include(args.path)
    if not istable(cases) then
        error("le fichier de test doit retourner une table { [nom] = function(t) end }")
    end

    local results, passed, failed = {}, 0, 0
    for name, fn in pairs(cases) do
        if isfunction(fn) then
            local ok, err = pcall(fn, makeT())
            results[#results + 1] = { name = tostring(name), ok = ok, error = ok and nil or tostring(err) }
            if ok then
                passed = passed + 1
            else
                failed = failed + 1
            end
        end
    end

    return { path = args.path, total = #results, passed = passed, failed = failed, results = results }
end
