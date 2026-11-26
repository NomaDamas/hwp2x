// Real Electron window, same profile across restarts: a hand-picked Hwp.exe is saved, comes back first on the
// next launch, is cleared by choosing another engine, and a moved/removed pick is reported, not silently used.
// Only the OS file dialog and the Windows-only detection list (HWP2X_FAKE_HANCOM) are substituted.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-pick-'));
  const profile = path.join(temp, 'profile');
  const root = path.join(temp, 'docs');
  const manualExe = path.join(temp, 'D-drive', 'MyHancom', 'HOffice120', 'Bin', 'Hwp.exe');
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(path.dirname(manualExe), { recursive: true });
  await fs.writeFile(manualExe, 'MZ');
  const auto = { path: 'C:\\Program Files\\HNC\\Office 2024\\HOffice130\\Bin\\Hwp.exe', name: '한컴오피스 한글 2024', version: '13.0', clsid: '{11111111-1111-1111-1111-111111111111}', registryView: '64', hive: 'HKLM', available: true };
  const custom = { path: manualExe, name: '한컴오피스 한글 2022', version: '12.0', clsid: '{22222222-2222-2222-2222-222222222222}', registryView: '32', hive: 'HKLM', available: true };
  const env = { ...process.env, HWP2X_START_ROOT: root, HWP2X_FAKE_HANCOM: JSON.stringify([auto, custom]) };
  const args = ['--no-sandbox', `--user-data-dir=${profile}`];
  const launch = () => _electron.launch(process.env.HWP2X_EXECUTABLE ? { executablePath: process.env.HWP2X_EXECUTABLE, args, env } : { args: [...args, '.'], env });
  const ready = async page => {
    for (let i = 0; i < 50 && !(await page.evaluate(() => window.hwp2x.state())).hancomCandidates?.length; i++) await page.waitForTimeout(100);
    return page.evaluate(() => window.hwp2x.state());
  };
  const settingsFile = path.join(profile, 'settings.json');
  let app;
  try {
    // 1. First run: auto-detection picks the first installed version.
    app = await launch();
    let page = await app.firstWindow();
    let state = await ready(page);
    assert.equal(state.hancomPath, auto.path, '처음에는 자동 감지 첫 버전');
    // 2. The user picks Hwp.exe from a non-standard folder with the file dialog.
    await app.evaluate(({ dialog }, exe) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [exe] }); }, manualExe);
    await page.getByText('설정', { exact: true }).first().click();
    await page.getByRole('button', { name: '한컴 직접 선택 Hwp.exe 선택', exact: true }).click();
    for (let i = 0; i < 30 && (await page.evaluate(() => window.hwp2x.state())).hancomPath !== manualExe; i++) await page.waitForTimeout(100);
    state = await page.evaluate(() => window.hwp2x.state());
    assert.equal(state.hancomPath, manualExe, '직접 고른 Hwp.exe 사용');
    assert.equal(JSON.parse(await fs.readFile(settingsFile, 'utf8')).manualHancomPath, manualExe, '고른 경로 저장');
    await page.getByText('(직접 선택)', { exact: false }).first().waitFor();
    console.log(`직접 선택: ${manualExe} → 사용 중, settings.json 저장`);
    await app.close(); app = undefined;

    // 3. Restart with the same profile: the saved pick wins over auto-detection and is listed first.
    app = await launch();
    page = await app.firstWindow();
    state = await ready(page);
    assert.equal(state.hancomPath, manualExe, '재실행 후에도 직접 선택 우선');
    assert.equal(state.hancomCandidates[0].path, manualExe, '직접 선택이 목록 맨 앞');
    assert.match(state.hancomName, /직접 선택/);
    console.log('재실행: 저장된 직접 선택이 자동 감지보다 우선, 목록 맨 앞');

    // 4. Choosing the auto-detected version clears the saved pick.
    await page.getByText('설정', { exact: true }).first().click();
    const autoRow = page.locator('span', { hasText: /^한컴오피스 한글 2024$/ }).locator('xpath=ancestor::div[contains(@style,"padding:14px 18px") or contains(@style,"padding: 14px 18px")][1]');
    await autoRow.getByRole('button', { name: '이 버전 사용', exact: true }).click();
    for (let i = 0; i < 30 && (await page.evaluate(() => window.hwp2x.state())).hancomPath !== auto.path; i++) await page.waitForTimeout(100);
    assert.equal((await page.evaluate(() => window.hwp2x.state())).hancomPath, auto.path);
    assert.equal(JSON.parse(await fs.readFile(settingsFile, 'utf8')).manualHancomPath, '', '다른 버전 선택 시 직접 선택 해제');
    await app.close(); app = undefined;
    app = await launch();
    page = await app.firstWindow();
    assert.equal((await ready(page)).hancomPath, auto.path, '해제 후 재실행은 자동 감지');
    console.log('다른 버전 선택: 직접 선택 해제, 재실행 후 자동 감지 버전 유지');

    // 5. Pick again, then the file disappears (uninstalled/moved): restart reports it and falls back, no crash.
    await app.evaluate(({ dialog }, exe) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [exe] }); }, manualExe);
    await page.getByText('설정', { exact: true }).first().click();
    await page.getByRole('button', { name: '한컴 직접 선택 Hwp.exe 선택', exact: true }).click();
    for (let i = 0; i < 30 && (await page.evaluate(() => window.hwp2x.state())).hancomPath !== manualExe; i++) await page.waitForTimeout(100);
    await app.close(); app = undefined;
    await fs.rm(manualExe);
    app = await launch();
    page = await app.firstWindow();
    state = await ready(page);
    assert.equal(state.hancomPath, auto.path, '사라진 직접 선택 대신 자동 감지 버전');
    assert.equal(state.hancomCandidates[0].available, false, '사라진 직접 선택은 사용 불가 표시');
    assert.match(state.hancomCandidates[0].unavailableReason ?? '', /찾을 수 없/);
    await page.getByText('설정', { exact: true }).first().click();
    const banners = await page.locator('[role=alert]').allInnerTexts();
    assert.ok(banners.every(text => /직접 선택한 한컴을 쓸 수 없어 다른 엔진을 사용합니다/.test(text)), `안내만 표시: ${JSON.stringify(banners)}`);
    console.log(`직접 선택 파일 삭제 후 재실행: "${state.hancomCandidates[0].unavailableReason}" 표시, 자동 감지 버전으로 대체`);
  } finally {
    if (app) await app.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
