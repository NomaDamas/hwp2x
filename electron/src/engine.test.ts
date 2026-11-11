import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { convertToHwpx, validateHwpx } from "kordoc";
import { Engine, mainDrive, verifyConversion } from "./engine";
import { flushLog, initLogger, logPath } from "./logger";
import { HANCOM_OPEN_FAILED, HANCOM_INTERACTION_REQUIRED, HANCOM_RECOVERY_BLOCKED } from "./hancom";
import type * as FileSystem from "node:fs/promises";

const HWPML = '<?xml version="1.0" encoding="UTF-8"?><HWPML Version="2.8"><HEAD SecCnt="1"></HEAD><BODY><SECTION Id="0"><P><TEXT><CHAR>Hello</CHAR></TEXT></P></SECTION></BODY></HWPML>';

async function fixture(ext = "hwpml") {
  const root = await mkdtemp(path.join(tmpdir(), "hwp2x-test-"));
  const source = path.join(root, `test.${ext}`);
  await writeFile(source, HWPML);
  return { root, source, target: path.join(root, "test.hwpx"), md: path.join(root, "test.md") };
}

test("검색 중 파일 접근이 거부되어도 다른 문서는 검색한다", async t => {
  const { root, source } = await fixture();
  const other = path.join(root, "정상.hwpml");
  await writeFile(other, HWPML);
  const fs = require("node:fs/promises") as typeof FileSystem;
  const original = fs.lstat;
  t.mock.method(fs, "lstat", async (...args: Parameters<typeof original>) => {
    if (String(args[0]) === source) throw Object.assign(new Error("denied"), { code: "EACCES" });
    return original(...args);
  });
  const engine = new Engine();
  await engine.scan(root);
  assert.deepEqual(engine.state.files.map(file => file.source), [other]);
  assert.ok(engine.state.skippedDirs.includes(source));
});

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

// The real-world sample (a table cell whose underline tag the HWPX reader does not return) used to be "일부 차이".
const SAMPLE_HWP = process.env.HWP2X_SMOKE_HWP ?? "/tmp/hwp2x-real/공고문.hwp";
test("밑줄 표시나 제목/문단 구분만 달라지고 글자·그림이 같으면 '일치'로 판정한다", { skip: !existsSync(SAMPLE_HWP) && "실제 HWP 샘플 없음" }, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hwp2x-match-"));
  await writeFile(path.join(root, "공고문.hwp"), await readFile(SAMPLE_HWP));
  const engine = new Engine();
  engine.configure({ makeMarkdown: false });
  await engine.scan(root);
  await engine.convert();
  const file = engine.snapshot().files[0];
  assert.equal(file.verification?.stats.modified, 1, "블록 비교로는 밑줄 표시 하나가 다름");
  assert.equal(file.status, "ok", file.message);
  assert.match(file.message, /글자·그림 일치/);
});

test("글자가 실제로 다르면 '일부 차이'로 두고 어디가 다른지 보여준다", async () => {
  const source = new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?><HWPML Version="2.8"><HEAD SecCnt="1"></HEAD><BODY><SECTION Id="0"><P><TEXT><CHAR>승인일 2. 910.</CHAR></TEXT></P></SECTION></BODY></HWPML>');
  const changed = await convertToHwpx(new TextEncoder().encode('<?xml version="1.0" encoding="UTF-8"?><HWPML Version="2.8"><HEAD SecCnt="1"></HEAD><BODY><SECTION Id="0"><P><TEXT><CHAR>승인일 2. 10.</CHAR></TEXT></P></SECTION></BODY></HWPML>'), { engine: "kordoc" });
  const same = await convertToHwpx(source, { engine: "kordoc" });
  assert.equal((await verifyConversion(source, same.data)).contentMatch, true);
  const result = await verifyConversion(source, changed.data);
  assert.equal(result.contentMatch, false);
  assert.match(result.textDiff ?? "", /원본 "…승인일2\.910\.…" \/ 변환 "…승인일2\.10\.…"/);
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
  assert.equal(files.find(file => file.name === "test.hwpml")?.reason, "이미 변환됨(건너뜀) · 같은 이름의 HWPX 파일이 있음");
  assert.match(files.find(file => file.name === "broken.hwp")?.reason ?? "", /^원본을 읽을 수 없음/);
});

const logLines = async () => { await flushLog(); return (await readFile(logPath(), "utf8")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line) as { level: string; event: string }); };

test("이미 HWPX가 있는 파일은 오류가 아니라 '이미 변환됨(건너뜀)'으로 info 기록되고 덮어쓰지 않는다", async () => {
  const { root, target } = await fixture();
  await writeFile(target, "existing");
  await initLogger(await mkdtemp(path.join(tmpdir(), "hwp2x-log-")), {});
  const engine = new Engine();
  engine.configure({ makeMarkdown: false });
  await engine.scan(root);
  const before = (await logLines()).length;
  await engine.convert();
  const file = engine.snapshot().files[0];
  assert.equal(file.status, "skipped");
  assert.match(file.message, /^이미 변환됨\(건너뜀\)/);
  assert.equal(await readFile(target, "utf8"), "existing");
  const lines = (await logLines()).slice(before);
  assert.ok(lines.some(line => line.event === "file.skip" && line.level === "info"));
  assert.equal(lines.filter(line => line.level === "error").length, 0, "건너뜀은 오류로 기록하지 않음");
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

test("결과를 쓴 직후 기록 저장 전에 강제 종료돼도 이어하면 그 파일은 완료로 남고 건너뜀이 되지 않는다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hwp2x-crash-window-"));
  for (const name of ["가.hwpml", "나.hwpml"]) await writeFile(path.join(root, name), HWPML);
  const checkpoint = path.join(await mkdtemp(path.join(tmpdir(), "hwp2x-ckpt-")), "state.json");
  const first = new Engine(checkpoint);
  first.configure({ workers: 1 });
  await first.scan(root);
  // Keep the last progress record the engine saved before 가.hwpx existed: that is what is on disk if the app
  // is killed right after writing 가's HWPX/MD, before the next save.
  let lastBeforeOutput = "";
  const save = first.checkpoint.bind(first);
  first.checkpoint = async () => {
    await save();
    const exists = await stat(path.join(root, "가.hwpx")).then(() => true, () => false);
    if (!exists) lastBeforeOutput = await readFile(checkpoint, "utf8");
  };
  await first.convert();
  const made = await stat(path.join(root, "가.hwpx"));
  assert.ok(lastBeforeOutput, "가 결과 전 저장 기록");
  await writeFile(checkpoint, lastBeforeOutput);
  await import("node:fs/promises").then(fs => Promise.all([fs.rm(path.join(root, "나.hwpx")), fs.rm(path.join(root, "나.md"))]));
  const second = new Engine(checkpoint);
  assert.equal(await second.restore(), true);
  const recovered = second.state.files.find(file => file.name === "가.hwpml")!;
  assert.equal(recovered.target, path.join(root, "가.hwpx"));
  assert.equal(recovered.mdPath, path.join(root, "가.md"));
  assert.equal(recovered.targetSize, made.size);
  await second.convert();
  const files = second.snapshot().files;
  assert.deepEqual(files.map(file => file.status === "skipped"), [false, false], files.map(file => `${file.name}:${file.status}`).join(", "));
  assert.equal(second.snapshot().completed, 2);
  assert.equal((await stat(path.join(root, "가.hwpx"))).mtimeMs, made.mtimeMs, "이미 만든 결과는 덮어쓰지 않음");
});

async function crashBeforeMarkdown(prefix: string) {
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  await writeFile(path.join(root, "가.hwpml"), HWPML);
  const checkpoint = path.join(await mkdtemp(path.join(tmpdir(), "hwp2x-ckpt-")), "state.json");
  const first = new Engine(checkpoint);
  first.configure({ workers: 1 });
  await first.scan(root);
  let lastBeforeOutput = "";
  const save = first.checkpoint.bind(first);
  first.checkpoint = async () => {
    await save();
    const exists = await stat(path.join(root, "가.hwpx")).then(() => true, () => false);
    if (!exists) lastBeforeOutput = await readFile(checkpoint, "utf8");
  };
  await first.convert();
  const md = path.join(root, "가.md"), hwpx = path.join(root, "가.hwpx");
  const markdown = await readFile(md, "utf8");
  // Killed after the HWPX landed but before the MD was published.
  await writeFile(checkpoint, lastBeforeOutput);
  await import("node:fs/promises").then(fs => fs.rm(md));
  return { root, checkpoint, md, hwpx, markdown };
}

test("HWPX 저장 후 MD 전에 강제 종료되면 이어할 때 기존 HWPX는 그대로 두고 MD만 복구한다", async () => {
  const { checkpoint, md, hwpx, markdown } = await crashBeforeMarkdown("hwp2x-md-recover-");
  const before = await readFile(hwpx), made = await stat(hwpx);
  const second = new Engine(checkpoint);
  assert.equal(await second.restore(), true);
  await second.convert();
  const [file] = second.snapshot().files;
  assert.ok(file.status === "ok" || file.status === "diff", `${file.status}: ${file.message}`);
  assert.equal(await readFile(md, "utf8"), markdown);
  assert.equal(file.target, hwpx);
  assert.equal(file.mdPath, md);
  assert.equal(file.targetSize, before.byteLength);
  assert.ok((await readFile(hwpx)).equals(before));
  assert.equal((await stat(hwpx)).mtimeMs, made.mtimeMs, "HWPX는 다시 쓰지 않음");
});

test("출력 HWPX가 기록과 다르면 MD를 복구하지 않고 파일을 건드리지 않는다", async () => {
  const { checkpoint, md, hwpx } = await crashBeforeMarkdown("hwp2x-md-mismatch-");
  await writeFile(hwpx, "사용자 파일");
  const second = new Engine(checkpoint);
  assert.equal(await second.restore(), true);
  await second.convert();
  assert.equal(await readFile(hwpx, "utf8"), "사용자 파일");
  assert.equal(await stat(md).then(() => true, () => false), false);
  assert.notEqual(second.snapshot().files[0].status, "ok");
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

test("일시정지된 작업은 새 폴더 검색으로 덮어쓰지 않고, 중지하면 새 작업을 시작할 수 있다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hwp2x-pause-"));
  for (const name of ["가.hwpml", "나.hwpml", "다.hwpml"]) await writeFile(path.join(root, name), HWPML);
  const other = await mkdtemp(path.join(tmpdir(), "hwp2x-other-"));
  await writeFile(path.join(other, "새.hwpml"), HWPML);
  const engine = new Engine();
  engine.configure({ workers: 1, makeMarkdown: false });
  await engine.scan(root);
  const run = engine.convert();
  engine.pause();
  // The click is taken at once, before the file in progress finishes.
  assert.equal(engine.state.phase, "converting");
  assert.match(engine.state.message, /일시정지 중입니다/);
  await run;
  assert.equal(engine.state.phase, "paused");
  const left = engine.state.files.filter(file => file.status === "wait").length;
  assert.ok(left > 0, "일시정지 후 남은 파일");
  await assert.rejects(engine.scan(other), /일시정지된 작업/);
  await assert.rejects(engine.selectRoot(other), /일시정지된 작업/);
  assert.equal(engine.state.root, path.resolve(root), "기존 작업 유지");
  await engine.stopRun();
  assert.equal(engine.state.phase, "stopped");
  assert.match(engine.state.message, new RegExp(`남은 ${left}개`));
  await engine.scan(other);
  assert.deepEqual(engine.state.files.map(file => file.name), ["새.hwpml"]);
  await engine.convert();
  assert.equal(engine.snapshot().phase, "done");
});

test("변환 중 중지하면 진행 중 파일만 마치고 나머지는 변환하지 않는다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hwp2x-stop-"));
  const names = Array.from({ length: 6 }, (_, i) => `문서${i}.hwpml`);
  for (const name of names) await writeFile(path.join(root, name), HWPML);
  const engine = new Engine();
  engine.configure({ workers: 1, makeMarkdown: false });
  await engine.scan(root);
  const run = engine.convert();
  const stopping = engine.stopRun();
  await Promise.all([run, stopping]);
  assert.equal(engine.state.phase, "stopped");
  const made = names.filter(name => engine.state.files.find(file => file.name === name)?.target);
  const left = engine.state.files.filter(file => file.status === "wait").length;
  assert.ok(left > 0 && made.length + left === names.length, `완료 ${made.length}, 남음 ${left}`);
  for (const name of names) {
    const exists = await stat(path.join(root, name.replace(".hwpml", ".hwpx"))).then(() => true, () => false);
    assert.equal(exists, made.includes(name), `${name} 출력과 화면 상태 일치`);
  }
});

test("이전에 고른 한컴이 사용 불가(구버전)로 판정되면 그 엔진을 쓰지 않고 kordoc으로 변환한다", async () => {
  const { root, target } = await fixture();
  const engine = new Engine();
  engine.configure({ makeMarkdown: false });
  // A choice restored from an earlier run or settings, later found to be 한글 2004 (no HWPX saving).
  const legacy = { path: "C:\\HNC\\Hwp65\\Hwp.exe", name: "한컴오피스 한글 6.5.0.1000", clsid: "{22222222-2222-2222-2222-222222222222}", available: false, unavailableReason: "HWPX 저장을 지원하지 않습니다" };
  engine.state.hancomCandidates = [legacy];
  engine.state.hancomPath = legacy.path;
  await engine.scan(root);
  await engine.convert();
  const file = engine.snapshot().files[0];
  assert.equal(file.status === "ok" || file.status === "diff", true, file.message);
  await stat(target);
  assert.match(engine.snapshot().hancomName, /kordoc/);
});

const v2024 = { path: "C:\\Program Files (x86)\\Hnc\\Office 2024\\HOffice130\\Bin\\Hwp.exe", name: "한컴오피스 한글 13.0.0.3380", clsid: "{2291CF00-64A1-4877-A9B4-68CFE89612D6}", available: true };

test("한글이 문서를 열지 못하면 내장 엔진으로 변환하고 그 사실을 파일 결과와 로그에 남긴다", async () => {
  const { root, target } = await fixture();
  const calls: string[] = [];
  const engine = new Engine(undefined, async (_hancom, source) => { calls.push(source); throw new Error(HANCOM_OPEN_FAILED); });
  engine.configure({ makeMarkdown: false });
  engine.state.hancomCandidates = [v2024];
  engine.state.hancomPath = v2024.path;
  await initLogger(await mkdtemp(path.join(tmpdir(), "hwp2x-log-")), {});
  await engine.scan(root);
  const before = (await logLines()).length;
  await engine.convert();
  const file = engine.snapshot().files[0];
  assert.equal(calls.length, 1, "한글로 먼저 시도");
  assert.equal(file.status, "diff", file.message);
  assert.match(file.message, /한글이 이 문서를 열지 못해 내장 kordoc 엔진으로 변환했습니다/);
  await stat(target);
  assert.ok((await logLines()).slice(before).some(line => line.event === "file.fallback"));
});

test("한글 실행 자체가 실패하면 대체 변환하지 않고 실패로 남긴다", async () => {
  const { root, target } = await fixture();
  const engine = new Engine(undefined, async () => { throw new Error("이미 열려 있는 한글 창에 연결되어 변환을 멈췄습니다"); });
  engine.configure({ makeMarkdown: false });
  engine.state.hancomCandidates = [v2024];
  engine.state.hancomPath = v2024.path;
  await engine.scan(root);
  await engine.convert();
  const file = engine.snapshot().files[0];
  assert.equal(file.status, "fail");
  assert.match(file.message, /이미 열려 있는 한글 창/);
  await assert.rejects(stat(target), { code: "ENOENT" });
});

test("한컴 사용자 확인이 필요하면 대체 변환 없이 원본을 유지하고 다음 파일은 완료한다", async () => {
  const { root, source, target, md } = await fixture();
  const second = path.join(root, "second.hwpml");
  await writeFile(second, HWPML);
  const originals = await Promise.all([readFile(source), readFile(second)]);
  const calls: string[] = [];
  // Security interaction is an engine stand-in; the successful output uses real kordoc conversion.
  const engine = new Engine(undefined, async (_hancom, input, out) => {
    calls.push(input);
    if (input === source) throw new Error(HANCOM_INTERACTION_REQUIRED);
    const converted = await convertToHwpx(await readFile(input), { engine: "kordoc" });
    await writeFile(out, converted.data);
  });
  engine.configure({ workers: 1, makeMarkdown: true });
  engine.state.hancomCandidates = [v2024];
  engine.state.hancomPath = v2024.path;
  await initLogger(await mkdtemp(path.join(tmpdir(), "hwp2x-approval-log-")), {});
  await engine.scan(root);
  engine.state.files.sort((a, b) => Number(b.source === source) - Number(a.source === source));
  const before = (await logLines()).length;
  await engine.convert();
  const state = engine.snapshot();
  const failed = state.files.find(file => file.source === source)!;
  const succeeded = state.files.find(file => file.source === second)!;
  assert.deepEqual(calls, [source, second]);
  assert.equal(failed.status, "fail");
  assert.match(failed.reason ?? "", /처리하지 못함.*사용자 확인/);
  assert.match(failed.message, /원본 유지/);
  assert.equal(failed.target, undefined);
  assert.equal(failed.mdPath, undefined);
  await assert.rejects(stat(target), { code: "ENOENT" });
  await assert.rejects(stat(md), { code: "ENOENT" });
  assert.ok(!(await logLines()).slice(before).some(line => line.event === "file.fallback"));
  assert.deepEqual(await readFile(source), originals[0]);
  assert.deepEqual(await readFile(second), originals[1]);
  assert.equal(succeeded.status, "ok", succeeded.message);
  assert.equal((await validateHwpx(await readFile(path.join(root, "second.hwpx")))).ok, true);
  await stat(path.join(root, "second.md"));
  assert.equal(state.phase, "done");
});

test("한컴 안전 복구가 막히면 두 파일을 대기로 유지하고 다음 파일을 호출하지 않는다", async () => {
  const { root, source, target, md } = await fixture();
  const second = path.join(root, "second.hwpml");
  await writeFile(second, HWPML);
  const originals = await Promise.all([readFile(source), readFile(second)]);
  const calls: string[] = [];
  const engine = new Engine(undefined, async (_hancom, input) => {
    calls.push(input);
    throw new Error(HANCOM_RECOVERY_BLOCKED);
  });
  engine.configure({ workers: 1, makeMarkdown: true });
  engine.state.hancomCandidates = [v2024];
  engine.state.hancomPath = v2024.path;
  await engine.scan(root);
  engine.state.files.sort((a, b) => Number(b.source === source) - Number(a.source === source));
  await assert.rejects(engine.convert(), { message: HANCOM_RECOVERY_BLOCKED });
  const state = engine.snapshot();
  assert.deepEqual(calls, [source]);
  assert.equal(state.phase, "paused");
  assert.deepEqual(state.files.map(file => file.status), ["wait", "wait"]);
  for (const file of state.files) {
    assert.equal(file.target, undefined);
    assert.equal(file.mdPath, undefined);
  }
  for (const output of [target, md, path.join(root, "second.hwpx"), path.join(root, "second.md")]) {
    await assert.rejects(stat(output), { code: "ENOENT" });
  }
  assert.deepEqual(await readFile(source), originals[0]);
  assert.deepEqual(await readFile(second), originals[1]);
});

test("한컴으로 저장한 HWPX는 내용이 달라 보여도 손실 체크 없이 '일치(통과)'로 처리하고 원본은 그대로 둔다", async () => {
  const { root, source, target } = await fixture();
  // A Hancom stand-in whose HWPX has different text than the source: the old check would call this "일부 차이".
  const other = await convertToHwpx(new TextEncoder().encode(HWPML.replace("Hello", "완전히 다른 글")), { engine: "kordoc" });
  const engine = new Engine(undefined, async (_hancom, _source, out) => { await writeFile(out, other.data); });
  engine.configure({ makeMarkdown: false });
  engine.state.hancomCandidates = [v2024];
  engine.state.hancomPath = v2024.path;
  const before = await readFile(source);
  await engine.scan(root);
  await engine.convert();
  const file = engine.snapshot().files[0];
  assert.equal(file.status, "ok", file.message);
  assert.match(file.message, /한컴오피스 한글로 변환/);
  assert.equal(file.verification, undefined, "내용 비교를 하지 않음");
  assert.deepEqual(await readFile(target), Buffer.from(other.data));
  assert.deepEqual(await readFile(source), before, "원본 바이트 그대로");
});

test("변환 중 원본이 바뀌면 결과를 성공으로 두지 않고 실패로 알린다", async () => {
  const { root, source } = await fixture();
  const other = await convertToHwpx(new TextEncoder().encode(HWPML), { engine: "kordoc" });
  // Simulates anything touching the user's file during conversion; hwp2x itself never writes it.
  const engine = new Engine(undefined, async (_hancom, from, out) => { await writeFile(from, "changed"); await writeFile(out, other.data); });
  engine.configure({ makeMarkdown: false });
  engine.state.hancomCandidates = [v2024];
  engine.state.hancomPath = v2024.path;
  await engine.scan(root);
  await engine.convert();
  const file = engine.snapshot().files[0];
  assert.equal(file.status, "fail");
  assert.match(file.message, /원본이 변경되었습니다|원본 HWP가 변환 중 바뀌었습니다/);
  await writeFile(source, HWPML);
});

test("페이지 snapshot은 전역 집계를 유지하고 상세 복제를 페이지로 제한한다", () => {
  const engine = new Engine();
  engine.state.files = Array.from({ length: 1000 }, (_, id) => ({ id, name: `Doc${id}.hwp`, dir: "/docs", source: `/docs/Doc${id}.hwp`, size: 10, targetSize: 5, status: id < 10 ? "conv" : id < 20 ? "ok" : "fail", message: "" }));
  const page = engine.snapshot({ offset: 5, limit: 999999, filter: "fail", query: " DOC ", selectedId: 0 });
  assert.equal(page.files.length, 100);
  assert.equal(page.files[0].id, 25);
  assert.equal(page.filteredTotal, 980);
  assert.equal(page.total, 1000);
  assert.equal(page.completed, 990);
  assert.equal(page.counts.ok, 10);
  assert.equal(page.selected?.id, 0);
  assert.equal(page.activeFiles?.length, 8);
  assert.deepEqual(page.summarySizes, { source: 100, target: 5000 });
  assert.equal(page.eligibleCount, 10);
  assert.equal(engine.snapshot().files.length, 1000);
  assert.equal("filteredTotal" in engine.snapshot(), false);
  assert.equal(engine.snapshot({ offset: -1, limit: Number.NaN }).offset, 0);
  assert.equal(engine.snapshot({ offset: Infinity }).files.length, 100);
  assert.equal(engine.snapshot({ offset: 99999 }).files.length, 0);
  assert.equal(engine.snapshot({ selectedId: -1 }).selected, null);
  assert.throws(() => engine.snapshot(null as never), /옵션/);
  assert.throws(() => engine.snapshot(3 as never), /옵션/);
  // Off-page detail must not even be visited while cloning page results.
  Object.defineProperty(engine.state.files[999], "verification", { get() { throw new Error("off-page clone"); } });
  assert.equal(engine.snapshot({ limit: 1 }).files.length, 1);
  Object.defineProperty(engine.state.files[0], "verification", { get() { throw new Error("list detail clone"); } });
  engine.state.files[0].message = "x".repeat(10000);
  const compact = engine.snapshot({ limit: 1 });
  assert.equal(compact.files[0].message.length, 512);
  assert.equal("verification" in compact.files[0], false);
});

test("attention 페이지는 실패·건너뜀·차이 순이며 상세는 독립 복사다", () => {
  const engine = new Engine();
  engine.state.files = (["diff", "ok", "skipped", "fail"] as const).map((status, id) => ({ id, name: `${id}.hwp`, source: `/docs/${id}.hwp`, dir: "/docs", size: 1, targetSize: 0, status, message: "", checks: [{ label: "원본", value: "유지", color: "green" }] }));
  const result = engine.snapshot({ filter: "attention", selectedId: 1 });
  assert.deepEqual(result.files.map(file => file.status), ["fail", "skipped", "diff"]);
  result.selected!.checks![0].value = "changed";
  assert.equal(engine.state.files[1].checks![0].value, "유지");
});

test("convertPaths는 공통 상위 폴더와 중복 제거로 지정 파일만 실제 변환한다", async () => {
  const { root, source, target } = await fixture();
  const sub = path.join(root, "하위 폴더");
  await mkdir(sub);
  const second = path.join(sub, "다른 문서.hwpml");
  await writeFile(second, HWPML);
  await writeFile(path.join(root, "제외.hwpml"), HWPML);
  const checkpoint = path.join(root, "state.json");
  const engine = new Engine(checkpoint);
  engine.configure({ makeMarkdown: false, workers: 1 });
  let saves = 0;
  const save = engine.checkpoint.bind(engine);
  engine.checkpoint = async () => { saves += 1; await save(); };
  const running = engine.convertPaths([source, second, source]);
  await assert.rejects(engine.convertPaths([source]), /진행 중/);
  await running;
  assert.equal(engine.state.root, root);
  assert.equal(engine.state.files.length, 2);
  assert.equal(engine.state.phase, "done");
  assert.equal(saves, 4, "시작+파일별 소유기록+완료 저장만 필요");
  assert.equal((await validateHwpx(await readFile(target))).ok, true);
  assert.equal((await validateHwpx(await readFile(second.replace(/hwpml$/, "hwpx")))).ok, true);
  assert.equal(existsSync(path.join(root, "제외.hwpx")), false);
  assert.equal(await readFile(source, "utf8"), HWPML);
  assert.equal(await readFile(second, "utf8"), HWPML);
  const restored = new Engine(checkpoint);
  assert.equal(await restored.restore(), true);
  assert.equal(restored.snapshot().completed, 2);
  const files = engine.state.files;
  await assert.rejects(engine.convertPaths(Array(101).fill(source)), /100개/);
  await assert.rejects(engine.convertPaths(["relative.hwp"]), /절대 경로/);
  await engine.convertPaths([]);
  assert.equal(engine.state.files, files);
  engine.state.phase = "paused";
  await assert.rejects(engine.convertPaths([source]), /일시정지/);
  assert.equal(engine.state.files, files);
});

test("중지·대기 상태 복원은 상태를 보존하고 새 폴더 검색을 허용한다", async () => {
  const { root } = await fixture();
  const next = await fixture();
  for (const phase of ["stopped", "idle"] as const) {
    const checkpoint = path.join(root, `${phase}.json`);
    const first = new Engine(checkpoint);
    await first.scan(root);
    first.state.phase = phase;
    await first.checkpoint();
    const restored = new Engine(checkpoint);
    assert.equal(await restored.restore(), true);
    assert.equal(restored.state.phase, phase);
    assert.equal(restored.state.files[0].status, "wait");
    await restored.scan(next.root);
    assert.equal(restored.state.root, next.root);
    assert.equal(restored.state.phase, "idle");
  }
});