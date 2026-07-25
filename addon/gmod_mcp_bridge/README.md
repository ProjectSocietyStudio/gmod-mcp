# gmod_mcp_bridge

The GLua half of [gmod-mcp](../../README.md). It exposes runtime state — players, entities,
hooks, convars, net messages, timers — and lets an AI agent act on the server (console
commands, debug prints, test runs), plus reach the **client** through a relay.

**A development tool. Never mount it on a production server.**

## How it works

The daemon and srcds share a filesystem, so no network is involved. GMod's `HTTP()` was
measured not to reach a localhost daemon from a dedicated server, which is why the transport
is files rather than HTTP.

1. The daemon writes `garrysmod/data/gmod_mcp/cmd/<id>.json`, atomically (`.tmp` then rename)
   so the addon never reads a partial file.
2. The addon polls `cmd/`, deletes each file before running it — single consumption — and
   dispatches to a named handler in `lua/gmod_mcp_bridge/server/sv_handlers.lua`.
3. The result goes back as `res/<id>.json`.
4. Server Lua errors (`OnLuaError`) are pushed as `evt/<n>.json`.

Client-realm commands travel the same file channel. The server addon forwards them to a
connected player over a net message; the client runs the handler and sends the result back in
chunks, which the server reassembles into `res/`. The client never needs to share the disk —
it only needs to be connected.

Chunks are deliberately small and paced one per frame. Pushing a screenshot as 60 KB chunks in
a single frame overflows the client-to-server reliable channel, and that failure is silent and
persistent: once the channel is swamped, no net message from that client gets through at all.

## Install

Symlink it into your server's addons directory, rather than copying, so a SteamCMD `validate`
can never overwrite it:

```bash
ln -s /path/to/gmod-mcp/addon/gmod_mcp_bridge \
      /path/to/srcds/garrysmod/addons/gmod_mcp_bridge
```

The addon starts on `InitPostEntity`, not at load time: addon autoruns run *before*
`server.cfg`, so anything reading a cvar earlier gets the engine default rather than the
owner's setting.

## Checking it

```bash
./tools/lint.sh /path/to/gmod-mcp/addon/gmod_mcp_bridge   # four passes, must be green
```

Linting needs the host project's `tools/lint.sh` and a local copy of GLua API definitions —
see `.luarc.example.json`.

## run_lua

Arbitrary Lua execution is **not** included here: it would fail `glua-audit`, which forbids
dynamic execution. It lives in the optional
[`gmod_mcp_runlua`](../../optional/gmod_mcp_runlua) extension instead, so this addon stays
lint-clean.
