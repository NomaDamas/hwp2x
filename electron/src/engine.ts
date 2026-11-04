import { readdir, readFile, stat, lstat, open, link, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setImmediate as yieldToUI } from "node:timers/promises";
import { compare, convertToHwpx, parse, validateHwpx } from "kordoc";

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
  target?: string;
  mdPath?: string;
  checks?: Check[];
  verification?: Verification;
}
export interface EngineState {
  phase: "idle" | "scanning" | "converting" | "paused" | "done";
  root: string;
  files: HwpItem[];
  workers: number;
  autoBackup: boolean;
  makeMarkdown: boolean;
  backupDir: string;
  message: string;
  startedAt: number;
}
export interface EngineOptions {
  workers?: number;
  makeMarkdown?: boolean;
  autoBackup?: boolean;
  backupDir?: string;
}
const LIMITATION = "내용 비교만으로 글꼴·쪽 배치·도형 등 전체 서식의 무손실을 증명할 수 없어 원본 백업 후 삭제를 지원하지 않습니다";
const EXCLUDED = new Set(["$recycle.bin", "system volume information", "windows", "program files", "program files (x86)", "node_modules", "hwp2x_백업"]);
const arrayBuffer = (data: Uint8Array): ArrayBuffer => data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;

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

export class Engine {
  state: EngineState = {
    phase: "idle", root: "", files: [], workers: 2, autoBackup: false,
    makeMarkdown: true, backupDir: "", message: "준비됨", startedAt: 0,
  };
  private cancel = false;
  private busy = false;

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
    for (const key of ["workers", "makeMarkdown", "autoBackup", "backupDir"] as const) {
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
      await this.walk(resolved, found);
      this.state.root = resolved;
      this.state.files = found;
      this.state.startedAt = 0;
      this.state.message = `${found.length}개 파일을 찾았습니다`;
      return found;
    } catch (error) {
      this.state.message = error instanceof Error ? error.message : "검색 실패";
      throw error;
    } finally {
      this.state.phase = "idle";
      this.busy = false;
    }
  }
  private async walk(dir: string, found: HwpItem[]): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (EXCLUDED.has(entry.name.toLowerCase())) continue;
      const full = path.join(dir, entry.name);
      if (this.state.backupDir && full === path.resolve(this.state.backupDir)) continue;
      if (entry.isDirectory()) await this.walk(full, found);
      else if (entry.isFile() && /\.(hwp|hwpml)$/i.test(entry.name)) {
        const info = await stat(full);
        found.push({ id: found.length, name: entry.name, dir, source: full, size: info.size, targetSize: 0, status: "wait", message: "", checks: [] });
      }
    }
  }
  async convert(): Promise<void> {
    this.acquire();
    const pending = this.state.files.filter(file => file.status === "wait" || file.status === "fail");
    this.beginRun(pending);
    try { await this.run(pending); }
    finally { this.busy = false; }
  }
  async retry(id: number): Promise<void> {
    this.acquire();
    try {
      const file = this.state.files.find(item => item.id === id);
      if (!file || !["fail", "diff", "skipped"].includes(file.status)) throw new Error("재시도할 파일이 없습니다");
      this.beginRun([file]);
      await this.run([file]);
    } finally { this.busy = false; }
  }
  private beginRun(pending: HwpItem[]): void {
    this.cancel = false;
    this.state.phase = "converting";
    this.state.startedAt = Date.now();
    this.state.message = "실제 변환 및 내용 비교 중";
    for (const file of pending) { file.status = "wait"; file.message = "대기"; }
  }
  private async run(pending: HwpItem[]): Promise<void> {
    let cursor = 0;
    const worker = async () => {
      while (true) {
        await yieldToUI();
        if (this.cancel || cursor >= pending.length) return;
        await this.convertOne(pending[cursor++]);
      }
    };
    const workers = Number.isInteger(this.state.workers) ? Math.min(8, Math.max(1, this.state.workers)) : 1;
    await Promise.all(Array.from({ length: Math.min(workers, pending.length) }, worker));
    this.state.phase = this.cancel ? "paused" : "done";
    this.state.message = this.cancel ? "일시정지했습니다. 진행 중이던 파일은 완료했습니다" : `변환이 끝났습니다. ${LIMITATION}`;
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
      const converted = await convertToHwpx(input, { engine: "kordoc" });
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
      file.status = (error as NodeJS.ErrnoException).code === "EEXIST" && !file.target ? "skipped" : "fail";
      file.message = `${error instanceof Error ? error.message : "변환 실패"}${file.target ? " (HWPX는 저장됨; 원본 유지)" : " (원본 유지)"}`;
      file.checks = [{ label: "변환", value: file.message, color: "red" }];
    }
  }
  async backupLossless(): Promise<number> {
    this.acquire();
    try { this.state.message = LIMITATION; return 0; }
    finally { this.busy = false; }
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
      elapsed: this.state.startedAt ? (Date.now() - this.state.startedAt) / 1000 : 0,
      counts, hancomName: "kordoc 4.24.42",
    };
  }
}
