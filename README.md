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

**One daemon per transport directory**, enforced by `daemon.lock` (PID inside, stale locks
reclaimed). The protocol *consumes* `res/`, so a second daemon reading the same directory
deletes results the first one is waiting for: the command really ran, the result really was
written, and the caller still times out. That is what happens the moment a second Claude Code
session is opened on the same repo — measured 2026-07-25, and it cost forty minutes because
the symptom accuses the game. Every bridge tool timed out while srcds was healthy and the
addon mounted; reconnecting the client and restarting the server changed nothing, since the
interfering state lived in a third process. Diagnose it with:

```bash
ps -eo pid,etime,args | grep gmod-mcp/dist/index.js   # more than one line is the bug
```

A daemon that cannot take the lock keeps its MCP tools but touches nothing: no scanner, no
commands written, and every bridge call refuses with the owner's PID. `health` reports the
same under `bridge.transport`. A `res/` file matching no in-flight command is now left alone
for a grace period rather than deleted on sight — blind cleanup is what turned coexistence
into an outage — and the count of such files is reported, because on a single-daemon setup it
should be zero.

**Client realm.** The daemon writes a `cl` command down the same file channel; the server addon
routes it to the client over a net message; the client runs it and sends the result back, in
chunks reassembled server-side into `res/`. No HTTP, and the client can be on any machine as
long as it is **connected to the server**. The target is the first player, or `args.player`
(SteamID).

Chunks are small and paced one per frame, drained one result at a time, and capped at 48
chunks per result. All three came from the same failure, met twice.

An early version pushed 60 KB chunks in a single frame, which overflowed the client-to-server
reliable channel (`send reliable stream overflow`) and timed the client out. That failure is
persistent and silent — once the channel is swamped, *no* net message from that client gets
through, so every client tool times out and the relay looks broken when it has merely been
flooded.

Per-frame pacing alone was not enough. Measured on a real player: a full-screen capture at
quality 80 came to 424 KB and 62 chunks and dropped them from the server, while a full-screen
q70 capture (100 KB, 15 chunks) had gone through fine minutes earlier. Two things were wrong.
Each result had its own timer, so several in flight summed on the same channel and the pacing
stopped meaning anything — a caller retrying a command it believes was lost has two captures
in flight, and the second is what tips it over. And nothing bounded a single result. Now one
drain serialises every result, and anything over 48 chunks is refused with its size and a
suggestion instead of sent. The default half-scale capture is about six chunks.

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

**Server, reading** — `batch`, `read_runtime`, `read_players`, `read_entities`,
`inspect_entity`, `read_hooks`, `read_convars`, `read_net_messages`, `read_timers`,
`run_console_command`, `send_debug`, `run_test`, `run_lua` (guarded, optional extension).

**Server, acting** (all guarded) — `spawn_entity`, `world_edit`, `set_player_state`,
`force_hook`.

**Client (via bridge)** — `read_view`, `client_input`, `read_panels`, `inspect_panel`,
`capture_screen`, `read_console`, `read_client_convars`.

`health` also asks the addon which handlers it registered and reports any the daemon
declares but the game does not have. That gap used to surface only as an "unknown handler"
after a full round trip, or — when a whole `include` was missing — not at all. It reports the
transport state alongside: whether this daemon owns the directory and who holds it otherwise,
what is in flight, how long since the addon last answered, and how many `res/` files matched
nothing of ours. Start every "nothing responds" investigation there.

`capture_screen` returns a real image content block. Returned as text, a base64 JPEG is
billed to the model token by token and still cannot be looked at, so the "see" half of an
act/see loop silently does nothing while every test passes.

## Acting

The reading tools diagnose; the acting ones set up what is worth diagnosing. Server-side,
`spawn_entity` places something, `world_edit` moves, freezes, heals, arms or removes it,
`set_player_state` sets money, job, salary or RP name, and `force_hook` runs a gamemode
hook directly.

Money goes through the r-capitalism ledger when it is loaded. That ledger holds an audited
invariant — `sum(balances) == issued - burned` — and a raw `addMoney` would move a balance
without an entry, leaving the drift permanently off zero. A debugging tool must not corrupt
what is being debugged. Amounts are integer cents, as the rest of that server economy is.

`force_hook` coerces tagged arguments, because JSON cannot carry a game object:
`{"__ent": 3}`, `{"__ply": "STEAM_0:1:2"}`, `{"__vec": [x,y,z]}`, `{"__ang": [p,y,r]}`.

Client-side, `client_input` drives the connected GMod client — movement, aim, key holds,
Derma clicks, typing, chat — and `read_view` reports eye position, aim trace, cursor,
hovered panel and keyboard focus. `read_view` is the cheap half of an act-then-look loop:
one chunk, no image, and it answers "am I aimed at the door" without a screenshot.

`client_input` is bounded in Lua rather than guarded behind a confirmation. It drives a
real person's machine, and a prompt clicked two hundred times is not a safety property:
holds expire, durations are seconds and clamped to five, a 30s deadline resets everything,
and `gmod_mcp_release` in the client console returns control without involving the daemon.

## Batching

A bridge round trip costs about 0.4s: the addon polls at 0.25s and the daemon scans at
0.15s. Any sequence that acts and then looks pays that per gesture. `batch` carries up to
32 server steps in one command instead:

```json
{ "steps": [{"tool": "read_runtime"},
            {"tool": "read_timers", "args": {"names": ["gmod_mcp_bridge_poll"]}}],
  "settleMs": 100 }
```

Measured against a live DarkRP server: three steps in 0.19s, versus roughly 0.75s as three
separate calls.

A failing step is data, not a transport error — each step reports its own `ok`/`data`/
`error`, `stopOnError` marks the rest `skipped` and records `abortedAt`, so the caller sees
the whole shape of the batch. `settleMs` pauses between steps, which is what makes
act-then-look honest: without it a step observes the frame before the previous one landed.

Guarded tools are checked on both sides. `batch` is a single unguarded definition, so
without the check a `run_lua` step would bypass the confirmation its own gate demands; the
daemon resolves each step against the registry and the Lua runner repeats the check.

Any argument may instead be `{"__step": 1, "get": "index"}`, read from an earlier step's
result. Without it, spawning something and then acting on it costs two round trips — the
caller cannot know the EntIndex until the spawn has answered, which is the round trip
batching exists to remove.

Steps share a server tick unless `settleMs` is set, and some engine effects only land at
end of frame: `Entity:Remove()` is deferred, so a step reading the entity back still finds
it valid and the agent concludes the removal failed. Set `settleMs` (100 is usually enough)
whenever a step must observe an earlier one.

Client-realm steps are refused explicitly rather than silently dropped — a batch runs
inside the server addon, and `cl` tools are relayed over net. So an act-then-look loop on
the client is currently two round trips, not one.

All three realms have been exercised against a live DarkRP server: the server tools on
`rp_nycity_day` at tick 33, and the client tools against a connected GMod client —
`read_panels` returning a live VGUI tree and `capture_screen` returning a complete 1920x1080
JPEG. `batch` was proven the same way, including its failure paths: a step raising returns
the real Lua error with `file:line`, the rest come back `skipped`, and a `run_lua` step is
refused unconfirmed and executes confirmed.

## Security

- Guarded tools (`run_lua`) require `confirm: true` or membership in `toolAllowlist`; otherwise
  they are refused without executing. A guarded tool used as a `batch` step needs the batch
  itself confirmed, and both the daemon and the Lua runner enforce that independently. Every call, result, patch and executed Lua line is
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
  "clientWaitMs": 30000,
  "toolAllowlist": [],
  "plugins": []
}
```

`clientWaitMs` is how long a client-realm call keeps retrying while the client is absent.
That realm needs a human connected, and humans crash, alt-tab and reconnect; retrying lets an
agent resume when they come back instead of failing the moment they drop. Set it to 0 to fail
fast. Server-realm calls ignore it — srcds does not come and go mid-session, so a failure there
is a real one.

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
