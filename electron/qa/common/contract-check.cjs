'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
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
}

main().catch(error => { console.error(error); process.exitCode = 1; });
