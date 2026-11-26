'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { runEvidence, ensureDisplay } = require('./common/evidence.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(100); }
  throw Error(`시간 초과: ${label}`);
}
async function dialogKey(title, keys, evidence) {
  const id = await until(async () => {
    try { return (await exec('xdotool', ['search', '--onlyvisible', '--name', title])).stdout.trim().split('\n').at(-1); }
    catch (error) { if (error.code === 1) return false; throw error; }
  }, title);
  await exec('xdotool', ['windowfocus', '--sync', id]);
  await exec('xdotool', ['key', ...keys]);
  evidence.actions.push({ type: 'native-key', title, keys, window: id });
}
async function rejectCalls(page, evidence, calls, pattern) {
  for (const [method, argument] of calls) {
    const error = await page.evaluate(async ({ method, argument }) => {
      try { await window.hwp2x[method](argument); return ''; } catch (error) { return String(error); }
    }, { method, argument });
    assert.match(error, pattern, method);
    evidence.observations.push({ type: 'ipc-rejected', method, error });
  }
}
const visible = app => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible());
const closeWindow = app => app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
async function inspectBase(context) {
  const { page, evidence, capture } = context;
  await page.getByRole('button', { name: '전체 자동 변환', exact: true }).click();
  evidence.actions.push({ type: 'click', name: '전체 자동 변환' });
  await capture('실제 패키지 생명주기 시작');
  evidence.observations.push({ type: 'initial', state: await page.evaluate(() => window.hwp2x.state()) });
}
async function prepare(evidence, options, fault = {}) {
  options.env.HWP2X_TEST_HOOKS = '1';
  options.env.HWP2X_AUTO_ROOTS = JSON.stringify([evidence.isolatedPaths.docs]);
  Object.assign(options.env, fault);
  evidence.lifecycle = { isolation: '실제 입력 사본과 자동 검색 루트만 격리; 상태 및 변환 대체 없음', boundaries: ['BrowserWindow.close는 실제 닫기 이벤트 사용; OS 제목표시줄 클릭 아님', '네이티브 대화상자는 xdotool 실제 키 입력', '실제 한컴 및 GitHub 보류'], fault };
  evidence.launch = { executablePath: options.executablePath, args: options.args, env: { ...options.env } };
  // Do not serialize the inherited environment (it may contain credentials).
  evidence._launch = evidence.launch;
  delete evidence.launch;
}
async function lifecycle(context) {
  const { app, page, evidence, capture } = context;
  const child = app.process();
  const launch = evidence._launch; delete evidence._launch;
  await inspectBase(context);
  const auto = () => page.evaluate(() => window.hwp2x.autoState());
  const background = page.getByRole('checkbox', { name: /창을 닫아도 트레이에서 계속/ });
  if (!(await auto()).background) { await background.click(); evidence.actions.push({ type: 'click', name: '창을 닫아도 트레이에서 계속' }); }
  await until(async () => (await auto()).background, '백그라운드 설정 저장');
  await page.getByRole('button', { name: '자동 변환 시작', exact: true }).click();
  evidence.actions.push({ type: 'click', name: '자동 변환 시작' });
  await until(async () => (await auto()).phase === 'watching', '실제 자동 변환 후 감시', 90000);
  await rejectCalls(page, evidence, [['scan', evidence.isolatedPaths.docs], ['start'], ['configure', { workers: 1 }], ['retry', 1], ['backup', true]], /자동/);
  await rejectCalls(page, evidence, [['cleanupStart', true], ['cleanupRollback']], /중지/);
  await closeWindow(app);
  await dialogKey('자동 변환 · 창 닫기', ['Escape'], evidence);
  assert.equal(await visible(app), true);
  assert.equal((await auto()).enabled, true);
  await closeWindow(app);
  await closeWindow(app);
  const dialogs = (await exec('xdotool', ['search', '--onlyvisible', '--name', '^자동 변환 · 창 닫기$'])).stdout.trim().split('\n');
  assert.equal(dialogs.length, 1, '반복 닫기 중복 대화상자 금지');
  await dialogKey('자동 변환 · 창 닫기', ['Tab', 'Return'], evidence);
  await until(async () => !(await visible(app)), '백그라운드 숨김');
  assert.equal(child.exitCode, null);
  assert.equal(page.isClosed(), false);
  const added = path.join(evidence.isolatedPaths.docs, '숨김 중 실제 문서.hwp');
  await fs.copyFile(evidence.source.path, added);
  await until(async () => { try { return (await fs.stat(added.replace(/\.hwp$/, '.hwpx'))).size > 0; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, '숨김 중 실제 변환', 90000);
  evidence.observations.push({ type: 'hidden-conversion', automatic: await auto(), processAlive: child.exitCode === null });
  const second = spawn(launch.executablePath, launch.args, { env: launch.env, stdio: 'pipe' });
  let stderr = ''; second.stderr.on('data', bytes => { stderr += bytes.toString('utf8'); });
  second.stdout.resume();
  const secondExit = new Promise((resolve, reject) => { second.once('error', reject); second.once('exit', (code, signal) => resolve({ code, signal })); });
  let timer;
  try {
    const result = await Promise.race([secondExit, new Promise((_, reject) => { timer = setTimeout(() => reject(Error('두 번째 인스턴스 종료 시간 초과')), 15000); })]);
    assert.equal(result.code, 0); assert.equal(result.signal, null);
    evidence.observations.push({ type: 'second-instance', ...result, stderr });
  } finally { clearTimeout(timer); if (second.exitCode === null && second.signalCode === null) second.kill(); }
  try { await until(() => visible(app), '중복 실행으로 숨긴 창 복원', 5000); }
  catch (error) {
    evidence.failures.push(String(error));
    // Diagnostic continuation only, never counted as successful restoration.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    evidence.actions.push({ type: 'diagnostic-continuation', note: '복원 실패 후 후속 검사용 show; 복원 통과 아님' });
  }
  await capture('중복 실행 후 창 상태');
  await page.getByRole('button', { name: '자동 변환 중지', exact: true }).click();
  evidence.actions.push({ type: 'click', name: '자동 변환 중지' });
  await until(async () => !(await auto()).enabled, '자동 중지와 잠금 해제');
  await page.evaluate(root => window.hwp2x.scan(root), evidence.isolatedPaths.docs);
  await page.evaluate(() => window.hwp2x.configure({ workers: 1 }));
  evidence.observations.push({ type: 'manual-unlocked', state: await page.evaluate(() => window.hwp2x.state()) });
  await page.getByRole('button', { name: '자동 변환 시작', exact: true }).click();
  await until(async () => (await auto()).phase === 'watching', '완전 종료 전 자동 감시');
  await background.click();
  await until(async () => !(await auto()).background, '백그라운드 해제');
  await closeWindow(app);
  await dialogKey('자동 변환 · 창 닫기', ['Escape'], evidence);
  assert.equal(await visible(app), true);
  assert.equal((await auto()).enabled, true);
  await background.click();
  await until(async () => (await auto()).background, '백그라운드 복원');
  await closeWindow(app);
  await dialogKey('자동 변환 · 창 닫기', ['Tab', 'Tab', 'Return'], evidence);
  await until(() => child.exitCode !== null || child.signalCode !== null, '실제 창 닫기 정상 종료');
  assert.equal(child.exitCode, 0);
}
async function shutdown(context, mode) {
  const { app, evidence, capture } = context;
  let { page } = context;
  const child = app.process();
  delete evidence._launch;
  await inspectBase(context);
  if (mode === 'crash') {
    const crashed = page.waitForEvent('crash');
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].webContents.forcefullyCrashRenderer(); });
    await crashed;
    await dialogKey('화면 프로세스가 종료되었습니다', ['Return'], evidence);
    const reloaded = await until(() => app.evaluate(({ BrowserWindow }) => {
      const contents = BrowserWindow.getAllWindows()[0].webContents;
      return !contents.isCrashed() && !contents.isLoading() && contents.executeJavaScript('typeof window.hwp2x?.state === "function"');
    }), '실제 다시 불러오기', 15000);
    evidence.observations.push({ type: 'renderer-reloaded', mainProcessObserved: reloaded });
    page = app.windows().find(item => !item.isClosed()) || page;
    const shot = path.join(evidence.directory, `screen-${String(evidence.screenshots.length + 1).padStart(2, '0')}.png`);
    const png = Buffer.from(await app.evaluate(async ({ BrowserWindow }) => (await BrowserWindow.getAllWindows()[0].webContents.capturePage()).toPNG().toString('base64')), 'base64');
    await fs.writeFile(shot, png, { flag: 'wx' });
    evidence.screenshots.push({ label: '실제 렌더러 충돌 후 다시 불러오기(주프로세스 캡처)', path: shot, sha256: require('node:crypto').createHash('sha256').update(png).digest('hex'), at: new Date().toISOString() });
    await closeWindow(app);
  } else {
    await closeWindow(app);
    if (mode === 'save') {
      await dialogKey('작업 기록 저장 실패', ['Return'], evidence);
      await until(async () => (await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].getTitle())) === 'hwp2x', '저장 실패 종료 취소');
      assert.equal(child.exitCode, null);
      await page.evaluate(() => window.hwp2x.configure({ workers: 1 }));
      evidence.observations.push({ type: 'save-failure-cancelled-unlocked', state: await page.evaluate(() => window.hwp2x.state()) });
      await capture('저장 실패 취소와 작업 잠금 해제');
      await closeWindow(app);
      await dialogKey('작업 기록 저장 실패', ['Tab', 'Return'], evidence);
    } else {
      await rejectCalls(page, evidence, [['scan', evidence.isolatedPaths.docs], ['start'], ['configure', { workers: 1 }], ['autoStart'], ['autoStop'], ['cleanupStart', true], ['cleanupRollback'], ['saveReport']], /종료 중/);
      for (const method of ['state', 'autoState', 'autoIssues', 'cleanupState', 'systemInfo', 'readLog']) {
        await page.evaluate(method => window.hwp2x[method](), method);
        evidence.observations.push({ type: 'shutdown-read-allowed', method });
      }
      await dialogKey('종료가 지연되고 있습니다', mode === 'force' ? ['Tab', 'Return'] : ['Return'], evidence);
    }
  }
  await until(() => child.exitCode !== null || child.signalCode !== null, `${mode} 종료`, 30000);
  assert.equal(child.exitCode, 0, `종료 신호 ${child.signalCode}`);
  evidence.observations.push({ type: 'exit', mode, code: child.exitCode });
}
async function main() {
  for (const argument of process.argv.slice(2)) assert.equal(argument, '--packaged', `지원하지 않는 인자: ${argument}`);
  if (ensureDisplay(__filename)) return;
  assert.equal(process.platform, 'linux', '현재 실제 네이티브 키 검사는 Linux만 지원');
  await exec('xdotool', ['version']);
  const results = [];
  results.push(await runEvidence('lifecycle-window', lifecycle, prepare));
  for (const mode of ['wait', 'force', 'save', 'crash']) {
    const fault = mode === 'save' ? { HWP2X_TEST_SAVE_FAIL: '1' } : mode === 'crash' ? {} : { HWP2X_TEST_STOP_DELAY_MS: mode === 'force' ? '15000' : '5000', HWP2X_TEST_CLOSE_TIMEOUT_MS: '2000' };
    results.push(await runEvidence(`lifecycle-${mode}`, context => shutdown(context, mode), (evidence, options) => prepare(evidence, options, fault)));
  }
  console.log(JSON.stringify({ suite: 'lifecycle', packaged: true, passed: results.every(result => result.passed), evidence: results.map(result => path.join(result.directory, 'evidence.json')), unverified: ['OS 트레이 메뉴 실제 클릭', '정리 실행 중 및 복구 실행 중 역방향 잠금은 기존 cleanup 검사 범위; 이 검사에서 미실행', '실제 한컴 및 GitHub'] }));
}
main().catch(error => { console.error(error); process.exitCode = 1; });
