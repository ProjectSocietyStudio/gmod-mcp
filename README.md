# gmod-mcp

A **local-first MCP server** for AI-assisted Garry's Mod addon development. It plugs into
Claude Code the way `claude-in-chrome` does: agents discover the MCP tools and iterate on
their own — lint → boot → observe runtime → patch → validate. **No web app, no UI.**

Two halves:

- **`gmod-mcp`** — the MCP server, TypeScript/Node, **stdio** transport.
- **`gmod_mcp_bridge`** (`addon/gmod_mcp_bridge`) — a GLua addon exposing server state over a
  **file transport** inside GMod's DATA sandbox. The daemon and srcds share a filesystem, so
  no network is involved. This is not a stylistic choice: GMod's `HTTP()` was measured not to
  reach a localhost daemon from a dedicated server.

## What it buys you

You talk about the addon in plain language while the model sees the actual game state —
*"why does this net message never fire?"*, *"fix this error"*, *"show me that menu"*. The
agent lints, boots the server, reads structured Lua errors, patches, reloads and re-validates,
in a loop.

## Install

```bash
pnpm install && pnpm build

# Register the server with Claude Code (project scope, committable):
node dist/index.js install
#   -> writes <repoRoot>/.mcp.json
```

CLI alternative:
`claude mcp add gmod-mcp -e GMOD_MCP_REPO=<repoRoot> -- node <abs>/dist/index.js`

The daemon finds the repo root by walking up from the cwd looking for `tools/lint.sh` and
`CLAUDE.md`, or via `GMOD_MCP_REPO`, or via `.gmod-mcp/config.json`.

The bridge addon must be mounted by your dedicated server. Symlink it rather than copying, so
a SteamCMD `validate` can never overwrite it:

```bash
ln -s /path/to/gmod-mcp/addon/gmod_mcp_bridge \
      /path/to/srcds/garrysmod/addons/gmod_mcp_bridge
```

## Transport

**Server realm.** The daemon writes `srcds/garrysmod/data/gmod_mcp/cmd/<id>.json` atomically;
the addon reads it, runs it, writes `res/<id>.json` and deletes the command. Events (Lua
errors, `bridge_up`) arrive as `evt/<n>.json`. The daemon polls `res/` and `evt/`. No port, no
token, no handshake.

**Client realm.** The daemon writes a `cl` command down the same file channel; the server addon
routes it to the client over a net message; the client runs it and sends the result back, in
chunks reassembled server-side into `res/`. No HTTP, and the client can be on any machine as
long as it is **connected to the server**. The target is the first player, or `args.player`
(SteamID).

Chunks are small and paced one per frame. This matters: an earlier version pushed 60 KB chunks
in a single frame, which overflowed the client-to-server reliable channel (`send reliable
stream overflow`) and eventually timed the client out. That failure is persistent and silent —
once the channel is swamped, *no* net message from that client gets through, so every client
tool times out and the relay looks broken when it has merely been flooded.

## Iteration loop

`edit → lint → (boot) → observe → patch → reload → validate → repeat`

The daemon shells out to the host project's `tools/lint.sh`, `start-server.sh` and
`server-log.sh`, parsing `file:line:` and exit codes. It also encodes the traps that cost real
debugging time: the boot boundary inside an accumulating `console.log`, waiting for
`InitPostEntity` before reading cvars, the queueing latency of `game.ConsoleCommand`, and
NUL-safe log reads.

## Tool catalogue

**Local (daemon)** — `health`, `lint`, `start_server`, `stop_server`, `sync_config`,
`read_logs`, `package`, `patch_file`, `restore_patch`, `reload_file`, `reload_addon`,
`validate`, `run_iteration`.

**Server (via bridge)** — `read_runtime`, `read_players`, `read_entities`, `inspect_entity`,
`read_hooks`, `read_convars`, `read_net_messages`, `read_timers`, `run_console_command`,
`send_debug`, `run_test`, `run_lua` (guarded, optional extension).

**Client (via bridge)** — `read_panels`, `inspect_panel`, `capture_screen`, `read_console`,
`read_client_convars`.

All three realms have been exercised against a live DarkRP server: the server tools on
`rp_nycity_day` at tick 33, and the client tools against a connected GMod client —
`read_panels` returning a live VGUI tree and `capture_screen` returning a complete 1920x1080
JPEG.

## Security

- Guarded tools (`run_lua`) require `confirm: true` or membership in `toolAllowlist`; otherwise
  they are refused without executing. Every call, result, patch and executed Lua line is
  appended to `<repoRoot>/.gmod-mcp/logs/audit.jsonl`.
- `patch_file` is locked to the repo root and refuses paths outside it.
- No network listener. The server transport is files inside DATA; the MCP layer is stdio. The
  trust boundary is the local filesystem.
- `run_lua` — arbitrary Lua execution — lives in the **optional** `optional/gmod_mcp_runlua`
  extension, isolated because `glua-audit` forbids dynamic execution and the main bridge stays
  lint-clean. **Development only, never on a production server.**

## Project config — `<repoRoot>/.gmod-mcp/config.json`

Every key is optional (see `config.example.json`):

```json
{
  "repoRoot": ".",
  "addons": ["gmod_mcp_bridge"],
  "toolAllowlist": [],
  "plugins": []
}
```

## Plugins

Extend the tool set with ESM modules listed in `plugins`. Each module exports `tools`:

```js
// my_plugin.mjs
export const tools = [
  { name: "my_tool", description: "…", realm: "local", inputSchema: {}, handler: () => ({ ok: true }) },
];
```

A failing plugin is reported on stderr without blocking startup.

## Development

```bash
pnpm test        # vitest
pnpm typecheck
pnpm build
```

Linting the GLua addon needs the host project's `tools/lint.sh` (four passes) plus a local
copy of GLua API definitions — see `addon/gmod_mcp_bridge/.luarc.example.json`.

## License

MIT. See [LICENSE](LICENSE).
