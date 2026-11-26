// Runs the real 32-bit Windows build (win-ia32-unpacked/hwp2x.exe) under Wine and drives it over the
// Chromium debugging port: every menu, folder pick → search → convert with Markdown. Linux stand-in for a
// 32-bit Windows 10/11 PC; it proves the ia32 binary starts and the app works, not Windows itself.
// Usage: DISPLAY=:91 WINEPREFIX=... node electron/win32-run-check.cjs <path-to-hwp2x.exe>
const { chromium } = require('playwright');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const net = require('node:net');

const exe = process.argv[2];
const port = 9333;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const portOpen = () => new Promise(resolve => { const s = net.connect(port, '127.0.0.1', () => { s.destroy(); resolve(true); }); s.on('error', () => resolve(false)); });

(async () => {
  const prefix = process.env.WINEPREFIX;
  // Windows-side folders inside the Wine prefix: documents to convert and a fresh app profile.
  const docsUnix = path.join(prefix, 'drive_c', 'hwp2x-docs');
  await fs.rm(docsUnix, { recursive: true, force: true });
  await fs.mkdir(path.join(docsUnix, '하위'), { recursive: true });
  const xml = text => `<?xml version="1.0" encoding="UTF-8"?><HWPML Version="2.8"><HEAD SecCnt="1"></HEAD><BODY><SECTION Id="0"><P><TEXT><CHAR>${text}</CHAR></TEXT></P></SECTION></BODY></HWPML>`;
  await fs.writeFile(path.join(docsUnix, '보고서.hwpml'), xml('32비트 변환 확인'));
  await fs.writeFile(path.join(docsUnix, '하위', '안쪽.hwpml'), xml('하위 폴더'));
  if (process.env.HWP2X_SMOKE_HWP) await fs.copyFile(process.env.HWP2X_SMOKE_HWP, path.join(docsUnix, '공고문.hwp'));
  const started = Date.now();
  const child = spawn('wine', [exe, `--remote-debugging-port=${port}`, '--user-data-dir=C:\\hwp2x-profile', '--no-sandbox'], {
    env: { ...process.env, HWP2X_START_ROOT: 'C:\\hwp2x-docs', WINEDEBUG: '-all' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let browser;
  try {
    for (let i = 0; i < 240 && !(await portOpen()); i++) await sleep(500);
    assert.ok(await portOpen(), '32비트 앱이 디버그 포트를 열지 못함');
    browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    let page;
    for (let i = 0; i < 60 && !page; i++) { page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().endsWith('app.html') || p.url().includes('app.html#')); if (!page) await sleep(500); }
    assert.ok(page, '앱 화면을 찾지 못함');
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const state = () => page.evaluate(() => window.hwp2x.state());
    for (let i = 0; i < 60 && !(await state()).root; i++) await sleep(250);
    const info = await page.evaluate(() => window.hwp2x.systemInfo());
    console.log(`실행: ${((Date.now() - started) / 1000).toFixed(1)}초 만에 창 표시 · platform=${info.platform} arch=${info.arch} electron=${info.versions.electron}`);
    assert.equal(info.platform, 'win32');
    assert.equal(info.arch, 'ia32', '32비트 프로세스로 실행');
    for (const round of [1, 2]) for (const menu of ['특정 폴더 변환', '파일', '설정']) {
      await page.getByText(menu, { exact: true }).first().click();
      await sleep(300);
      assert.ok(Array.isArray((await state()).files), `${menu} 상태 조회`);
      assert.equal(await page.locator('[role=alert]').count(), 0, `${menu} 오류 배너`);
    }
    console.log('메뉴: 특정 폴더 변환·파일·설정 2회 왕복, 상태 조회 정상, 오류 배너 없음');
    await page.getByText('특정 폴더 변환', { exact: true }).first().click();
    await page.getByRole('button', { name: '검색 후 변환', exact: true }).click();
    for (let i = 0; i < 480 && (await state()).phase !== 'done'; i++) await sleep(250);
    const done = await state();
    assert.equal(done.phase, 'done', '변환 완료');
    for (const name of ['보고서', path.join('하위', '안쪽')]) {
      const hwpx = await fs.readFile(path.join(docsUnix, `${name}.hwpx`));
      assert.ok(hwpx.subarray(0, 2).equals(Buffer.from('PK')), `${name}.hwpx`);
      await fs.stat(path.join(docsUnix, `${name}.md`));
    }
    console.log(`변환: ${done.total}개 처리 (${JSON.stringify(done.counts)}), C:\\hwp2x-docs 의 HWPX·MD 생성 확인 (엔진: ${done.hancomName})`);
    await page.getByText('파일', { exact: true }).first().click();
    await page.getByText('보고서.hwpml', { exact: true }).first().waitFor();
    assert.deepEqual(errors, [], '화면 스크립트 오류 없음');
    console.log('32비트 실행 확인 통과');
  } finally {
    if (browser) await browser.close().catch(() => {});
    child.kill('SIGKILL');
    spawn('wineserver', ['-k'], { env: process.env });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
