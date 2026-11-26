// Real Electron window: the user hand-picks a 한글 2004 Hwp.exe (Settings → Hwp.exe 선택), then changes the
// folder, searches and presses convert. 2004 cannot save HWPX: the app must say so, keep converting with
// kordoc, and make real HWPX/MD files. Only the OS dialogs and the Windows-only detection list
// (HWP2X_FAKE_HANCOM, shaped like the real PowerShell output: name from the file version) are substituted.
// Usage: HWP2X_SMOKE_HWP=<real .hwp> [HWP2X_EXECUTABLE=<packaged app>] xvfb-run -a node electron/legacy-hancom-check.cjs
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

(async () => {
  assert.ok(process.env.HWP2X_SMOKE_HWP, 'HWP2X_SMOKE_HWP must name a real HWP sample');
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-legacy-'));
  const start = path.join(temp, '기본위치');
  const chosen = path.join(temp, '바꾼폴더');
  const exe = path.join(temp, 'HNC', 'Hwp65', 'Hwp.exe');
  await fs.mkdir(start, { recursive: true });
  await fs.mkdir(path.join(chosen, '하위'), { recursive: true });
  await fs.mkdir(path.dirname(exe), { recursive: true });
  await fs.writeFile(exe, 'MZ');
  for (const dir of [chosen, path.join(chosen, '하위')]) await fs.copyFile(process.env.HWP2X_SMOKE_HWP, path.join(dir, '공고문.hwp'));
  // What the discovery script reports for a registered 한글 2004: version 6.5, a COM class, nothing named "2004".
  const detected = [{ path: exe, name: '한컴오피스 한글 6.5.0.1000', version: '6.5.0.1000', clsid: '{22222222-2222-2222-2222-222222222222}', registryView: '32', hive: 'HKLM', available: true }];
  const executablePath = process.env.HWP2X_EXECUTABLE;
  const app = await _electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', ...(executablePath ? [] : [process.env.HWP2X_APP_DIR || '.']), `--user-data-dir=${path.join(temp, 'profile')}`],
    env: { ...process.env, HWP2X_START_ROOT: start, HWP2X_FAKE_HANCOM: JSON.stringify(detected) },
  });
  const evidence = { directory: temp, errors: [] };
  try {
    const answer = value => app.evaluate(({ dialog }, v) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [v] }); }, value);
    const page = await app.firstWindow();
    page.on('pageerror', error => evidence.errors.push(error.message));
    const state = () => page.evaluate(() => window.hwp2x.state());
    // Detection runs after the window loads; wait until its verdict on this Hwp.exe is in.
    for (let i = 0; i < 100; i++) {
      const candidate = (await state()).hancomCandidates?.find(c => c.path === exe);
      if (candidate && typeof candidate.available === 'boolean' && (candidate.available === false || i > 50)) break;
      await page.waitForTimeout(100);
    }
    // 1. Detection alone already marks 2004 unusable instead of offering it.
    const first = await state();
    evidence.detected = first.hancomCandidates;
    assert.equal(first.hancomCandidates.find(c => c.path === exe)?.available, false, '자동 감지된 2004는 사용 불가');
    assert.equal(first.hancomPath, '', '2004를 엔진으로 고르지 않음');

    // 2. Hand-pick the same Hwp.exe: no exception, a clear reason, kordoc stays the engine.
    await answer(exe);
    await page.getByText('설정', { exact: true }).first().click();
    await page.getByRole('button', { name: '한컴 직접 선택 Hwp.exe 선택', exact: true }).click();
    await page.getByText(/HWPX 저장을 지원하지 않습니다/).first().waitFor({ timeout: 10000 });
    const picked = await state();
    evidence.pick = { hancomPath: picked.hancomPath, engine: picked.hancomName, reason: picked.hancomCandidates[0].unavailableReason };
    assert.equal(picked.hancomPath, '');
    assert.match(picked.hancomName, /kordoc/);

    // 3. Change folder in Settings → search → back to 특정 폴더 변환 → convert.
    await answer(chosen);
    await page.getByRole('button', { name: '검색할 폴더 폴더 선택', exact: true }).first().click();
    await page.waitForFunction(root => document.body.innerText.includes(root), chosen);
    assert.equal((await state()).total, 2);
    await page.getByText('특정 폴더 변환', { exact: true }).first().click();
    const phases = new Set();
    await page.getByRole('button', { name: /^\d+개 파일 변환$/ }).click();
    const deadline = Date.now() + 30000;
    let final;
    do { final = await state(); phases.add(final.phase); if (final.phase === 'done') break; await page.waitForTimeout(50); } while (Date.now() < deadline);
    evidence.phases = [...phases];
    evidence.final = { root: final.root, phase: final.phase, completed: final.completed, counts: final.counts };
    assert.ok(phases.has('converting'), '변환 단계로 진입');
    assert.equal(final.phase, 'done');
    assert.equal(final.counts.fail, 0, '실패 없음');
    evidence.files = [];
    for (const dir of [chosen, path.join(chosen, '하위')]) {
      const hwpx = await fs.readFile(path.join(dir, '공고문.hwpx'));
      assert.equal(hwpx.subarray(0, 2).toString(), 'PK');
      assert.ok((await fs.readFile(path.join(dir, '공고문.md'), 'utf8')).trim());
      evidence.files.push(path.join(dir, '공고문.hwpx'), path.join(dir, '공고문.md'));
    }
    await page.getByText('2 / 2개 처리', { exact: true }).waitFor({ timeout: 10000 });
    assert.deepEqual(evidence.errors, []);
    await page.screenshot({ path: path.join(temp, 'result.png') });
    evidence.passed = true;
  } finally {
    await app.close();
    console.log(JSON.stringify(evidence, null, 2));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
