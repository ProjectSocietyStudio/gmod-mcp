import { z } from "zod";
import { defineTool } from "../mcp/registry.js";
import type { AnyToolDef } from "../mcp/registry.js";
import { parseLintOutput } from "../parse/lint.js";
import { parseRuntimeLog } from "../parse/runtime.js";
import {
  lintAddon,
  packageAddon,
  readGameLog,
  readStdoutLog,
  startServer,
  stopServer,
  syncConfig,
} from "../proc/scripts.js";
import type { Finding } from "../schemas.js";

function tally(findings: Finding[]): { errors: number; warnings: number } {
  return {
    errors: findings.filter((f) => f.severity === "error").length,
    warnings: findings.filter((f) => f.severity === "warning").length,
  };
}

/** Clips long text so a result does not drown the agent. */
function clip(s: string, max = 8000): string {
  return s.length > max ? s.slice(0, max) + `\n...(${s.length - max} bytes truncated)` : s;
}

const lint = defineTool({
  name: "lint",
  description:
    "Runs tools/lint.sh on an addon (name or path). Returns structured findings (file, line, rule) and the exit code. Exit 0 means clean.",
  realm: "local",
  inputSchema: { addon: z.string().min(1) },
  handler: async ({ addon }, ctx) => {
    const r = await lintAddon(ctx.config, addon);
    if (r.code === 2) {
      return { ok: false, exitCode: 2, error: r.stderr.trim() || "invalid usage or directory", findings: [] };
    }
    const findings = parseLintOutput(r.stdout);
    return {
      ok: r.code === 0,
      exitCode: r.code,
      ...tally(findings),
      findings,
      raw: clip(r.stdout),
    };
  },
});

const startServerTool = defineTool({
  name: "start_server",
  description:
    "Starts the dedicated server through tools/start-server.sh [map] [gamemode] [tickrate] and records the log's boot boundary. Script defaults: rp_nycity_day/darkrp/33.",
  realm: "local",
  inputSchema: {
    map: z.string().optional(),
    gamemode: z.string().optional(),
    tickrate: z.number().int().min(1).max(128).optional(),
  },
  handler: async (args, ctx) => {
    const { result, boot } = await startServer(ctx.config, args);
    return {
      ok: result.code === 0,
      exitCode: result.code,
      boot,
      stdout: clip(result.stdout),
      stderr: clip(result.stderr),
      note:
        result.code === 1
          ? "start-server.sh refused -- is the server already running? See stderr."
          : "Server started in the background. Give it around 45s, then call read_logs.",
    };
  },
});

const stopServerTool = defineTool({
  name: "stop_server",
  description: "Stops the dedicated server through tools/stop-server.sh.",
  realm: "local",
  inputSchema: {},
  handler: async (_args, ctx) => {
    const r = await stopServer(ctx.config);
    return { ok: r.code === 0, exitCode: r.code, stdout: clip(r.stdout), stderr: clip(r.stderr) };
  },
});

const syncConfigTool = defineTool({
  name: "sync_config",
  description:
    "Reapplies server-config/ and (re)creates the symlinks through tools/sync-server-config.sh. check:true compares without writing (--check).",
  realm: "local",
  inputSchema: { check: z.boolean().default(false) },
  handler: async ({ check }, ctx) => {
    const r = await syncConfig(ctx.config, check);
    return { ok: r.code === 0, exitCode: r.code, stdout: clip(r.stdout), stderr: clip(r.stderr) };
  },
});

const readLogs = defineTool({
  name: "read_logs",
  description:
    "Reads the server logs. source=game (Lua errors, -condebug) or stdout (the wrapper). sinceBoot:true bounds output to the current boot. errorsOnly:true returns structured runtime findings.",
  realm: "local",
  inputSchema: {
    source: z.enum(["game", "stdout"]).default("game"),
    sinceBoot: z.boolean().default(true),
    errorsOnly: z.boolean().default(true),
  },
  handler: ({ source, sinceBoot, errorsOnly }, ctx) => {
    if (source === "stdout") {
      const text = readStdoutLog(ctx.config);
      return errorsOnly
        ? { source, findings: parseRuntimeLog(text) }
        : { source, text: clip(text, 20000) };
    }
    const text = readGameLog(ctx.config, sinceBoot);
    if (!errorsOnly) return { source, sinceBoot, text: clip(text, 20000) };
    const findings = parseRuntimeLog(text);
    return { source, sinceBoot, count: findings.length, findings };
  },
});

const packageTool = defineTool({
  name: "package",
  description:
    "Builds an addon's .gma through tools/package-gma.sh, linting first and refusing on failure. Output lands in dist/.",
  realm: "local",
  inputSchema: { addon: z.string().min(1) },
  handler: async ({ addon }, ctx) => {
    const r = await packageAddon(ctx.config, addon);
    return { ok: r.code === 0, exitCode: r.code, stdout: clip(r.stdout), stderr: clip(r.stderr) };
  },
});

export const localTools: AnyToolDef[] = [
  lint,
  startServerTool,
  stopServerTool,
  syncConfigTool,
  readLogs,
  packageTool,
];
