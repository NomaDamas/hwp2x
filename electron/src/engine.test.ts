import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { validateHwpx } from "kordoc";
import { Engine, mainDrive } from "./engine";

const HWPML = '<?xml version="1.0" encoding="UTF-8"?><HWPML Version="2.8"><HEAD SecCnt="1"></HEAD><BODY><SECTION Id="0"><P><TEXT><CHAR>Hello</CHAR></TEXT></P></SECTION></BODY></HWPML>';

async function fixture(ext = "hwpml") {
  const root = await mkdtemp(path.join(tmpdir(), "hwp2x-test-"));
  const source = path.join(root, `test.${ext}`);
  await writeFile(source, HWPML);
  return { root, source, target: path.join(root, "test.hwpx"), md: path.join(root, "test.md") };
}

test("실제 HWPML 변환 결과는 parse 가능한 HWPX이고 원본을 보존한다", async () => {
  const { root, source, target } = await fixture();
  const engine = new Engine();
  engine.configure({ makeMarkdown: false });
  await engine.scan(root);
  await engine.convert();
  const output = await readFile(target);
  const valid = await validateHwpx(output);
  assert.equal(valid.ok, true);
  assert.equal((await readFile(source, "utf8")), HWPML);
  assert.equal(engine.snapshot().files[0].status, "diff");
});

test("MD는 기본 생성되고 끌 수 있다", async () => {
  const first = await fixture();
  const on = new Engine();
  await on.scan(first.root);
  await on.convert();
  assert.equal((await readFile(first.md, "utf8")).includes("Hello"), true);

  const second = await fixture();
  const off = new Engine();
  off.configure({ makeMarkdown: false });
  await off.scan(second.root);
  await off.convert();
  await assert.rejects(() => stat(second.md));
});

test("동시 작업은 모든 파일을 한 번씩 끝내고 완료 상태로 바꾼다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hwp2x-workers-"));
  for (const name of ["가.hwpml", "나.hwpml", "다.hwpml"]) await writeFile(path.join(root, name), HWPML);
  await writeFile(path.join(root, "손상.hwp"), "not hwp");
  const engine = new Engine();
  engine.configure({ workers: 2, makeMarkdown: false });
  await engine.scan(root);
  await engine.convert();
  const snapshot = engine.snapshot();
  assert.equal(snapshot.phase, "done");
  assert.equal(snapshot.counts.conv, 0);
  assert.equal(snapshot.counts.wait, 0);
  assert.equal(snapshot.counts.diff, 3);
  assert.equal(snapshot.counts.fail, 1);
});

test("재시도 시작 직후 이전 완료 상태를 보여주지 않는다", async () => {
  const { root } = await fixture("hwp");
  const engine = new Engine();
  await engine.scan(root);
  await engine.convert();
  const retry = engine.retry(0);
  assert.equal(engine.snapshot().phase, "converting");
  await retry;
});

test("기존 출력은 건너뛰고 덮어쓰지 않는다", async () => {
  const { root, target } = await fixture();
  await writeFile(target, "existing");
  const engine = new Engine();
  await engine.scan(root);
  await engine.convert();
  assert.equal(engine.snapshot().files[0].status, "skipped");
  assert.equal(await readFile(target, "utf8"), "existing");
});

test("변환이 끝나면 경과 시간이 멈춘다", async t => {
  const { root } = await fixture();
  const engine = new Engine();
  await engine.scan(root);
  await engine.convert();
  const first = engine.snapshot().elapsed;
  const now = Date.now();
  t.mock.method(Date, "now", () => now + 60_000);
  assert.equal(engine.snapshot().phase, "done");
  assert.equal(engine.snapshot().elapsed, first);
});

test("건너뜀과 실패는 짧은 사유를 남긴다", async () => {
  const { root, target } = await fixture();
  await writeFile(target, "existing");
  await writeFile(path.join(root, "broken.hwp"), "not hwp");
  const engine = new Engine();
  await engine.scan(root);
  await engine.convert();
  const files = engine.snapshot().files;
  assert.equal(files.find(file => file.name === "test.hwpml")?.reason, "같은 이름의 HWPX 파일이 이미 있어 건너뜀");
  assert.match(files.find(file => file.name === "broken.hwp")?.reason ?? "", /^원본을 읽을 수 없음/);
});

test("잘못된 원본은 명시적으로 실패하고 출력하지 않는다", async () => {
  const { root, source, target } = await fixture("hwp");
  await writeFile(source, "not hwp");
  const engine = new Engine();
  await engine.scan(root);
  await engine.convert();
  assert.equal(engine.snapshot().files[0].status, "fail");
  await assert.rejects(() => stat(target));
  assert.equal(await readFile(source, "utf8"), "not hwp");
});

test("변환이 끝나면 원본을 지우지 않고 백업 폴더에 복사한다", async () => {
  const { root, source } = await fixture();
  const backup = await mkdtemp(path.join(tmpdir(), "hwp2x-backup-"));
  const engine = new Engine();
  engine.configure({ backupDir: backup, makeMarkdown: false });
  await engine.scan(root);
  await engine.convert();
  assert.equal(await engine.backupLossless(), 1);
  assert.equal(await readFile(path.join(backup, "test.hwpml"), "utf8"), HWPML);
  assert.equal(await readFile(source, "utf8"), HWPML);
});

test("지원하지 않는 백업 설정과 잘못된 작업 수를 거부한다", () => {
  const engine = new Engine();
  assert.throws(() => engine.configure({ autoBackup: true }), /백업 기능/);
  assert.throws(() => engine.configure({ workers: 0 }), /1~8/);
  assert.throws(() => engine.configure({ workers: 9 }), /1~8/);
});

test("메인 드라이브는 Windows 시스템 드라이브, 그 밖에는 루트다", () => {
  assert.equal(mainDrive("win32", { SystemDrive: "d:" }), "D:\\");
  assert.equal(mainDrive("win32", {}), "C:\\");
  assert.equal(mainDrive("win32", { SystemDrive: "C:\\Windows" }), "C:\\");
  assert.equal(mainDrive("linux", {}), "/");
});

test("모든 깊이의 하위 폴더 HWP를 빠짐없이 찾아 변환한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hwp2x-deep-"));
  const files = ["맨위.hwpml", "가/하나.hwpml", "가/나/둘.HWPML", "가/나/다/라/넷.hwpml", "마/셋.hwpml"];
  for (const file of files) {
    await mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await writeFile(path.join(root, file), HWPML);
  }
  await writeFile(path.join(root, "가/메모.txt"), "x");
  await mkdir(path.join(root, "node_modules/깊이"), { recursive: true });
  await writeFile(path.join(root, "node_modules/깊이/제외.hwpml"), HWPML);
  const engine = new Engine();
  engine.configure({ makeMarkdown: false });
  await engine.scan(root);
  assert.deepEqual(engine.state.files.map(file => path.relative(root, file.source)).sort(), files.map(file => path.normalize(file)).sort());
  await engine.convert();
  for (const file of files) await stat(path.join(root, file.replace(/\.hwpml$/i, ".hwpx")));
  assert.equal(engine.snapshot().completed, files.length);
});

test("열 수 없는 하위 폴더는 건너뛰고 나머지를 계속 검색한다", { skip: process.getuid?.() === 0 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hwp2x-locked-"));
  await mkdir(path.join(root, "잠김"));
  await writeFile(path.join(root, "잠김/숨김.hwpml"), HWPML);
  await mkdir(path.join(root, "열림/안쪽"), { recursive: true });
  await writeFile(path.join(root, "열림/안쪽/보임.hwpml"), HWPML);
  await chmod(path.join(root, "잠김"), 0o000);
  try {
    const engine = new Engine();
    await engine.scan(root);
    assert.deepEqual(engine.state.files.map(file => file.name), ["보임.hwpml"]);
    assert.deepEqual(engine.state.skippedDirs, [path.join(root, "잠김")]);
    assert.match(engine.state.message, /열 수 없는 폴더 1개 건너뜀/);
  } finally { await chmod(path.join(root, "잠김"), 0o755); }
});

test("검색 위치로 고른 폴더 자체를 열 수 없으면 실패로 알린다", { skip: process.getuid?.() === 0 }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hwp2x-rootlock-"));
  await chmod(root, 0o000);
  try { await assert.rejects(new Engine().scan(root), { code: "EACCES" }); }
  finally { await chmod(root, 0o755); }
});

test("검색 위치만 지정하면 이전 목록을 비우고 시작 전 상태로 둔다", async () => {
  const { root } = await fixture();
  const engine = new Engine();
  await engine.scan(root);
  await engine.selectRoot(tmpdir());
  assert.equal(engine.state.root, path.resolve(tmpdir()));
  assert.deepEqual(engine.state.files, []);
  await assert.rejects(engine.selectRoot(path.join(root, "없음")), { code: "ENOENT" });
});

test("백업을 다시 눌러도 이미 백업된 같은 파일 때문에 실패하지 않는다", async () => {
  const { root } = await fixture();
  const backup = await mkdtemp(path.join(tmpdir(), "hwp2x-backup-again-"));
  const engine = new Engine();
  engine.configure({ backupDir: backup, makeMarkdown: false });
  await engine.scan(root);
  await engine.convert();
  assert.equal(await engine.backupLossless(), 1);
  assert.equal(await engine.backupLossless(), 0);
  assert.match(engine.state.message, /1개는 이미 백업됨/);
  assert.equal(await readFile(path.join(backup, "test.hwpml"), "utf8"), HWPML);
});

test("백업 폴더에 내용이 다른 같은 이름 파일이 있으면 덮어쓰지 않고 알린다", async () => {
  const { root } = await fixture();
  const backup = await mkdtemp(path.join(tmpdir(), "hwp2x-backup-conflict-"));
  await writeFile(path.join(backup, "test.hwpml"), "다른 내용");
  const engine = new Engine();
  engine.configure({ backupDir: backup, makeMarkdown: false });
  await engine.scan(root);
  await engine.convert();
  await assert.rejects(engine.backupLossless(), /덮어쓰지 않았습니다: test\.hwpml/);
  assert.equal(await readFile(path.join(backup, "test.hwpml"), "utf8"), "다른 내용");
});

test("다른 실행에서 진행 기록을 복원하면 끝난 파일은 그대로 두고 남은 파일만 변환한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hwp2x-resume-"));
  for (const name of ["가.hwpml", "나.hwpml", "다.hwpml"]) await writeFile(path.join(root, name), HWPML);
  const checkpoint = path.join(await mkdtemp(path.join(tmpdir(), "hwp2x-ckpt-")), "state.json");
  const first = new Engine(checkpoint);
  first.configure({ workers: 1 });
  await first.scan(root);
  await first.convert();
  const done = await stat(path.join(root, "가.hwpx"));
  // Simulate a run cut off after the first file: the other two are back in the queue.
  for (const file of first.state.files.slice(1)) { file.status = "wait"; delete file.target; delete file.mdPath; }
  await import("node:fs/promises").then(fs => Promise.all(["나", "다"].flatMap(n => [fs.rm(path.join(root, `${n}.hwpx`)), fs.rm(path.join(root, `${n}.md`))])));
  first.state.phase = "converting";
  await first.checkpoint();
  const second = new Engine(checkpoint);
  assert.equal(await second.restore(), true);
  assert.equal(second.state.phase, "paused");
  assert.equal(second.state.files.filter(file => file.status === "wait").length, 2);
  await second.convert();
  assert.equal(second.snapshot().phase, "done");
  assert.equal(second.snapshot().completed, 3);
  for (const n of ["가", "나", "다"]) { await stat(path.join(root, `${n}.hwpx`)); await stat(path.join(root, `${n}.md`)); }
  assert.equal((await stat(path.join(root, "가.hwpx"))).mtimeMs, done.mtimeMs, "끝난 파일은 다시 만들지 않음");
});

test("손상되었거나 없는 진행 기록은 복원하지 않고 그대로 둔다", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "hwp2x-ckpt-bad-"));
  assert.equal(await new Engine(path.join(dir, "없음.json")).restore(), false);
  await writeFile(path.join(dir, "bad.json"), "{깨짐");
  assert.equal(await new Engine(path.join(dir, "bad.json")).restore(), false);
  assert.equal(await readFile(path.join(dir, "bad.json"), "utf8"), "{깨짐");
});

test("저장 공간이 부족하면 실패로 남기지 않고 남은 파일을 대기로 두고 안전하게 멈춘다", async t => {
  const root = await mkdtemp(path.join(tmpdir(), "hwp2x-enospc-"));
  for (const name of ["가.hwpml", "나.hwpml", "다.hwpml"]) await writeFile(path.join(root, name), HWPML);
  const checkpoint = path.join(await mkdtemp(path.join(tmpdir(), "hwp2x-ckpt-")), "state.json");
  const engine = new Engine(checkpoint);
  engine.configure({ workers: 1, makeMarkdown: false });
  await engine.scan(root);
  // The engine reads link() off the CommonJS module at call time, so the mock goes on that object.
  const fs = require("node:fs/promises") as typeof import("node:fs/promises");
  const realLink = fs.link;
  let calls = 0;
  // The second published output hits a full disk.
  t.mock.method(fs, "link", async (...args: Parameters<typeof realLink>) => {
    if (++calls === 2) throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
    return realLink(...args);
  });
  await assert.rejects(engine.convert(), { code: "ENOSPC" });
  const state = engine.snapshot();
  assert.equal(state.phase, "paused");
  assert.equal(state.counts.fail, 0, "자원 부족을 파일 실패로 남기지 않음");
  assert.equal(state.counts.wait, 2, "멈춘 파일과 남은 파일은 대기");
  assert.match(state.message, /^안전 중단/);
  const saved = JSON.parse(await readFile(checkpoint, "utf8"));
  assert.equal(saved.state.files.filter((file: { status: string }) => file.status === "wait").length, 2, "진행 기록에 남은 파일 저장");
});
