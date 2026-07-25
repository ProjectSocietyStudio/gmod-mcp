import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Config } from "../config.js";
import { run } from "../proc/run.js";
import type { Patch } from "../schemas.js";

/** Internal record of a patch (the public Patch plus restore information). */
interface PatchRecord extends Patch {
  absFile: string;
  backupPath: string;
  /** Did the file exist before the patch? If not, restoring means emptying it. */
  existedBefore: boolean;
}

/**
 * Applies and reverts file changes, with a backup and a diff.
 * Locked scope: refuses any target outside the repo root.
 */
export class PatchEngine {
  private readonly config: Config;
  private readonly patchesDir: string;
  private readonly backupsDir: string;

  constructor(config: Config) {
    this.config = config;
    this.patchesDir = join(config.stateDir, "patches");
    this.backupsDir = join(config.stateDir, "backups");
    mkdirSync(this.patchesDir, { recursive: true });
    mkdirSync(this.backupsDir, { recursive: true });
  }

  /** Resolves a target inside the repo; throws if it escapes. */
  private resolveInsideRepo(file: string): string {
    const abs = resolve(this.config.repoRoot, file);
    const rel = relative(this.config.repoRoot, abs);
    if (rel.startsWith("..") || resolve(this.config.repoRoot, rel) !== abs) {
      throw new Error(`out of scope: ${file} lies outside ${this.config.repoRoot}`);
    }
    return abs;
  }

  private recordPath(id: string): string {
    return join(this.patchesDir, `${id}.json`);
  }

  /**
   * Replaces a file's entire contents after backing it up. Returns the Patch, with a
   * unified diff. Creates the file when it does not exist.
   */
  async applyFile(
    file: string,
    content: string,
    rationale: string,
    sessionId?: string,
  ): Promise<Patch> {
    const abs = this.resolveInsideRepo(file);
    const id = randomUUID();
    const backupPath = join(this.backupsDir, id);
    const existedBefore = existsSync(abs);

    if (existedBefore) copyFileSync(abs, backupPath);
    else writeFileSync(backupPath, ""); // marqueur "vide avant"

    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);

    const diff = await this.diff(existedBefore ? backupPath : "/dev/null", abs, file);
    const patch: Patch = {
      id,
      file: relative(this.config.repoRoot, abs),
      diff,
      rationale,
      appliedAt: Date.now(),
    };
    const record: PatchRecord = { ...patch, absFile: abs, backupPath, existedBefore };
    writeFileSync(this.recordPath(id), JSON.stringify(record, null, 2));
    return patch;
  }

  /** Restores the pre-patch state. Idempotent after the first restore. */
  restore(patchId: string): { ok: boolean; file: string; action: string } {
    const rp = this.recordPath(patchId);
    if (!existsSync(rp)) throw new Error(`patch inconnu : ${patchId}`);
    const rec = JSON.parse(readFileSync(rp, "utf8")) as PatchRecord;

    let action: string;
    if (rec.existedBefore) {
      copyFileSync(rec.backupPath, rec.absFile);
      action = "restored from backup";
    } else if (existsSync(rec.absFile)) {
      // The file did not exist before, so return to that state by emptying it.
      writeFileSync(rec.absFile, "");
      action = "file created by the patch was emptied";
    } else {
      action = "already absent";
    }

    const reverted: PatchRecord = { ...rec, revertedAt: Date.now() };
    writeFileSync(rp, JSON.stringify(reverted, null, 2));
    return { ok: true, file: rec.file, action };
  }

  /** Unified diff via `diff -u` (exit 1 means the files differ, which is expected). */
  private async diff(oldPath: string, newPath: string, label: string): Promise<string> {
    const r = await run("diff", ["-u", "--label", `a/${label}`, "--label", `b/${label}`, oldPath, newPath]);
    return r.stdout;
  }
}
