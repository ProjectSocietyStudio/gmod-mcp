# gmod_mcp_runlua (optional, DEVELOPMENT ONLY)

Adds the `run_lua` handler to the bridge: arbitrary server-side Lua execution, gated behind a
confirmation (`confirm: true` on the MCP side, propagated as `confirmed` to the bridge).

**Why it is kept out of the main bridge.** `run_lua` relies on `CompileString`, a form of
dynamic execution that `glua-audit` forbids — rightly — for any addon meant to be sold. Keeping
it here lets `gmod_mcp_bridge` stay entirely lint-clean, while this extension deliberately
fails the `exec-dynamique` rule. That failure is expected, not a defect.

**Never mount this on a production server.** It is a local iteration tool.

## Enable

```bash
ln -s /path/to/gmod-mcp/optional/gmod_mcp_runlua \
      /path/to/srcds/garrysmod/addons/gmod_mcp_runlua
# then restart the server
```

Requires the main bridge (`gmod_mcp_bridge`) to be loaded.
