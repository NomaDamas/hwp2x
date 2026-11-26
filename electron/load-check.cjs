// Real window under load: a folder of many documents in nested folders. Measures how long search takes,
// how long the screen freezes (longest gap between animation frames) while the list is drawn and during
// conversion, and how long buttons take to answer. Fails if the screen freezes for more than the limit.
// Usage: [HWP2X_EXECUTABLE=<packaged app>] [HWP2X_LOAD_FILES=3000] xvfb-run -a node electron/load-check.cjs
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const xml = text => `<?xml version="1.0" encoding="UTF-8"?><HWPML Version="2.8"><HEAD SecCnt="1"></HEAD><BODY><SECTION Id="0"><P><TEXT><CHAR>${text}</CHAR></TEXT></P></SECTION></BODY></HWPML>`;
const LIMIT_MS = Number(process.env.HWP2X_FREEZE_LIMIT_MS || 300);

(async () => {
  const count = Number(process.env.HWP2X_LOAD_FILES || 3000);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-load-'));
  assert.ok(Number.isInteger(count) && count >= 1000, '대량 목록 검사는 최소 1000개 문서 필요');
  const root = path.join(temp, '문서');
  for (let i = 0; i < count; i++) {
    const dir = path.join(root, `부서${i % 20}`, `${2000 + (i % 7)}년`);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `공문${i}.hwpml`), xml(`공문 ${i}`));
  }
  const executablePath = process.env.HWP2X_EXECUTABLE;
  const app = await _electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', ...(executablePath ? [] : ['.']), `--user-data-dir=${path.join(temp, 'profile')}`],
    env: { ...process.env, HWP2X_START_ROOT: temp },
  });
  const result = { files: count };
  try {
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, root);
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const state = () => page.evaluate(() => window.hwp2x.state({ limit: 1 }));
    const memory = async () => ({
      rendererHeapMB: await page.evaluate(() => performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null),
      mainRssMB: Math.round(await app.evaluate(() => process.memoryUsage().rss / 1048576)),
    });
    result.memoryMB = { beforeScan: await memory() };
    // Longest gap between frames = the longest time the screen could not redraw or react.
    // Each section gets its own frame loop; the previous one is stopped first so readings never carry over.
    const watch = () => page.evaluate(() => { cancelAnimationFrame(window.__raf); window.__gaps = []; let last = performance.now(); const tick = now => { if (now - last > 50) window.__gaps.push(Math.round(now - last)); last = now; window.__raf = requestAnimationFrame(tick); }; window.__raf = requestAnimationFrame(tick); });
    const gap = () => page.evaluate(() => { cancelAnimationFrame(window.__raf); return { max: Math.max(0, ...window.__gaps), over50: window.__gaps.length }; });
    // The check itself reads only the count, not the whole list, so it does not add load the user never causes.
    const total = async () => (await state()).total;
    await page.evaluate(() => window.hwp2x.configure({ workers: 2 }));

    await watch();
    let t = Date.now();
    await page.getByRole('button', { name: '폴더 선택', exact: true }).first().click();
    for (let i = 0; i < 600 && (await total()) !== count; i++) await page.waitForTimeout(50);
    result.searchMs = Date.now() - t;
    assert.equal(await total(), count);
    t = Date.now();
    await page.getByText('파일', { exact: true }).first().click();
    const firstPage = await page.evaluate(() => window.hwp2x.state({ limit: 100, offset: 0, filter: 'all', query: '' }));
    const secondPage = await page.evaluate(() => window.hwp2x.state({ limit: 100, offset: 100, filter: 'all', query: '' }));
    assert.equal(firstPage.files.length, 100);
    assert.equal(secondPage.files.length, 100);
    const rows = page.getByRole('button').filter({ has: page.getByText(/^공문\d+\.hwpml$/) });
    const waitRows = async expected => {
      await page.waitForFunction(names => {
        const elements = [...document.querySelectorAll('[role="button"]')].filter(row => /^공문\d+\.hwpml/m.test(row.innerText));
        return elements.length === names.length && names.every(name => elements.some(row => [...row.querySelectorAll('*')].some(child => child.textContent === name)));
      }, expected, { timeout: 30000 });
      const visible = await rows.count();
      assert.equal(visible, expected.length, '실제 파일 이름 행 수');
      assert.ok(visible <= 100, `파일 DOM 행 ${visible}개`);
    };
    await waitRows(firstPage.files.map(file => file.name));
    result.fileListMs = Date.now() - t;
    result.firstPageRows = await rows.count();
    await page.getByRole('button', { name: '다음 페이지', exact: true }).click();
    await waitRows(secondPage.files.map(file => file.name));
    assert.equal(await rows.filter({ has: page.getByText(firstPage.files[0].name, { exact: true }) }).count(), 0, '이전 페이지 문서가 남지 않음');
    result.secondPageRows = await rows.count();
    const searchName = firstPage.files[0].name;
    await page.getByRole('textbox', { name: '파일 이름 검색', exact: true }).fill(searchName);
    await waitRows([searchName]);
    await rows.filter({ has: page.getByText(searchName, { exact: true }) }).click();
    result.searchDocument = searchName;
    await page.getByRole('textbox', { name: '파일 이름 검색', exact: true }).fill('');
    await waitRows(firstPage.files.map(file => file.name));
    result.memoryMB.afterPagingAndSearch = await memory();
    await page.getByText('특정 폴더 변환', { exact: true }).first().click();
    result.searchFreezeMs = await gap();

    await watch();
    t = Date.now();
    await page.getByRole('button', { name: /^\d+개 파일 변환$/ }).click();
    await page.getByRole('button', { name: '일시정지', exact: true }).waitFor({ timeout: 10000 });
    result.startToControlsMs = Date.now() - t;
    // Click through every menu while converting and time how long each takes to show.
    result.menuMs = {};
    for (const menu of ['파일', '설정', '특정 폴더 변환']) {
      const m = Date.now();
      await page.getByText(menu, { exact: true }).first().click();
      await page.waitForFunction(label => document.body.innerText.includes(label), menu === '파일' ? '전체' : menu === '설정' ? '검색할 폴더' : '동시 작업');
      result.menuMs[menu] = Date.now() - m;
    }
    await page.waitForTimeout(2000);
    const p = Date.now();
    await page.getByRole('button', { name: '일시정지', exact: true }).click();
    // Whatever the speed of the PC, the screen must show the click was taken before the pause completes.
    await page.getByText(/일시정지 중입니다|일시정지됨/).first().waitFor({ timeout: 30000 });
    result.pauseAckMs = Date.now() - p;
    await page.getByText('일시정지됨', { exact: true }).first().waitFor({ timeout: 30000 });
    result.pauseMs = Date.now() - p;
    result.convertFreezeMs = await gap();
    result.convertedBeforePause = (await state()).completed;
    result.memoryMB.afterPause = await memory();
    result.rendererMemoryMB = result.memoryMB.afterPause.rendererHeapMB;
    result.mainMemoryMB = result.memoryMB.afterPause.mainRssMB;
    assert.deepEqual(errors, []);
    assert.ok(result.searchFreezeMs.max <= LIMIT_MS, `검색·목록 표시 중 화면 멈춤 ${result.searchFreezeMs.max}ms`);
    assert.ok(result.pauseAckMs <= 1000, `일시정지 누른 뒤 안내까지 ${result.pauseAckMs}ms`);
    assert.ok(result.convertFreezeMs.max <= LIMIT_MS, `변환 중 화면 멈춤 ${result.convertFreezeMs.max}ms`);
    result.passed = true;
  } finally {
    await app.close();
    console.log(JSON.stringify(result));
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
