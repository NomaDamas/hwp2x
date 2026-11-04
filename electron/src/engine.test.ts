import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { Engine } from "./engine";

test("검색한 HWP를 변환하고 무손실 원본을 백업한다", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "hwp2x-"));
  await mkdir(path.join(root, "문서"));
  await writeFile(path.join(root, "문서", "보고서.hwp"), "원본");
  const engine = new Engine();
  engine.state.backupDir = path.join(root, "hwp2x_백업");
  const found = await engine.scan(root);
  assert.equal(found.length, 1);
  await engine.convert();
  const snapshot = engine.snapshot();
  assert.equal(snapshot.counts.deleted, 1);
  assert.equal(snapshot.phase, "done");
});
