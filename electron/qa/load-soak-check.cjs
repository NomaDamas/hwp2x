'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { performance } = require('node:perf_hooks');
const { runEvidence, ensureDisplay } = require('./common/evidence.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const limits = Object.freeze({ rows: 100, interactionMs: 1000, frameMs: 300, rssBytes: 32 * 1024 * 1024, handles: 4, watchers: 0, cpuPercent: 5, ipcBytes: 4096 });
function growth(values, allowance) {
  assert.ok(values.length >= 20 && values.every(Number.isFinite), '20개 이상 유효 표본 필요');
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const delta = mean(values.slice(-5)) - mean(values.slice(0, 5));
  const center = (values.length - 1) / 2;
  const slope = values.reduce((sum, v, i) => sum + (i - center) * (v - mean(values)), 0) / values.reduce((sum, _, i) => sum + (i - center) ** 2, 0);
  return { delta, slope, allowance, failed: delta > allowance && slope > 0 };
}
async function until(check, label, timeout = 90000) {
  const end = performance.now() + timeout;
  do { if (await check()) return; await sleep(25); } while (performance.now() < end);
  throw Error(`시간 초과: ${label}`);
}
function parse(args) {
  const result = { files: 3000, cycles: 20 };
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (key === '--packaged') result.packaged = true;
    else if (['--real-hwp', '--files', '--cycles'].includes(key)) {
      assert.ok(args[i + 1] && !args[i + 1].startsWith('--'), `${key} 값 필요`);
      result[key === '--real-hwp' ? 'source' : key.slice(2)] = key === '--real-hwp' ? args[++i] : Number(args[++i]);
    } else throw Error(`지원하지 않는 인자: ${key}`);
  }
  assert.ok(result.packaged && result.source, '--packaged --real-hwp 필수');
  assert.ok(Number.isSafeInteger(result.files) && result.files >= 3000, '--files 최소 3000');
  assert.ok(Number.isSafeInteger(result.cycles) && result.cycles >= 20, '--cycles 최소 20');
  return result;
}
async function resources(app, page) {
  const processes = await app.evaluate(({ app }) => app.getAppMetrics().map(p => ({ pid: p.pid, type: p.type, cpu: p.cpu.percentCPUUsage, rss: p.memory.workingSetSize * 1024 })));
  assert.ok(processes.length >= 2, '주프로세스와 렌더러 계측 필요');
  let handles = 0, watchers = 0;
  for (const process of processes) {
    const descriptors = await fs.readdir(`/proc/${process.pid}/fdinfo`);
    handles += descriptors.length;
    for (const descriptor of descriptors) {
      try { watchers += ((await fs.readFile(`/proc/${process.pid}/fdinfo/${descriptor}`, 'utf8')).match(/^inotify wd:/gm) || []).length; }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }
  const payloads = await page.evaluate(async () => ({ state: await window.hwp2x.state({ limit: 100 }), automatic: await window.hwp2x.autoState(), issues: await window.hwp2x.autoIssues({ limit: 100 }) }));
  const ipcSizes = Object.fromEntries(Object.entries(payloads).map(([name, value]) => [name, Buffer.byteLength(JSON.stringify(value), 'utf8')]));
  return { processes, rssBytes: processes.reduce((n, p) => n + p.rss, 0), cpuPercent: processes.reduce((n, p) => n + p.cpu, 0), handles, watchers, ipcBytes: Object.values(ipcSizes).reduce((a, b) => a + b, 0), ipcSizes };
}
async function inspect(context, config) {
  const { app, page, evidence, capture } = context;
  const recordFailure = message => evidence.failures.push(message);
  await page.evaluate(() => {
    window.__loadSoakClicks = [];
    document.addEventListener('click', event => {
      window.__loadSoakClicks.push({ at: Date.now(), trusted: event.isTrusted, label: event.target.closest('button')?.textContent?.trim() || '' });
    }, true);
  });
  const click = async name => { await page.getByRole('button', { name, exact: true }).click(); evidence.actions.push({ type: 'click', name: String(name) }); };
  const timed = async (name, action, ready) => {
    const eventStart = Date.now();
    const beforeClicks = await page.evaluate(() => window.__loadSoakClicks.length);
    const start = performance.now(); await action();
    const actionEnded = performance.now(); await ready();
    const ended = performance.now();
    const ms = ended - start;
    evidence.observations.push({ type: 'interaction', name, ms, actionMs: actionEnded - start, resultWaitMs: ended - actionEnded });
    const clicks = await page.evaluate(before => window.__loadSoakClicks.slice(before), beforeClicks);
    evidence.observations.push({ type: 'click-delivery', name, events: clicks, deliveryMs: clicks.length ? clicks[0].at - eventStart : null });
    if (ms > limits.interactionMs) recordFailure(`${name}: ${ms.toFixed(2)}ms > 1000ms`);
  };
  await page.evaluate(() => {
    window.__loadSoak = { max: 0, frames: 0, last: performance.now() };
    const tick = now => { const s = window.__loadSoak; s.max = Math.max(s.max, now - s.last); s.last = now; s.frames++; s.raf = requestAnimationFrame(tick); };
    window.__loadSoak.raf = requestAnimationFrame(tick);
  });
  const rows = () => page.locator('[role="button"][tabindex="0"] span[title]').evaluateAll(elements => elements.map(el => el.getAttribute('title')).filter(name => name.endsWith('.hwp')));
  const waitRows = expected => until(async () => { const actual = await rows(); return actual.length === expected.length && expected.every(name => actual.includes(name)); }, '실제 DOM 행 일치', 15000);
  try {
    for (const count of [...new Set([1000, config.files])]) {
      const root = path.join(evidence.directory, `목록-${count}`); await fs.mkdir(root);
      for (let i = 0; i < count; i++) await fs.copyFile(evidence.source.path, path.join(root, `문서-${String(i).padStart(5, '0')}.hwp`), fs.constants.COPYFILE_EXCL);
      evidence.observations.push({ type: 'dataset', count, root, independentRealDocuments: 1, realHwpCopies: count, syntheticDocuments: 0, sha256: evidence.source.beforeHash });
      // Real scan IPC selects only an isolated directory; no dialog or GUI state replacement.
      await page.evaluate(root => window.hwp2x.scan(root), root);
      evidence.actions.push({ type: 'real-ipc', method: 'scan', root });
      const state = await page.evaluate(() => window.hwp2x.state({ limit: 100 })); assert.equal(state.total, count);
      const first = state.files.map(f => f.name);
      const second = await page.evaluate(async () => (await window.hwp2x.state({ limit: 100, offset: 100 })).files.map(f => f.name));
      await timed(`목록 ${count}`, () => click(/^파일(?:\s*\d+)?$/), () => waitRows(first));
      await timed(`다음 페이지 ${count}`, () => click('다음 페이지'), () => waitRows(second));
      await timed(`이전 페이지 ${count}`, () => click('이전 페이지'), () => waitRows(first));
      const search = page.getByRole('textbox', { name: '파일 이름 검색', exact: true });
      await timed(`검색 ${count}`, () => search.fill(first[0]), () => waitRows([first[0]]));
      await timed(`검색 해제 ${count}`, () => search.fill(''), () => waitRows(first));
      assert.ok((await rows()).length <= limits.rows);
      await capture(`${count} 실제 HWP 복사본 목록`);
      await click('특정 폴더 변환');
      await click(new RegExp(`^${count}개 파일 변환$`));
      await page.getByRole('button', { name: '일시정지', exact: true }).waitFor();
      await timed(`작업 취소 ${count}`, () => click('중지'), () => until(async () => (await page.evaluate(() => window.hwp2x.state({ limit: 1 }))).phase === 'stopped', '중지 완료', 30000));
      for (let i = 0; i < count; i++) {
        const source = path.join(root, `문서-${String(i).padStart(5, '0')}.hwp`);
        const digest = require('node:crypto').createHash('sha256').update(await fs.readFile(source)).digest('hex');
        assert.equal(digest, evidence.source.beforeHash, `변환 중지 후 원본 복사본 보존: ${source}`);
      }
      evidence.observations.push({ type: 'source-copies-preserved', count, sha256: evidence.source.beforeHash });
    }
    await click('전체 자동 변환');
    const auto = () => page.evaluate(() => window.hwp2x.autoState());
    const issue = () => page.evaluate(async () => (await window.hwp2x.autoIssues()).items.find(item => item.name === '손상 재작업.hwp'));
    await click('자동 변환 시작');
    await until(async () => (await auto()).phase === 'watching' && (await issue())?.status === 'failed', '초기 실제 감시');
    evidence.samples = []; evidence.warmup = [];
    for (let cycle = -3; cycle < config.cycles; cycle++) {
      const previous = await issue();
      await timed(`재작업 ${cycle}`, () => click('손상 재작업.hwp 다시 작업'), () => until(async () => { const next = await issue(); return next?.attempts > previous.attempts && next.status === 'failed'; }, '재작업 실제 실패 완료'));
      await until(async () => (await auto()).phase === 'watching', '재작업 후 감시');
      const watching = await resources(app, page);
      await timed(`감시 중지 ${cycle}`, () => click('자동 변환 중지'), () => until(async () => !(await auto()).enabled, '감시 중지'));
      await sleep(250);
      const stopped = await resources(app, page);
      await timed(`감시 재개 ${cycle}`, () => click('자동 변환 시작'), () => until(async () => (await auto()).phase === 'watching', '감시 재개'));
      await sleep(250);
      const sample = { cycle, watching, stopped, resumed: await resources(app, page) };
      (cycle < 0 ? evidence.warmup : evidence.samples).push(sample);
    }
    evidence.growth = [];
    for (const phase of ['watching', 'stopped', 'resumed']) for (const metric of ['rssBytes', 'cpuPercent', 'handles', 'watchers', 'ipcBytes']) {
      const result = { phase, metric, ...growth(evidence.samples.map(s => s[phase][metric]), limits[metric]) };
      evidence.growth.push(result); if (result.failed) recordFailure(`지속증가: ${JSON.stringify(result)}`);
    }
    await capture('워밍업 3회 이후 실제 20회 감시 재작업 중지 재개');
    await click('자동 변환 중지');
  } finally {
    const frames = await page.evaluate(() => { const s = window.__loadSoak; cancelAnimationFrame(s.raf); return { max: Math.max(s.max, performance.now() - s.last), frames: s.frames }; });
    evidence.observations.push({ type: 'animation-frames', ...frames });
    if (!frames.frames || frames.max > limits.frameMs) recordFailure(`프레임 최대 ${frames.max}ms > 300ms 또는 표본 없음`);
  }
}
async function main() {
  if (process.argv.slice(2).join(' ') === '--self-test') {
    assert.equal(growth(Array(20).fill(100), 0).failed, false);
    assert.equal(growth(Array.from({ length: 20 }, (_, i) => i), 0).failed, true);
    assert.equal(growth(Array.from({ length: 20 }, (_, i) => 20 - i), 0).failed, false);
    assert.equal(growth(Array.from({ length: 20 }, (_, i) => i), 15).failed, false);
    assert.throws(() => growth([NaN], 0));
    assert.throws(() => parse(['--packaged', '--real-hwp', 'x', '--cycles', '19']));
    assert.equal(parse(['--packaged', '--real-hwp', '한글 공백.hwp']).files, 3000);
    console.log('SELF_TEST_PASS: growth 경계·증가·감소·누락·인수 검사'); return;
  }
  const config = parse(process.argv.slice(2));
  process.env.HWP2X_SAMPLE = path.resolve(config.source);
  if (ensureDisplay(__filename)) return;
  assert.equal(process.platform, 'linux', 'fdinfo 기반 자원 계측은 Linux 전용');
  await runEvidence('load-soak', context => inspect(context, config), async (evidence, options) => {
    evidence.limits = limits;
    evidence.methodology = { sustainedGrowth: '워밍업 3회 제외; 동일 상태의 마지막5회 평균-처음5회 평균이 허용량 초과이고 전체 최소제곱 기울기>0이면 실패', handles: 'Electron app.getAppMetrics 전체 PID의 /proc/PID/fdinfo 개수', watchers: '동일 PID fdinfo inotify wd 등록 수', cpu: 'Electron 전체 PID percentCPUUsage 합계, 동일 상태 표본', rss: 'Electron 전체 PID workingSetSize 합계 bytes', ipc: '실제 state(limit100)/autoState/autoIssues(limit100) 응답 JSON UTF-8 bytes 합계; 전송 봉투 및 전체 이벤트 트래픽 미포함', input: '실제 원본 1종의 1000/3000 격리 복사본; 재작업만 별도 손상 합성 HWP', boundaries: 'scan IPC 실제 호출로 격리 목록 준비; 모든 페이지검색중지재작업재개는 실제 GUI. 상태 대역 없음' };
    const invalid = path.join(evidence.isolatedPaths.docs, '손상 재작업.hwp'); await fs.writeFile(invalid, 'deliberately invalid HWP', { flag: 'wx' });
    options.env.HWP2X_TEST_HOOKS = '1'; options.env.HWP2X_AUTO_ROOTS = JSON.stringify([evidence.isolatedPaths.docs]);
    evidence.syntheticInputs = [{ path: invalid, purpose: '실제 변환 실패 및 재작업 반복', synthetic: true }];
  });
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { growth, parse };
