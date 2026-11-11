'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { runEvidence, ensureDisplay } = require('./common/evidence.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 90000) {
  const started = Date.now();
  while (Date.now() - started < timeout) { if (await check()) return Date.now() - started; await sleep(100); }
  throw Error(`시간 초과: ${label} (${timeout}ms)`);
}
async function exists(file) { try { await fs.access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
let roots, failed, previousProfile;
async function prepare(evidence, options) {
  assert.ok(options?.env, '공통 도우미가 실제 launch options를 전달해야 합니다');
  roots = [evidence.isolatedPaths.docs, path.join(evidence.directory, '다른 위치'), path.join(evidence.directory, '분리된 위치')];
  await fs.mkdir(roots[1]);
  await fs.copyFile(evidence.source.path, path.join(roots[1], '두번째.hwp'));
  failed = path.join(roots[1], '손상 문서.hwp');
  await fs.writeFile(failed, Buffer.from('actual invalid HWP bytes'));
  options.env.HWP2X_TEST_HOOKS = '1';
  options.env.HWP2X_AUTO_ROOTS = JSON.stringify(roots);
  evidence.isolation = { roots, hooks: ['automatic roots only'], syntheticConversion: false };
}
async function inspect({ page, evidence, capture }) {
  const auto = () => page.evaluate(() => window.hwp2x.autoState());
  const issues = () => page.evaluate(() => window.hwp2x.autoIssues());
  const click = async name => { await page.getByRole('button', { name, exact: true }).click(); evidence.actions.push({ type: 'click', name }); };
  await click('전체 자동 변환');
  await click('자동 변환 시작');
  const output = async source => {
    const file = source.replace(/\.hwp$/i, '.hwpx');
    await until(() => exists(file), file);
    await execFile('python3', ['-c', 'import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert "Contents/header.xml" in z.namelist(); assert any(n.startswith("Contents/section") and n.endswith(".xml") for n in z.namelist())', file]);
    evidence.outputs.push({ path: file, bytes: (await fs.stat(file)).size });
    return file;
  };
  const originalOutput = await output(evidence.inputs[0].path);
  await output(path.join(roots[1], '두번째.hwp'));
  await until(async () => (await auto()).phase === 'watching', '감시 전환');
  await until(async () => (await issues()).items.some(item => item.source === failed), '실제 손상 입력 실패');
  await capture('복수 실제 HWP 변환과 미처리 사유');
  for (const attempts of [2, 3]) {
    await click('손상 문서.hwp 다시 작업');
    await until(async () => (await issues()).items.find(item => item.source === failed)?.attempts === attempts, `실패 재작업 ${attempts - 1}`);
    const issue = (await issues()).items.find(item => item.source === failed);
    assert.equal(issue.status, 'failed'); assert.ok(issue.reason); assert.ok(issue.message);
    evidence.observations.push({ type: 'retry', issue });
    await capture(`재작업 ${attempts - 1}회 실패 사유`);
  }
  for (const call of ['scan', 'start', 'configure', 'retry', 'backup']) {
    const result = await page.evaluate(async ({ call, root }) => {
      try { await window.hwp2x[call](call === 'scan' ? root : call === 'configure' ? { workers: 1 } : call === 'backup' ? true : 1); return ''; }
      catch (error) { return String(error); }
    }, { call, root: roots[0] });
    assert.match(result, /자동/); evidence.observations.push({ type: 'manual-rejected', call, result });
  }
  await fs.mkdir(roots[2]);
  const added = path.join(roots[2], '재연결 추가.hwp');
  let start = Date.now(); await fs.copyFile(evidence.source.path, added);
  await output(added);
  const addedMs = Date.now() - start;
  assert.ok(addedMs < 90000, `재연결 발견 및 변환 ${addedMs}ms`);
  const fixed = failed;
  start = Date.now(); await fs.copyFile(evidence.source.path, fixed);
  await output(fixed);
  await until(async () => !(await issues()).items.some(item => item.source === fixed), '변경된 실패 파일 해결');
  evidence.observations.push({ type: 'watch-detection', addedMs, changedMs: Date.now() - start, note: '30초 재검색 + 1초 안정화 + 실제 변환 시간; 총 90초 검사 제한' });
  console.log(JSON.stringify({ actualWatchTiming: evidence.observations.at(-1), retryAttempts: [2, 3], retryInput: '실제 GUI 버튼' }));
  // A second real invalid file remains pending for restart verification.
  failed = path.join(roots[1], '재시작 미처리.hwp');
  await fs.writeFile(failed, 'invalid persisted HWP');
  await until(async () => (await issues()).items.some(item => item.source === failed), '재시작용 실제 미처리');
  const preserved = await fs.readFile(originalOutput);
  await click('자동 변환 중지');
  await click('자동 변환 시작');
  await until(async () => (await auto()).phase === 'watching', '기존 출력 재검색');
  assert.deepEqual(await fs.readFile(originalOutput), preserved);
  assert.equal((await issues()).total, 1);
  await capture('기존 출력 보존과 감시');
  await click('자동 변환 중지');
  previousProfile = evidence.profile;
  evidence.observations.push({ type: 'final', automatic: await auto(), issues: await issues() });
}
async function restartPrepare(evidence, options) {
  assert.ok(options?.env);
  await fs.cp(previousProfile, evidence.profile, { recursive: true });
  options.env.HWP2X_TEST_HOOKS = '1'; options.env.HWP2X_AUTO_ROOTS = JSON.stringify(roots);
}
async function restartInspect({ page, evidence, capture }) {
  const issues = await page.evaluate(() => window.hwp2x.autoIssues());
  assert.equal(issues.total, 1); assert.equal(issues.items[0].source, failed); assert.equal(issues.items[0].attempts, 1);
  await page.getByRole('button', { name: '전체 자동 변환', exact: true }).click();
  evidence.actions.push({ type: 'click', name: '전체 자동 변환' });
  await page.getByRole('button', { name: '자동 변환 시작', exact: true }).click();
  evidence.actions.push({ type: 'click', name: '자동 변환 시작' });
  await until(async () => (await page.evaluate(() => window.hwp2x.autoState())).phase === 'watching', '재시작 감시');
  assert.deepEqual(await page.evaluate(() => window.hwp2x.autoIssues()), issues);
  evidence.observations.push({ type: 'restart-without-loss-or-duplicate', issues });
  await capture('재시작 미처리 보존');
  await page.evaluate(() => window.hwp2x.autoStop());
}
async function main() {
  assert.ok(process.argv.includes('--packaged'), '--packaged 필수');
  const first = await runEvidence('automatic', inspect, prepare);
  if (first.passed) await runEvidence('automatic-restart', restartInspect, restartPrepare);
  await runEvidence('automatic-empty-permission', async ({ page, evidence, capture }) => {
    const denied = evidence.denied;
    try {
      await assert.rejects(fs.readdir(denied), { code: 'EACCES' });
      for (const name of ['전체 자동 변환', '자동 변환 시작']) {
        await page.getByRole('button', { name, exact: true }).click();
        evidence.actions.push({ type: 'click', name });
      }
      await until(async () => (await page.evaluate(() => window.hwp2x.autoState())).phase === 'watching', '빈 검색과 접근 거부 후 감시');
      const snapshot = await page.evaluate(() => window.hwp2x.autoState());
      const issues = await page.evaluate(() => window.hwp2x.autoIssues());
      assert.equal(snapshot.processed, 0);
      assert.equal(issues.total, 0);
      const manual = page.getByRole('button', { name: '특정 폴더 변환', exact: true });
      await until(() => manual.isDisabled(), '자동 실행 중 수동 메뉴 잠금 표시', 5000);
      assert.equal(await manual.isDisabled(), true, '자동 실행 중 수동 메뉴 잠금');
      evidence.observations.push({ type: 'empty-permission', snapshot, issues, manualDisabled: true });
      await capture('빈 위치와 접근 거부 상태에서 감시');
      await page.getByRole('button', { name: '자동 변환 중지', exact: true }).click();
    } finally {
      await fs.chmod(denied, 0o700);
      assert.deepEqual(await fs.readFile(path.join(denied, '보존.hwp')), await fs.readFile(evidence.source.path));
      await assert.rejects(fs.stat(path.join(denied, '보존.hwpx')), { code: 'ENOENT' });
    }
  }, async (evidence, options) => {
    const empty = path.join(evidence.directory, '빈 감시 위치');
    const denied = path.join(empty, '접근 거부');
    await fs.mkdir(denied, { recursive: true });
    await fs.copyFile(evidence.source.path, path.join(denied, '보존.hwp'));
    await fs.chmod(denied, 0);
    evidence.denied = denied;
    options.env.HWP2X_TEST_HOOKS = '1';
    options.env.HWP2X_AUTO_ROOTS = JSON.stringify([empty]);
  });
  await runEvidence('automatic-record-limit', async ({ page, evidence, capture }) => {
    const issues = () => page.evaluate(() => window.hwp2x.autoIssues());
    assert.equal((await issues()).total, 4096);
    for (const name of ['전체 자동 변환', '자동 변환 시작']) {
      await page.getByRole('button', { name, exact: true }).click();
      evidence.actions.push({ type: 'click', name });
    }
    await until(async () => (await page.evaluate(() => window.hwp2x.autoState())).phase === 'error', '기록 상한 안전 중단');
    assert.equal((await issues()).total, 4096);
    await assert.rejects(fs.stat(evidence.inputs[0].path.replace(/\.hwp$/, '.hwpx')), { code: 'ENOENT' });
    const persisted = JSON.parse(await fs.readFile(path.join(evidence.profile, 'automatic.json.issues.json'), 'utf8'));
    assert.equal(persisted.items.length, 4096);
    assert.equal(new Set(persisted.items.map(item => item.source)).size, 4096);
    evidence.observations.push({ type: 'record-limit', total: 4096, outputAbsent: true });
    await capture('기록 상한 안전 중단');
  }, async (evidence, options) => {
    await fs.mkdir(evidence.profile, { recursive: true });
    const items = Array.from({ length: 4096 }, (_, index) => ({ source: path.join(evidence.isolatedPaths.docs, `기록${index}.hwp`), name: `기록${index}.hwp`, reason: '처리하지 못함', message: '처리하지 못함', status: 'failed', attempts: 1, updatedAt: Date.now(), fingerprint: '1:2' }));
    await fs.writeFile(path.join(evidence.profile, 'automatic.json.issues.json'), JSON.stringify({ version: 1, items }));
    evidence.syntheticScope = '기록 상한 오류주입용 저장 기록만 합성; 신규 변환 대상은 실제 HWP 복사본';
    options.env.HWP2X_TEST_HOOKS = '1'; options.env.HWP2X_AUTO_ROOTS = JSON.stringify([evidence.isolatedPaths.docs]);
  });
  await runEvidence('manual-before-automatic', async ({ app, page, evidence, capture }) => {
    await app.evaluate(({ dialog }, root) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [root] }); }, evidence.isolatedPaths.docs);
    await page.getByRole('button', { name: '폴더 선택', exact: true }).first().click();
    await until(async () => (await page.evaluate(() => window.hwp2x.state())).total === 80, '수동 검색');
    await page.getByRole('button', { name: '80개 파일 변환', exact: true }).click();
    evidence.actions.push({ type: 'click', name: '80개 파일 변환' });
    await until(async () => (await page.evaluate(() => window.hwp2x.state())).phase === 'converting', '수동 실행');
    await page.getByRole('button', { name: '일시정지', exact: true }).click();
    await until(async () => (await page.evaluate(() => window.hwp2x.state())).phase === 'paused', '수동 작업 유지');
    await page.getByRole('button', { name: '전체 자동 변환', exact: true }).click();
    evidence.actions.push({ type: 'click', name: '전체 자동 변환' });
    const start = page.getByRole('button', { name: '자동 변환 시작', exact: true });
    await start.click();
    evidence.actions.push({ type: 'click', name: '자동 변환 시작 거부' });
    await page.getByText(/특정 폴더 변환 작업을 먼저 종료|작업을 먼저 종료/).first().waitFor();
    assert.equal((await page.evaluate(() => window.hwp2x.autoState())).enabled, false);
    assert.equal((await page.evaluate(() => window.hwp2x.state())).phase, 'paused');
    evidence.observations.push({ type: 'manual-first', automaticRejected: true, manual: await page.evaluate(() => window.hwp2x.state()) });
    await capture('수동 작업 중 자동 실행 거부');
  }, async evidence => {
    for (let index = 1; index < 80; index++) await fs.copyFile(evidence.source.path, path.join(evidence.isolatedPaths.docs, `공고문${index}.hwp`));
  });
}
if (!ensureDisplay(__filename)) main().catch(error => { console.error(error); process.exitCode = 1; });
