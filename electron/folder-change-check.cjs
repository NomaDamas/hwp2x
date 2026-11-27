// Real Electron window: change folder in Settings, search, then click convert.
// Only the native folder chooser is substituted; conversion and files are real.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

(async () => {
  assert.ok(process.env.HWP2X_SMOKE_HWP, 'HWP2X_SMOKE_HWP must name a real HWP sample');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-change-'));
  const initial = path.join(temp, '기본위치');
  const chosen = path.join(temp, '바꾼폴더');
  const nested = path.join(chosen, '하위');
  await fs.mkdir(initial, { recursive: true });
  await fs.copyFile(process.env.HWP2X_SMOKE_HWP, path.join(initial, '이전문서.hwp'));
  await fs.mkdir(nested, { recursive: true });
  for (const dir of [chosen, nested]) await fs.copyFile(process.env.HWP2X_SMOKE_HWP, path.join(dir, '공고문.hwp'));
  const executablePath = process.env.HWP2X_EXECUTABLE;
  const hancom = process.env.HWP2X_CHECK_HANCOM === '1';
  const candidate = { path: 'C:\\Program Files\\HNC\\Hwp.exe', name: '검사용 한컴', available: true, clsid: '{11111111-1111-1111-1111-111111111111}' };
  const app = await _electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', ...(executablePath ? [] : [process.env.HWP2X_APP_DIR || '.']), `--user-data-dir=${path.join(temp, 'profile')}`],
    env: { ...process.env, HWP2X_START_ROOT: initial, ...(hancom ? { HWP2X_FAKE_HANCOM: JSON.stringify([candidate]) } : {}) },
  });
  const evidence = { directory: temp, errors: [], files: [] };
  try {
    const pick = dir => app.evaluate(({ dialog }, value) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [value] }); }, dir);
    const page = await app.firstWindow();
    page.on('pageerror', error => evidence.errors.push(error.message));
    const state = () => page.evaluate(() => window.hwp2x.state());
    const route = process.env.HWP2X_FOLDER_ROUTE || 'settings';
    const choose = async dir => {
      await pick(dir);
      await page.getByText(route === 'settings' ? '설정' : '특정 폴더 변환', { exact: true }).first().click();
      await page.getByRole('button', { name: route === 'settings' ? '검색할 폴더 폴더 선택' : '폴더 선택', exact: true }).first().click();
      await page.waitForFunction(root => document.body.innerText.includes(root), dir);
    };
    await choose(initial);
    const previous = await state();
    assert.equal(previous.total, 1);
    assert.equal(previous.files[0].source, path.join(initial, '이전문서.hwp'));
    evidence.previous = { root: previous.root, total: previous.total, route };
    await choose(chosen);
    const searched = await state();
    assert.equal(searched.root, chosen);
    assert.equal(searched.total, 2);
    evidence.searched = { root: searched.root, sources: searched.files.map(file => file.source) };
    if (hancom) {
      for (let i = 0; i < 50 && (await state()).hancomPath !== candidate.path; i++) await page.waitForTimeout(100);
      assert.equal((await state()).hancomPath, candidate.path);
      evidence.engine = candidate.path;
    }
    // Settings route leaves the user on 설정; the 특정 폴더 변환 menu opens the convert screen with the chosen folder ready.
    await page.getByText('특정 폴더 변환', { exact: true }).first().click();
    await page.getByRole('button', { name: /^\d+개 파일 변환$/ }).click();
    const deadline = Date.now() + 30000;
    let final;
    const phases = new Set();
    do {
      final = await state();
      phases.add(final.phase);
      if (final.phase === 'done') break;
      await page.waitForTimeout(50);
    } while (Date.now() < deadline);
    evidence.phases = [...phases];
    evidence.final = { root: final.root, phase: final.phase, completed: final.completed, total: final.total };
    evidence.alerts = await page.locator('[role=alert]').allInnerTexts();
    assert.equal(final.phase, 'done');
    assert.equal(final.root, chosen);
    assert.equal(final.completed, 2);
    assert.equal(final.files.some(file => file.source.startsWith(initial + path.sep)), false);
    assert.deepEqual(await fs.readdir(initial), ['이전문서.hwp']);
    if (hancom) {
      assert.equal(final.counts.fail, 2);
      evidence.fileErrors = final.files.map(file => file.message);
      assert.ok(evidence.fileErrors.every(message => message.includes('한컴 변환은 Windows에서만 사용할 수 있습니다')));
      await page.getByText('파일', { exact: true }).first().click();
      await page.getByText('변환 실패', { exact: true }).first().waitFor({ timeout: 10000 });
      await page.getByText('공고문.hwp', { exact: true }).first().click();
      await page.getByText(/한컴 변환은 Windows에서만/).first().waitFor({ timeout: 10000 });
      assert.equal((await fs.readdir(chosen)).some(name => /\.(hwpx|md)$/.test(name)), false);
      await page.screenshot({ path: path.join(temp, 'hancom-error.png') });
      evidence.visibleFailure = true;
      evidence.passed = true;
      return;
    }
    for (const dir of [chosen, nested]) {
      const hwpx = path.join(dir, '공고문.hwpx');
      const md = path.join(dir, '공고문.md');
      const zipped = await fs.readFile(hwpx);
      assert.equal(zipped.subarray(0, 2).toString(), 'PK');
      assert.ok((await fs.readFile(md, 'utf8')).trim());
      assert.deepEqual(await fs.readFile(path.join(dir, '공고문.hwp')), await fs.readFile(process.env.HWP2X_SMOKE_HWP));
      evidence.files.push(hwpx, md);
    }
    assert.deepEqual(evidence.errors, []);
    // 100% reached: the screen moved to 파일 and lists both converted files.
    await page.getByPlaceholder('파일 이름 검색').waitFor({ timeout: 10000 });
    await page.getByText('공고문.hwp', { exact: true }).first().waitFor({ timeout: 10000 });
    assert.equal(await page.locator('span[title="공고문.hwp"]').count(), 2, '두 폴더의 결과가 목록에 보임');
    await page.screenshot({ path: path.join(temp, 'result.png') });
    evidence.passed = true;
  } finally {
    await app.close();
    if (process.env.HWP2X_CHECK_LOGS === '1') {
      const dir = path.join(temp, 'profile', 'logs');
      const entries = (await Promise.all((await fs.readdir(dir)).filter(name => name.endsWith('.log')).map(name => fs.readFile(path.join(dir, name), 'utf8')))).join('').trim().split('\n').map(line => JSON.parse(line));
      const required = ['ipc.request', 'scan.begin', 'scan.end', 'conversion.request', 'conversion.begin', 'file.begin', 'file.engine', 'file.end', 'conversion.end', ...(hancom ? ['file.error'] : ['file.validate', 'file.save'])];
      for (const event of required) assert.ok(entries.some(entry => entry.event === event), `로그 누락: ${event}`);
      if (hancom) assert.ok(entries.some(entry => entry.event === 'file.error' && entry.stage === 'hancom' && entry.error.message.includes('Windows')));
      evidence.logEvents = entries.filter(entry => required.includes(entry.event));
    }
    await fs.writeFile(path.join(temp, 'evidence.json'), JSON.stringify(evidence, null, 2));
    console.log(JSON.stringify(evidence, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
