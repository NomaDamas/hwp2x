import { readdir, readFile, stat, lstat, open, link, unlink, mkdtemp, rm, mkdir, copyFile, rename } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { setImmediate as yieldToUI } from "node:timers/promises";
import { compare, convertToHwpx, parse, validateHwpx } from "kordoc";
import { convertWithHancom, type HancomCandidate } from "./hancom";

export type FileStatus = "wait" | "conv" | "ok" | "diff" | "fail" | "deleted" | "skipped";
export interface Check { label: string; value: string; color: string }
export interface Verification {
  contentMatch: boolean;
  layoutVerified: false;
  lossless: false;
  limitation: string;
  stats: { added: number; removed: number; modified: number; unchanged: number };
  warnings: string[];
}
export interface HwpItem {
  id: number;
  name: string;
  dir: string;
  source: string;
  size: number;
  targetSize: number;
  status: FileStatus;
  message: string;
  /** One short line for the progress view: why the file was skipped or failed. */
  reason?: string;
  target?: string;
  mdPath?: string;
  checks?: Check[];
  verification?: Verification;
  owned?: { sourceHash: string; targetHash: string; markdownHash?: string; status: "ok" | "diff" };
}
export interface EngineState {
  phase: "idle" | "scanning" | "converting" | "paused" | "done";
  root: string;
  files: HwpItem[];
  /** Folders under the root that could not be opened during the last scan. */
  skippedDirs: string[];
  workers: number;
  hancomPath: string;
  hancomName: string;
  hancomCandidates: HancomCandidate[];
  message: string;
  startedAt: number;
  endedAt: number;
  autoBackup: boolean;
  makeMarkdown: boolean;
  backupDir: string;
}
export interface EngineOptions {
  workers?: number;
  makeMarkdown?: boolean;
  autoBackup?: boolean;
  backupDir?: string;
  hancomPath?: string;
}
const LIMITATION = "내용 비교만으로 글꼴·쪽 배치·도형 등 전체 서식의 무손실을 증명할 수 없어 원본 백업 후 삭제를 지원하지 않습니다";
const EXCLUDED = new Set(["$recycle.bin", "system volume information", "windows", "program files", "program files (x86)", "node_modules", "hwp2x_백업"]);
const arrayBuffer = (data: Uint8Array): ArrayBuffer => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

const digest = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");
const resourceError = (error: unknown): boolean => ["ENOSPC", "ENOMEM", "EMFILE", "ENFILE"].includes((error as NodeJS.ErrnoException)?.code ?? "");
async function matches(file: string, hash: string): Promise<boolean> {
  try { return (await lstat(file)).isFile() && digest(await readFile(file)) === hash; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
// The system drive is where Windows lives (SystemDrive, normally C:); elsewhere it is the filesystem root.
export function mainDrive(platform: NodeJS.Platform = process.platform, env: NodeJS.ProcessEnv = process.env): string {
  if (platform !== "win32") return "/";
  const drive = /^[A-Za-z]:$/.test(env.SystemDrive ?? "") ? env.SystemDrive!.toUpperCase() : "C:";
  return `${drive}\\`;
}

export async function verifyConversion(source: Uint8Array, target: Uint8Array, warnings: string[] = []): Promise<Verification> {
  const result = await compare(arrayBuffer(source), arrayBuffer(target));
  return {
    contentMatch: result.stats.added + result.stats.removed + result.stats.modified === 0,
    layoutVerified: false, lossless: false, limitation: LIMITATION,
    stats: result.stats, warnings,
  };
}

// Publish only a fully written file; hard-link creation is exclusive even against symlinks.
// Filesystems without hard-link support fail explicitly rather than exposing partial outputs.
async function publish(target: string, data: Uint8Array | string): Promise<void> {
  const temporary = path.join(path.dirname(target), `.hwp2x-${randomUUID()}.tmp`);
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(data);
    await handle.sync();
    await handle.close();
    await link(temporary, target);
  } finally {
    await handle.close().catch(() => undefined);
    await unlink(temporary);
  }
}
async function ensureAbsent(target: string): Promise<void> {
  try { await lstat(target); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const error = new Error(`기존 출력 파일을 덮어쓰지 않습니다: ${target}`) as NodeJS.ErrnoException;
  error.code = "EEXIST";
  throw error;
}
// Map the detailed error to one plain line for the progress list; the full text stays in `message`.
function shortReason(error: unknown, saved: boolean): string {
  const text = error instanceof Error ? error.message : "";
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (saved) return "HWPX는 저장했지만 MD 저장 실패";
  if (code === "EACCES" || code === "EPERM") return "파일 접근 권한이 없음";
  if (code === "ENOENT") return "원본 파일을 찾을 수 없음";
  if (code === "ENOSPC") return "저장 공간 부족";
  if (text.startsWith("원본 파싱 실패")) return "원본을 읽을 수 없음 (손상되었거나 HWP가 아님)";
  if (text.startsWith("지원하지 않는 원본 형식")) return "지원하지 않는 문서 형식";
  if (text.startsWith("HWPX 구조 검증 실패") || text.startsWith("변환 결과 파싱 실패")) return "변환 결과 검증 실패";
  if (text.startsWith("변환 중 원본이 변경")) return "변환 중 원본이 바뀌어 저장 안 함";
  return "변환 실패";
}

export class Engine {
  state: EngineState = {
    phase: "idle", root: "", files: [], skippedDirs: [], workers: 2, autoBackup: false,
    makeMarkdown: true, backupDir: "", hancomPath: "", hancomName: "kordoc 4.24.42", hancomCandidates: [], message: "준비됨", startedAt: 0, endedAt: 0,
  };
  private cancel = false;
  private busy = false;
  private saves: Promise<void> = Promise.resolve();
  private idleWaiters: Array<() => void> = [];
  private fatal: unknown;

  constructor(private readonly checkpointPath?: string) {}

  private release(): void {
    this.busy = false;
    for (const resolve of this.idleWaiters.splice(0)) resolve();
  }

  private halt(error: unknown): void {
    this.cancel = true;
    this.fatal ??= error;
    this.state.message = `안전 중단: ${error instanceof Error ? error.message : String(error)}`;
    if (!this.busy) this.state.phase = "paused";
  }

  async checkpoint(): Promise<void> {
    if (!this.checkpointPath) return;
    const data = JSON.stringify({ version: 1, state: this.state });
    const save = this.saves.catch(() => undefined).then(async () => {
      const destination = this.checkpointPath!;
      await mkdir(path.dirname(destination), { recursive: true });
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        const handle = await open(temporary, "wx", 0o600);
        try { await handle.writeFile(data); await handle.sync(); }
        finally { await handle.close(); }
        // Never unlink the previous checkpoint: a failed replacement must preserve it.
        await rename(temporary, destination);
        if (process.platform !== "win32") {
          const dir = await open(path.dirname(destination), "r");
          try { await dir.sync(); } finally { await dir.close(); }
        }
      } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
    }).catch(error => { this.halt(error); throw error; });
    this.saves = save;
    await save;
  }

  async restore(): Promise<boolean> {
    if (this.busy) throw new Error("작업 중에는 복원할 수 없습니다");
    if (!this.checkpointPath) return false;
    let saved;
    try { saved = JSON.parse(await readFile(this.checkpointPath, "utf8")); }
    catch (error) {
      if (error instanceof SyntaxError || (error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
    const state = saved?.state as EngineState | undefined;
    if (saved?.version !== 1 || !state || typeof state.root !== "string" || !path.isAbsolute(state.root) ||
        !Array.isArray(state.files) || !Array.isArray(state.skippedDirs) || !state.skippedDirs.every(dir => typeof dir === "string") ||
        !["idle", "scanning", "converting", "paused", "done"].includes(state.phase) ||
        !Number.isInteger(state.workers) || state.workers < 1 || state.workers > 8 ||
        typeof state.makeMarkdown !== "boolean" || state.autoBackup !== false ||
        typeof state.backupDir !== "string" || typeof state.hancomPath !== "string") return false;
    const ids = new Set<number>();
    const sources = new Set<string>();
    for (const file of state.files) {
      if (!file || !Number.isInteger(file.id) || file.id < 0 || ids.has(file.id) || typeof file.source !== "string" ||
          !path.isAbsolute(file.source) || sources.has(file.source) || !/\.(hwp|hwpml)$/i.test(file.source) ||
          typeof file.name !== "string" || file.name !== path.basename(file.source) || file.dir !== path.dirname(file.source) ||
          !Number.isFinite(file.size) || file.size < 0 || !Number.isFinite(file.targetSize) || file.targetSize < 0 ||
          !["wait", "conv", "ok", "diff", "fail", "deleted", "skipped"].includes(file.status)) return false;
      const relative = path.relative(state.root, file.source);
      if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return false;
      if (file.target && file.target !== file.source.replace(/\.(hwp|hwpml)$/i, ".hwpx")) return false;
      if (file.mdPath && file.mdPath !== file.source.replace(/\.(hwp|hwpml)$/i, ".md")) return false;
      if (file.owned && (![file.owned.sourceHash, file.owned.targetHash, ...(file.owned.markdownHash === undefined ? [] : [file.owned.markdownHash])].every(hash => typeof hash === "string" && /^[a-f0-9]{64}$/.test(hash)) || !["ok", "diff"].includes(file.owned.status))) return false;
      ids.add(file.id); sources.add(file.source);
    }
    try { if (!(await stat(state.root)).isDirectory()) return false; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    for (const file of state.files) {
      if (file.status === "conv") file.status = "wait";
      if (file.owned) {
        const target = file.source.replace(/\.(hwp|hwpml)$/i, ".hwpx");
        const md = file.source.replace(/\.(hwp|hwpml)$/i, ".md");
        const complete = await matches(file.source, file.owned.sourceHash) && await matches(target, file.owned.targetHash) &&
          (!state.makeMarkdown || Boolean(file.owned.markdownHash && await matches(md, file.owned.markdownHash)));
        file.status = complete ? file.owned.status : "wait";
      }
      // Presentation data is rebuilt by conversion; malformed optional data must not crash snapshot().
      file.checks = [];
      delete file.verification;
    }
    this.state = { ...this.state, root: state.root, files: state.files, skippedDirs: state.skippedDirs,
      workers: state.workers, makeMarkdown: state.makeMarkdown, autoBackup: false, backupDir: state.backupDir,
      hancomPath: state.hancomPath, phase: state.phase === "done" && !state.files.some(file => file.status === "wait") ? "done" : "paused",
      message: "이전 작업을 복원했습니다. 대기 파일부터 이어갈 수 있습니다" };
    return true;
  }

  async stop(): Promise<void> {
    this.pause();
    if (this.busy) await new Promise<void>(resolve => this.idleWaiters.push(resolve));
    await this.checkpoint();
  }

  private acquire(): void {
    if (this.busy) throw new Error("다른 작업이 진행 중입니다");
    this.busy = true;
  }
  configure(options: EngineOptions): void {
    if (this.busy) throw new Error("작업 중에는 설정을 바꿀 수 없습니다");
    if (options.workers !== undefined && (!Number.isInteger(options.workers) || options.workers < 1 || options.workers > 8)) throw new Error("작업 수는 1~8 사이의 정수여야 합니다");
    for (const key of ["makeMarkdown", "autoBackup"] as const) {
      if (options[key] !== undefined && typeof options[key] !== "boolean") throw new Error(`${key}: 참/거짓 값이 필요합니다`);
    }
    if (options.autoBackup === true) throw new Error("원본 보호를 위해 현재 백업 기능을 지원하지 않습니다");
    if (options.backupDir !== undefined && typeof options.backupDir !== "string") throw new Error("백업 경로는 문자열이어야 합니다");
    if (options.hancomPath !== undefined && typeof options.hancomPath !== "string") throw new Error("한컴 경로는 문자열이어야 합니다");
    for (const key of ["workers", "makeMarkdown", "autoBackup", "backupDir", "hancomPath"] as const) {
      if (options[key] !== undefined) Object.assign(this.state, { [key]: options[key] });
    }
  }
  async scan(root: string): Promise<HwpItem[]> {
    this.acquire();
    this.state.phase = "scanning";
    this.state.message = "파일을 찾고 있습니다";
    try {
      const resolved = path.resolve(root);
      if (!(await stat(resolved)).isDirectory()) throw new Error("폴더를 선택해 주세요");
      const found: HwpItem[] = [];
      const skippedDirs: string[] = [];
      await this.walk(resolved, found, skippedDirs, true);
      this.state.root = resolved;
      this.state.files = found;
      this.state.skippedDirs = skippedDirs;
      this.state.startedAt = 0;
      this.state.endedAt = 0;
      this.state.message = `${found.length}개 파일을 찾았습니다${skippedDirs.length ? ` · 열 수 없는 폴더 ${skippedDirs.length}개 건너뜀` : ""}`;
      return found;
    } catch (error) {
      this.state.message = error instanceof Error ? error.message : "검색 실패";
      throw error;
    } finally {
      this.state.phase = "idle";
      this.release();
    }
  }
  // A whole drive always holds folders the user cannot open (system, other accounts); those are
  // recorded and skipped so one locked folder does not abort the scan. The chosen root itself must open.
  private async walk(dir: string, found: HwpItem[], skippedDirs: string[], isRoot = false): Promise<void> {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (isRoot || !["EACCES", "EPERM", "ENOENT", "EBUSY", "ELOOP"].includes(code ?? "")) throw error;
      skippedDirs.push(dir);
      return;
    }
    for (const entry of entries) {
      if (EXCLUDED.has(entry.name.toLowerCase())) continue;
      const full = path.join(dir, entry.name);
      if (this.state.backupDir && full === path.resolve(this.state.backupDir)) continue;
      if (entry.isDirectory()) await this.walk(full, found, skippedDirs);
      else if (entry.isFile() && /\.(hwp|hwpml)$/i.test(entry.name)) {
        const info = await stat(full);
        found.push({ id: found.length, name: entry.name, dir, source: full, size: info.size, targetSize: 0, status: "wait", message: "", checks: [] });
      }
    }
  }
  async selectRoot(root: string): Promise<void> {
    if (this.busy) throw new Error("작업 중에는 검색 위치를 바꿀 수 없습니다");
    const resolved = path.resolve(root);
    if (!(await stat(resolved)).isDirectory()) throw new Error("폴더를 선택해 주세요");
    this.state.root = resolved;
    this.state.files = [];
    this.state.skippedDirs = [];
    this.state.phase = "idle";
    this.state.message = `${resolved} 검색 준비됨`;
  }
  async convert(): Promise<void> {
    this.acquire();
    const pending = this.state.files.filter(file => file.status === "wait" || file.status === "fail");
    this.beginRun(pending);
    try { await this.run(pending); }
    finally { this.release(); }
  }
  async retry(id: number): Promise<void> {
    this.acquire();
    try {
      const file = this.state.files.find(item => item.id === id);
      if (!file || !["fail", "diff", "skipped"].includes(file.status)) throw new Error("재시도할 파일이 없습니다");
      this.beginRun([file]);
      await this.run([file]);
    } finally { this.release(); }
  }
  private beginRun(pending: HwpItem[]): void {
    this.cancel = false;
    this.fatal = undefined;
    this.state.phase = "converting";
    this.state.startedAt = Date.now();
    this.state.endedAt = 0;
    this.state.message = "실제 변환 및 내용 비교 중";
    for (const file of pending) { file.status = "wait"; file.message = "대기"; delete file.reason; }
  }
  private async run(pending: HwpItem[]): Promise<void> {
    let cursor = 0;
    const worker = async () => {
      try {
        while (true) {
          await yieldToUI();
          if (this.cancel || cursor >= pending.length) return;
          await this.convertOne(pending[cursor++]);
          await this.checkpoint();
        }
      } catch (error) { this.halt(error); }
    };
    try {
      await this.checkpoint();
      const workers = Number.isInteger(this.state.workers) ? Math.min(8, Math.max(1, this.state.workers)) : 1;
      await Promise.all(Array.from({ length: Math.min(workers, pending.length) }, worker));
    } catch (error) { this.halt(error); }
    this.state.endedAt = Date.now();
    this.state.phase = this.cancel ? "paused" : "done";
    if (!this.fatal) this.state.message = this.cancel ? "일시정지했습니다. 진행 중이던 파일은 완료했습니다" : `변환이 끝났습니다. ${LIMITATION}`;
    await this.checkpoint();
    if (this.fatal) throw this.fatal;
  }
  private async convertOne(file: HwpItem): Promise<void> {
    file.status = "conv";
    file.message = "변환 중";
    file.checks = [];
    file.targetSize = 0;
    delete file.target;
    delete file.mdPath;
    delete file.verification;
    const target = file.source.replace(/\.(hwp|hwpml)$/i, ".hwpx");
    const markdownPath = file.source.replace(/\.(hwp|hwpml)$/i, ".md");
    try {
      await ensureAbsent(target);
      if (this.state.makeMarkdown) await ensureAbsent(markdownPath);
      const input = await readFile(file.source);
      const original = await parse(input);
      if (!original.success) throw new Error(`원본 파싱 실패: ${original.error}`);
      if (!["hwp", "hwp3", "hwpml"].includes(original.fileType)) throw new Error(`지원하지 않는 원본 형식: ${original.fileType}`);
      await yieldToUI();
      const hancom = this.state.hancomCandidates.find(candidate => candidate.path === this.state.hancomPath);
      let converted: { data: Uint8Array; warnings: string[]; mode?: string };
      if (hancom) {
        const dir = await mkdtemp(path.join(tmpdir(), "hwp2x-hancom-"));
        try {
          const temporary = path.join(dir, "output.hwpx");
          await convertWithHancom(hancom, file.source, temporary);
          converted = { data: await readFile(temporary), warnings: [] };
        } finally { await rm(dir, { recursive: true, force: true }); }
      } else converted = await convertToHwpx(input, { engine: "kordoc" });
      const structure = await validateHwpx(converted.data);
      if (!structure.ok) throw new Error(`HWPX 구조 검증 실패: ${structure.issues.map(issue => issue.message).join("; ")}`);
      const output = await parse(arrayBuffer(converted.data));
      if (!output.success || output.fileType !== "hwpx") throw new Error(`변환 결과 파싱 실패: ${output.success ? output.fileType : output.error}`);
      await yieldToUI();
      const warnings = [...converted.warnings, ...(original.warnings ?? []).map(w => JSON.stringify(w)), ...(output.warnings ?? []).map(w => JSON.stringify(w))];
      const verification = await verifyConversion(input, converted.data, warnings);
      if (!(await readFile(file.source)).equals(input)) throw new Error("변환 중 원본이 변경되었습니다. 출력을 저장하지 않았습니다");
      await publish(target, converted.data);
      file.target = target;
      file.targetSize = converted.data.byteLength;
      file.verification = verification;
      if (this.state.makeMarkdown) {
        // Inline assets keep the exported Markdown self-contained without additional output paths.
        let markdown = original.markdown;
        for (const image of original.images ?? []) {
          markdown = markdown.split(`(${image.filename})`).join(`(data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")})`);
        }
        await publish(markdownPath, markdown);
        file.mdPath = markdownPath;
      }
      const changed = !verification.contentMatch || converted.mode === "content" || warnings.length > 0;
      file.status = changed ? "diff" : "ok";
      file.message = changed ? `내용 차이 또는 서식 보존 제한이 있습니다. 원본 유지. ${warnings.join("; ")}` : "내용 비교 일치 · 전체 서식 무손실 미확인 · 원본 유지";
      const stats = verification.stats;
      file.checks = [
        { label: "HWPX 구조", value: "검증 통과", color: "green" },
        { label: "내용 비교", value: `추가 ${stats.added} / 삭제 ${stats.removed} / 변경 ${stats.modified}`, color: verification.contentMatch ? "green" : "amber" },
        { label: "전체 서식 무손실", value: "미확인 · 원본 유지", color: "amber" },
      ];
    } catch (error) {
      // Disk full / out of memory / out of file handles: every later file would fail the same way,
      // so the file goes back to the queue and the run stops safely instead of marking files failed.
      if (resourceError(error) && !file.target) {
        file.status = "wait";
        file.message = "대기";
        file.reason = `안전 중단: ${shortReason(error, false)} · 해결 후 계속을 누르면 이어서 변환`;
        file.checks = [];
        throw error;
      }
      const skipped = (error as NodeJS.ErrnoException).code === "EEXIST" && !file.target;
      file.status = skipped ? "skipped" : "fail";
      file.message = `${error instanceof Error ? error.message : "변환 실패"}${file.target ? " (HWPX는 저장됨; 원본 유지)" : " (원본 유지)"}`;
      file.reason = skipped ? `같은 이름의 ${(error as Error).message.endsWith(".md") ? "MD" : "HWPX"} 파일이 이미 있어 건너뜀` : shortReason(error, Boolean(file.target));
      file.checks = [{ label: "변환", value: file.message, color: "red" }];
    }
  }
  async backupLossless(): Promise<number> {
    this.acquire();
    try {
      if (this.state.phase !== "done") throw new Error("변환이 끝난 뒤에 백업할 수 있습니다");
      if (!path.isAbsolute(this.state.backupDir)) throw new Error("백업 폴더를 선택하세요");
      const eligible = this.state.files.filter(file => file.status === "ok" || file.status === "diff");
      if (!eligible.length) throw new Error("백업할 변환 완료 파일이 없습니다");
      let copied = 0, already = 0;
      const conflicts: string[] = [];
      for (const file of eligible) {
        const relative = path.relative(this.state.root, file.source);
        if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("검색 폴더 밖의 파일은 백업하지 않습니다");
        const destination = path.join(this.state.backupDir, relative);
        await mkdir(path.dirname(destination), { recursive: true });
        try { await copyFile(file.source, destination, fsConstants.COPYFILE_EXCL); copied += 1; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
          // Running backup again must not fail on files it already copied; a different file in the way is never overwritten.
          if ((await readFile(destination)).equals(await readFile(file.source))) already += 1;
          else conflicts.push(relative);
        }
      }
      this.state.message = `${copied}개 원본을 백업했습니다${already ? ` · ${already}개는 이미 백업됨` : ""}. 원본은 그대로 두었습니다.`;
      if (conflicts.length) throw new Error(`백업 폴더에 내용이 다른 같은 이름 파일이 있어 덮어쓰지 않았습니다: ${conflicts.join(", ")}`);
      return copied;
    } finally { this.release(); }
  }
  pause(): void { if (this.state.phase === "converting") this.cancel = true; }
  snapshot() {
    const counts = { ok: 0, diff: 0, fail: 0, deleted: 0, wait: 0, conv: 0, skipped: 0 };
    for (const file of this.state.files) counts[file.status] += 1;
    const done = this.state.files.length - counts.wait - counts.conv;
    return {
      ...this.state,
      files: this.state.files.map(file => ({ ...file, checks: file.checks?.map(check => ({ ...check })), verification: file.verification ? structuredClone(file.verification) : undefined })),
      total: this.state.files.length, completed: done,
      percent: this.state.files.length ? Math.round(done / this.state.files.length * 1000) / 10 : 0,
      elapsed: this.state.startedAt ? ((this.state.endedAt || Date.now()) - this.state.startedAt) / 1000 : 0,
      counts, hancomName: this.state.hancomCandidates.find(candidate => candidate.path === this.state.hancomPath)?.name ?? "kordoc 4.24.42 (한컴 미감지 시 대체)",
    };
  }
}
