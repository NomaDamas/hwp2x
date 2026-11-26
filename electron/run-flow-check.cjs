// Real Electron window (dev or packaged via HWP2X_EXECUTABLE), real nested folders and real files:
// pick folder → search → convert → pause → resume → stop → pick other folder → run → done → run again.
// Repeated clicks must not start a second run, and the numbers on screen must match the files on disk.
// Only the OS folder dialog is substituted.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const xml = text => `<?xml version="1.0" encoding="UTF-8"?><HWPML Version="2.8"><HEAD SecCnt="1"></HEAD><BODY><SECTION Id="0"><P><TEXT><CHAR>${text}</CHAR></TEXT></P></SECTION></BODY></HWPML>`;
async function makeFolder(root, count) {
  for (let i = 0; i < count; i++) {
    const dir = path.join(root, `묶음${i % 4}`, i % 2 ? '안쪽' : '');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, `문서${i}.hwpml`), xml(`문서 ${i}`));
  }
}
async function outputs(root) {
  const found = [];
  const walk = async dir => { for (const entry of await fs.readdir(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) await walk(full); else if (entry.name.endsWith('.hwpx')) found.push(full); } };
  await walk(root);
  return found;
}

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-flow-'));
  const first = path.join(temp, '첫번째'), second = path.join(temp, '두번째');
  await makeFolder(first, 60);
  await makeFolder(second, 5);
  const args = ['--no-sandbox', `--user-data-dir=${path.join(temp, 'profile')}`];
  const env = { ...process.env, HWP2X_START_ROOT: temp };
  const app = await _electron.launch(process.env.HWP2X_EXECUTABLE ? { executablePath: process.env.HWP2X_EXECUTABLE, args, env } : { args: [...args, '.'], env });
  try {
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const state = () => page.evaluate(() => window.hwp2x.state());
    const until = async (test, label, tries = 600) => { for (let i = 0; i < tries; i++) { const s = await state(); if (test(s)) return s; await page.waitForTimeout(100); } throw new Error(`시간 초과: ${label} (${JSON.stringify((await state()).phase)})`); };
    const pick = dir => app.evaluate(({ dialog }, d) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] }); }, dir);
    await page.evaluate(() => window.hwp2x.configure({ workers: 1 }));

    // 1. First screen is "특정 폴더 변환" and lets the user pick the folder right there.
    await page.getByText('특정 폴더 변환', { exact: true }).first().waitFor();
    await pick(first);
    await page.getByRole('button', { name: '폴더 선택', exact: true }).first().click();
    await until(s => s.root === first && s.total === 60, '첫 폴더 검색');
    await page.getByText(first, { exact: false }).first().waitFor();
    console.log('1. 특정 폴더 변환 화면에서 폴더 선택·검색: 60개 (하위 폴더 포함)');

    // 2. Start, then hammer the start path: only one run may exist.
    await page.getByRole('button', { name: /^\d+개 파일 변환$/ }).click();
    await until(s => s.phase === 'converting', '변환 시작');
    const repeat = await Promise.allSettled([1, 2, 3].map(() => page.evaluate(() => window.hwp2x.start())));
    assert.ok(repeat.every(r => r.status === 'rejected' && /이미 변환 중/.test(String(r.reason))), '실행 중 추가 시작 거부');
    // The screen redraws a moment after the state turns "converting": wait for the start button to go away.
    for (let i = 0; i < 30 && await page.getByRole('button', { name: /^\d+개 파일 변환$/ }).count() > 0; i++) await page.waitForTimeout(100);
    assert.equal(await page.getByRole('button', { name: /^\d+개 파일 변환$/ }).count(), 0, '실행 중 시작 버튼 숨김');
    await page.getByText('설정', { exact: true }).first().click();
    assert.equal(await page.getByRole('button', { name: '검색할 폴더 폴더 선택', exact: true }).count(), 0, '실행 중 폴더 선택 잠김');
    assert.equal(await page.getByRole('button', { name: '검색할 폴더 변환 중 잠김', exact: true }).count(), 1, '실행 중 잠김 표시');
    await page.getByText('특정 폴더 변환', { exact: true }).first().click();
    console.log('2. 실행 중: 추가 시작 3회 모두 거부, 시작·폴더 선택 버튼 잠김');

    // 3. Pause: the run keeps its list, progress on screen matches files on disk.
    await until(s => s.completed >= 3, '일부 처리');
    await page.getByRole('button', { name: '일시정지', exact: true }).click();
    let s = await until(s => s.phase === 'paused', '일시정지');
    const madeAtPause = (await outputs(first)).length;
    assert.equal(s.files.filter(f => f.target).length, madeAtPause, '일시정지 시 화면 처리 수 = 실제 HWPX 수');
    assert.ok(s.files.some(f => f.status === 'wait'), '남은 파일 있음');
    await assert.rejects(page.evaluate(d => window.hwp2x.scan(d), second), /일시정지된 작업/);
    console.log(`3. 일시정지: 화면 ${s.completed}/60 = 디스크 HWPX ${madeAtPause}개, 다른 폴더 검색은 거부`);

    // 4. Resume continues the same list, then stop ends it with the rest unconverted.
    await page.getByRole('button', { name: '이어하기', exact: true }).click();
    await until(s => s.phase === 'converting', '이어하기');
    await until(s => s.completed >= madeAtPause + 2, '이어서 처리');
    await page.getByRole('button', { name: '중지', exact: true }).click();
    s = await until(s => s.phase === 'stopped', '중지');
    const madeAtStop = (await outputs(first)).length;
    assert.ok(madeAtStop > madeAtPause, '이어하기로 더 처리');
    assert.equal(s.files.filter(f => f.target).length, madeAtStop, '중지 시 화면 처리 수 = 실제 HWPX 수');
    assert.equal(s.files.filter(f => f.status === 'wait').length, 60 - madeAtStop);
    await page.getByText('중지됨', { exact: true }).first().waitFor();
    console.log(`4. 이어하기 후 중지: 실제 HWPX ${madeAtStop}개, 남은 ${60 - madeAtStop}개는 변환 안 함`);

    // 5. From the stopped screen, pick another folder in one press (no extra screen in between).
    await pick(second);
    await page.getByRole('button', { name: '다른 폴더 선택', exact: true }).click();
    await until(s => s.root === second && s.total === 5 && s.phase === 'idle', '두번째 폴더 검색');
    await page.getByRole('button', { name: '5개 파일 변환', exact: true }).waitFor();
    await page.getByRole('button', { name: /^\d+개 파일 변환$/ }).click();
    s = await until(s => s.phase === 'done', '두번째 완료');
    assert.equal((await outputs(second)).length, 5);
    assert.equal(s.completed, 5);
    assert.equal((await outputs(first)).length, madeAtStop, '첫 폴더는 더 바뀌지 않음');
    console.log('5. 다른 폴더 선택 → 변환 → 완료: 5/5 HWPX, 첫 폴더 결과 그대로');

    // 6. After done, convert the same folder again in one press: rescans; existing outputs are skipped.
    await page.getByRole('button', { name: '이 폴더 다시 변환', exact: true }).click();
    s = await until(s => s.phase === 'done' && s.counts.skipped === 5, '완료 후 재실행');
    for (const menu of ['파일', '설정', '특정 폴더 변환']) { await page.getByText(menu, { exact: true }).first().click(); assert.ok(Array.isArray((await state()).files)); }
    assert.equal(await page.locator('[role=alert]').count(), 0);
    assert.deepEqual(errors, []);
    console.log('6. 완료 후 재실행: 다시 검색, 기존 HWPX 5개는 덮어쓰지 않고 건너뜀, 메뉴 정상');

    // 7. Close and open the app again after a finished run: it opens on the folder screen, ready to start.
    await app.close();
    const again = await _electron.launch(process.env.HWP2X_EXECUTABLE ? { executablePath: process.env.HWP2X_EXECUTABLE, args, env } : { args: [...args, '.'], env });
    try {
      const page2 = await again.firstWindow();
      await page2.getByRole('button', { name: '폴더 선택', exact: true }).first().waitFor({ timeout: 10000 });
      await page2.getByRole('button', { name: /^\d+개 파일 변환$|^검색 후 변환$/ }).first().waitFor();
      assert.equal(await page2.getByRole('button', { name: '이 폴더 다시 변환', exact: true }).count(), 0, '첫 화면은 이전 결과가 아님');
      console.log('7. 완료 후 앱 다시 열기: 첫 화면에서 바로 폴더 선택·변환 가능');
    } finally { await again.close(); }
  } finally {
    await app.close();
    await fs.rm(temp, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
