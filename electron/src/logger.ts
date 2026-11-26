import * as fs from "node:fs/promises";
import path from "node:path";

let directory = "";
let currentPath = "";
let initialized = false;
let pending: string[] = [];
let queue: Promise<void> = Promise.resolve();
let queueDepth = 0;
let queueBytes = 0;
let droppedLines = 0;
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_QUEUE = 4096;
const MAX_PENDING = 1024;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

function enqueue(work: () => Promise<void>, bytes = 0): Promise<void> {
  queueDepth++;
  queueBytes += bytes;
  const run = queue.then(work).catch(() => {});
  queue = run.finally(() => { queueDepth--; queueBytes = Math.max(0, queueBytes - bytes); });
  return queue;
}

export function logMetrics(): { queueDepth: number; queueBytes: number; droppedLines: number } {
  return { queueDepth, queueBytes, droppedLines };
}


function normalize(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (value === undefined) return null;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object" || value === null) return value;
  if (ancestors.has(value)) return "[순환 참조]";
  ancestors.add(value);
  try {
    if (value instanceof Error) {
      return {
        message: value.message,
        stack: value.stack,
        code: normalize((value as Error & { code?: unknown }).code, ancestors),
      };
    }
    if (Array.isArray(value)) return value.map(item => normalize(item, ancestors));
    if (value instanceof Date) return value.toISOString();
    const result: Record<string, unknown> = Object.create(null);
    for (const key of Object.keys(value)) {
      try { result[key] = normalize((value as Record<string, unknown>)[key], ancestors); }
      catch { result[key] = "[직렬화 불가]"; }
    }
    return result;
  } finally {
    ancestors.delete(value);
  }
}

function makeLine(level: "info" | "warn" | "error", event: string, data?: Record<string, unknown>): string {
  try {
    return JSON.stringify({ ...normalize(data) as object, t: new Date().toISOString(), level, event }) + "\n";
  } catch {
    return JSON.stringify({ t: new Date().toISOString(), level, event: "로그 직렬화 실패" }) + "\n";
  }
}

async function append(line: string): Promise<void> {
  if (!directory) return;
  currentPath = path.join(directory, `hwp2x-${new Date().toISOString().slice(0, 10)}.log`);
  let size = 0;
  try { size = (await fs.stat(currentPath)).size; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  if (size > 0 && size + Buffer.byteLength(line) > MAX_BYTES) {
    await fs.rm(currentPath + ".1", { force: true });
    await fs.rename(currentPath, currentPath + ".1");
  }
  await fs.appendFile(currentPath, line, "utf8");
}

export async function initLogger(dir: string, info: Record<string, unknown>): Promise<string> {
  initialized = true;
  const buffered = pending;
  pending = [];
  const target = path.join(dir, `hwp2x-${new Date().toISOString().slice(0, 10)}.log`);
  await enqueue(async () => {
    directory = dir;
    currentPath = target;
    await fs.mkdir(dir, { recursive: true });
    const cutoff = Date.now() - KEEP_MS;
    for (const entry of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const match = /^hwp2x-(\d{4}-\d{2}-\d{2})\.log(?:\.1)?$/.exec(entry.name);
      if (entry.isFile() && match && Date.parse(match[1] + "T23:59:59.999Z") < cutoff) await fs.unlink(path.join(dir, entry.name)).catch(() => {});
    }
    for (const line of buffered) await append(line).catch(() => {});
    await append(makeLine("info", "실행 환경", info));
  });
  return target;
}

// 파일마다 남는 기록에 밀려 로그 보기(최근 200KB)에서 사라지지 않도록 자동 변환 기록을 따로 보관한다.
// 주기 측정이 감속·일시정지·복구 사건을 밀어내지 않게 측정(최근 20줄)과 사건(최근 40줄)을 나눠 둔다.
let pinnedMetrics: string[] = [];
let pinnedEvents: string[] = [];
const keep = (list: string[], line: string, max: number) => (list.length >= max ? [...list.slice(1 - max), line] : [...list, line]);

export function log(level: "info" | "warn" | "error", event: string, data?: Record<string, unknown>): void {
  try {
    const line = makeLine(level, event, data);
    const bytes = Buffer.byteLength(line);
    if (event === "automatic.metrics") pinnedMetrics = keep(pinnedMetrics, line, 20);
    else if (event.startsWith("automatic.")) pinnedEvents = keep(pinnedEvents, line, 40);
    if (!initialized) {
      if (pending.length >= MAX_PENDING) { pending.shift(); droppedLines++; }
      pending.push(line);
    } else if (queueDepth >= MAX_QUEUE) {
      droppedLines++;
    } else void enqueue(() => append(line), bytes);
  } catch { /* 진단 기록 실패는 앱 실행을 중단하지 않는다. */ }
}

/** 로그 보기·전체 복사용: 최근 기록 앞에, 그 범위 밖으로 밀려난 자동 변환 부하 기록을 시간 순서대로 붙인다. */
export async function viewLog(maxBytes: number): Promise<string> {
  const tail = await recentLog(maxBytes);
  // 각 줄의 "t" 시각은 ISO 형식이라 글자 순서가 곧 시간 순서다.
  const at = (line: string) => /"t":"([^"]+)"/.exec(line)?.[1] ?? "";
  const pinned = [...pinnedEvents, ...pinnedMetrics].filter(line => !tail.includes(line)).sort((a, b) => at(a).localeCompare(at(b)));
  return pinned.join("") + tail;
}

export function logPath(): string { return currentPath; }
export function logDir(): string { return directory; }
export async function flushLog(): Promise<void> { await queue; }

export async function recentLog(maxBytes = 20000): Promise<string> {
  await flushLog();
  if (!currentPath || !Number.isFinite(maxBytes) || maxBytes <= 0) return "";
  try {
    const file = await fs.open(currentPath, "r");
    try {
      const size = (await file.stat()).size;
      const length = Math.min(size, Math.floor(maxBytes));
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await file.read(buffer, 0, length, size - length);
      let start = 0;
      // 앞이 잘렸으면 반쪽짜리 첫 줄은 버리고 온전한 다음 줄부터 보여준다. 줄바꿈이 없으면 잘린 UTF-8 글자만 건너뛴다.
      const newline = length < size ? buffer.subarray(0, bytesRead).indexOf(0x0a) : -1;
      if (newline >= 0 && newline + 1 < bytesRead) start = newline + 1;
      else while (start < bytesRead && (buffer[start] & 0xc0) === 0x80) start++;
      return buffer.subarray(start, bytesRead).toString("utf8");
    } finally { await file.close(); }
  } catch { return ""; }
}
