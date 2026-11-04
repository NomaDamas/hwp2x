import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { validateHwpx } from "kordoc";
import { Engine } from "./engine";

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

test("검증할 수 없는 무손실 백업은 원본을 삭제하지 않는다", async () => {
  const { root, source } = await fixture();
  const engine = new Engine();
  await engine.scan(root);
  await engine.convert();
  assert.equal(await engine.backupLossless(), 0);
  assert.equal(await readFile(source, "utf8"), HWPML);
  assert.match(engine.snapshot().message, /무손실/);
});

test("지원하지 않는 백업 설정과 잘못된 작업 수를 거부한다", () => {
  const engine = new Engine();
  assert.throws(() => engine.configure({ autoBackup: true }), /백업 기능/);
  assert.throws(() => engine.configure({ workers: 0 }), /1~8/);
  assert.throws(() => engine.configure({ workers: 9 }), /1~8/);
});
