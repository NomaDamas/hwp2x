// Real packaged window, real HWP copies: run 전체 자동 변환 with the memory limits lowered (test hooks only) so the
// app really slows down and pauses, keep switching tabs while it converts, then open 설정 → 로그 보기 and check the
// periodic measurements and the slow-down / pause / recovery events are on screen in readable Korean and copy whole.
// Usage: HWP2X_EXECUTABLE=<packaged app> [HWP2X_SMOKE_HWP=<real .hwp>] [HWP2X_LOAD_FILES=300] xvfb-run -a node electron/auto-load-log-check.cjs
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
(async () => {
  const sample = path.resolve(process.env.HWP2X_SMOKE_HWP || '/tmp/hwp2x-real/공고문.hwp');
  const count = Number(process.env.HWP2X_LOAD_FILES || 300);
  const before = hash(await fs.readFile(sample));
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-autoload-'));
  const docs = path.join(temp, '문서');
  for (let i = 0; i < count; i++) {
    const dir = path.join(docs, `부서${i % 7}`);
    await fs.mkdir(dir, { recursive: true });
    await fs.copyFile(sample, path.join(dir, `공문-${String(i).padStart(4, '0')}.hwp`));
  }
  const app = await _electron.launch({
    ...(process.env.HWP2X_EXECUTABLE ? { executablePath: process.env.HWP2X_EXECUTABLE } : {}),
    args: ['--no-sandbox', ...(process.env.HWP2X_EXECUTABLE ? [] : ['.']), `--user-data-dir=${path.join(temp, 'profile')}`],
    // Lowered limits make the real slow-down and pause paths run on an ordinary machine; nothing else is faked.
    env: { ...process.env, HWP2X_TEST_HOOKS: '1', HWP2X_AUTO_ROOTS: JSON.stringify([docs]), HWP2X_START_ROOT: docs, HWP2X_TEST_SLOW_RSS_MB: '200', HWP2X_TEST_PAUSE_RSS_MB: '330' },
  });
  const errors = [];
  try {
    const page = await app.firstWindow();
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(20000);
    await page.waitForFunction(() => typeof window.hwp2x?.autoState === 'function');
    const auto = () => page.evaluate(() => window.hwp2x.autoState());
    await page.getByRole('button', { name: '전체 자동 변환', exact: true }).click();
    await page.getByRole('button', { name: '자동 변환 시작', exact: true }).click();
    const clicks = [];
    const started = Date.now();
    let state;
    for (let i = 0; ; i++) {
      state = await auto();
      if (state.phase === 'watching' && state.processed >= count) break;
      assert.notEqual(state.phase, 'error', state.message);
      assert.ok(Date.now() - started < 20 * 60 * 1000, '20분 안에 끝나야 함');
      const tab = ['설정', '파일', '전체 자동 변환'][i % 3];
      const t = performance.now();
      await page.getByRole('button', { name: new RegExp(`^${tab}`) }).first().click();
      clicks.push(performance.now() - t);
      await page.waitForTimeout(700);
    }
    const slowest = Math.max(...clicks);
    console.log(`자동 변환 ${state.processed}개 · ${Math.round((Date.now() - started) / 1000)}초 · 탭 전환 ${clicks.length}회 최대 ${Math.round(slowest)}ms`);
    assert.ok(slowest < 1000, `변환 중 탭 전환이 1초 안에 반응해야 함: ${slowest}`);
    // Let one more measurement tick land after the run.
    await page.waitForTimeout(11000);
    await page.getByRole('button', { name: '설정', exact: true }).click();
    await page.getByRole('button', { name: '상세 로그 로그 보기', exact: true }).click();
    const box = page.getByRole('textbox', { name: '로그 내용' });
    await box.waitFor();
    const shown = await box.inputValue();
    for (const [label, pattern] of [['측정값', /"요약":"자동 변환 상태 · 메모리 \d+MB · CPU \d+% · 화면 지연 \d+ms · 한컴 실행 \d+개/], ['감속', /"요약":"감속 · 메모리 \d+MB/], ['일시정지', /"요약":"일시정지 · /], ['복구', /"요약":"복구 · /]]) {
      assert.match(shown, pattern, `로그 보기에 ${label} 기록이 보여야 함`);
    }
    assert.equal((shown.match(/\uFFFD/g) || []).length, 0, '깨진 글자 없음');
    await app.evaluate(({ clipboard }) => clipboard.writeText(''));
    await page.getByRole('button', { name: '표시 범위 복사', exact: true }).click();
    await page.getByText(/클립보드에 복사했습니다/).waitFor();
    const copied = await app.evaluate(({ clipboard }) => clipboard.readText());
    assert.equal(copied.trim(), (await box.inputValue()).trim(), '복사한 내용 = 복사 후 화면 로그');
    const lines = copied.trim().split('\n').map(line => JSON.parse(line));
    const count2 = name => lines.filter(line => line.event === name).length;
    console.log(`로그 보기: 측정 ${count2('automatic.metrics')} · 감속 ${count2('automatic.throttle')} · 일시정지 ${count2('automatic.pause')} · 복구 ${count2('automatic.recovery')}`);
    console.log('예:', lines.filter(line => line.요약).slice(-3).map(line => line.요약).join(' | '));
    await page.screenshot({ path: path.join(temp, 'auto-load-log.png') });
    await page.getByRole('button', { name: '닫기', exact: true }).click();
    await page.getByRole('button', { name: /^전체 자동 변환/ }).first().click();
    await page.getByRole('button', { name: '자동 변환 중지', exact: true }).click();
    await page.waitForFunction(async () => !(await window.hwp2x.autoState()).enabled);
    assert.deepEqual(errors, []);
    assert.equal(hash(await fs.readFile(sample)), before, '원본 HWP 바뀌지 않음');
    console.log('통과');
  } finally {
    await app.close();
    console.log('스크린샷:', temp);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
