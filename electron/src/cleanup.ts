import { lstat, open, mkdir, rename, link, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { HwpItem } from "./engine";

type Phase = "idle" | "running" | "rollingBack" | "done" | "rolledBack" | "error";
interface Entry { source: string; target: string; backup: string; quarantine: string; hash: string; targetHash: string; mode: number; atime: number; mtime: number; intent: boolean; restored: boolean }
interface Journal { version: 1; id: string; directory: string; phase: Phase; entries: Entry[] }
const sha256 = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
const errorText = (error: unknown): string => error instanceof Error ? error.message : String(error);

async function assertSafe(file: string, finalMayBeAbsent = false): Promise<void> {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) throw new Error("절대 정규 경로가 필요합니다");
  const parsed = path.parse(file), parts = file.slice(parsed.root.length).split(path.sep).filter(Boolean);
  let current = parsed.root;
  for (let index = 0; index < parts.length; index++) {
    current = path.join(current, parts[index]);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || (index < parts.length - 1 && !info.isDirectory())) throw new Error(`안전하지 않은 경로: ${current}`);
    } catch (error) {
      if (finalMayBeAbsent && index === parts.length - 1 && isMissing(error)) return;
      throw error;
    }
  }
}
async function fsyncDirectory(directory: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(directory, constants.O_RDONLY);
  try { await handle.sync(); } finally { await handle.close(); }
}
async function readRegular(file: string): Promise<Buffer> {
  await assertSafe(file);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
  try {
    if (!(await handle.stat()).isFile()) throw new Error(`일반 파일이 아닙니다: ${file}`);
    return await handle.readFile();
  } finally { await handle.close(); }
}
async function exists(file: string): Promise<boolean> {
  try { await lstat(file); return true; } catch (error) { if (isMissing(error)) return false; throw error; }
}
async function writeExclusive(file: string, data: Buffer, entry: Entry): Promise<void> {
  await assertSafe(file, true);
  const handle = await open(file, "wx", entry.mode);
  try {
    await handle.writeFile(data); await handle.chmod(entry.mode);
    await handle.utimes(entry.atime / 1000, entry.mtime / 1000); await handle.sync();
  } finally { await handle.close(); }
  await fsyncDirectory(path.dirname(file));
  if (sha256(await readRegular(file)) !== entry.hash) throw new Error(`복사 검증 실패: ${file}`);
}

export class Cleanup {
  private journal?: Journal;
  private active = false;
  private cancelled = false;
  private phase: Phase = "idle";
  private processed = 0;
  private note = "원본 정리는 무손실 서식 인증이 아닙니다";
  constructor(private readonly journalPath: string) {}
  get busy(): boolean { return this.active; }
  snapshot(): { phase: Phase; total: number; processed: number; percent: number; message: string; canRollback: boolean } {
    const total = this.journal?.entries.length ?? 0;
    const visiblePhase = this.active && !["running", "rollingBack"].includes(this.phase)
      ? (this.journal?.phase === "running" ? "running" : "rollingBack") : this.phase;
    return { phase: visiblePhase, total, processed: this.processed, percent: total ? Math.floor(this.processed / total * 100) : 0, message: this.note, canRollback: !this.active && !!this.journal?.entries.some(entry => entry.intent && !entry.restored) };
  }
  cancel(): void { this.cancelled = true; }
  private abortIfCancelled(): void { if (this.cancelled) throw new Error("원본 정리가 취소되었습니다"); }
  private async save(): Promise<void> {
    if (!this.journal) return;
    await assertSafe(this.journalPath, true);
    const temporary = `${this.journalPath}.${randomUUID()}.tmp`;
    const handle = await open(temporary, "wx", 0o600);
    try { await handle.writeFile(JSON.stringify(this.journal)); await handle.sync(); } finally { await handle.close(); }
    await rename(temporary, this.journalPath); await fsyncDirectory(path.dirname(this.journalPath));
  }
  private async archiveRolledBack(): Promise<void> {
    if (!this.journal || this.journal.phase !== "rolledBack") return;
    const archive = `${this.journalPath}.archive-${this.journal.id}.json`;
    await assertSafe(archive, true); await rename(this.journalPath, archive); await fsyncDirectory(path.dirname(this.journalPath));
    this.journal = undefined;
  }
  async start(files: HwpItem[], backupDir: string): Promise<void> {
    if (this.active) throw new Error("원본 정리 작업이 진행 중입니다");
    this.active = true; this.cancelled = false; this.processed = 0;
    try {
      await this.archiveRolledBack();
      if (this.journal) throw new Error("이전 정리 작업을 먼저 복원해야 합니다");
      if (await exists(this.journalPath)) throw new Error("기존 정리 기록이 있습니다. 먼저 restore를 호출해야 합니다");
      backupDir = path.resolve(backupDir); await assertSafe(backupDir);
      if (!(await lstat(backupDir)).isDirectory()) throw new Error("백업 폴더가 아닙니다");
      const id = randomUUID(), directory = path.join(backupDir, `hwp2x-cleanup-${id}`), entries: Entry[] = [], seen = new Set<string>();
      for (const item of files) {
        if (item.status !== "ok" || item.owned?.status !== "ok" || !item.target || path.extname(item.source).toLowerCase() !== ".hwp" || !/^[a-f0-9]{64}$/.test(item.owned.sourceHash) || !/^[a-f0-9]{64}$/.test(item.owned.targetHash)) continue;
        const source = path.resolve(item.source), target = path.resolve(item.target);
        if (source === target || seen.has(source)) continue;
        seen.add(source); await assertSafe(source); await assertSafe(target);
        const info = await lstat(source); if (!info.isFile()) throw new Error("원본이 일반 파일이 아닙니다");
        const index = entries.length;
        entries.push({ source, target, backup: path.join(directory, `${index}.hwp`), quarantine: path.join(path.dirname(source), `.${path.basename(source)}.hwp2x-cleanup-${id}-${index}`, "original.bin"), hash: item.owned.sourceHash, targetHash: item.owned.targetHash, mode: info.mode & 0o777, atime: info.atimeMs, mtime: info.mtimeMs, intent: false, restored: false });
      }
      if (!entries.length) throw new Error("정리할 검증된 HWP 원본이 없습니다");
      await mkdir(directory, { mode: 0o700 }); await fsyncDirectory(backupDir);
      this.journal = { version: 1, id, directory, phase: "running", entries }; this.phase = "running"; await this.save();
      for (const entry of entries) {
        this.abortIfCancelled();
        if (sha256(await readRegular(entry.source)) !== entry.hash || sha256(await readRegular(entry.target)) !== entry.targetHash) throw new Error("원본 또는 결과가 변경되었습니다");
        await mkdir(path.dirname(entry.quarantine), { mode: 0o700 }); await fsyncDirectory(path.dirname(entry.source));
        const original = await readRegular(entry.source);
        if (sha256(original) !== entry.hash) throw new Error("원본이 변경되었습니다");
        await writeExclusive(entry.backup, original, entry);
        // Probe the exact no-overwrite recovery primitive before moving the original.
        const probe = path.join(path.dirname(entry.quarantine), "recovery-probe");
        await link(entry.source, probe);
        await fsyncDirectory(path.dirname(probe));
        await unlink(probe);
        await fsyncDirectory(path.dirname(probe));
        if (sha256(await readRegular(entry.source)) !== entry.hash || sha256(await readRegular(entry.target)) !== entry.targetHash) throw new Error("원본 또는 결과가 변경되었습니다");
        entry.intent = true; await this.save(); this.abortIfCancelled();
        await assertSafe(entry.quarantine, true); await rename(entry.source, entry.quarantine);
        await fsyncDirectory(path.dirname(entry.quarantine)); await fsyncDirectory(path.dirname(entry.source));
        const quarantined = await readRegular(entry.quarantine);
        if (sha256(quarantined) !== entry.hash) throw new Error("격리한 원본이 변경되었습니다");
        if (sha256(await readRegular(entry.target)) !== entry.targetHash) throw new Error("결과가 변경되었습니다");
        if (sha256(await readRegular(entry.backup)) !== entry.hash) throw new Error("백업이 변경되었습니다");
        this.abortIfCancelled();
        this.processed++; await this.save();
      }
      this.phase = this.journal.phase = "done"; this.note = "백업 검증 후 원본 정리 완료 — 무손실 서식 인증 아님"; await this.save();
    } catch (error) {
      this.note = errorText(error);
      try { if (this.journal) await this.undo(); else this.phase = "error"; }
      catch (rollbackError) { this.phase = "error"; this.note += ` / 복구 필요: ${errorText(rollbackError)}`; if (this.journal) { this.journal.phase = "error"; await this.save().catch(() => {}); } }
    } finally { this.active = false; }
  }
  private async undo(): Promise<void> {
    if (!this.journal) return;
    this.phase = this.journal.phase = "rollingBack"; this.processed = this.journal.entries.filter(entry => entry.restored || !entry.intent).length; await this.save();
    const errors: string[] = [];
    for (const entry of [...this.journal.entries].reverse()) {
      if (!entry.intent || entry.restored) continue;
      try {
        if (await exists(entry.source)) {
          if (sha256(await readRegular(entry.source)) !== entry.hash) throw new Error(`기존 파일 충돌: ${entry.source}`);
          if (await exists(entry.quarantine)) {
            const sourceInfo = await lstat(entry.source), quarantineInfo = await lstat(entry.quarantine);
            if (sourceInfo.dev !== quarantineInfo.dev || sourceInfo.ino !== quarantineInfo.ino) throw new Error(`기존 파일 충돌: ${entry.source}`);
          }
        } else if (await exists(entry.quarantine)) {
          if (sha256(await readRegular(entry.quarantine)) !== entry.hash) throw new Error(`격리 파일 손상: ${entry.quarantine}`);
          await assertSafe(entry.source, true); await link(entry.quarantine, entry.source); await fsyncDirectory(path.dirname(entry.source));
        } else {
          const data = await readRegular(entry.backup); if (sha256(data) !== entry.hash) throw new Error(`백업 손상: ${entry.backup}`);
          await writeExclusive(entry.source, data, entry);
        }
        entry.restored = true; this.processed++; await this.save();
      } catch (error) { errors.push(errorText(error)); }
    }
    if (errors.length) throw new Error(errors.join(" / "));
    this.phase = this.journal.phase = "rolledBack"; await this.save();
  }
  async rollback(): Promise<void> {
    if (this.active) throw new Error("원본 정리 작업이 진행 중입니다");
    this.active = true;
    try { await this.undo(); this.note = "원본 복원 완료 — 백업 유지"; }
    catch (error) { this.phase = "error"; this.note = errorText(error); if (this.journal) { this.journal.phase = "error"; await this.save().catch(() => {}); } }
    finally { this.active = false; }
  }
  async restore(): Promise<void> {
    if (this.active) throw new Error("원본 정리 작업이 진행 중입니다");
    this.active = true;
    try {
      let raw: Buffer; try { raw = await readRegular(this.journalPath); } catch (error) { if (isMissing(error)) { this.phase = "idle"; return; } throw error; }
      const journal = JSON.parse(raw.toString()) as Journal;
      if (!journal || journal.version !== 1 || typeof journal.id !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(journal.id) || typeof journal.directory !== "string" || !path.isAbsolute(journal.directory) || path.resolve(journal.directory) !== journal.directory || path.basename(journal.directory) !== `hwp2x-cleanup-${journal.id}` || !Array.isArray(journal.entries) || !journal.entries.length || !["running", "rollingBack", "done", "rolledBack", "error"].includes(journal.phase)) throw new Error("정리 기록이 유효하지 않습니다");
      const seen = new Set<string>();
      for (const [index, entry] of journal.entries.entries()) {
        if (!entry || typeof entry.source !== "string" || typeof entry.target !== "string") throw new Error("정리 항목이 유효하지 않습니다");
        const expectedQuarantine = path.join(path.dirname(entry.source), `.${path.basename(entry.source)}.hwp2x-cleanup-${journal.id}-${index}`, "original.bin");
        if (!path.isAbsolute(entry.source) || path.resolve(entry.source) !== entry.source || !path.isAbsolute(entry.target) || path.resolve(entry.target) !== entry.target || path.extname(entry.source).toLowerCase() !== ".hwp" || entry.source === entry.target || seen.has(entry.source) || entry.backup !== path.join(journal.directory, `${index}.hwp`) || entry.quarantine !== expectedQuarantine || !/^[a-f0-9]{64}$/.test(entry.hash) || !/^[a-f0-9]{64}$/.test(entry.targetHash) || !Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777 || !Number.isFinite(entry.atime) || !Number.isFinite(entry.mtime) || typeof entry.intent !== "boolean" || typeof entry.restored !== "boolean") throw new Error("정리 항목이 유효하지 않습니다");
        if (entry.source.startsWith(journal.directory + path.sep) || entry.target.startsWith(journal.directory + path.sep) || entry.source === journal.directory || entry.target === journal.directory || (entry.restored && !entry.intent)) throw new Error("정리 경로 관계가 유효하지 않습니다");
        await assertSafe(entry.source, true); await assertSafe(entry.target, true);
        if (await exists(path.dirname(entry.quarantine))) await assertSafe(entry.quarantine, true);
        await assertSafe(entry.backup, true);
        seen.add(entry.source);
      }
      await assertSafe(journal.directory); this.journal = journal; this.phase = journal.phase;
      this.processed = journal.phase === "done" ? journal.entries.length : journal.entries.filter(entry => entry.restored).length;
      if (journal.phase !== "done" && journal.phase !== "rolledBack") await this.undo();
      this.note = journal.phase === "done" ? "이전 정리 완료 기록 — 원본 복원 가능" : "이전 정리 복구 완료";
    } catch (error) { this.phase = "error"; this.note = `복구 필요: ${errorText(error)}`; }
    finally { this.active = false; }
  }
}
