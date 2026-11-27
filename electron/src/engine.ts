import { readdir, readFile, stat, lstat, open, link, unlink, mkdtemp, rm, mkdir, copyFile, rename } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { setImmediate as yieldToUI } from "node:timers/promises";
import { compare, convertToHwpx, parse, validateHwpx } from "kordoc";
import { convertWithHancom, HANCOM_OPEN_FAILED, HANCOM_INTERACTION_REQUIRED, HANCOM_RECOVERY_BLOCKED, type HancomCandidate } from "./hancom";
import { log } from "./logger";
import { CONTRACT_VERSION, PROFILE_VERSION, type RunPhase, type StateContract } from "./contracts/state";

export type FileStatus = "wait" | "conv" | "ok" | "diff" | "fail" | "deleted" | "skipped";
export interface Check { label: string; value: string; color: string }
/** How much of the plain text (spacing and inline markup ignored) survived conversion, and which colour band that falls in. */
export interface TextMatch {
  /** 0–100 with one decimal; null when neither side has any text to compare. Never 100 unless the text is identical. */
  percent: number | null;
  /** high: 98% or more (green) · mid: 90–98% (amber) · low: under 90% (red) · none: nothing to compare (grey). */
  band: "high" | "mid" | "low" | "none";
}
export const TEXT_MATCH_HIGH = 98;
export const TEXT_MATCH_MID = 90;
export interface Verification {
  /** The document's text (ignoring spacing and inline markup) and its images are the same after conversion. */
  contentMatch: boolean;
  layoutVerified: false;
  lossless: false;
  limitation: string;
  /** Block-by-block comparison; a heading read back as a bold paragraph counts here but is not a content change. */
  stats: { added: number; removed: number; modified: number; unchanged: number };
  warnings: string[];
  /** Where the text first differs, shown to the user; absent when the text matches. */
  textDiff?: string;
  imagesMatch?: boolean;
  textMatch: TextMatch;
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
  /** Text similarity of the built-in engine's result; absent for Hancom results (not compared) and unfinished files. */
  textMatch?: TextMatch;
  owned?: { sourceHash: string; targetHash: string; markdownHash?: string; status: "ok" | "diff" };
}
export interface EngineState {
  phase: RunPhase;
  root: string;
  files: HwpItem[];
  /** Folders under the root that could not be opened during the last scan. */
  skippedDirs: string[];
  workers: number;
  hancomPath: string;
  hancomName: string;
  hancomCandidates: HancomCandidate[];
  /** Result of the last 다시 감지 press, shown under the engine list; empty until the user presses it. */
  hancomDetectNote: string;
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

interface CompareBlock { type?: string; text?: string; table?: { cells: { text?: string }[][] }; imageData?: { data?: Uint8Array | Record<string, number> } }
// Text of one block with spacing and inline markup removed: the same words in a heading or a bold paragraph,
// or with an underline tag dropped, are the same content.
const plainText = (block?: CompareBlock): string => !block || block.type === "image" ? ""
  : (block.table ? block.table.cells.flat().map(cell => cell.text ?? "").join("") : block.text ?? "")
    .replace(/<\/?[a-z][^>]*>/gi, "").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\*\*|__/g, "").replace(/\s+/g, "");
const imageDigest = (block?: CompareBlock): string | undefined => {
  const data = block?.type === "image" ? block.imageData?.data : undefined;
  return data ? digest(data instanceof Uint8Array ? data : Uint8Array.from(Object.values(data))) : undefined;
};

export function textMatchBand(percent: number | null): TextMatch["band"] {
  return percent === null ? "none" : percent >= TEXT_MATCH_HIGH ? "high" : percent >= TEXT_MATCH_MID ? "mid" : "low";
}
/** The 확인 항목 row for a text match: the number in words and the band colour (green · amber · red · grey). */
function textMatchCheck(match: TextMatch): Check {
  return { label: "글자 일치율", value: match.percent === null ? "비교할 글자 없음" : `${match.percent}% 같음`, color: { high: "green", mid: "amber", low: "red", none: "grey" }[match.band] };
}

/**
 * Share of the text that is the same, from the two-character pieces both sides have in common (counted with
 * repetition) over the longer side. Unlike a first-difference check it gives a degree, and unlike a line diff
 * it is not thrown off when the converter reads a paragraph or table in a different order. Linear in length.
 */
export function textSimilarity(before: string, after: string): TextMatch {
  if (before === after) return before ? { percent: 100, band: "high" } : { percent: null, band: "none" };
  const a = Array.from(before), b = Array.from(after);
  if (!a.length || !b.length) return { percent: 0, band: "low" };
  const size = Math.min(a.length, b.length) < 2 ? 1 : 2;
  const pieces = (chars: string[]) => {
    const counts = new Map<string, number>();
    for (let i = 0; i + size <= chars.length; i++) {
      const key = size === 1 ? chars[i]! : chars[i]! + chars[i + 1]!;
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return counts;
  };
  const left = pieces(a), right = pieces(b);
  let common = 0;
  for (const [key, count] of left) common += Math.min(count, right.get(key) ?? 0);
  // Different text never reads as 100%: cap at 99.9 so the number cannot hide a real difference.
  const total = Math.max(a.length, b.length) - size + 1;
  const percent = Math.min(99.9, Math.floor(common / total * 1000) / 10);
  return { percent, band: textMatchBand(percent) };
}

export async function verifyConversion(source: Uint8Array, target: Uint8Array, warnings: string[] = []): Promise<Verification> {
  const result = await compare(arrayBuffer(source), arrayBuffer(target));
  const diffs = result.diffs as { before?: CompareBlock; after?: CompareBlock }[];
  const before = diffs.map(diff => plainText(diff.before)).join(""), after = diffs.map(diff => plainText(diff.after)).join("");
  const images = (side: "before" | "after") => diffs.map(diff => imageDigest(diff[side])).filter(Boolean).sort().join(",");
  const imagesMatch = images("before") === images("after");
  let at = 0;
  while (at < before.length && before[at] === after[at]) at += 1;
  const textDiff = before === after ? undefined : `원본 "…${before.slice(Math.max(0, at - 10), at + 20)}…" / 변환 "…${after.slice(Math.max(0, at - 10), at + 20)}…"`;
  return {
    contentMatch: !textDiff && imagesMatch,
    layoutVerified: false, lossless: false, limitation: LIMITATION,
    stats: result.stats, warnings, textDiff, imagesMatch, textMatch: textSimilarity(before, after),
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
  if (text === HANCOM_INTERACTION_REQUIRED) return "처리하지 못함 · 사용자 확인 필요 · 원본을 직접 열어 보안 안내 확인 후 다시 시도";
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
    // Two jobs measured only ~10% faster than one, for ~40 MB more memory: a PC with 2 cores or fewer starts
    // with one so the window stays responsive. A saved choice (restore) and the settings screen still win.
    phase: "idle", root: "", files: [], skippedDirs: [], workers: availableParallelism() <= 2 ? 1 : 2, autoBackup: false,
    makeMarkdown: true, backupDir: "", hancomPath: "", hancomName: "kordoc 4.24.42", hancomCandidates: [], hancomDetectNote: "", message: "준비됨", startedAt: 0, endedAt: 0,
  };
  private cancel = false;
  private busy = false;
  private stopRequested = false;
  private saves: Promise<void> = Promise.resolve();
  private idleWaiters: Array<() => void> = [];
  private fatal: unknown;

  /** The Hancom converter is a parameter so a test can stand in for Hwp.exe, which only exists on Windows. */
  constructor(private readonly checkpointPath?: string, private readonly hancomConvert: typeof convertWithHancom = convertWithHancom) {}

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
        !["idle", "scanning", "converting", "paused", "stopped", "done"].includes(state.phase) ||
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
        if (complete) {
          file.target = target;
          file.targetSize = (await stat(target)).size;
          if (state.makeMarkdown) file.mdPath = md;
          file.message = "저장된 변환 결과를 확인했습니다 · 원본 유지";
        }
      }
      // Presentation data is rebuilt by conversion; malformed optional data must not crash snapshot().
      file.checks = [];
      delete file.verification;
      const match = file.textMatch;
      const validMatch = match && typeof match === "object" && ["high", "mid", "low", "none"].includes(match.band) &&
        (match.percent === null ? match.band === "none" : typeof match.percent === "number" && match.percent >= 0 && match.percent <= 100 && textMatchBand(match.percent) === match.band);
      if (!validMatch || (file.status !== "ok" && file.status !== "diff")) delete file.textMatch;
      else {
        file.textMatch = { percent: match.percent, band: match.band };
        file.checks = [textMatchCheck(match)];
      }
    }
    this.state = { ...this.state, root: state.root, files: state.files, skippedDirs: state.skippedDirs,
      workers: state.workers, makeMarkdown: state.makeMarkdown, autoBackup: false, backupDir: state.backupDir,
      hancomPath: state.hancomPath, phase: state.phase === "stopped" || state.phase === "idle" ? state.phase
        : state.phase === "done" && !state.files.some(file => file.status === "wait") ? "done" : "paused",
      message: "이전 작업을 복원했습니다. 대기 파일부터 이어갈 수 있습니다" };
    return true;
  }

  async stop(): Promise<void> {
    this.pause();
    if (this.busy) await new Promise<void>(resolve => this.idleWaiters.push(resolve));
    await this.checkpoint();
  }
  /** True while a scan, conversion, retry or backup holds the engine. */
  get running(): boolean { return this.busy; }

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
    this.assertNoPausedRun();
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
      if (this.state.phase === "scanning") this.state.phase = "idle";
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
    // Sizes are read in batches of 64 within a folder: one stat after another made a 10,000-file search
    // wait on every disk round trip in turn, and an unbounded batch can run out of file handles.
    const documents: string[] = [];
    for (const entry of entries) {
      if (EXCLUDED.has(entry.name.toLowerCase())) continue;
      const full = path.join(dir, entry.name);
      if (this.state.backupDir && full === path.resolve(this.state.backupDir)) continue;
      if (entry.isDirectory()) await this.walk(full, found, skippedDirs);
      else if (entry.isFile() && /\.(hwp|hwpml)$/i.test(entry.name)) documents.push(entry.name);
    }
    for (let start = 0; start < documents.length; start += 64) {
      const batch = documents.slice(start, start + 64);
      const sizes = await Promise.all(batch.map(async name => {
        try { const info = await lstat(path.join(dir, name)); return info.isFile() ? info.size : null; }
        catch (error) {
          if (["ENOENT", "EACCES", "EPERM", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) {
            skippedDirs.push(path.join(dir, name));
            return null;
          }
          throw error;
        }
      }));
      batch.forEach((name, index) => {
        if (sizes[index] === null) return;
        found.push({ id: found.length, name, dir, source: path.join(dir, name), size: sizes[index]!, targetSize: 0, status: "wait", message: "", checks: [] });
      });
    }
  }
  // A paused run still owns its file list: replacing it silently would drop the resume. The user ends it with
  // stop (or lets it finish) first, then picks another folder.
  private assertNoPausedRun(): void {
    if (this.state.phase === "paused") throw new Error("일시정지된 작업이 있습니다. 이어하기나 중지를 먼저 선택하세요");
  }
  async selectRoot(root: string): Promise<void> {
    if (this.busy) throw new Error("작업 중에는 검색 위치를 바꿀 수 없습니다");
    this.assertNoPausedRun();
    const resolved = path.resolve(root);
    if (!(await stat(resolved)).isDirectory()) throw new Error("폴더를 선택해 주세요");
    this.state.root = resolved;
    this.state.files = [];
    this.state.skippedDirs = [];
    this.state.phase = "idle";
    this.state.message = `${resolved} 검색 준비됨`;
  }
  async convertPaths(paths: string[]): Promise<void> {
    this.assertNoPausedRun();
    this.acquire();
    try {
      if (!Array.isArray(paths) || paths.length > 100 || paths.some(source => typeof source !== "string" || !path.isAbsolute(source) || !/\.(hwp|hwpml)$/i.test(source))) {
        throw new Error("절대 경로의 HWP/HWPML 파일을 최대 100개 지정하세요");
      }
      if (!paths.length) return;
      const sources = [...new Set(paths.map(source => path.resolve(source)))];
      let root = path.dirname(sources[0]);
      for (const source of sources) {
        if (path.parse(root).root.toLowerCase() !== path.parse(source).root.toLowerCase()) throw new Error("같은 드라이브의 파일을 지정하세요");
        while (true) {
          const relative = path.relative(root, source);
          if (relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) break;
          const parent = path.dirname(root);
          if (parent === root) throw new Error("공통 상위 폴더를 찾을 수 없습니다");
          root = parent;
        }
      }
      const files = await Promise.all(sources.map(async (source, id): Promise<HwpItem> => {
        const info = await lstat(source);
        if (!info.isFile()) throw new Error("일반 문서 파일만 변환할 수 있습니다");
        return { id, name: path.basename(source), dir: path.dirname(source), source, size: info.size, targetSize: 0, status: "wait", message: "", checks: [] };
      }));
      this.state.root = root;
      this.state.files = files;
      this.state.skippedDirs = [];
      this.state.phase = "idle";
    } finally { this.release(); }
    await this.convert();
  }
  async convert(): Promise<void> {
    this.acquire();
    const pending = this.state.files.filter(file => file.status === "wait" || file.status === "fail");
    this.beginRun(pending);
    log("info", "conversion.begin", { root: this.state.root, pending: pending.length, hancomPath: this.state.hancomPath });
    try { await this.run(pending); }
    finally {
      log("info", "conversion.end", { phase: this.state.phase, counts: this.snapshot({ limit: 1 }).counts, message: this.state.message });
      this.release();
    }
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
          const file = pending[cursor++];
          await this.convertOne(file);
          // Successful output is already recoverable from the durable pre-publication ownership record.
          // Failures/skips still need progress saved; completion and pause save the whole run below.
          if (file.status !== "ok" && file.status !== "diff") await this.checkpoint();
        }
      } catch (error) { this.halt(error); }
    };
    try {
      await this.checkpoint();
      const workers = Number.isInteger(this.state.workers) ? Math.min(8, Math.max(1, this.state.workers)) : 1;
      await Promise.all(Array.from({ length: Math.min(workers, pending.length) }, worker));
    } catch (error) { this.halt(error); }
    this.state.endedAt = Date.now();
    this.state.phase = this.stopRequested ? "stopped" : this.cancel ? "paused" : "done";
    if (!this.fatal) this.state.message = this.stopRequested
      ? `중지했습니다. 진행 중이던 파일은 완료했고 남은 ${this.state.files.filter(file => file.status === "wait").length}개는 변환하지 않았습니다`
      : this.cancel ? "일시정지했습니다. 진행 중이던 파일은 완료했습니다" : `변환이 끝났습니다. ${LIMITATION}`;
    this.stopRequested = false;
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
    const previousMatch = file.textMatch;
    delete file.textMatch;
    // A retry starts clean: a reason left from an earlier failure or skip must not show next to a success.
    delete file.reason;
    const previousOutput = file.owned;
    delete file.owned;
    const target = file.source.replace(/\.(hwp|hwpml)$/i, ".hwpx");
    const markdownPath = file.source.replace(/\.(hwp|hwpml)$/i, ".md");
    let stage = "read";
    log("info", "file.begin", { id: file.id, source: file.source });
    try {
      if (this.state.makeMarkdown && previousOutput?.markdownHash &&
          await matches(file.source, previousOutput.sourceHash) && await matches(target, previousOutput.targetHash)) {
        await ensureAbsent(markdownPath);
        const original = await parse(await readFile(file.source));
        if (!original.success) throw new Error(`원본 파싱 실패: ${original.error}`);
        let markdown = original.markdown;
        for (const image of original.images ?? []) {
          markdown = markdown.split(`(${image.filename})`).join(`(data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")})`);
        }
        if (digest(markdown) !== previousOutput.markdownHash) throw new Error("복구할 MD가 저장 기록과 다릅니다. 기존 HWPX는 유지합니다");
        if (!await matches(file.source, previousOutput.sourceHash) || !await matches(target, previousOutput.targetHash)) throw new Error("복구 중 원본 또는 HWPX가 변경되었습니다");
        file.owned = previousOutput;
        await publish(markdownPath, markdown);
        file.target = target;
        file.mdPath = markdownPath;
        file.targetSize = (await stat(target)).size;
        file.status = previousOutput.status;
        if (previousMatch) file.textMatch = previousMatch;
        file.message = "기존 HWPX를 보존하고 누락된 MD를 복구했습니다. 원본 유지";
        log("info", "file.markdown-recovered", { id: file.id, target, markdownPath });
        return;
      }
      await ensureAbsent(target);
      if (this.state.makeMarkdown) await ensureAbsent(markdownPath);
      const input = await readFile(file.source);
      stage = "parse";
      const original = await parse(input);
      if (!original.success) throw new Error(`원본 파싱 실패: ${original.error}`);
      if (!["hwp", "hwp3", "hwpml"].includes(original.fileType)) throw new Error(`지원하지 않는 원본 형식: ${original.fileType}`);
      await yieldToUI();
      const hancom = this.activeHancom();
      let converted: { data: Uint8Array; warnings: string[]; mode?: string };
      // Saved by Hancom itself (not the built-in fallback): its own HWPX export is trusted, so no loss check.
      let byHancom = false;
      stage = hancom ? "hancom" : "kordoc";
      log("info", "file.engine", { id: file.id, engine: stage, path: hancom?.path, clsid: hancom?.clsid, available: hancom?.available });
      if (hancom) {
        const dir = await mkdtemp(path.join(tmpdir(), "hwp2x-hancom-"));
        try {
          const temporary = path.join(dir, "output.hwpx");
          await this.hancomConvert(hancom, file.source, temporary);
          converted = { data: await readFile(temporary), warnings: [] };
          byHancom = true;
        } catch (error) {
          // The interaction-triggering document stays failed. Later requests rejected before
          // entering a blocked COM session can safely use the already-parsed input instead.
          if (!(error instanceof Error && [HANCOM_OPEN_FAILED, HANCOM_RECOVERY_BLOCKED].includes(error.message))) throw error;
          log("warn", "file.fallback", { id: file.id, from: "hancom", to: "kordoc", reason: error.message });
          stage = "kordoc";
          const fallback = await convertToHwpx(input, { engine: "kordoc" });
          converted = { ...fallback, warnings: [...fallback.warnings, error.message === HANCOM_RECOVERY_BLOCKED
            ? "한컴이 사용자 확인 대기 중이므로 한컴을 조작하지 않고 내장 kordoc 엔진으로 변환했습니다"
            : "한글이 이 문서를 열지 못해 내장 kordoc 엔진으로 변환했습니다"] };
        } finally { await rm(dir, { recursive: true, force: true }); }
      } else converted = await convertToHwpx(input, { engine: "kordoc" });
      stage = "validate";
      log("info", "file.validate", { id: file.id });
      const structure = await validateHwpx(converted.data);
      if (!structure.ok) throw new Error(`HWPX 구조 검증 실패: ${structure.issues.map(issue => issue.message).join("; ")}`);
      const output = await parse(arrayBuffer(converted.data));
      if (!output.success || output.fileType !== "hwpx") throw new Error(`변환 결과 파싱 실패: ${output.success ? output.fileType : output.error}`);
      await yieldToUI();
      const warnings = byHancom ? [] : [...converted.warnings, ...(original.warnings ?? []).map(w => JSON.stringify(w)), ...(output.warnings ?? []).map(w => JSON.stringify(w))];
      const verification = byHancom ? undefined : await verifyConversion(input, converted.data, warnings);
      if (!(await readFile(file.source)).equals(input)) throw new Error("변환 중 원본이 변경되었습니다. 출력을 저장하지 않았습니다");
      let markdown: string | undefined;
      if (this.state.makeMarkdown) {
        // Inline assets keep the exported Markdown self-contained without additional output paths.
        markdown = original.markdown;
        for (const image of original.images ?? []) {
          markdown = markdown.split(`(${image.filename})`).join(`(data:${image.mimeType};base64,${Buffer.from(image.data).toString("base64")})`);
        }
      }
      const changed = !byHancom && (!verification!.contentMatch || converted.mode === "content" || warnings.length > 0);
      // Record what is about to be written before writing it. If the app is killed after the HWPX/MD land but
      // before the next progress save, restore() finds these exact files and keeps the file done instead of
      // showing it as "skipped (already exists)" on resume.
      file.owned = { sourceHash: digest(input), targetHash: digest(converted.data), markdownHash: markdown === undefined ? undefined : digest(markdown), status: changed ? "diff" : "ok" };
      await this.checkpoint();
      stage = "save";
      log("info", "file.save", { id: file.id, target, makeMarkdown: this.state.makeMarkdown });
      await publish(target, converted.data);
      file.target = target;
      file.targetSize = converted.data.byteLength;
      if (verification) { file.verification = verification; file.textMatch = verification.textMatch; }
      if (markdown !== undefined) {
        await publish(markdownPath, markdown);
        file.mdPath = markdownPath;
      }
      // The original must be byte-for-byte what was read before converting; anything else is reported, never hidden.
      if (!(await readFile(file.source)).equals(input)) throw new Error("원본 HWP가 변환 중 바뀌었습니다. 원본을 확인해 주세요 (hwp2x는 원본에 쓰지 않습니다)");
      // (changed was decided above, before the outputs were written.)
      file.status = changed ? "diff" : "ok";
      if (byHancom) {
        // Hancom saved the HWPX itself: no text comparison, the result simply passes.
        file.message = "한컴오피스 한글로 변환 · 통과 · 원본 유지";
        file.checks = [
          { label: "HWPX 구조", value: "검증 통과", color: "green" },
          { label: "변환 엔진", value: `${hancom!.name} (내용 비교 생략)`, color: "green" },
          { label: "판정", value: "한컴 변환 · 통과", color: "green" },
          { label: "원본", value: "수정하지 않음 · 복사본으로 변환", color: "green" },
        ];
      } else {
        const checked = verification!;
        const match = checked.textMatch;
        const matchText = textMatchCheck(match).value;
        // Say what differs: the first text difference, missing images, or the converter's warnings.
        const why = [checked.textDiff && `글자 차이: ${checked.textDiff}`, checked.imagesMatch === false && "그림 수 또는 내용 차이",
          converted.mode === "content" && "서식 일부 보존 제한", ...warnings].filter(Boolean).join("; ");
        file.message = `글자 ${matchText}${why ? ` · ${why}` : ""} · 전체 서식 무손실 미확인 · 원본 유지`;
        file.checks = [
          { label: "HWPX 구조", value: "검증 통과", color: "green" },
          textMatchCheck(match),
          { label: "그림", value: checked.imagesMatch === false ? "수 또는 내용 차이" : "같음", color: checked.imagesMatch === false ? "amber" : "green" },
          { label: "전체 서식 무손실", value: "미확인 · 원본 유지", color: "amber" },
        ];
      }
    } catch (error) {
      // An output already on disk is a normal skip (never overwritten), not an error.
      if (error instanceof Error && error.message === HANCOM_RECOVERY_BLOCKED) {
        file.status = "wait";
        file.message = error.message;
        file.reason = "안전 중단 · 사용자 문서를 저장하고 한글과 앱을 다시 시작하세요";
        delete file.owned;
        throw error;
      }
      const skipped = (error as NodeJS.ErrnoException).code === "EEXIST" && !file.target;
      if (skipped) log("info", "file.skip", { id: file.id, reason: "이미 변환됨(건너뜀)", existing: (error as Error).message });
      else log("error", "file.error", { id: file.id, stage, error });
      // Nothing of this attempt was written: drop the record of what was about to be written.
      if (!file.target) delete file.owned;
      // Disk full / out of memory / out of file handles: every later file would fail the same way,
      // so the file goes back to the queue and the run stops safely instead of marking files failed.
      if (resourceError(error) && !file.target) {
        file.status = "wait";
        file.message = "대기";
        file.reason = `안전 중단: ${shortReason(error, false)} · 해결 후 계속을 누르면 이어서 변환`;
        file.checks = [];
        throw error;
      }
      file.status = skipped ? "skipped" : "fail";
      file.message = skipped ? `이미 변환됨(건너뜀): ${(error as Error).message.replace(/^기존 출력 파일을 덮어쓰지 않습니다: /, "")} 파일이 이미 있어 덮어쓰지 않았습니다 (원본 유지)`
        : `${error instanceof Error ? error.message : "변환 실패"}${file.target ? " (HWPX는 저장됨; 원본 유지)" : " (원본 유지)"}`;
      file.reason = skipped ? `이미 변환됨(건너뜀) · 같은 이름의 ${(error as Error).message.endsWith(".md") ? "MD" : "HWPX"} 파일이 있음` : shortReason(error, Boolean(file.target));
      file.checks = [{ label: "변환", value: file.message, color: skipped ? "amber" : "red" }];
    }
    finally { log("info", "file.end", { id: file.id, status: file.status, target: file.target, markdown: file.mdPath, message: file.message }); }
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
  // The file in progress always finishes (outputs are never half written), which can take a moment on a slow
  // PC: the message says so at once, so the click is visibly taken.
  pause(): void {
    if (this.state.phase !== "converting") return;
    this.cancel = true;
    this.state.message = "일시정지 중입니다. 진행 중인 파일을 마치고 멈춥니다";
  }
  // Stop ends the run for good. While converting, the file in progress finishes (outputs are never left half
  // written) and the rest stay unconverted; a paused run is closed at once. Either way a new folder can follow.
  async stopRun(): Promise<void> {
    if (this.state.phase === "converting") {
      this.stopRequested = true;
      this.cancel = true;
      this.state.message = "중지 중입니다. 진행 중인 파일을 마치고 멈춥니다";
      if (this.busy) await new Promise<void>(resolve => this.idleWaiters.push(resolve));
      return;
    }
    if (this.state.phase !== "paused") return;
    const left = this.state.files.filter(file => file.status === "wait").length;
    this.state.phase = "stopped";
    this.state.endedAt ||= Date.now();
    this.state.message = `중지했습니다. 남은 ${left}개는 변환하지 않았습니다`;
    await this.checkpoint();
  }
  snapshot(options?: { offset?: number; limit?: number; filter?: string; query?: string; selectedId?: number }) {
    if (options !== undefined && (!options || typeof options !== "object" || Array.isArray(options) ||
        (options.filter !== undefined && typeof options.filter !== "string") ||
        (options.query !== undefined && typeof options.query !== "string"))) throw new Error("목록 조회 옵션이 올바르지 않습니다");
    const counts = { ok: 0, diff: 0, fail: 0, deleted: 0, wait: 0, conv: 0, skipped: 0 };
    const summarySizes = { source: 0, target: 0 };
    for (const file of this.state.files) {
      counts[file.status] += 1;
      summarySizes.target += file.targetSize;
      if (file.status === "ok" || file.status === "diff") summarySizes.source += file.size;
    }
    const done = this.state.files.length - counts.wait - counts.conv;
    const clone = (file: HwpItem): HwpItem => ({ ...file, checks: file.checks?.map(check => ({ ...check })), verification: file.verification ? structuredClone(file.verification) : undefined });
    const summary = (file: HwpItem): HwpItem => ({
      id: file.id, name: file.name, dir: file.dir, source: file.source, size: file.size,
      targetSize: file.targetSize, status: file.status, message: file.message.slice(0, 512),
      reason: file.reason?.slice(0, 512), target: file.target, mdPath: file.mdPath,
      ...(file.textMatch ? { textMatch: { percent: file.textMatch.percent, band: file.textMatch.band } } : {}),
    });
    const offset = Number.isFinite(options?.offset) ? Math.max(0, Math.floor(options!.offset!)) : 0;
    const limit = Number.isFinite(options?.limit) ? Math.min(100, Math.max(1, Math.floor(options!.limit!))) : 100;
    const query = options?.query?.trim().toLocaleLowerCase() ?? "";
    const attention = ["fail", "skipped", "diff"];
    let filtered = options ? this.state.files.filter(file =>
      (!options.filter || options.filter === "all" || (options.filter === "attention" ? attention.includes(file.status) : file.status === options.filter)) &&
      (!query || file.name.toLocaleLowerCase().includes(query))) : this.state.files;
    if (options?.filter === "attention") filtered.sort((a, b) => attention.indexOf(a.status) - attention.indexOf(b.status));
    const selected = options ? this.state.files.find(file => file.id === options.selectedId) : undefined;
    const contract: StateContract = {
      contractVersion: CONTRACT_VERSION, settingsVersion: PROFILE_VERSION, phase: this.state.phase,
      progress: { total: this.state.files.length, completed: done, percent: this.state.files.length ? Math.round(done / this.state.files.length * 1000) / 10 : 0 },
      unprocessed: { waiting: counts.wait, failed: counts.fail, skipped: counts.skipped },
      recovery: { canResume: this.state.phase === "paused" && counts.wait > 0, rollbackAuthority: "cleanup-state" },
    };
    return {
      ...this.state,
      contract,
      files: options ? filtered.slice(offset, offset + limit).map(summary) : filtered.map(clone),
      ...(options ? {
        skippedDirs: this.state.skippedDirs.slice(0, 100),
        filteredTotal: filtered.length, offset, selected: selected ? clone(selected) : null,
        activeFiles: this.state.files.filter(file => file.status === "conv").slice(0, 8).map(summary),
        summarySizes, eligibleCount: counts.ok + counts.diff,
      } : {}),
      total: this.state.files.length, completed: done,
      percent: this.state.files.length ? Math.round(done / this.state.files.length * 1000) / 10 : 0,
      elapsed: this.state.startedAt ? ((this.state.endedAt || Date.now()) - this.state.startedAt) / 1000 : 0,
      counts, hancomName: this.activeHancom()?.name ?? "kordoc 4.24.42 (한컴 미감지 시 대체)",
    };
  }
  /** The chosen Hancom install, only when it can save HWPX; an old or unregistered pick falls back to kordoc. */
  private activeHancom(): HancomCandidate | undefined {
    return this.state.hancomCandidates.find(candidate => candidate.path === this.state.hancomPath && candidate.available !== false);
  }
}
