// Real window: Settings → 한컴 다시 감지, three times while "installs" change underneath, then pick a version.
// Only the Windows-only detection list is substituted (HWP2X_FAKE_HANCOM_FILE, re-read on every detection and
// shaped like the real PowerShell output: Korean names from the file version).
// Usage: [HWP2X_EXECUTABLE=<packaged app>] xvfb-run -a node electron/hancom-redetect-check.cjs
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const v2024 = { path: 'C:\\Program Files (x86)\\Hnc\\Office 2024\\HOffice130\\Bin\\Hwp.exe', name: '한컴오피스 한글 13.0.0.3380', version: '13.0.0.3380', clsid: '{11111111-1111-1111-1111-111111111111}', registryView: '32', hive: 'HKLM', available: true };
const v2022 = { path: 'C:\\Program Files\\HNC\\Office 2022\\HOffice120\\Bin\\Hwp.exe', name: '한컴오피스 한글 12.0.0.2100', version: '12.0.0.2100', clsid: '{22222222-2222-2222-2222-222222222222}', registryView: '64', hive: 'HKLM', available: true };

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-redetect-'));
  const list = path.join(temp, 'installed.json');
  const install = items => fs.writeFile(list, JSON.stringify(items));
  await install([v2024]);
  const executablePath = process.env.HWP2X_EXECUTABLE;
  const app = await _electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', ...(executablePath ? [] : ['.']), `--user-data-dir=${path.join(temp, 'profile')}`],
    env: { ...process.env, HWP2X_START_ROOT: temp, HWP2X_FAKE_HANCOM_FILE: list },
  });
  const errors = [];
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1240, height: 860 });
    page.on('pageerror', error => errors.push(error.message));
    const state = () => page.evaluate(() => window.hwp2x.state());
    for (let i = 0; i < 50 && !(await state()).hancomCandidates?.length; i++) await page.waitForTimeout(100);
    await page.getByText('설정', { exact: true }).first().click();
    // Press 다시 감지 the way a user does, then read the result text shown under it once the press has finished
    // (the screen shows "작업 중입니다…" while busy and drops it when the call returns).
    const press = async () => {
      await page.getByRole('button', { name: '한컴 다시 감지 다시 감지', exact: true }).click();
      for (let i = 0; i < 80 && (await page.getByText('작업 중입니다…', { exact: true }).count()) > 0; i++) await page.waitForTimeout(100);
      await page.waitForTimeout(200);
      const note = (await state()).hancomDetectNote;
      assert.ok(note, '다시 감지 결과 안내가 나와야 함');
      await page.getByText(note, { exact: true }).waitFor({ timeout: 5000 });
      return note;
    };
    // Rows of the engine list: a version name directly followed by its Hwp.exe path (the sidebar shows only the name).
    const engineRows = async () => { const lines = (await page.locator('body').innerText()).split('\n'); return lines.filter((line, i) => /^한컴오피스 한글/.test(line) && /Hwp\.exe/i.test(lines[i + 1] ?? '')); };

    // 1. Nothing new installed: says so, keeps the version in use, points to 직접 지정.
    const nothingNew = await press();
    console.log('1. 새 설치 없음:', nothingNew);
    assert.match(nothingNew, /새로운 한컴 설치본을 찾지 못했습니다/);
    assert.match(nothingNew, /한컴오피스 한글 13\.0\.0\.3380/);
    assert.match(nothingNew, /Hwp\.exe 선택/);
    assert.equal((await state()).hancomPath, v2024.path, '기존 설정 유지');
    await page.screenshot({ path: path.join(temp, '1-nothing-new.png') });

    // 2. Another version installed meanwhile: it is listed with 이 버전 사용, and the note names it.
    await install([v2024, v2022]);
    const found = await press();
    console.log('2. 새 설치 발견:', found);
    assert.match(found, /새 한컴 설치본 1개를 찾았습니다\(한컴오피스 한글 12\.0\.0\.2100\)/);
    assert.deepEqual(await engineRows(), ['한컴오피스 한글 13.0.0.3380', '한컴오피스 한글 12.0.0.2100']);
    assert.equal((await state()).hancomPath, v2024.path, '새로 찾아도 쓰던 버전은 그대로');
    await page.screenshot({ path: path.join(temp, '2-found.png') });

    // 3. Choose the new one from the list; it becomes the engine everywhere.
    const row = page.locator('span', { hasText: /^한컴오피스 한글 12\.0\.0\.2100$/ }).locator('xpath=ancestor::div[contains(@style,"padding:14px 18px") or contains(@style,"padding: 14px 18px")][1]');
    await row.getByRole('button', { name: '이 버전 사용', exact: true }).click();
    for (let i = 0; i < 30 && (await state()).hancomPath !== v2022.path; i++) await page.waitForTimeout(100);
    assert.equal((await state()).hancomPath, v2022.path);
    await row.getByText('사용 중', { exact: true }).waitFor();
    console.log('3. 목록에서 12.0 선택: 사용 중으로 바뀜');

    // 4. Press again with two installs and nothing new: offers to switch between them.
    const again = await press();
    console.log('4. 두 개 중 선택 안내:', again);
    assert.match(again, /새로운 한컴 설치본은 없습니다\. 지금은 한컴오피스 한글 12\.0\.0\.2100을\(를\) 사용 중이며, 사용할 수 있는 2개 중/);
    assert.equal((await state()).hancomPath, v2022.path, '다시 감지해도 고른 버전 유지');

    // 5. Hancom removed entirely: says the old one is gone, that kordoc converts now, and how to point to Hwp.exe.
    await install([]);
    const none = await press();
    console.log('5. 한컴 없음:', none);
    assert.match(none, /사용하던 한컴오피스 한글 12\.0\.0\.2100을\(를\) 찾을 수 없습니다\. 사용할 수 있는 한컴오피스를 찾지 못해 지금은 내장 kordoc 엔진으로 변환합니다/);
    assert.match(none, /Hwp\.exe 선택/);
    assert.equal((await state()).hancomPath, '', '쓸 수 없는 경로를 남기지 않음');
    await page.screenshot({ path: path.join(temp, '5-none.png') });

    const text = await page.locator('body').innerText();
    assert.equal((text.match(/\uFFFD/g) || []).length, 0, '깨진 글자 없음');
    assert.equal(await page.locator('[role=alert]').count(), 0);
    assert.deepEqual(errors, []);
    console.log('통과');
  } finally {
    await app.close();
    console.log('스크린샷:', temp);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
