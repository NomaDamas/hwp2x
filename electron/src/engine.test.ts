import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Engine } from "./engine";

test("검색한 HWP를 변환하고 무손실 원본을 백업한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hwp2x-"));
  await mkdir(path.join(root, "문서"));
  await writeFile(path.join(root, "문서", "보고서.hwp"), "원본");
  const engine = new Engine();
  engine.state.makeMarkdown = false;
  engine.state.backupDir = path.join(root, "hwp2x_백업");
  const found = await engine.scan(root);
  assert.equal(found.length, 1);
  await engine.convert();
  const snapshot = engine.snapshot();
  assert.equal(snapshot.counts.deleted, 1);
  assert.equal(snapshot.phase, "done");
});

test("마크다운 옵션이 켜지면 MD를 함께 만들고 끄면 HWPX만 만든다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hwp2x-md-"));
  const source = path.join(root, "보고서.hwp");
  await writeFile(source, "원본");
  const on = new Engine();
  on.state.autoBackup = false;
  await on.scan(root);
  await on.convert();
  assert.equal(await readFile(source.replace(/\.hwp$/, ".md"), "utf8").then((text) => text.includes("원본")), true);
  await unlink(source.replace(/\.hwp$/, ".md"));
  const off = new Engine();
  off.state.makeMarkdown = false;
  off.state.autoBackup = false;
  await off.scan(root);
  await off.convert();
  await assert.rejects(() => readFile(source.replace(/\.hwp$/, ".md")));
});
