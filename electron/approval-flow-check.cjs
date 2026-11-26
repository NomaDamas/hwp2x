// Real Linux automatic-mode recovery; Hancom security interaction is covered only by the engine stand-in test.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { validateHwpx } = require('kordoc');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const deadline = Date.now() + 180000;
  while (Date.now() < deadline) { if (await check()) return; await sleep(100); }
  throw new Error(`시간 초과: ${label}`);
}
(async () => {
  assert.equal(process.platform, 'linux');
  const source = process.env.HWP2X_SMOKE_HWP || '/tmp/hwp2x-real/공고문.hwp';
  const original = await fs.readFile(source);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-approval-ui-'));
  const root = path.join(temp, '실제 HWP 복사본');
  await fs.mkdir(root);
  const healthy = path.join(root, '정상.hwp');
  await fs.copyFile(source, healthy);
  const damaged = path.join(root, '손상.hwp');
  const broken = original.subarray(0, 128);
  await fs.writeFile(damaged, broken);
  const replacement = path.join(temp, '교체용 정상.hwp');
  await fs.copyFile(source, replacement);
  const evidence = { temp, source, security: '엔진 대역 테스트와 별개인 Linux 실제 HWP 검증', cycles: [], errors: [] };
  let app, page;
  try {
    app = await _electron.launch({
      ...(process.env.HWP2X_EXECUTABLE ? { executablePath: process.env.HWP2X_EXECUTABLE } : {}),
      args: ['--no-sandbox', `--user-data-dir=${path.join(temp, 'profile')}`, ...(process.env.HWP2X_EXECUTABLE ? [] : [path.resolve(__dirname, '..')])],
      env: { ...process.env, XDG_CONFIG_HOME: path.join(temp, 'config'), HWP2X_TEST_HOOKS: '1', HWP2X_AUTO_ROOTS: JSON.stringify([root]) },
      timeout: 30000,
    });
    page = await app.firstWindow();
    page.on('pageerror', error => evidence.errors.push(error.message));
    await page.waitForFunction(() => typeof window.hwp2x?.autoIssues === 'function');
    await page.getByRole('button', { name: '전체 자동 변환', exact: true }).click();
    await page.getByRole('button', { name: /자동 변환 시작/ }).click();
    const section = page.locator('section[aria-labelledby="auto-issues-title"]');
    const status = page.locator('[role="status"][aria-label="자동 변환 진행 상태"]');
    for (let cycle = 1; cycle <= 2; cycle++) {
      const input = cycle === 1 ? damaged : path.join(root, '두번째 손상.hwp');
      if (cycle === 2) await fs.writeFile(input, broken);
      const name = path.basename(input);
      const retry = page.getByRole('button', { name: `${name} 다시 작업`, exact: true });
      await retry.waitFor({ state: 'visible', timeout: 180000 });
      await until(async () => (await status.innerText()).includes('완료 · 감시 체제로 전환됨'), '실패 후 감시 복귀');
      const failed = await section.innerText();
      assert.match(failed, /미처리 파일 1개/);
      assert.match(failed, /\d+초 전 실패/);
      await sleep(1500);
      assert.equal(await retry.count(), 1, '실패 항목이 감시 중 유지됨');
      assert.deepEqual(await fs.readFile(input), broken, '실패 원본 보존');
      await assert.rejects(fs.stat(input.replace(/\.hwp$/, '.hwpx')), { code: 'ENOENT' });
      await page.screenshot({ path: path.join(temp, `${cycle}-failed.png`), fullPage: true });
      await page.evaluate(() => {
        window.approvalTexts = [];
        window.approvalObserver = new MutationObserver(() => window.approvalTexts.push(document.querySelector('section[aria-labelledby="auto-issues-title"]').innerText));
        window.approvalObserver.observe(document.querySelector('section[aria-labelledby="auto-issues-title"]'), { subtree: true, childList: true, characterData: true });
      });
      await fs.copyFile(replacement, input);
      assert.equal(await retry.isEnabled(), true);
      await retry.click();
      const output = input.replace(/\.hwp$/, '.hwpx');
      await until(async () => { try { return (await validateHwpx(await fs.readFile(output))).ok; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, '재시도 실제 HWPX 출력');
      await until(async () => !(await section.innerText()).includes(name), '성공 항목 미처리 목록 제거');
      await until(async () => (await status.innerText()).includes('완료 · 감시 체제로 전환됨'), '재시도 완료 감시 복귀');
      const completed = await status.innerText();
      const retryTexts = await page.evaluate(() => { window.approvalObserver.disconnect(); return window.approvalTexts; });
      assert.ok(retryTexts.some(text => /\d+초 경과 · 시도 \d+회/.test(text)), JSON.stringify(retryTexts));
      assert.deepEqual(await fs.readFile(input), original);
      await page.screenshot({ path: path.join(temp, `${cycle}-recovered.png`), fullPage: true });
      evidence.cycles.push({ cycle, input, output, failed, retryTexts, completed, state: await page.evaluate(() => window.hwp2x.autoState()) });
    }
    assert.equal((await validateHwpx(await fs.readFile(healthy.replace(/\.hwp$/, '.hwpx')))).ok, true);
    assert.deepEqual(await fs.readFile(source), original);
    assert.deepEqual(evidence.errors, []);
    console.log(JSON.stringify({ ok: true, evidence: path.join(temp, 'evidence.json'), cycles: evidence.cycles.length }));
  } catch (error) {
    evidence.failure = String(error.stack || error);
    if (page) await page.screenshot({ path: path.join(temp, 'failure.png'), fullPage: true }).catch(() => {});
    throw error;
  } finally {
    await fs.writeFile(path.join(temp, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(`검증 증거: ${temp}`);
    if (app) await app.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
