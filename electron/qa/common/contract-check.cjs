'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs/promises');
const { ensureDisplay, runEvidence } = require('./evidence.cjs');

function assertContract(state) {
  const { contract } = state;
  assert.equal(contract?.contractVersion, 1);
  assert.equal(contract.settingsVersion, 1);
  assert.equal(contract.phase, state.phase);
  assert.deepEqual(contract.progress, { total: state.total, completed: state.completed, percent: state.percent });
  for (const key of ['waiting', 'failed', 'skipped']) assert.ok(Number.isInteger(contract.unprocessed?.[key]), `unprocessed.${key}`);
  assert.equal(typeof contract.recovery?.canResume, 'boolean');
  assert.equal(contract.recovery.rollbackAuthority, 'cleanup-state');
}

async function main() {
  if (ensureDisplay(__filename)) return;
  await runEvidence('contract-check', async ({ page, evidence, capture }) => {
    const state = () => page.evaluate(() => window.hwp2x.state());
    for (const end = Date.now() + 30000; Date.now() < end && (await state()).phase !== 'idle'; await page.waitForTimeout(100));
    const initial = await state();
    assert.equal(path.resolve(initial.root), evidence.isolatedPaths.docs, '격리 문서 폴더에서 시작');
    assert.equal(initial.phase, 'idle', '시작 상태 idle');
    assertContract(initial);
    evidence.observations.push({ label: '초기', contract: initial.contract });
    await capture('초기 화면');
    for (const label of ['특정 폴더 변환', '파일', '설정']) {
      await page.getByRole('button', { name: new RegExp(`^${label}(\\s+\\d+)?$`) }).first().click();
      await page.waitForTimeout(200);
      const current = await state();
      assertContract(current);
      evidence.actions.push({ type: 'click', target: label, at: new Date().toISOString(), phase: current.phase });
      evidence.observations.push({ label, visibleText: await page.locator('body').innerText(), contract: current.contract });
      await capture(`${label} 메뉴`);
    }
  });
  await runEvidence('legacy-profile', async ({ page, evidence, capture }) => {
    const initial = await page.evaluate(() => window.hwp2x.state());
    assertContract(initial);
    assert.equal(initial.phase, 'paused');
    assert.equal(initial.workers, 1);
    assert.equal(initial.makeMarkdown, false);
    assert.equal(initial.total, 2);
    assert.equal(initial.contract.recovery.canResume, true);
    assert.equal(initial.contract.unprocessed.waiting, 2);
    evidence.observations.push({ label: '구형 프로필 복원', state: initial });
    await page.getByRole('button', { name: '설정', exact: true }).click();
    assert.equal(await page.getByRole('radio', { name: '1', exact: true }).getAttribute('aria-checked'), 'true');
    assert.equal(await page.getByRole('switch', { name: /AI가 읽기 편한 md 파일도 생성/ }).getAttribute('aria-checked'), 'false');
    evidence.actions.push({ type: 'click', target: '설정', at: new Date().toISOString() });
    await capture('복원된 설정 실제 화면');
    await page.getByRole('button', { name: '특정 폴더 변환', exact: true }).click();
    await capture('기존 프로필 복원');
    await page.getByRole('button', { name: '이어하기', exact: true }).click();
    evidence.actions.push({ type: 'click', target: '이어하기', at: new Date().toISOString() });
    const deadline = Date.now() + 60000;
    while ((await page.evaluate(() => window.hwp2x.state())).phase !== 'done') {
      if (Date.now() > deadline) throw Error('기존 프로필 이어하기 완료 시간 초과');
      await page.waitForTimeout(100);
    }
    const completed = await page.evaluate(() => window.hwp2x.state());
    assertContract(completed);
    assert.equal(completed.completed, 2);
    assert.equal(completed.counts.fail, 1);
    assert.equal(completed.contract.unprocessed.failed, 1);
    assert.equal(completed.contract.unprocessed.waiting, 0);
    assert.equal(completed.contract.recovery.canResume, false);
    assert.equal(completed.contract.progress.percent, 100);
    assert.ok(completed.files.find(file => file.status === 'fail').message.length > 0);
    evidence.observations.push({ label: '정상 및 잘못된 입력 처리 완료', state: completed });
    const output = path.join(evidence.isolatedPaths.docs, '공고문.hwpx');
    assert.ok((await fs.stat(output)).size > 0);
    await assert.rejects(fs.stat(path.join(evidence.isolatedPaths.docs, '공고문.md')), { code: 'ENOENT' });
    evidence.outputs.push({ path: output, bytes: (await fs.stat(output)).size });
    await capture('기존 프로필 이어하기 완료');
  }, async evidence => {
    const file = evidence.inputs[0];
    await fs.mkdir(evidence.profile, { recursive: true });
    const state = { phase: 'paused', root: evidence.isolatedPaths.docs, files: [{ id: 1, name: '공고문.hwp', dir: evidence.isolatedPaths.docs, source: file.path, size: file.bytes, targetSize: 0, status: 'wait', message: '' }], skippedDirs: [], workers: 1, makeMarkdown: false, autoBackup: false, backupDir: path.join(evidence.directory, 'backup'), hancomPath: '', hancomName: '', hancomCandidates: [], hancomDetectNote: '', message: '', startedAt: 0, endedAt: 0 };
    const invalid = path.join(evidence.isolatedPaths.docs, '오류주입.hwp');
    await fs.writeFile(invalid, '오류 주입 전용: HWP가 아님');
    state.files.push({ id: 2, name: '오류주입.hwp', dir: evidence.isolatedPaths.docs, source: invalid, size: (await fs.stat(invalid)).size, targetSize: 0, status: 'wait', message: '' });
    evidence.syntheticInputs = [{ path: invalid, purpose: '잘못된 입력 오류 계약 검사 전용' }];
    await fs.writeFile(path.join(evidence.profile, 'conversion-state.json'), JSON.stringify({ version: 1, state }));
    await fs.writeFile(path.join(evidence.profile, 'settings.json'), JSON.stringify({ manualHancomPath: '' }));
    evidence.legacyProfile = { version: 1, settingsVersionAbsent: true, runtimeMock: false };
  });
}

main().catch(error => { console.error(error); process.exitCode = 1; });
