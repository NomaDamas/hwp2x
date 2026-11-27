// Real packaged window, real HWP copies: each converted file shows its text match % with a colour band in the file
// list and the detail panel; a finished 특정 폴더 변환 jumps to the 파일 screen; pressing 특정 폴더 변환 there opens the
// folder-picking first screen. Done twice with different folders (the bands change between them), plus a document
// with no text, an unreadable file, a stopped run and a folder with nothing to convert. Originals stay byte-identical.
// Usage: HWP2X_EXECUTABLE=<packaged app> HWP2X_SAMPLE_DIR=<folder of real .hwp> xvfb-run -a node electron/text-match-check.cjs
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const hash = async file => crypto.createHash('sha256').update(await fs.readFile(file)).digest('hex');
const SAMPLES = process.env.HWP2X_SAMPLE_DIR || '/home/cheol/tools/rhwp';
// Real public documents whose built-in conversion keeps nearly all text (green), most (amber) or clearly less (red),
// and one with no text at all. The band of each was measured, not assumed; the check reads it from the screen.
const picks = {
  green: ['rhwp-studio/public/samples/basic/KTX.hwp', 'samples/exam-kor-1p.hwp'],
  amber: ['samples/math-001.hwp', 'samples/80250_regulatory_analysis.hwp'],
  red: ['rhwp-studio/public/samples/field-01.hwp', 'rhwp-studio/public/samples/BlogForm_BookReview.hwp'],
  empty: ['saved/blank2010.hwp'],
};
const bandColor = { green: 'rgb(19, 116, 78)', amber: 'rgb(138, 92, 5)', red: 'rgb(168, 48, 42)', empty: 'rgb(91, 95, 102)' };

(async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-textmatch-'));
  const originals = [];
  const folder = async (name, entries) => {
    const dir = path.join(temp, name);
    await fs.mkdir(dir, { recursive: true });
    for (const [file, from] of entries) {
      const to = path.join(dir, file);
      if (Buffer.isBuffer(from)) await fs.writeFile(to, from); else await fs.copyFile(path.join(SAMPLES, from), to);
      originals.push([to, await hash(to)]);
    }
    return dir;
  };
  const first = await folder('첫째 폴더', [['초록-KTX.hwp', picks.green[0]], ['주황-수식.hwp', picks.amber[0]], ['빨강-누름틀.hwp', picks.red[0]], ['빈문서.hwp', picks.empty[0]], ['손상.hwp', Buffer.from('this is not a HWP file')]]);
  const second = await folder('둘째 폴더', [['초록-시험지.hwp', picks.green[1]], ['주황-규제분석.hwp', picks.amber[1]], ['빨강-서평.hwp', picks.red[1]]]);
  const empty = await folder('빈 폴더', []);
  const stopDir = await folder('중지 폴더', Array.from({ length: 30 }, (_, i) => [`문서-${i}.hwp`, picks.green[1]]));
  const app = await _electron.launch({
    ...(process.env.HWP2X_EXECUTABLE ? { executablePath: process.env.HWP2X_EXECUTABLE } : {}),
    args: ['--no-sandbox', ...(process.env.HWP2X_EXECUTABLE ? [] : ['.']), `--user-data-dir=${path.join(temp, 'profile')}`],
    env: { ...process.env, HWP2X_START_ROOT: temp },
  });
  const errors = [];
  try {
    const page = await app.firstWindow();
    await page.setViewportSize({ width: 1240, height: 860 });
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(20000);
    const state = () => page.evaluate(() => window.hwp2x.state());
    const until = async (test, label, tries = 600) => { for (let i = 0; i < tries; i++) { const s = await state(); if (test(s)) return s; await page.waitForTimeout(100); } throw new Error(`시간 초과: ${label}`); };
    const pick = dir => app.evaluate(({ dialog }, d) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [d] }); }, dir);
    const nav = name => page.getByRole('button', { name: new RegExp(`^${name}`) }).first();
    const onFiles = () => page.getByPlaceholder('파일 이름 검색').count().then(n => n > 0);
    // The status pill is the last column of the row: its text is the label, its colour the band.
    const badge = name => page.locator('[role="button"][tabindex="0"]').filter({ has: page.locator(`span[title="${name}"]`) }).locator(':scope > div').last().locator('span').first();
    await page.waitForFunction(() => typeof window.hwp2x?.state === 'function');

    const runFolder = async (dir, expect, label) => {
      // First screen: pick the folder and convert, then the screen moves to 파일 by itself at 100%.
      await nav('특정 폴더 변환').click();
      await page.getByRole('button', { name: '폴더 선택', exact: true }).first().waitFor();
      assert.equal(await onFiles(), false, `${label}: 특정 폴더 변환은 폴더 선택 첫 화면`);
      await pick(dir);
      await page.getByRole('button', { name: '폴더 선택', exact: true }).first().click();
      await until(s => s.root === dir && s.phase === 'idle', `${label} 검색`);
      await page.getByRole('button', { name: /^\d+개 파일 변환$/ }).click();
      await until(s => s.phase === 'done', `${label} 완료`);
      for (let i = 0; i < 40 && !(await onFiles()); i++) await page.waitForTimeout(100);
      assert.equal(await onFiles(), true, `${label}: 100% 뒤 파일 화면으로 넘어감`);
      const seen = {};
      for (const [name, band] of Object.entries(expect)) {
        const b = badge(name);
        await b.waitFor();
        const text = (await b.innerText()).trim(), colour = await b.evaluate(el => getComputedStyle(el).color);
        seen[name] = `${text} · ${band}`;
        if (band === 'fail') { assert.equal(text, '실패', `${name}: ${text}`); continue; }
        if (band === 'empty') assert.equal(text, '비교할 글자 없음', `${name}: ${text}`);
        else {
          const m = /^글자 (\d+(?:\.\d)?)%$/.exec(text); assert.ok(m, `${name}: 퍼센트가 보여야 함 (${text})`);
          const pct = Number(m[1]);
          assert.ok(band === 'green' ? pct >= 98 : band === 'amber' ? pct >= 90 && pct < 98 : pct < 90, `${name}: ${pct}% 는 ${band} 구간이어야 함`);
        }
        assert.equal(colour, bandColor[band], `${name}: ${band} 색 (${colour})`);
      }
      // Detail panel: the same % with its colour under 확인 항목 (a two-column grid row: label span, value span).
      const [detailName, detailBand] = Object.entries(expect).find(([, band]) => band !== 'fail' && band !== 'empty');
      await page.locator(`span[title="${detailName}"]`).first().click();
      const region = page.getByRole('region', { name: '파일 상세' });
      await region.waitFor();
      const value = region.locator('span', { hasText: /^글자 일치율$/ }).locator('xpath=following-sibling::span[1]');
      assert.match(await value.innerText(), /^\d+(\.\d)?% 같음$|^비교할 글자 없음$/);
      assert.equal(await value.evaluate(el => getComputedStyle(el).color), bandColor[detailBand], `${detailName}: 상세 색`);
      await page.screenshot({ path: path.join(temp, `${label}.png`) });
      console.log(`${label}: 완료 → 파일 화면 자동 이동 · ${Object.values(seen).join(' | ')} · 상세 ${await value.innerText()}`);
    };

    await runFolder(first, { '초록-KTX.hwp': 'green', '주황-수식.hwp': 'amber', '빨강-누름틀.hwp': 'red', '빈문서.hwp': 'empty', '손상.hwp': 'fail' }, '1회차');
    await runFolder(second, { '초록-시험지.hwp': 'green', '주황-규제분석.hwp': 'amber', '빨강-서평.hwp': 'red' }, '2회차');

    // Settings and saving the result still work after the change.
    await nav('설정').click();
    await page.getByRole('button', { name: '상세 로그 로그 보기', exact: true }).waitFor();
    const report = path.join(temp, '결과.json');
    await app.evaluate(({ dialog }, file) => { dialog.showSaveDialog = async () => ({ canceled: false, filePath: file }); }, report);
    assert.equal(await page.evaluate(() => window.hwp2x.saveReport()), true);
    const saved = JSON.parse(await fs.readFile(report, 'utf8'));
    assert.ok(saved.files.every(file => file.status !== 'ok' && file.status !== 'diff' || file.textMatch), '결과 저장 파일에 일치율 포함');
    console.log(`설정 화면 정상 · 결과 저장: ${saved.files.map(file => `${file.name} ${file.textMatch?.percent ?? '-'}%`).join(', ')}`);

    // Nothing to convert: stays on the first screen, no jump.
    await nav('특정 폴더 변환').click();
    await pick(empty);
    await page.getByRole('button', { name: '폴더 선택', exact: true }).first().click();
    await until(s => s.root === empty, '빈 폴더 검색');
    await page.getByRole('button', { name: /검색 후 변환|\d+개 파일 변환/ }).first().click().catch(() => undefined);
    await page.waitForTimeout(800);
    assert.equal(await onFiles(), false, '빈 폴더는 첫 화면에 머묾');
    assert.equal((await state()).total, 0);
    console.log('빈 폴더: 변환할 파일 0개, 첫 화면 유지');

    // Stopped run: no jump to 파일; 특정 폴더 변환 menu opens the first screen again.
    await page.evaluate(() => window.hwp2x.configure({ workers: 1 }));
    await pick(stopDir);
    await page.getByRole('button', { name: '폴더 선택', exact: true }).first().click();
    await until(s => s.root === stopDir && s.total === 30, '중지 폴더 검색');
    await page.getByRole('button', { name: '30개 파일 변환', exact: true }).click();
    await until(s => s.completed >= 2, '일부 변환');
    await page.getByRole('button', { name: '중지', exact: true }).click();
    await until(s => s.phase === 'stopped', '중지');
    await page.waitForTimeout(1200);
    assert.equal(await onFiles(), false, '중지는 파일 화면으로 넘기지 않음');
    await nav('파일').click();
    await nav('특정 폴더 변환').click();
    await page.getByRole('button', { name: '폴더 선택', exact: true }).first().waitFor();
    assert.equal(await page.getByRole('button', { name: '이 폴더 다시 변환', exact: true }).count(), 0, '중지 후 메뉴는 첫 화면');
    console.log(`중지: ${(await state()).completed}개 처리 후 진행 화면 유지, 메뉴로 첫 화면`);

    assert.deepEqual(errors, []);
    for (const [file, digest] of originals) assert.equal(await hash(file), digest, `원본 그대로: ${file}`);
    console.log(`원본 ${originals.length}개 해시 그대로 · 통과`);
  } finally {
    await app.close();
    console.log('스크린샷:', temp);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
