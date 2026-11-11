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
}
if (!ensureDisplay(__filename)) main().catch(error => { console.error(error); process.exitCode = 1; });
