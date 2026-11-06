// Real Electron window: walk every menu (and the in-page `#` links) and require hwp2x:state to answer.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const HWPML = '<?xml version="1.0" encoding="UTF-8"?><HWPML Version="2.8"><HEAD SecCnt="1"></HEAD><BODY><SECTION Id="0"><P><TEXT><CHAR>사유</CHAR></TEXT></P></SECTION></BODY></HWPML>';
(async () => {
  const exe = process.env.HWP2X_EXECUTABLE;
  // The fake Hancom list (HWP2X_FAKE_HANCOM) can only be shown, not converted with, on Linux, so it is
  // passed solely to the settings-row launch below; every converting launch runs without it.
  const fakeHancom = process.env.HWP2X_FAKE_HANCOM;
  const baseEnv = { ...process.env };
  delete baseEnv.HWP2X_FAKE_HANCOM;
  const launch = async env => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-profile-'));
    return _electron.launch(exe ? { executablePath: exe, args: ['--no-sandbox', `--user-data-dir=${userDataDir}`], env: { ...baseEnv, ...env } } : { args: ['--no-sandbox', '.', `--user-data-dir=${userDataDir}`], env: { ...baseEnv, ...env } });
  };
  // Default start: the main drive is already the search location, without choosing a folder.
  {
    const first = await launch({});
    try {
      const page = await first.firstWindow();
      const expected = process.platform === 'win32' ? `${(process.env.SystemDrive || 'C:').toUpperCase()}\\` : '/';
      for (let i = 0; i < 50 && !(await page.locator('body').innerText()).includes(`검색 위치 ${expected} · 하위 폴더 모두 포함`); i++) await page.waitForTimeout(100);
      assert.equal((await page.evaluate(() => window.hwp2x.state())).root, expected, '시작 시 메인 드라이브 선택');
      await page.getByText(`검색 위치 ${expected} · 하위 폴더 모두 포함`, { exact: false }).first().waitFor();
      await page.getByRole('button', { name: '검색 후 변환', exact: true }).waitFor();
      console.log(`기본 검색 위치: ${expected} 표시 OK`);
    } finally { await first.close(); }
  }
  // Start button on a preselected location scans every nested folder and converts them all.
  {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-start-'));
    const nested = ['위.hwpml', '가/하나.hwpml', '가/나/다/라/깊음.hwpml', '마/바/셋.hwpml'];
    for (const file of nested) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), HWPML); }
    const second = await launch({ HWP2X_START_ROOT: root });
    try {
      const page = await second.firstWindow();
      await page.getByRole('button', { name: '검색 후 변환', exact: true }).click();
      for (let i = 0; i < 150 && (await page.evaluate(() => window.hwp2x.state())).phase !== 'done'; i++) await page.waitForTimeout(100);
      const state = await page.evaluate(() => window.hwp2x.state());
      assert.equal(state.phase, 'done');
      assert.equal(state.total, nested.length, '하위 폴더 파일 수');
      for (const file of nested) await fs.stat(path.join(root, file.replace(/\.hwpml$/, '.hwpx')));
      console.log(`하위 폴더 재귀 변환: ${state.total}개 모두 HWPX 생성 OK (가장 깊은 4단계 포함)`);
    } finally { await second.close(); await fs.rm(root, { recursive: true, force: true }); }
  }
  // Settings rows with three detected Hancom installs (2 usable, 1 without COM registration).
  if (fakeHancom) {
    const third = await launch({ HWP2X_FAKE_HANCOM: fakeHancom });
    try {
      const page = await third.firstWindow();
      await page.getByText('설정', { exact: true }).first().click();
      const hancom = [
        { name: '한컴오피스 한글 2024', path: 'C:\\HNC\\2024\\Hwp.exe' },
        { name: '한컴오피스 한글 2022', path: 'C:\\HNC\\2022\\Hwp.exe' },
        { name: '한컴오피스 한글 2018', path: 'C:\\HNC\\2018\\Hwp.exe' },
      ];
      // One settings row = the row grid (padding:14px 18px) whose bold label span reads exactly the given name;
      // the sidebar also shows the engine name, so rows are matched by their own style.
      const row = name => page.locator('span', { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`) }).locator('xpath=ancestor::div[contains(@style,"padding:14px 18px") or contains(@style,"padding: 14px 18px")][1]');
      await row(hancom[0].name).waitFor();
      const kordoc = row('kordoc 4.24.42');
      assert.equal(await kordoc.count(), 1, 'kordoc 행 하나');
      const kordocY = (await kordoc.boundingBox()).y;
      for (const item of hancom) {
        const r = row(item.name);
        assert.equal(await r.count(), 1, `${item.name} 행 하나`);
        const text = await r.innerText();
        assert.ok(text.includes(item.name) && text.includes(item.path), `${item.name} 행에 이름·경로`);
        assert.ok((await r.boundingBox()).y < kordocY, `${item.name} 행이 kordoc 행보다 위`);
      }
      const tag = async (r, label) => (await r.locator('span', { hasText: new RegExp(`^${label}$`) }).count()) > 0;
      let state = await page.evaluate(() => window.hwp2x.state());
      assert.equal(state.hancomPath, hancom[0].path, '저장된 선택 없으면 첫 사용 가능 한컴');
      assert.equal(await tag(row(hancom[0].name), '사용 중'), true, '2024 행 사용 중');
      assert.equal(await tag(row(hancom[1].name), '사용 중'), false, '2022 행 사용 중 아님');
      assert.equal(await tag(kordoc, '사용 중'), false, 'kordoc 행 사용 중 아님');
      const blocked = row(hancom[2].name);
      assert.equal(await tag(blocked, '사용 불가'), true, '2018 행 사용 불가');
      assert.equal(await blocked.getByRole('button').count(), 0, '2018 행 선택 버튼 없음');
      await row(hancom[1].name).getByRole('button', { name: '이 버전 사용', exact: true }).click();
      for (let i = 0; i < 20 && (await page.evaluate(() => window.hwp2x.state())).hancomPath !== hancom[1].path; i++) await page.waitForTimeout(100);
      await page.getByText('개요', { exact: true }).first().click();
      await page.getByText('설정', { exact: true }).first().click();
      state = await page.evaluate(() => window.hwp2x.state());
      assert.equal(state.hancomPath, hancom[1].path, '다시 불러와도 2022 유지');
      for (let i = 0; i < 20 && !(await tag(row(hancom[1].name), '사용 중')); i++) await page.waitForTimeout(100);
      assert.equal(await tag(row(hancom[1].name), '사용 중'), true, '2022 행 사용 중');
      assert.equal(await tag(row(hancom[0].name), '사용 중'), false, '2024 행 사용 중 해제');
      console.log(`한컴 행 점검: 3개 행 모두 kordoc(y=${Math.round(kordocY)})보다 위·이름·경로 OK, 기본 2024 사용 중, kordoc 미사용, 2018 사용 불가·버튼 없음, 2022 선택 후 재조회 유지`);
    } finally { await third.close(); }
  }
  // Backup on screen: convert a temp folder, press the enabled backup button, confirm, and check the copy.
  {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-bk-src-'));
    const backupDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-bk-dst-'));
    const nestedFile = path.join('하위', '보고서.hwpml');
    await fs.mkdir(path.join(root, '하위'));
    await fs.writeFile(path.join(root, nestedFile), HWPML);
    const original = await fs.readFile(path.join(root, nestedFile));
    const fourth = await launch({ HWP2X_START_ROOT: root });
    try {
      const page = await fourth.firstWindow();
      // The OS folder dialog is the only substitute: it returns the temp backup folder for "위치 변경".
      await fourth.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, backupDir);
      await page.getByText('설정', { exact: true }).first().click();
      await page.getByRole('button', { name: '위치 변경', exact: true }).click();
      for (let i = 0; i < 20 && (await page.evaluate(() => window.hwp2x.state())).backupDir !== backupDir; i++) await page.waitForTimeout(100);
      assert.equal((await page.evaluate(() => window.hwp2x.state())).backupDir, backupDir, '백업 위치 지정');
      await page.getByText('개요', { exact: true }).first().click();
      await page.getByRole('button', { name: '검색 후 변환', exact: true }).click();
      for (let i = 0; i < 150 && (await page.evaluate(() => window.hwp2x.state())).phase !== 'done'; i++) await page.waitForTimeout(100);
      await page.getByText('파일', { exact: true }).first().click();
      const backupButton = page.getByRole('button', { name: /^원본 백업/ });
      for (let i = 0; i < 40 && await backupButton.isDisabled(); i++) await page.waitForTimeout(100);
      assert.equal(await backupButton.isEnabled(), true, '변환 후 백업 버튼 활성');
      await backupButton.click();
      await page.getByRole('checkbox').last().check();
      const confirm = page.getByRole('button', { name: '원본 백업', exact: true });
      assert.equal(await confirm.isEnabled(), true, '동의 후 확인 버튼 활성');
      await confirm.click();
      const copied = path.join(backupDir, nestedFile);
      for (let i = 0; i < 40; i++) { try { await fs.stat(copied); break; } catch { await page.waitForTimeout(100); } }
      assert.ok((await fs.readFile(copied)).equals(original), '백업 폴더에 원본과 같은 HWP');
      assert.ok((await fs.readFile(path.join(root, nestedFile))).equals(original), '원래 파일 유지');
      assert.equal(await page.locator('[role=alert]').count(), 0, '백업 후 오류 배너 없음');
      console.log(`화면 백업: 버튼 활성·클릭 → ${path.relative(backupDir, copied)} 생성(원본과 동일), 원래 파일 유지`);
      // Pressing backup again used to fail with EEXIST and leave the dialog covering every menu.
      await backupButton.click();
      await page.getByRole('checkbox').last().check();
      await page.getByRole('button', { name: '원본 백업', exact: true }).click();
      for (let i = 0; i < 30 && !(await page.evaluate(() => window.hwp2x.state())).message.includes('이미 백업됨'); i++) await page.waitForTimeout(100);
      assert.match((await page.evaluate(() => window.hwp2x.state())).message, /1개는 이미 백업됨/);
      assert.equal(await page.locator('[role=alert]').count(), 0, '다시 백업해도 오류 배너 없음');
      await page.getByText('설정', { exact: true }).first().click({ timeout: 3000 });
      console.log('화면 백업 다시 누르기: 오류 없이 "이미 백업됨" 안내, 메뉴 이동 가능');
    } finally { await fourth.close(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(backupDir, { recursive: true, force: true }); }
  }
  const app = await launch({});
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
    // Skipped/failed reasons on the progress view and the file list, and a frozen timer after done.
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-reason-'));
    await fs.writeFile(path.join(root, '있음.hwpml'), HWPML);
    await fs.writeFile(path.join(root, '있음.hwpx'), 'existing');
    await fs.writeFile(path.join(root, '손상.hwp'), 'not hwp');
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, root);
    await page.getByText('설정', { exact: true }).first().click();
    await page.getByRole('button', { name: '폴더 선택', exact: true }).click();
    await page.getByText('개요', { exact: true }).first().click();
    await page.getByRole('button', { name: '검색한 파일 변환', exact: true }).click();
    for (let i = 0; i < 100 && (await page.evaluate(() => window.hwp2x.state())).phase !== 'done'; i++) await page.waitForTimeout(100);
    const skipText = '같은 이름의 HWPX 파일이 이미 있어 건너뜀';
    await page.getByText(skipText).first().waitFor();
    await page.getByText(/원본을 읽을 수 없음/).first().waitFor();
    console.log('진행 화면 사유: OK');
    const elapsed = () => page.evaluate(() => window.hwp2x.state().then(s => s.elapsed));
    const first = await elapsed();
    await page.waitForTimeout(2200); // real clock on purpose: the bug was the timer ticking in the real app
    assert.equal(await elapsed(), first, '완료 후 경과 시간 멈춤');
    await page.getByText('완료 · 멈춤').first().waitFor();
    console.log(`경과 시간 멈춤: OK (${first.toFixed(2)}초 고정)`);
    await page.getByText('파일', { exact: true }).first().click();
    await page.getByText(skipText).first().waitFor();
    await page.getByText(/원본을 읽을 수 없음/).first().waitFor();
    console.log('파일 목록 사유: OK');
    await check('변환 후 파일');
    await fs.mkdir('dist-electron/evidence', { recursive: true });
    await page.screenshot({ path: 'dist-electron/evidence/reasons.png' });
    await fs.rm(root, { recursive: true, force: true });
    assert.deepEqual(errors, []);
  } finally { await app.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
