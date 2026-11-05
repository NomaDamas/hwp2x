// Real Electron window: walk every menu (and the in-page `#` links) and require hwp2x:state to answer.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
(async () => {
  const exe = process.env.HWP2X_EXECUTABLE;
  const app = await _electron.launch(exe ? { executablePath: exe, args: ['--no-sandbox'] } : { args: ['--no-sandbox', '.'] });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const check = async label => {
      const state = await page.evaluate(() => window.hwp2x.state());
      assert.ok(Array.isArray(state.files), label);
      assert.equal(await page.locator('[role=alert]').count(), 0, `${label}: 오류 배너`);
      console.log(`${label}: state OK (${page.url().split('/').pop()})`);
    };
    await check('시작');
    await page.getByText('설정 변경', { exact: true }).click();
    await check('설정 변경 링크');
    for (const round of [1, 2]) for (const menu of ['개요', '파일', '설정']) {
      await page.getByText(menu, { exact: true }).first().click();
      await page.waitForTimeout(200);
      await check(`${menu} ${round}회차`);
    }
    await page.evaluate(() => { location.hash = 'settings'; });
    await check('주소 해시 변경');
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
