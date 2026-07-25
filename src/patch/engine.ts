import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import type { Config } from "../config.js";
import { run } from "../proc/run.js";
import type { Patch } from "../schemas.js";

/** Enregistrement interne d'un patch (Patch public + infos de restauration). */
interface PatchRecord extends Patch {
  absFile: string;
  backupPath: string;
  /** Le fichier existait-il avant le patch ? (sinon, restaurer = supprimer). */
  existedBefore: boolean;
}

/**
 * Applique et annule des modifications de fichiers, avec sauvegarde et diff.
 * Périmètre verrouillé : refuse toute cible hors de la racine du repo.
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

  /** Résout une cible dans le repo ; lève si elle s'en échappe. */
  private resolveInsideRepo(file: string): string {
    const abs = resolve(this.config.repoRoot, file);
    const rel = relative(this.config.repoRoot, abs);
    if (rel.startsWith("..") || resolve(this.config.repoRoot, rel) !== abs) {
      throw new Error(`hors périmètre : ${file} est hors de ${this.config.repoRoot}`);
    }
    return abs;
  }

  private recordPath(id: string): string {
    return join(this.patchesDir, `${id}.json`);
  }

  /**
   * Remplace intégralement le contenu d'un fichier, après sauvegarde. Renvoie le
   * Patch (avec diff unifié). Crée le fichier s'il n'existe pas.
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

  /** Restaure l'état d'avant le patch. Idempotent après un premier restore. */
  restore(patchId: string): { ok: boolean; file: string; action: string } {
    const rp = this.recordPath(patchId);
    if (!existsSync(rp)) throw new Error(`patch inconnu : ${patchId}`);
    const rec = JSON.parse(readFileSync(rp, "utf8")) as PatchRecord;

    let action: string;
    if (rec.existedBefore) {
      copyFileSync(rec.backupPath, rec.absFile);
      action = "restauré depuis la sauvegarde";
    } else if (existsSync(rec.absFile)) {
      // Le fichier n'existait pas avant : on revient à cet état en le vidant.
      writeFileSync(rec.absFile, "");
      action = "fichier créé par le patch remis à vide";
    } else {
      action = "déjà absent";
    }

    const reverted: PatchRecord = { ...rec, revertedAt: Date.now() };
    writeFileSync(rp, JSON.stringify(reverted, null, 2));
    return { ok: true, file: rec.file, action };
  }

  /** Diff unifié via `diff -u` (exit 1 = fichiers différents, normal). */
  private async diff(oldPath: string, newPath: string, label: string): Promise<string> {
    const r = await run("diff", ["-u", "--label", `a/${label}`, "--label", `b/${label}`, oldPath, newPath]);
    return r.stdout;
  }
}
