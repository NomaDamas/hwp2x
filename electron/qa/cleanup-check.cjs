'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { runEvidence, ensureDisplay } = require('./common/evidence.cjs');
const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
async function prepare(evidence) {
  evidence.cleanup = { cases: [], limitations: ['ENOSPC·쓰기거부·hardlink 불가: 단위 오류주입, 실제 매체 시험 아님', 'Windows reparse point 및 FAT/exFAT 미검증', '실제 SIGKILL 재시작: cleanup.test의 별도 Node 프로세스이며 패키지 GUI 강제종료는 아님', '접근시간은 해시 읽기로 변경될 수 있음; inode·권한·mtime 검증, ctime/birthtime 복사 보장 아님'] };
  const original = await fs.readFile(evidence.inputs[0].path);
  // A sufficiently large real batch allows cancellation after observed progress without slowing the engine.
  for (let i = 1; i < 160; i++) {
    const file = path.join(evidence.isolatedPaths.docs, `공고문-${i}.hwp`);
    await fs.writeFile(file, original, { flag: 'wx' });
    evidence.inputs.push({ path: file, sha256: evidence.source.beforeHash, bytes: original.length });
  }
  evidence.cleanup.backup = path.join(evidence.directory, 'backup');
  await fs.mkdir(evidence.cleanup.backup);
}
async function inspect({ app, page, evidence, capture }) {
  const state = () => page.evaluate(() => window.hwp2x.state());
  const cleanup = () => page.evaluate(() => window.hwp2x.cleanupState());
  const until = async (check, label) => {
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await page.waitForTimeout(10); }
    throw Error(`시간 초과: ${label}`);
  };
  const click = async name => {
    evidence.actions.push({ type: 'click', name: String(name), at: new Date().toISOString() });
    await page.getByRole('button', { name, exact: typeof name === 'string' }).first().click();
  };
  await page.evaluate(async backupDir => { await window.hwp2x.configure({ backupDir, workers: 4 }); }, evidence.cleanup.backup);
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, evidence.isolatedPaths.docs);
  evidence.actions.push({ type: 'native-dialog-return', path: evidence.isolatedPaths.docs });
  await click(/^(다른 폴더 선택|폴더 선택)$/);
  await until(async () => (await state()).total === 160, '실제 원본 사본 검색');
  await click(/^160개 파일 변환$/);
  const converted = await until(async () => { const s = await state(); return s.phase === 'done' && s; }, '실제 변환');
  assert.equal(converted.files.length, 160);
  const metadata = new Map();
  for (const file of converted.files) {
    assert.equal(file.status, 'ok'); assert.equal(file.owned?.status, 'ok');
    assert.equal(await digest(file.source), file.owned.sourceHash);
    assert.equal(await digest(file.target), file.owned.targetHash);
    metadata.set(file.source, await fs.stat(file.source));
  }
  evidence.observations.push({ label: '실제 변환 적격성', snapshot: converted });
  await click('설정');
  assert.equal(await page.getByRole('button', { name: '백업 후 삭제 시작', exact: true }).isDisabled(), true);
  for (const text of ['서식까지 같다는 보증', '확인이 끝난 원본은 같은 폴더의 숨김 안전보관본과', '원래 이름의 파일은 원래 위치에서 사라진다']) await page.getByRole('checkbox', { name: new RegExp(text) }).check();
  const journalPath = path.join(evidence.profile, 'cleanup.json');
  const restored = async () => {
    for (const file of converted.files) {
      const before = metadata.get(file.source), after = await fs.stat(file.source);
      assert.equal(after.ino, before.ino); assert.equal(after.mode, before.mode); assert.equal(after.mtimeMs, before.mtimeMs);
      assert.equal(await digest(file.source), file.owned.sourceHash); assert.equal(await digest(file.target), file.owned.targetHash);
    }
  };
  for (let round = 1; round <= 2; round++) {
    for (const scenario of ['cancel', 'complete']) {
      for (const text of ['서식까지 같다는 보증', '확인이 끝난 원본은 같은 폴더의 숨김 안전보관본과', '원래 이름의 파일은 원래 위치에서 사라진다']) await page.getByRole('checkbox', { name: new RegExp(text) }).check();
      await click('백업 후 삭제 시작');
      if (scenario === 'cancel') {
        const running = await until(async () => { const s = await cleanup(); assert.notEqual(s.phase, 'done', '실제 취소 전 완료됨'); assert.notEqual(s.phase, 'error', s.message); return s.phase === 'running' && s.processed > 0 && s; }, '진행 확인');
        evidence.observations.push({ label: `${round} 진행 취소 전`, snapshot: running });
        await click('취소하고 복구');
      } else {
        const done = await until(async () => { const s = await cleanup(); assert.notEqual(s.phase, 'error', s.message); return s.phase === 'done' && s; }, '정리 완료');
        evidence.observations.push({ label: `${round} 완료`, snapshot: done });
        const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
        assert.equal(journal.entries.length, converted.files.length);
        for (const entry of journal.entries) {
          await assert.rejects(fs.stat(entry.source), { code: 'ENOENT' });
          assert.equal(await digest(entry.backup), entry.hash); assert.equal(await digest(entry.quarantine), entry.hash);
        }
        await capture(`${round} 완료: 영구삭제 아닌 백업과 보관`);
        await click('원래 위치로 복구');
      }
      const result = await until(async () => { const s = await cleanup(); assert.notEqual(s.phase, 'error', s.message); return s.phase === 'rolledBack' && s; }, '원본 복구');
      await restored();
      const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
      for (const entry of journal.entries.filter(entry => entry.intent)) {
        assert.equal(await digest(entry.backup), entry.hash);
        try { assert.equal(await digest(entry.quarantine), entry.hash); }
        catch (error) { if (scenario !== 'cancel' || error.code !== 'ENOENT') throw error; assert.equal(await digest(entry.source), entry.hash); }
      }
      evidence.cleanup.cases.push({ round, scenario, passed: true, retained: journal.entries.filter(entry => entry.intent).length });
      evidence.observations.push({ label: `${round} ${scenario} 복구`, snapshot: result });
      await capture(`${round} ${scenario} 복구`);
    }
  }
  const denied = path.join(evidence.directory, '쓰기 거부 백업');
  await fs.mkdir(denied);
  await fs.chmod(denied, 0o500);
  try {
    await assert.rejects(fs.writeFile(path.join(denied, 'probe'), 'x'), { code: 'EACCES' });
    await page.evaluate(backupDir => window.hwp2x.configure({ backupDir }), denied);
    for (const text of ['서식까지 같다는 보증', '확인이 끝난 원본은 같은 폴더의 숨김 안전보관본과', '원래 이름의 파일은 원래 위치에서 사라진다']) await page.getByRole('checkbox', { name: new RegExp(text) }).check();
    await click('백업 후 삭제 시작');
    const rejected = await until(async () => { const s = await cleanup(); return s.phase === 'error' && s; }, '실제 백업 쓰기 거부');
    await restored();
    assert.deepEqual(await fs.readdir(denied), []);
    evidence.cleanup.cases.push({ scenario: 'actual-EACCES', passed: true, originalMoved: false });
    evidence.observations.push({ label: '실제 쓰기 거부 원본 보존', snapshot: rejected });
    await capture('쓰기 거부 시 원본 이동 없음');
  } finally { await fs.chmod(denied, 0o700); }
  evidence.cleanup.unitEvidenceCommand = 'node --test electron/dist/cleanup.test.js';
}
if (require.main === module) {
  if (!process.argv.includes('--packaged')) { console.error('사용법: node electron/qa/cleanup-check.cjs --packaged'); process.exitCode = 1; }
  else if (!ensureDisplay(__filename)) runEvidence('cleanup-check', inspect, prepare).catch(error => { console.error(error); process.exitCode = 1; });
}
