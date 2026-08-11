/**
 * Process running lives in `@projectsociety/mcp-core`, shared with hammer-mcp. `stripAnsi` is
 * re-exported here because the lint parser reaches for it alongside `run`.
 */
export { run, stripAnsi, type RunOptions, type RunResult } from "@projectsociety/mcp-core";
