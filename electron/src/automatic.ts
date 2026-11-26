import { watch, type FSWatcher } from "node:fs";
import { lstat, opendir, mkdir, open, readFile, realpath, rename, unlink } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { setImmediate as yieldToUI } from "node:timers/promises";
import { setTimeout as delay } from "node:timers/promises";
import type { Engine } from "./engine";
import { hancomProcessCount } from "./hancom";
import { log, logMetrics } from "./logger";

const EXCLUDED = new Set(["proc", "sys", "dev", "run", "windows", "system volume information", "$recycle.bin", "program files", "program files (x86)", "node_modules", "hwp2x_백업", "backup", "backups", ".git"]);
const RESCAN_MS = 30_000;
const STABLE_MS = 1_000;
const WATCH_DEBOUNCE_MS = 1_000;
const METRICS_MS = 10_000;
const AUTO_BATCH = 16;
const testHooks = process.env.HWP2X_TEST_HOOKS === "1";
const testLimit = (name: string, fallback: number) => {
  const value = testHooks ? Number(process.env[name]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};
const SLOW_RSS_BYTES = testLimit("HWP2X_TEST_SLOW_RSS_MB", 384) * 1024 * 1024;
const PAUSE_RSS_BYTES = testLimit("HWP2X_TEST_PAUSE_RSS_MB", 512) * 1024 * 1024;
const STALL_MS = 1_000;
const STALL_PAUSE_MS = 5_000;
const mb = (bytes: number) => `${Math.round(bytes / 1024 / 1024)}MB`;
const MAX_WATCH_EVENTS = 1_000_000;
const FAILURE_LIMIT = 4096;
const ignoredError = (error: unknown) => ["ENOENT", "ENOTDIR", "EACCES", "EPERM", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "");
const fingerprint = (info: { size: number; mtimeMs: number }) => `${info.size}:${info.mtimeMs}`;
interface EventLoopMonitor {
  enable(): void;
  disable(): void;
  reset(): void;
  percentile(percentile: number): number;
}

export async function systemRoots(): Promise<string[]> {
  if (process.platform !== "win32") return ["/"];
  const roots: string[] = [];
  for (let code = 65; code <= 90; code++) {
    const root = `${String.fromCharCode(code)}:\\`;
    try { const dir = await opendir(root); await dir.close(); roots.push(root); }
    catch (error) { if (!ignoredError(error) && (error as NodeJS.ErrnoException).code !== "UNKNOWN") throw error; }
  }
  return roots;
}

interface Settings { enabled: boolean; background: boolean; resumeAtLogin: boolean }
export interface AutomaticIssue {
  source: string;
  name: string;
  reason: string;
  message: string;
  status: "failed" | "queued" | "retrying";
  attempts: number;
  updatedAt: number;
}
export interface AutomaticMetrics {
  scans: number;
  lastScanMs: number;
  watchEvents: number;
  watchers: number;
  hancomProcesses: number;
  queue: { queueDepth: number; queueBytes: number; droppedLines: number };
  eventLoopP99Ms: number;
  cpuPercent: number;
  rssBytes: number;
}
interface StoredIssue extends AutomaticIssue { fingerprint: string }
export class AutomaticConverter {
  private settings: Settings = { enabled: false, background: false, resumeAtLogin: false };
  private phase = "idle";
  private message = "자동 변환 꺼짐";
  private directories: string[] = [];
  private realDirectories: string[] = [];
  private processed = 0;
  private failed = 0;
  private failures = new Map<string, string>();
  private records = new Map<string, StoredIssue>();
  private retryQueue = new Set<string>();
  private issueWrites: Promise<void> = Promise.resolve();
  private lastScanMs = 0;
  private eventLoop?: EventLoopMonitor;
  private watchers = new Map<string, FSWatcher>();
  private loop?: Promise<void>;
  private stopping = false;
  private wake?: () => void;
  private wakeTimer?: NodeJS.Timeout;
  private changed = false;
  private watchEvents = 0;
  private scans = 0;
  private metricsTimer?: NodeJS.Timeout;
  private lastCpuPercent = 0;
  private cpuUsage = process.cpuUsage();
  private cpuAt = process.hrtime.bigint();
  private controls: Promise<void> = Promise.resolve();
  private stallUntil = 0;
  private converting = false;

  constructor(private readonly engine: Engine, private readonly settingsPath: string, private readonly roots: () => Promise<string[]>) {}

  snapshot(): { enabled: boolean; background: boolean; resumeAtLogin: boolean; phase: string; message: string; roots: string[]; processed: number; failed: number; pendingIssues: number; retrying: number; metrics: AutomaticMetrics } {
    return {
      ...this.settings, phase: this.phase, message: this.message, roots: [...this.directories], processed: this.processed, failed: this.failed,
      pendingIssues: this.records.size, retrying: [...this.records.values()].filter(item => item.status === "retrying").length,
      metrics: { scans: this.scans, lastScanMs: this.lastScanMs, watchEvents: this.watchEvents, watchers: this.watchers.size, hancomProcesses: hancomProcessCount(), queue: logMetrics(), eventLoopP99Ms: this.eventLoop ? this.eventLoop.percentile(99) / 1e6 : 0, cpuPercent: this.lastCpuPercent, rssBytes: process.memoryUsage().rss },
    };
  }


  issues(options: { offset?: number; limit?: number } = {}) {
    const offset = options.offset ?? 0;
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 0 || limit > FAILURE_LIMIT) throw new Error("미처리 조회 범위가 올바르지 않습니다");
    const items = [...this.records.values()].slice(offset, offset + limit).map(({ fingerprint: _key, ...item }) => ({ ...item }));
    return { items, total: this.records.size, offset };
  }

  hasIssue(source: string): boolean {
    return this.records.has(source);
  }

  /** A registered unprocessed file that still resolves inside the watched roots (a later swap to a link is refused). */
  async openableIssue(source: string): Promise<boolean> {
    if (!this.records.has(source)) return false;
    try { return await this.withinRoots(source); } catch { return false; }
  }

  retryIssue(source: string): Promise<void> {
    return this.control(async () => {
      if (!this.settings.enabled || this.stopping) throw new Error("자동 감시 실행 중에만 재시도할 수 있습니다");
      const issue = this.records.get(source);
      if (!issue) throw new Error("등록된 미처리 파일이 아닙니다");
      if (!await this.withinRoots(source)) throw new Error("허용된 드라이브 밖의 파일입니다");
      if (this.stopping) throw new Error("자동 변환 중지 중입니다");
      if (issue.status !== "failed") return;
      if (this.retryQueue.size >= FAILURE_LIMIT) throw new Error("재시도 대기열이 가득 찼습니다");
      issue.status = "queued";
      issue.updatedAt = Date.now();
      await this.saveIssues();
      this.retryQueue.add(source);
      this.wake?.();
    });
  }

  private saveIssues(): Promise<void> {
    const write = this.issueWrites.then(async () => {
      const destination = `${this.settingsPath}.issues.json`;
      const temporary = `${destination}.${randomUUID()}.tmp`;
      await mkdir(path.dirname(destination), { recursive: true });
      try {
        const file = await open(temporary, "wx", 0o600);
        try { await file.writeFile(JSON.stringify({ version: 1, items: [...this.records.values()] })); await file.sync(); }
        finally { await file.close(); }
        await rename(temporary, destination);
      } finally { await unlink(temporary).catch(error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }); }
    });
    this.issueWrites = write.catch(() => undefined);
    return write.catch(error => {
      this.stopping = true;
      this.settings.enabled = false;
      this.phase = "error";
      this.message = `안전 중단: 미처리 기록 저장 실패: ${String(error)}`;
      this.wake?.();
      this.closeWatchers();
      throw new Error(this.message);
    });
  }

  private async restoreIssues(): Promise<void> {
    let data;
    try {
      const file = await open(`${this.settingsPath}.issues.json`, "r");
      try {
        if ((await file.stat()).size > 16 * 1024 * 1024) throw new Error("미처리 기록 파일이 너무 큽니다");
        data = JSON.parse(await file.readFile("utf8"));
      } finally { await file.close(); }
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    if (data?.version !== 1 || !Array.isArray(data.items) || data.items.length > FAILURE_LIMIT) throw new Error("미처리 기록 형식이 올바르지 않습니다");
    const restored = new Map<string, StoredIssue>();
    for (const item of data.items) {
      if (!item || ["source", "name", "reason", "message", "fingerprint"].some(key => typeof item[key] !== "string" || item[key].length > 32768)
        || !path.isAbsolute(item.source) || !/\.(hwp|hwpml)$/i.test(item.source) || restored.has(item.source)
        || !["failed", "queued", "retrying"].includes(item.status) || !Number.isSafeInteger(item.attempts) || item.attempts < 1
        || !Number.isFinite(item.updatedAt) || item.updatedAt < 0) throw new Error("미처리 기록 항목이 올바르지 않습니다");
      restored.set(item.source, { source: item.source, name: path.basename(item.source), reason: item.reason, message: item.message, fingerprint: item.fingerprint, status: "failed", attempts: item.attempts, updatedAt: item.updatedAt });
    }
    this.records = restored;
    this.failures = new Map([...restored.values()].map(item => [item.source, item.fingerprint]));
    this.retryQueue.clear();
  }

  private control(action: () => Promise<void>): Promise<void> {
    const result = this.controls.then(action);
    this.controls = result.catch(() => undefined);
    return result;
  }

  private async save(settings: Settings): Promise<void> {
    await mkdir(path.dirname(this.settingsPath), { recursive: true });
    const temporary = `${this.settingsPath}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(JSON.stringify({ version: 1, ...settings })); await file.sync(); }
      finally { await file.close(); }
      await rename(temporary, this.settingsPath);
    } finally { await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; }); }
  }

  restore(): Promise<void> {
    return this.control(async () => {
      if (this.loop) throw new Error("자동 변환 실행 중에는 복원할 수 없습니다");
      await this.restoreIssues();
      let data;
      try { data = JSON.parse(await readFile(this.settingsPath, "utf8")); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
      if (data?.version !== 1 || [data.enabled, data.background, data.resumeAtLogin].some(value => typeof value !== "boolean")) throw new Error("자동 변환 설정 형식이 올바르지 않습니다");
      this.settings = { enabled: false, background: data.background, resumeAtLogin: data.resumeAtLogin };
    });
  }

  configure(options: { background?: boolean; resumeAtLogin?: boolean }): Promise<void> {
    return this.control(async () => {
      const next = { ...this.settings };
      for (const key of ["background", "resumeAtLogin"] as const) {
        if (options[key] !== undefined) {
          if (typeof options[key] !== "boolean") throw new Error("자동 변환 설정은 boolean이어야 합니다");
          next[key] = options[key];
        }
      }
      await this.save(next);
      const enabled = this.settings.enabled;
      this.settings = { ...next, enabled };
      if (enabled !== next.enabled) await this.save(this.settings);
    });
  }

  start(): Promise<void> { return this.control(() => this.begin()); }

  private async begin(): Promise<void> {
    if (this.loop) return;
    if (this.engine.running || this.engine.state.phase === "paused") throw new Error("진행 중이거나 일시정지된 작업을 먼저 종료해 주세요");
    const roots = await this.roots();
    this.directories = [...new Set(roots.map(root => path.resolve(root)))];
    if (!this.directories.length) throw new Error("접근 가능한 드라이브가 없습니다");
    this.realDirectories = [];
    for (const root of this.directories) {
      try { this.realDirectories.push(await realpath(root)); }
      catch (error) { if (!ignoredError(error)) throw error; }
    }
    const next = { ...this.settings, enabled: true };
    await this.save(next);
    this.settings = next;
    this.stopping = false;
    this.changed = false;
    this.phase = "scanning";
    this.message = "전체 드라이브에서 변환할 파일을 찾는 중";
    this.startMetrics();
    // Non-recursive watches are bounded hints; streaming scans cover unwatched directories.
    this.loop = this.run().catch(async error => {
      this.stopping = true;
      this.settings.enabled = false;
      this.phase = "error";
      this.message = `안전 중단: ${error instanceof Error ? error.message : String(error)}`;
      try { await this.save(this.settings); }
      catch (saveError) { this.message += ` / 설정 저장 실패: ${String(saveError)}`; }
    }).finally(() => { this.closeWatchers(); this.stopMetrics(); this.loop = undefined; });
  }
  private startMetrics(): void {
    this.eventLoop = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoop.enable();
    this.cpuUsage = process.cpuUsage();
    this.cpuAt = process.hrtime.bigint();
    this.metricsTimer = setInterval(() => {
      const now = process.hrtime.bigint();
      const elapsed = Number(now - this.cpuAt) / 1e9;
      const used = process.cpuUsage(this.cpuUsage);
      const cpuPercent = elapsed > 0 ? (used.user + used.system) / 10_000 / elapsed : 0;
      this.lastCpuPercent = cpuPercent;
      const eventLoopP99Ms = this.eventLoop ? this.eventLoop.percentile(99) / 1e6 : 0;
      const rssBytes = process.memoryUsage().rss;
      const queue = logMetrics();
      const hancomProcesses = hancomProcessCount();
      const metrics = { rssBytes, cpuPercent, eventLoopP99Ms, hancomProcesses, watchEvents: this.watchEvents, watchers: this.watchers.size, scans: this.scans, lastScanMs: this.lastScanMs, records: this.records.size, processed: this.processed, queue };
      log("info", "automatic.metrics", { 요약: `자동 변환 상태 · 메모리 ${mb(rssBytes)} · CPU ${Math.round(cpuPercent)}% · 화면 지연 ${Math.round(eventLoopP99Ms)}ms · 한컴 실행 ${hancomProcesses}개 · 처리 ${this.processed}개 · 미처리 ${this.records.size}개 · 로그 대기 ${queue.queueDepth}줄`, ...metrics });
      if (eventLoopP99Ms >= STALL_MS) {
        this.stallUntil = Date.now() + STALL_PAUSE_MS;
        log("warn", "automatic.event-loop-stall", { 요약: `앱 응답 지연 감지(${Math.round(eventLoopP99Ms)}ms) · 다음 파일 전에 ${STALL_PAUSE_MS / 1000}초 쉬어 갑니다`, ...metrics });
      }
      this.cpuUsage = process.cpuUsage();
      this.cpuAt = now;
      this.eventLoop?.reset();
    }, METRICS_MS);
    this.metricsTimer.unref();
  }

  private stopMetrics(): void {
    if (this.metricsTimer) clearInterval(this.metricsTimer);
    this.metricsTimer = undefined;
    this.eventLoop?.disable();
    this.eventLoop = undefined;
  }

  private async throttle(): Promise<void> {
    const rssBytes = process.memoryUsage().rss;
    const stalled = Date.now() < this.stallUntil;
    if (stalled || rssBytes >= PAUSE_RSS_BYTES) {
      const waitMs = stalled ? this.stallUntil - Date.now() : 2_000;
      const reason = stalled ? "앱 응답 지연" : `메모리 ${mb(rssBytes)} (한도 ${mb(PAUSE_RSS_BYTES)})`;
      this.message = "부하가 높아 자동 변환을 잠시 멈췄습니다";
      log("warn", "automatic.pause", { 요약: `일시정지 · ${reason} · ${Math.round(waitMs / 100) / 10}초 쉬어 갑니다`, rssBytes, waitMs, threshold: PAUSE_RSS_BYTES });
      await this.wait(waitMs);
      this.stallUntil = 0;
      log("info", "automatic.recovery", { 요약: `복구 · 일시정지 후 변환을 다시 이어갑니다 · 메모리 ${mb(process.memoryUsage().rss)}`, action: "pause", rssBytes: process.memoryUsage().rss });
    } else if (rssBytes >= SLOW_RSS_BYTES) {
      log("warn", "automatic.throttle", { 요약: `감속 · 메모리 ${mb(rssBytes)} (기준 ${mb(SLOW_RSS_BYTES)}) · 0.5초 쉬어 갑니다`, rssBytes, threshold: SLOW_RSS_BYTES });
      await this.wait(500);
      log("info", "automatic.recovery", { 요약: `복구 · 감속 후 변환을 다시 이어갑니다 · 메모리 ${mb(process.memoryUsage().rss)}`, action: "throttle", rssBytes: process.memoryUsage().rss });
    }
    if (!this.stopping) this.message = `${this.processed}개 처리 · 변환 계속`;
    await yieldToUI();
  }

  stop(): Promise<void> {
    this.stopping = true;
    if (this.wakeTimer) { clearTimeout(this.wakeTimer); this.wakeTimer = undefined; }
    this.wake?.();
    return this.control(async () => {
      if (this.loop) await this.loop;
      for (const issue of this.records.values()) if (issue.status !== "failed") issue.status = "failed";
      await this.saveIssues();
      this.settings.enabled = false;
      this.phase = "stopped";
      this.message = "자동 변환 중지됨";
      try { await this.save(this.settings); }
      catch (error) { this.phase = "error"; this.message = `설정 저장 실패: ${String(error)}`; throw error; }
    });
  }

  private closeWatchers(): void {
    for (const watcher of this.watchers.values()) watcher.close();
    this.watchers.clear();
  }

  private signalChange(directory: string, filename: string | Buffer | null): void {
    const name = filename === null ? "" : filename.toString();
    if (name.startsWith(".hwp2x-") || /\.(hwpx|md)$/i.test(name)) return;
    this.watchEvents = Math.min(MAX_WATCH_EVENTS, this.watchEvents + 1);
    this.changed = true;
    if (this.watchEvents >= MAX_WATCH_EVENTS) {
      log("warn", "automatic.watch-limit", { events: this.watchEvents });
      this.closeWatchers();
      return;
    }
    if (this.wakeTimer || this.converting || this.phase === "scanning") return;
    this.wakeTimer = setTimeout(() => {
      this.wakeTimer = undefined;
      this.wake?.();
    }, WATCH_DEBOUNCE_MS);
    this.wakeTimer.unref();
  }

  private observe(directory: string): void {
    if (this.watchers.size >= 128 || this.watchers.has(directory)) return;
    try {
      const watcher = watch(directory, { recursive: false, persistent: false }, (_event, filename) => this.signalChange(directory, filename));
      watcher.on("error", () => { watcher.close(); this.watchers.delete(directory); });
      this.watchers.set(directory, watcher);
    } catch { /* Periodic scans also cover unsupported and inaccessible watches. */ }
  }

  private wait(ms: number): Promise<void> {
    if (this.stopping) return Promise.resolve();
    let resolve!: () => void;
    const promise = new Promise<void>(done => { resolve = done; });
    const finish = () => { clearTimeout(timer); if (this.wake === finish) this.wake = undefined; resolve(); };
    const timer = setTimeout(finish, ms);
    this.wake = finish;
    return promise;
  }


  private async *walk(directory: string, depth = 0): AsyncGenerator<string> {
    if (this.stopping || depth > 128 || EXCLUDED.has(path.basename(directory).toLowerCase()) || directory === this.engine.state.backupDir) return;
    try {
      if (!(await lstat(directory)).isDirectory()) return;
      this.observe(directory);
      const entries = await opendir(directory);
      for await (const entry of entries) {
        if (this.stopping) return;
        if (entry.isSymbolicLink()) continue;
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) yield* this.walk(file, depth + 1);
        else if (entry.isFile() && /\.(hwp|hwpml)$/i.test(entry.name)) yield file;
        await yieldToUI();
      }
    } catch (error) { if (!ignoredError(error)) throw error; }
  }

  private async withinRoots(file: string): Promise<boolean> {
    const actual = await realpath(file);
    return this.realDirectories.some(root => actual === root || actual.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`));
  }

  private async eligible(file: string, explicit = false): Promise<string | undefined> {
    try {
      if (!explicit && this.records.get(file)?.status !== undefined && this.records.get(file)?.status !== "failed") return;
      const source = await lstat(file);
      if (!(await this.withinRoots(file))) return;
      if (!source.isFile()) return;
      try { await lstat(file.replace(/\.(hwp|hwpml)$/i, ".hwpx")); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      const key = fingerprint(source);
      return !explicit && this.failures.get(file) === key ? undefined : key;
    } catch (error) { if (!ignoredError(error)) throw error; }
  }

  private async batch(files: string[], explicit = false): Promise<void> {
    const candidates: Array<{ file: string; key: string }> = [];
    for (const file of files) {
      await yieldToUI();
      const key = await this.eligible(file, explicit);
      if (key) candidates.push({ file, key });
    }
    if (!candidates.length) return;
    const until = Date.now() + STABLE_MS;
    while (!this.stopping && Date.now() < until) await this.wait(until - Date.now());
    const stable: Array<{ file: string; key: string }> = [];
    for (const candidate of candidates) {
      if (this.stopping) return;
      if (await this.eligible(candidate.file, explicit) === candidate.key) stable.push(candidate);
    }
    if (!stable.length || this.stopping) return;
    if (this.records.size + stable.filter(item => !this.records.has(item.file)).length > FAILURE_LIMIT) throw new Error("미처리 기록 한도에 도달하여 자동 변환을 중지합니다");
    for (const { file } of stable) {
      const issue = this.records.get(file);
      if (issue) { issue.status = "retrying"; issue.updatedAt = Date.now(); }
    }
    if (stable.some(item => this.records.has(item.file))) await this.saveIssues();
    if (this.stopping) return;
    if (this.engine.running || this.engine.state.phase === "paused") throw new Error("다른 변환 작업이 시작되어 자동 변환을 중지합니다");
    this.phase = "converting";
    this.message = `${stable.length}개 파일 변환 중`;
    const workers = this.engine.state.workers;
    this.engine.configure({ workers: 1 });
    this.converting = true;
    let conversionError: unknown;
    try { await this.engine.convertPaths(stable.map(item => item.file)); }
    catch (error) { conversionError = error; }
    finally { this.converting = false; this.engine.configure({ workers }); }
    for (const { file, key } of stable) {
      await yieldToUI();
      const result = this.engine.state.files.find(item => item.source === file);
      if (result?.status === "ok" || result?.status === "diff") {
        this.processed++;
        this.failures.delete(file);
        this.records.delete(file);
        this.retryQueue.delete(file);
      } else if (result?.status === "fail") {
        this.failed++;
        this.recordFailure(file, key, result.reason || "변환 실패", result.message || "파일을 확인하고 다시 시도해 주세요");
      } else this.recordFailure(file, key, "변환 중단", "완료되지 않았습니다. 파일 상태를 확인하고 다시 시도해 주세요");
    }
    await yieldToUI();
    await this.saveIssues();
    if (conversionError) throw conversionError;
    if (!this.stopping && (String(this.engine.state.phase) === "paused" || this.engine.state.message.startsWith("안전 중단"))) throw new Error(this.engine.state.message);
  }

  private async run(): Promise<void> {
    while (!this.stopping) {
      const scanStarted = Date.now();
      this.scans++;
      this.changed = false;
      this.phase = "scanning";
      this.message = this.processed || this.records.size ? "새 파일과 바뀐 파일을 다시 찾는 중" : "전체 드라이브에서 변환할 파일을 찾는 중";
      log("info", "automatic.scan-begin", { scan: this.scans, roots: this.directories.length, watchEvents: this.watchEvents });
      const batch: string[] = [];
      for (const root of this.directories) {
        try {
          const actual = await realpath(root);
          if (!this.realDirectories.includes(actual)) this.realDirectories.push(actual);
        } catch (error) { if (!ignoredError(error)) throw error; }
        for await (const file of this.walk(root)) {
          await this.drainRetries();
          batch.push(file);
          if (batch.length === AUTO_BATCH) { await this.throttle(); await this.batch(batch); batch.length = 0; }
          if (this.stopping) return;
        }
        if (this.stopping) return;
        await this.batch(batch);
        batch.length = 0;
      }
      await this.batch(batch);
      await this.drainRetries();
      this.lastScanMs = Date.now() - scanStarted;
      log("info", "automatic.scan-end", { 요약: `검색 한 바퀴 끝 · ${Math.round(this.lastScanMs / 1000)}초 · 처리 ${this.processed}개 · 미처리 ${this.records.size}개`, scan: this.scans, ms: this.lastScanMs, watchEvents: this.watchEvents, processed: this.processed, pending: this.records.size });
      if (this.stopping) return;
      this.phase = "watching";
      this.message = "완료 · 감시 체제로 전환됨";
      if (this.retryQueue.size) continue;
      if (this.changed) await this.wait(WATCH_DEBOUNCE_MS);
      else await this.wait(RESCAN_MS);
    }
  }

  private recordFailure(source: string, key: string, reason: string, message: string): void {
    const previous = this.records.get(source);
    if (!previous && this.records.size >= FAILURE_LIMIT) throw new Error("미처리 기록 한도에 도달했습니다");
    const prefix = (text: string) => text.startsWith("처리하지 못함") ? text : `처리하지 못함: ${text}`;
    this.records.set(source, { source, name: path.basename(source), reason: prefix(reason), message: prefix(message), status: "failed", attempts: (previous?.attempts ?? 0) + 1, updatedAt: Date.now(), fingerprint: key });
    this.failures.set(source, key);
    this.retryQueue.delete(source);
  }

  private async drainRetries(): Promise<void> {
    for (const source of this.retryQueue) {
      if (this.stopping) return;
      this.retryQueue.delete(source);
      const issue = this.records.get(source);
      if (!issue || issue.status !== "queued") continue;
      const key = await this.eligible(source, true);
      if (!key) {
        this.recordFailure(source, issue.fingerprint, "재시도 조건 확인 필요", "기존 HWPX 결과를 보존했습니다. 출력 파일의 이동·이름 변경 또는 원본 접근 권한과 경로를 확인한 후 다시 시도해 주세요");
        await this.saveIssues();
        continue;
      }
      await this.batch([source], true);
      if (this.records.get(source) === issue && issue.status === "queued") {
        this.recordFailure(source, issue.fingerprint, "파일 변경 또는 접근 불가", "파일 저장을 마치고 원본과 출력 경로를 확인한 후 다시 시도해 주세요");
        await this.saveIssues();
      }
    }
  }

}
