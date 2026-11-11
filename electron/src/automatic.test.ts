import test from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { AutomaticConverter } from "./automatic";
import type { Engine } from "./engine";

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate: () => boolean, timeout = 5_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() >= end) throw new Error("조건 대기 시간 초과");
    await delay(20);
  }
}

class FakeEngine {
  running = false;
  calls: string[][] = [];
  fail = new Set<string>();
  state = { phase: "idle", message: "준비됨", files: [] as Array<{ source: string; status: string }>, workers: 4, backupDir: "" };
  configure(options: { workers?: number }): void { if (options.workers !== undefined) this.state.workers = options.workers; }
  async convertPaths(files: string[]): Promise<void> {
    this.running = true;
    this.calls.push([...files]);
    assert.equal(this.state.workers, 1);
    this.state.files = files.map(source => ({ source, status: this.fail.has(source) ? "fail" : "ok" }));
    for (const source of files) if (!this.fail.has(source)) await writeFile(source.replace(/\.(hwp|hwpml)$/i, ".hwpx"), "converted");
    this.state.phase = "done";
    this.running = false;
  }
  async stopRun(): Promise<void> { this.running = false; this.state.phase = "stopped"; }
}

async function fixture() {
  const home = await mkdtemp(path.join(tmpdir(), "hwp2x-automatic-"));
  const settings = path.join(home, "state", "automatic.json");
  const engine = new FakeEngine();
  const roots = [path.join(home, "a"), path.join(home, "b")];
  await Promise.all(roots.map(root => mkdir(root)));
  const automatic = new AutomaticConverter(engine as unknown as Engine, settings, async () => roots);
  return { home, settings, engine, roots, automatic };
}

test("설정 복원은 자동 시작 없이 옵션만 복원한다", async t => {
  const f = await fixture(); t.after(() => rm(f.home, { recursive: true, force: true }));
  await mkdir(path.dirname(f.settings), { recursive: true });
  await writeFile(f.settings, JSON.stringify({ version: 1, enabled: true, background: true, resumeAtLogin: true }));
  await f.automatic.restore();
  assert.deepEqual(f.automatic.snapshot(), { enabled: false, background: true, resumeAtLogin: true, phase: "idle", message: "자동 변환 꺼짐", roots: [], processed: 0, failed: 0, pendingIssues: 0, retrying: 0 });
  assert.equal(f.engine.calls.length, 0);
});

test("다중 roots 신규 파일을 최대 32개 단일 작업으로 처리하고 원본과 workers를 보존한다", async t => {
  const f = await fixture(); t.after(async () => { await f.automatic.stop(); await rm(f.home, { recursive: true, force: true }); });
  const files: string[] = [];
  for (let index = 0; index < 33; index++) {
    const file = path.join(f.roots[0], `${index}.hwp`);
    files.push(file); await writeFile(file, `original-${index}`);
  }
  const secondRoot = path.join(f.roots[1], "second-root.hwp");
  files.push(secondRoot); await writeFile(secondRoot, "second-root-original");
  await f.automatic.start();
  await until(() => f.automatic.snapshot().processed === 34);
  assert.deepEqual(f.engine.calls.map(call => call.length), [32, 1, 1]);
  assert.equal(await readFile(files[0], "utf8"), "original-0");
  await writeFile(path.join(f.roots[0], "new.hwp"), "new-original");
  await until(() => f.automatic.snapshot().processed === 35);
});

test("기존 출력은 건너뛰고 실패 파일은 변경 전 반복하지 않는다", async t => {
  const f = await fixture(); t.after(async () => { await f.automatic.stop(); await rm(f.home, { recursive: true, force: true }); });
  const existing = path.join(f.roots[0], "existing.hwp");
  const failed = path.join(f.roots[0], "failed.hwp");
  f.engine.fail.add(failed);
  await writeFile(existing, "source"); await writeFile(existing.replace(/\.hwp$/, ".hwpx"), "keep"); await writeFile(failed, "bad");
  await f.automatic.start();
  await until(() => f.automatic.snapshot().failed === 1);
  const calls = f.engine.calls.length;
  await writeFile(path.join(f.roots[0], "wake.txt"), "wake"); await delay(1_300);
  assert.equal(f.engine.calls.length, calls);
  assert.equal(await readFile(existing.replace(/\.hwp$/, ".hwpx"), "utf8"), "keep");
});

test("중지는 후속 신규 파일을 막고 설정 저장 실패에도 메모리에서 꺼진다", async t => {
  const f = await fixture(); t.after(() => rm(f.home, { recursive: true, force: true }));
  await f.automatic.start(); await f.automatic.stop();
  await writeFile(path.join(f.roots[0], "after-stop.hwp"), "source"); await delay(1_200);
  assert.equal(f.engine.calls.length, 0);
  assert.equal(f.automatic.snapshot().enabled, false);
  assert.equal(JSON.parse(await readFile(f.settings, "utf8")).enabled, false);

  await f.automatic.start();
  await rm(path.dirname(f.settings), { recursive: true });
  await writeFile(path.dirname(f.settings), "설정 디렉터리 차단");
  await assert.rejects(f.automatic.stop());
  assert.equal(f.automatic.snapshot().enabled, false);
});

test("미처리는 다음 batch에도 남고 페이지 조회와 재시도 실패·중복·성공을 지원한다", async t => {
  const f = await fixture(); t.after(async () => { await f.automatic.stop(); await rm(f.home, { recursive: true, force: true }); });
  const source = path.join(f.roots[0], "실패.hwp");
  await writeFile(source, "원본"); f.engine.fail.add(source);
  await assert.rejects(f.automatic.retryIssue(source));
  await f.automatic.start();
  await until(() => f.automatic.snapshot().phase === "watching");
  assert.equal(f.automatic.snapshot().message, "완료 · 감시 체제로 전환됨");
  assert.equal(f.automatic.issues().items[0].attempts, 1);
  await writeFile(path.join(f.roots[0], "다음.hwp"), "다음 원본");
  await until(() => f.automatic.snapshot().processed === 1);
  assert.equal(f.automatic.issues().total, 1);
  assert.deepEqual(f.automatic.issues({ offset: 1, limit: 1 }), { items: [], total: 1, offset: 1 });
  assert.throws(() => f.automatic.issues({ offset: -1 }));
  assert.throws(() => f.automatic.issues({ limit: Infinity }));
  const copy = f.automatic.issues().items[0]; copy.message = "외부 변경";
  assert.notEqual(f.automatic.issues().items[0].message, copy.message);
  await Promise.all([f.automatic.retryIssue(source), f.automatic.retryIssue(source)]);
  assert.equal(f.automatic.issues().items[0].status, "queued");
  await until(() => f.automatic.issues().items[0]?.attempts === 2);
  assert.equal(f.engine.calls.filter(call => call.includes(source)).length, 2);
  assert.match(f.automatic.issues().items[0].reason, /^처리하지 못함/);
  f.engine.fail.delete(source);
  await f.automatic.retryIssue(source);
  await until(() => f.automatic.issues().total === 0);
  assert.equal(await readFile(source, "utf8"), "원본");
  const stopping = f.automatic.stop();
  await assert.rejects(f.automatic.retryIssue(source)); await stopping;
});

test("별도 JSON 복원은 미처리와 fingerprint를 보존하고 roots 밖 재시도는 막는다", async t => {
  const f = await fixture(); t.after(async () => { await f.automatic.stop(); await rm(f.home, { recursive: true, force: true }); });
  const source = path.join(f.roots[0], "failed.hwp");
  await writeFile(source, "bad"); f.engine.fail.add(source);
  await f.automatic.start(); await until(() => f.automatic.snapshot().phase === "watching"); await f.automatic.stop();
  const restored = new AutomaticConverter(f.engine as unknown as Engine, f.settings, async () => f.roots);
  t.after(() => restored.stop());
  await restored.restore(); assert.equal(restored.issues().items[0].source, source);
  const count = f.engine.calls.length;
  await restored.start(); await until(() => restored.snapshot().phase === "watching");
  assert.equal(f.engine.calls.length, count); await restored.stop();
  const outside = new AutomaticConverter(f.engine as unknown as Engine, f.settings, async () => [f.roots[1]]);
  await outside.restore(); await outside.start();
  try { await assert.rejects(outside.retryIssue(source), /드라이브 밖/); }
  finally { await outside.stop(); }
});

test("기존 결과를 가진 실패는 명시 재시도도 덮어쓰지 않고 조치를 안내한다", async t => {
  const f = await fixture(); t.after(async () => { await f.automatic.stop(); await rm(f.home, { recursive: true, force: true }); });
  const source = path.join(f.roots[0], "failed.hwp"); const target = source.replace(/\.hwp$/, ".hwpx");
  await writeFile(source, "원본"); f.engine.fail.add(source);
  await f.automatic.start(); await until(() => f.automatic.snapshot().phase === "watching");
  await writeFile(target, "유지");
  await f.automatic.retryIssue(source); await until(() => f.automatic.issues().items[0]?.status === "failed");
  assert.equal(f.engine.calls.length, 1);
  assert.match(f.automatic.issues().items[0].message, /이름 변경/);
  assert.equal(await readFile(target, "utf8"), "유지");
  assert.equal(await readFile(source, "utf8"), "원본");
});

test("미처리 저장 실패는 안전중단하고 잘못된 복원 기록을 거부한다", async t => {
  const f = await fixture(); t.after(() => rm(f.home, { recursive: true, force: true }));
  const source = path.join(f.roots[0], "failed.hwp"); await writeFile(source, "bad"); f.engine.fail.add(source);
  await mkdir(`${f.settings}.issues.json`, { recursive: true });
  await f.automatic.start(); await until(() => f.automatic.snapshot().phase === "error");
  assert.equal(f.automatic.snapshot().enabled, false);
  assert.match(f.automatic.snapshot().message, /미처리 기록 저장 실패/);
  await rm(`${f.settings}.issues.json`, { recursive: true });
  await f.automatic.stop();
  await writeFile(`${f.settings}.issues.json`, JSON.stringify({ version: 1, items: [{ source: "relative.hwp" }] }));
  await assert.rejects(f.automatic.restore(), /기록 항목/);
  await writeFile(`${f.settings}.issues.json`, JSON.stringify({ version: 1, items: Array(4097).fill({}) }));
  await assert.rejects(f.automatic.restore(), /기록 형식/);
});

test("fingerprint 자동 재시도와 명시 요청은 중복 실행하지 않고 engine 배타를 유지한다", async t => {
  const f = await fixture(); t.after(async () => { await f.automatic.stop(); await rm(f.home, { recursive: true, force: true }); });
  const source = path.join(f.roots[0], "race.hwp"); await writeFile(source, "bad"); f.engine.fail.add(source);
  await f.automatic.start(); await until(() => f.automatic.snapshot().phase === "watching");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const original = f.engine.convertPaths.bind(f.engine);
  let active = 0;
  f.engine.convertPaths = async files => {
    assert.equal(++active, 1);
    await gate;
    try { await original(files); } finally { active--; }
  };
  await writeFile(source, "fixed-and-changed");
  await until(() => f.automatic.snapshot().retrying === 1);
  await f.automatic.retryIssue(source);
  await until(() => active === 1);
  await f.automatic.retryIssue(source);
  assert.equal(active, 1);
  f.engine.fail.delete(source); release();
  await until(() => f.automatic.issues().total === 0);
  assert.equal(f.engine.calls.filter(call => call.includes(source)).length, 2);
});

test("복원된 queued와 retrying은 자동 실행 없이 failed로 돌아오고 중복 자료는 거부한다", async t => {
  const f = await fixture(); t.after(() => rm(f.home, { recursive: true, force: true }));
  await mkdir(path.dirname(f.settings), { recursive: true });
  const items = ["queued", "retrying"].map((status, index) => ({ source: path.join(f.roots[0], `${index}.hwp`), name: `${index}.hwp`, reason: "처리하지 못함", message: "처리하지 못함: 확인 필요", status, attempts: 2, updatedAt: Date.now(), fingerprint: "1:2" }));
  await writeFile(`${f.settings}.issues.json`, JSON.stringify({ version: 1, items }));
  await f.automatic.restore();
  assert.deepEqual(f.automatic.issues().items.map(item => item.status), ["failed", "failed"]);
  assert.equal(f.engine.calls.length, 0);
  await writeFile(`${f.settings}.issues.json`, JSON.stringify({ version: 1, items: [items[0], items[0]] }));
  await assert.rejects(f.automatic.restore(), /기록 항목/);
});

test("미처리 경로가 외부 symlink로 바뀌면 재시도를 거부한다", async t => {
  const f = await fixture(); t.after(async () => { await f.automatic.stop(); await rm(f.home, { recursive: true, force: true }); });
  const source = path.join(f.roots[0], "link.hwp");
  await writeFile(source, "bad"); f.engine.fail.add(source);
  await f.automatic.start(); await until(() => f.automatic.snapshot().phase === "watching");
  const outside = path.join(f.home, "outside.hwp"); await writeFile(outside, "외부 원본");
  await rm(source); await symlink(outside, source);
  await assert.rejects(f.automatic.retryIssue(source), /드라이브 밖/);
  assert.equal(await readFile(outside, "utf8"), "외부 원본");
  assert.equal(f.engine.calls.length, 1);
});

test("4096개 기록 복원은 bounded 페이지로 조회하고 초과 위험은 변환 전에 중단한다", async t => {
  const f = await fixture(); t.after(async () => { await f.automatic.stop(); await rm(f.home, { recursive: true, force: true }); });
  await mkdir(path.dirname(f.settings), { recursive: true });
  const items = Array.from({ length: 4096 }, (_, index) => ({ source: path.join(f.roots[0], `${index}.hwp`), name: `${index}.hwp`, reason: "처리하지 못함", message: "처리하지 못함", status: "failed", attempts: 1, updatedAt: Date.now(), fingerprint: "1:2" }));
  await writeFile(`${f.settings}.issues.json`, JSON.stringify({ version: 1, items }));
  await f.automatic.restore();
  assert.equal(f.automatic.issues({ offset: 4095, limit: 10 }).items.length, 1);
  assert.equal(f.automatic.issues().total, 4096);
  await writeFile(path.join(f.roots[0], "new.hwp"), "원본");
  await f.automatic.start(); await until(() => f.automatic.snapshot().phase === "error");
  assert.equal(f.automatic.snapshot().pendingIssues, 4096);
  assert.equal(f.engine.calls.length, 0);
});

test("분리된 루트가 있어도 빈 검색은 감시로 전환하고 재연결 파일을 발견한다", async t => {
  const f = await fixture();
  t.after(async () => { await f.automatic.stop(); await rm(f.home, { recursive: true, force: true }); });
  await rm(f.roots[1], { recursive: true });
  await f.automatic.start();
  await until(() => f.automatic.snapshot().phase === "watching");
  assert.equal(f.engine.calls.length, 0);
  await mkdir(f.roots[1]);
  const source = path.join(f.roots[1], "reconnected.hwp");
  await writeFile(source, "reconnected original");
  await writeFile(path.join(f.roots[0], "wake.txt"), "rescan");
  await until(() => f.automatic.snapshot().processed === 1);
  assert.deepEqual(f.engine.calls, [[source]]);
});

test("수동 실행 및 일시정지 중 자동 시작은 설정 변경 없이 거부한다", async t => {
  const f = await fixture();
  t.after(() => rm(f.home, { recursive: true, force: true }));
  f.engine.running = true;
  await assert.rejects(f.automatic.start(), /작업을 먼저 종료/);
  f.engine.running = false;
  f.engine.state.phase = "paused";
  await assert.rejects(f.automatic.start(), /작업을 먼저 종료/);
  assert.equal(f.automatic.snapshot().enabled, false);
  assert.equal(f.engine.calls.length, 0);
});

test("두 차례 실패 재작업 이력은 재시작 뒤 유실이나 중복 실행 없이 보존한다", async t => {
  const f = await fixture();
  t.after(async () => { await f.automatic.stop(); await rm(f.home, { recursive: true, force: true }); });
  const source = path.join(f.roots[0], "retry-twice.hwp");
  await writeFile(source, "bad"); f.engine.fail.add(source);
  await f.automatic.start();
  await until(() => f.automatic.issues().items[0]?.attempts === 1);
  for (const attempts of [2, 3]) {
    await f.automatic.retryIssue(source);
    await until(() => f.automatic.issues().items[0]?.attempts === attempts);
  }
  await f.automatic.stop();
  const restored = new AutomaticConverter(f.engine as unknown as Engine, f.settings, async () => f.roots);
  try {
    await restored.restore(); await restored.start();
    await until(() => restored.snapshot().phase === "watching");
    assert.equal(restored.issues().total, 1);
    assert.equal(restored.issues().items[0].attempts, 3);
    assert.equal(f.engine.calls.length, 3);
  } finally { await restored.stop(); }
});

test("감시 등록 실패에도 30초 정기 재검색으로 신규 파일을 발견한다", async t => {
  const f = await fixture();
  t.after(async () => { await f.automatic.stop(); await rm(f.home, { recursive: true, force: true }); });
  t.mock.method(require("node:fs"), "watch", () => { throw Object.assign(new Error("watch unavailable"), { code: "ENOSPC" }); });
  await f.automatic.start();
  await until(() => f.automatic.snapshot().phase === "watching");
  const source = path.join(f.roots[0], "unwatched.hwp");
  await writeFile(source, "original");
  const started = Date.now();
  await until(() => f.automatic.snapshot().processed === 1, 35_000);
  assert.ok(Date.now() - started < 35_000);
  assert.deepEqual(f.engine.calls, [[source]]);
});

test("읽기 권한 없는 하위 폴더는 다른 루트의 변환을 막지 않는다", async t => {
  if (process.platform === "win32" || process.getuid?.() === 0) { t.skip("POSIX 비관리자 권한 검사 필요"); return; }
  const f = await fixture();
  const denied = path.join(f.roots[0], "denied");
  await mkdir(denied); await writeFile(path.join(denied, "private.hwp"), "private");
  await chmod(denied, 0);
  t.after(async () => { await f.automatic.stop(); await chmod(denied, 0o700); await rm(f.home, { recursive: true, force: true }); });
  const source = path.join(f.roots[1], "accessible.hwp"); await writeFile(source, "original");
  await f.automatic.start();
  await until(() => f.automatic.snapshot().phase === "watching");
  assert.deepEqual(f.engine.calls, [[source]]);
});

test("이전 실패 저장 중 들어온 다음 재시도는 실제 변환으로 실행한다", async t => {
  const f = await fixture();
  t.after(async () => { await f.automatic.stop(); await rm(f.home, { recursive: true, force: true }); });
  const source = path.join(f.roots[0], "save-race.hwp");
  await writeFile(source, "bad"); f.engine.fail.add(source);
  await f.automatic.start();
  await until(() => f.automatic.snapshot().phase === "watching");
  const storage = f.automatic as unknown as { saveIssues(): Promise<void> };
  const save = storage.saveIssues.bind(storage);
  let injected = false;
  t.mock.method(storage, "saveIssues", async () => {
    await save();
    if (!injected && f.automatic.issues().items[0]?.attempts === 2) {
      injected = true;
      await f.automatic.retryIssue(source);
    }
  });
  await f.automatic.retryIssue(source);
  await until(() => f.automatic.issues().items[0]?.attempts === 3);
  assert.equal(injected, true);
  assert.equal(f.engine.calls.length, 3);
  assert.equal(f.automatic.issues().items[0].reason, "처리하지 못함: 변환 실패");
});
