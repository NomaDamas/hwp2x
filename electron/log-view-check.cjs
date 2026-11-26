// Real window: convert a real document, then Settings → 로그 보기 → 표시 범위 복사, twice. The clipboard must hold
// the log lines of this run (readable Korean, no garbled characters), and the second copy must include
// what happened after the first (a new detection press).
// Usage: [HWP2X_EXECUTABLE=<packaged app>] HWP2X_SMOKE_HWP=<real .hwp> xvfb-run -a node electron/log-view-check.cjs
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-logview-'));
  const docs = path.join(temp, '문서');
  await fs.mkdir(docs);
  const sample = process.env.HWP2X_SMOKE_HWP;
  assert.ok(sample, 'HWP2X_SMOKE_HWP: 실제 HWP 파일 경로가 필요합니다');
  await fs.copyFile(sample, path.join(docs, '공고문.hwp'));
  const executablePath = process.env.HWP2X_EXECUTABLE;
  const app = await _electron.launch({
    ...(executablePath ? { executablePath } : {}),
    args: ['--no-sandbox', ...(executablePath ? [] : ['.']), `--user-data-dir=${path.join(temp, 'profile')}`],
    env: { ...process.env, HWP2X_START_ROOT: docs },
  });
  const errors = [];
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1240, height: 860 });
    page.on('pageerror', error => errors.push(error.message));
    const state = () => page.evaluate(() => window.hwp2x.state());
    for (let i = 0; i < 50 && (await state()).root !== docs; i++) await page.waitForTimeout(100);
    await page.getByRole('button', { name: /검색 후 변환|\d+개 파일 변환/ }).click();
    for (let i = 0; i < 300 && (await state()).phase !== 'done'; i++) await page.waitForTimeout(100);
    assert.equal((await state()).phase, 'done');

    const clipboard = () => app.evaluate(({ clipboard }) => clipboard.readText());
    const copy = async () => {
      await app.evaluate(({ clipboard }) => clipboard.writeText(''));
      await page.getByRole('button', { name: '표시 범위 복사', exact: true }).click();
      await page.getByText(/클립보드에 복사했습니다/).waitFor();
      return clipboard();
    };

    await page.getByText('설정', { exact: true }).first().click();
    await page.getByRole('button', { name: '상세 로그 로그 보기', exact: true }).click();
    const box = page.getByRole('textbox', { name: '로그 내용' });
    await box.waitFor();
    assert.match(await box.inputValue(), /"event":"conversion.end"/, '로그 창에 이번 변환 기록이 보임');
    const first = await copy();
    assert.equal(first.trim(), (await box.inputValue()).trim(), '복사한 내용 = 화면에 보이는 로그');
    for (const line of first.trim().split('\n')) JSON.parse(line); // every line is a whole log entry
    assert.match(first, /공고문\.hwp/);
    assert.equal((first.match(/\uFFFD/g) || []).length, 0, '깨진 글자 없음');
    console.log(`1회차 복사: ${first.trim().split('\n').length}줄, 변환 기록 포함`);
    await page.screenshot({ path: path.join(temp, 'log-view.png') });

    // Close, do something new, open again: the second copy carries the new entries too.
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    await page.getByRole('button', { name: '한컴 다시 감지 다시 감지', exact: true }).click();
    for (let i = 0; i < 50 && (await page.getByText('작업 중입니다…').count()) > 0; i++) await page.waitForTimeout(100);
    await page.getByRole('button', { name: '상세 로그 로그 보기', exact: true }).click();
    await box.waitFor();
    const second = await copy();
    assert.ok(second.length > first.length, '두 번째 복사에 새 기록이 더해짐');
    assert.match(second, /한컴 다시 감지/);
    assert.match(second, /로그 복사/);
    console.log(`2회차 복사: ${second.trim().split('\n').length}줄, 다시 감지 기록 포함`);
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    assert.equal(await box.count(), 0, '닫기 후 로그 창 사라짐');

    assert.equal(await page.locator('[role=alert]').count(), 0);
    assert.deepEqual(errors, []);
    console.log('통과');
  } finally {
    await app.close();
    console.log('스크린샷:', temp);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
