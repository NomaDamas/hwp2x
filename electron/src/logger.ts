import * as fs from "node:fs/promises";
import path from "node:path";

let directory = "";
let currentPath = "";
let initialized = false;
let pending: string[] = [];
let queue: Promise<void> = Promise.resolve();
const MAX_BYTES = 5 * 1024 * 1024;
const KEEP_MS = 7 * 24 * 60 * 60 * 1000;

function enqueue(work: () => Promise<void>): Promise<void> {
  queue = queue.then(work).catch(() => {});
  return queue;
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
      if (entry.isFile() && match && Date.parse(match[1] + "T23:59:59.999Z") < cutoff) {
        await fs.unlink(path.join(dir, entry.name)).catch(() => {});
      }
    }
    for (const line of buffered) await append(line).catch(() => {});
    await append(makeLine("info", "실행 환경", info));
  });
  return target;
}

export function log(level: "info" | "warn" | "error", event: string, data?: Record<string, unknown>): void {
  try {
    const line = makeLine(level, event, data);
    if (!initialized) pending.push(line);
    else void enqueue(() => append(line));
  } catch { /* 진단 기록 실패는 앱 실행을 중단하지 않는다. */ }
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
      // 잘린 UTF-8 문자의 연속 바이트는 건너뛴다.
      while (start < bytesRead && (buffer[start] & 0xc0) === 0x80) start++;
      return buffer.subarray(start, bytesRead).toString("utf8");
    } finally { await file.close(); }
  } catch { return ""; }
}
