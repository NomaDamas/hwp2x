'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { runEvidence, ensureDisplay } = require('./common/evidence.cjs');
// page.waitForFunction treats an async predicate's Promise as truthy, so state waits poll from Node instead.
async function until(read, ok, page, timeout = 30000) {
  const deadline = Date.now() + timeout;
  for (;;) { const s = await read(); if (ok(s)) return s; if (Date.now() > deadline) throw Error(`상태 대기 시간 초과: ${s.phase} ${s.message || ''}`); await page.waitForTimeout(100); }
}
async function inspect({ app, page, evidence, capture }) {
  const click = async name => { await page.getByRole('button', { name, exact: true }).click(); evidence.actions.push({ type: 'click', name }); };
  const docs = evidence.isolatedPaths.docs;
  for (let i = 0; i < 102; i++) await fs.copyFile(evidence.source.path, path.join(docs, `목록 ${String(i).padStart(3, '0')}.hwp`));
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, docs);
  await click('폴더 선택');
  await until(() => page.evaluate(() => window.hwp2x.state()), s => s.total === 103, page);
  await click(/^파일\s*103$/);
  const search = page.getByRole('textbox', { name: '파일 이름 검색' });
  for (let pass = 0; pass < 2; pass++) {
    await search.fill('없는 파일');
    await page.getByText('해당하는 파일이 없습니다.', { exact: true }).waitFor();
    assert.equal(await search.evaluate(el => document.activeElement === el), true);
    await search.fill('목록 00');
    await page.getByRole('button', { name: /목록 000.hwp/ }).waitFor();
    for (const name of ['목록 000.hwp', '목록 001.hwp']) {
      await page.getByRole('button', { name: new RegExp(name.replace('.', '\\.')) }).click();
      evidence.actions.push({ type: 'click', name });
      await page.getByRole('button', { name: '상세 닫기' }).waitFor();
      assert.ok(await page.getByText(name, { exact: true }).count() >= 2, '선택한 파일이 상세에도 표시');
      await click('상세 닫기');
    }
    await search.fill('');
    await search.fill('목록');
    await search.evaluate(el => { el.focus(); el.setSelectionRange(1, 2); });
    await page.waitForTimeout(1200);
    assert.deepEqual(await search.evaluate(el => ({ focused: document.activeElement === el, value: el.value, start: el.selectionStart, end: el.selectionEnd })), { focused: true, value: '목록', start: 1, end: 2 }, '주기 갱신 중 입력과 선택 영역 유지');
    await search.fill('');
    await click('다음 페이지');
    await page.getByRole('button', { name: '이전 페이지' }).waitFor();
    await click('이전 페이지');
    evidence.observations.push({ label: `검색·선택변경·페이지 반복 ${pass + 1}`, state: await page.evaluate(() => window.hwp2x.state()) });
  }
  await capture('검색 선택 페이지 반복');
  await click('설정');
  const log = page.getByRole('button', { name: '상세 로그 로그 보기', exact: true });
  await log.click(); evidence.actions.push({ type: 'click', name: '상세 로그 로그 보기' });
  await page.getByRole('dialog', { name: '상세 로그' }).waitFor();
  await click('닫기');
  evidence.observations.push({ label: '설정 로그 확인창', focusReturned: await log.evaluate(el => document.activeElement === el) });
  assert.equal(evidence.observations.at(-1).focusReturned, true);
  await capture('설정');
  await realStates({ app, page, evidence, capture, click });
  evidence.limitations = ['상태는 실제 패키지 엔진 변환(정상 2개·손상 오류주입 1개)으로만 만듦; 상태 대역 없음', '자동 재작업·원본 백업 실행·복구 상태는 이 검사에서 만들지 않음(백업 확인창 열고 취소만) — automatic/cleanup 검사 증거로 별도 확인', '네이티브 폴더 선택 반환만 격리 경로로 대체', '119개 전체 조작 항목은 이 검사로 검증되지 않음'];
}
async function realStates({ app, page, evidence, capture, click }) {
  const root = path.join(evidence.directory, '상태 검사');
  const deep = path.join(root, ...Array.from({ length: 8 }, (_, i) => `아주 긴 한글 하위 폴더 이름 공백 포함 ${i}`));
  await fs.mkdir(deep, { recursive: true });
  const bytes = await fs.readFile(evidence.source.path);
  const longName = `긴 파일 이름 ${'가나다라마바사 '.repeat(6)}끝.hwp`;
  await fs.writeFile(path.join(deep, longName), bytes, { flag: 'wx' });
  await fs.writeFile(path.join(root, '정상 문서.hwp'), bytes, { flag: 'wx' });
  await fs.writeFile(path.join(root, '손상 오류주입.hwp'), bytes.subarray(0, 24), { flag: 'wx' });
  evidence.inputs.push({ path: path.join(root, '손상 오류주입.hwp'), sha256: require('node:crypto').createHash('sha256').update(bytes.subarray(0, 24)).digest('hex'), bytes: 24, errorInjection: true });
  const state = () => page.evaluate(() => window.hwp2x.state({ limit: 200 }));
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, root);
  evidence.actions.push({ type: 'native-dialog-return', path: root });
  await click('특정 폴더 변환');
  await click('폴더 선택');
  await until(state, s => s.root === root && s.phase === 'idle' && s.total === 3, page);
  await click('3개 파일 변환');
  const done = await until(state, s => s.phase === 'done', page, 180000);
  evidence.observations.push({ label: '실제 변환 완료 상태', counts: done.counts, files: done.files.map(f => ({ name: f.name, dir: f.dir, status: f.status, message: f.message })) });
  assert.equal(done.counts.fail, 1, `실패 1개 기대: ${done.phase} ${done.message}`); assert.equal(done.counts.ok + (done.counts.diff || 0), 2);
  await click(/^파일\s*3$/);
  const filter = name => page.getByRole('button', { name: new RegExp(`^${name}\\s*\\d+$`) });
  const visibleNames = () => page.locator('[role=button][tabindex="0"]').evaluateAll(els => els.map(el => el.querySelector('span[title]')?.getAttribute('title')).filter(Boolean));
  const expectFilter = async (name, expected) => {
    await filter(name).click(); evidence.actions.push({ type: 'click', name: `필터 ${name}` });
    await page.waitForFunction(n => [...document.querySelectorAll('[aria-pressed=true]')].some(el => el.textContent.startsWith(n)), name);
    await page.waitForFunction(count => document.querySelectorAll('[role=button][tabindex="0"] span[title]:first-child').length === count, expected.length);
    assert.deepEqual((await visibleNames()).sort(), expected.slice().sort(), `필터 ${name} 목록`);
    assert.equal(await page.locator('[aria-pressed=true]').count(), 1, '눌린 필터는 하나');
  };
  const okNames = done.files.filter(f => f.status !== 'fail').map(f => f.name), all = done.files.map(f => f.name);
  const okLabel = done.counts.ok === 2 ? '변환됨' : null;
  for (let pass = 0; pass < 2; pass++) {
    await expectFilter('실패', ['손상 오류주입.hwp']);
    if (okLabel) await expectFilter(okLabel, okNames);
    await expectFilter('전체', all);
    for (const file of [done.files.find(f => f.status === 'fail'), done.files.find(f => f.name === longName)]) {
      await page.getByRole('button').filter({ has: page.locator(`span[title="${file.name}"]`) }).click();
      evidence.actions.push({ type: 'click', name: file.name });
      const detail = page.getByRole('region', { name: '파일 상세' });
      await detail.getByText(file.name, { exact: true }).waitFor();
      await detail.getByText(file.dir, { exact: true }).waitFor();
      if (file.status === 'fail') await detail.getByText(file.message, { exact: true }).waitFor();
      evidence.observations.push({ label: `상세 대상 일치 ${pass + 1}`, name: file.name, dir: file.dir, status: file.status });
    }
    await capture(`실제 상태 필터 상세 ${pass + 1}`);
  }
  // Detail still shows the long-path file; judge clipping at larger text.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1.5));
  await page.waitForTimeout(300);
  const clip = await page.evaluate(() => {
    const els = [...document.querySelectorAll('body *')].filter(el => el.children.length === 0 && el.getClientRects().length && (el.textContent || '').trim());
    const clipped = els.filter(el => el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX === 'hidden');
    const region = document.querySelector('[role=region][aria-label="파일 상세"]');
    return {
      zoom: devicePixelRatio,
      hiddenWithoutFullText: clipped.filter(el => el.getAttribute('title') !== el.textContent).map(el => el.textContent.slice(0, 80)),
      clippedWithTitle: clipped.filter(el => el.getAttribute('title') === el.textContent).length,
      detailClipped: region ? [...region.querySelectorAll('*')].filter(el => el.children.length === 0 && el.scrollWidth > el.clientWidth + 1 && getComputedStyle(el).overflowX !== 'auto').map(el => el.textContent.slice(0, 80)) : null,
      pageOverflow: document.documentElement.scrollWidth > innerWidth,
    };
  });
  evidence.observations.push({ label: '큰글자 150% 긴경로 잘림 판정', ...clip });
  await capture('큰글자 긴경로 상세');
  assert.deepEqual(clip.hiddenWithoutFullText, [], '잘린 글자에 전체 텍스트(title) 없음');
  assert.deepEqual(clip.detailClipped, [], '상세의 이름·경로는 잘리면 안 됨');
  assert.equal(clip.pageOverflow, false, '창 가로 넘침');
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  await click('상세 닫기');
  await click(/^원본 백업/);
  const dialogBox = page.getByRole('dialog');
  await dialogBox.waitFor();
  evidence.observations.push({ label: '실제 완료 상태의 원본 백업 확인창(실행 안 함)', text: (await dialogBox.innerText()).slice(0, 400) });
  await dialogBox.getByRole('button', { name: '취소', exact: true }).click(); evidence.actions.push({ type: 'click', name: '취소' });
  await dialogBox.waitFor({ state: 'detached' });
  assert.equal((await fs.readdir(root)).includes('정상 문서.hwp'), true, '취소 후 원본 유지');
}
if (!process.argv.includes('--packaged')) { console.error('--packaged 필수'); process.exitCode = 1; }
else if (!ensureDisplay(__filename)) (async () => {
  const result = await runEvidence('gui-controls-check', inspect);
  if (!result.passed) return;
  const { spawnSync } = require('node:child_process');
  for (const script of ['automatic-check.cjs', 'cleanup-check.cjs']) {
    const run = spawnSync(process.execPath, [path.join(__dirname, script), '--packaged'], { stdio: 'inherit', env: process.env, timeout: 300000 });
    if (run.error || run.status !== 0) throw Error(`${script}: 실제 상태 GUI 검사 실패 ${run.error?.message || run.status}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
