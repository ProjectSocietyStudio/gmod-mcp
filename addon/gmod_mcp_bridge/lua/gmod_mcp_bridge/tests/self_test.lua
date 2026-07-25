-- Exemple de fichier de test pour le moteur run_test. Exécuté côté serveur via
-- include() par le handler run_test. Chemin à passer : "gmod_mcp_bridge/tests/self_test.lua".
--
-- Un fichier de test RETOURNE une table { ["nom du cas"] = function(t) ... end }.
-- Il n'est jamais auto-exécuté (hors de autorun/), seulement chargé à la demande.
return {
    ["arithmétique de base"] = function(t)
        t.eq(1 + 1, 2)
        t.neq(1, 2)
    end,

    ["read_runtime renvoie la map"] = function(t)
        local rt = GMODMCP.Handlers.read_runtime()
        t.truthy(istable(rt))
        t.truthy(isstring(rt.map))
    end,

    ["read_players renvoie un compte numérique"] = function(t)
        local rp = GMODMCP.Handlers.read_players()
        t.truthy(isnumber(rp.count))
    end,
}
