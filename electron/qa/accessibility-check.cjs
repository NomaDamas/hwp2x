'use strict';
const assert = require('node:assert/strict');
const { runEvidence, ensureDisplay } = require('./common/evidence.cjs');
async function inspect({ app, page, evidence, capture }) {
  const click = async name => { await page.getByRole('button', { name, exact: true }).click(); evidence.actions.push({ type: 'click', name }); };
  await click('설정');
  const opener = page.getByRole('button', { name: '상세 로그 로그 보기', exact: true });
  for (let pass = 0; pass < 2; pass++) {
    await opener.click(); evidence.actions.push({ type: 'click', name: '상세 로그 로그 보기' });
    const dialog = page.getByRole('dialog', { name: '상세 로그' });
    await dialog.waitFor();
    await page.waitForFunction(() => document.activeElement?.closest('[role=dialog]'));
    for (const key of ['Tab', 'Shift+Tab']) for (let i = 0; i < 8; i++) {
      await page.keyboard.press(key);
      assert.equal(await page.evaluate(() => !!document.activeElement?.closest('[role=dialog]')), true, `${key} 모달 밖 이탈`);
    }
    await dialog.getByRole('button', { name: '표시 범위 복사', exact: true }).click();
    await page.getByRole('status').filter({ hasText: '클립보드에 복사했습니다' }).waitFor();
    await capture(`로그 모달 키보드 ${pass + 1}`);
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await opener.evaluate(el => document.activeElement === el), true, 'Esc 후 실행 버튼 초점 복귀');
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setSize(760, 600));
  await page.emulateMedia({ forcedColors: 'active' });
  await capture('최소 창 고대비');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '창 전체 가로 넘침');
  const unnamed = await page.locator('button,[role=button],[role=switch],[role=radio],input,textarea').evaluateAll(els => els.filter(el => el.getClientRects().length && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !(el.textContent || '').trim() && !(el.labels?.length)).map(el => el.outerHTML));
  assert.deepEqual(unnamed, [], '이름 없는 조작 요소');
  for (const screen of ['특정 폴더 변환', '전체 자동 변환', '파일', '설정']) {
    await page.getByRole('button', { name: new RegExp(`^${screen}(\\s+\\d+)?$`) }).first().click();
    evidence.actions.push({ type: 'click', name: screen });
    await page.waitForTimeout(200);
    const missing = await page.locator('button,[role=button],[role=switch],[role=radio],input,textarea').evaluateAll(els => els.filter(el => el.getClientRects().length && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby') && !(el.textContent || '').trim() && !(el.labels?.length)).map(el => el.outerHTML));
    assert.deepEqual(missing, [], `${screen}: 이름 없는 조작 요소`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${screen}: 고대비 최소 창 가로 넘침`);
    evidence.observations.push({ screen, unnamed: missing });
    await capture(`${screen} 최소 창 고대비`);
  }
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5));
  for (const screen of ['특정 폴더 변환', '전체 자동 변환', '파일', '설정']) {
    await page.getByRole('button', { name: new RegExp(`^${screen}(\\s+\\d+)?$`) }).first().click();
    evidence.actions.push({ type: 'click', name: `${screen} 150%` });
    await page.waitForTimeout(200);
    const viewport = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    assert.ok(viewport.scrollWidth <= viewport.width, `${screen}: 확대시 창 가로 넘침`);
    evidence.observations.push({ screen, zoom: 1.5, viewport });
    await capture(`${screen} 150퍼센트 확대`);
  }
  await capture('최소 창 150퍼센트 확대');
  evidence.observations.push({ label: '키보드 순환과 복귀 두 회, 고대비·확대', unnamed, viewport: await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth })) });
  evidence.limitations = ['스크린리더 실제 낭독·Windows 고대비 테마·원본백업 인증 모달은 미검증', '확대 화면은 스크린샷 증거이며 모든 요소의 잘림을 자동 판정하지 않음'];
}
if (!process.argv.includes('--packaged')) { console.error('--packaged 필수'); process.exitCode = 1; }
else if (!ensureDisplay(__filename)) runEvidence('accessibility-check', inspect).catch(error => { console.error(error); process.exitCode = 1; });
