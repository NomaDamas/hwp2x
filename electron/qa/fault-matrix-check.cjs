'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const exec = require('node:util').promisify(execFile);
const { prepareRun, captureScreenshot, ensureDisplay } = require('./common/evidence.cjs');
const hash = b => crypto.createHash('sha256').update(b).digest('hex');
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await fn(); if (value) return value; await sleep(25); }
  throw Error(`시간 초과: ${label}`);
}
async function runScenario(mode) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-fault-'));
  const e = { schemaVersion: 1, name: `fault-${mode}`, directory, startedAt: new Date().toISOString(), source: { path: '/tmp/hwp2x-real/공고문.hwp' }, inputs: [], outputs: [], actions: [], observations: [], screenshots: [], failures: [], consoleErrors: [], rendererErrors: [], launches: [], limitations: ['상태 및 로그 조회는 preload 읽기 호출; 실행은 GUI 클릭', 'tmpfs 분리는 실제 Linux 마운트 분리이며 물리 USB·Windows 드라이브 분리가 아님'] };
  let app, page, options, mounted = false, revoked = false;
  const mount = path.join(directory, 'drive');
  const launch = async () => {
    app = await require('playwright')._electron.launch(options);
    const child = app.process();
    const record = { pid: child.pid, at: new Date().toISOString(), stdout: '', stderr: '' };
    e.launches.push(record);
    child.stdout?.on('data', b => { record.stdout += b.toString('utf8'); });
    child.stderr?.on('data', b => { record.stderr += b.toString('utf8'); });
    child.on('exit', (code, signal) => { record.exit = { code, signal, at: new Date().toISOString() }; });
    const info = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, profile: app.getPath('userData') }));
    assert.equal(info.packaged, true); assert.equal(info.profile, e.profile); e.packaged = true;
    page = await app.firstWindow(); page.setDefaultTimeout(15000);
    page.on('pageerror', error => e.rendererErrors.push(String(error)));
    page.on('console', m => { if (m.type() === 'error') e.consoleErrors.push(m.text()); });
    await page.waitForFunction(() => typeof window.hwp2x?.state === 'function');
  };
  const state = () => page.evaluate(() => window.hwp2x.state());
  const click = async name => { await page.getByRole('button', { name, exact: typeof name === 'string' }).first().click(); e.actions.push({ type: 'click', name: String(name), at: new Date().toISOString() }); };
  const snapshot = async label => { e.observations.push({ label, state: await state(), at: new Date().toISOString() }); await captureScreenshot(page, e, label); };
  try {
    options = await prepareRun(e);
    let root = e.isolatedPaths.docs;
    if (['disk-full', 'drive-detach'].includes(mode)) {
      await exec('sudo', ['-n', 'true']); await fs.mkdir(mount);
      await exec('sudo', ['-n', 'mount', '-t', 'tmpfs', '-o', `size=16m,uid=${process.getuid()},gid=${process.getgid()},mode=0700`, 'hwp2x-fault', mount]); mounted = true;
      root = mount;
    }
    for (let i = 0; i < 40; i++) {
      const file = path.join(root, `실제 사본 ${i}.hwp`);
      await fs.copyFile(e.inputs[0].path, file);
      e.inputs.push({ path: file, sha256: e.source.beforeHash });
    }
    options.env.HWP2X_START_ROOT = root;
    await launch();
    if (mode === 'disk-full') {
      const handle = await fs.open(path.join(mount, 'fill'), 'wx');
      try { for (;;) await handle.write(Buffer.alloc(65536)); }
      catch (error) { assert.equal(error.code, 'ENOSPC'); e.observations.push({ injected: 'ENOSPC', real: true }); }
      finally { await handle.close(); }
    }
    if (mode === 'permission-revoke') {
      await fs.chmod(root, 0o500); revoked = true;
      await assert.rejects(fs.writeFile(path.join(root, 'permission-probe'), ''), { code: 'EACCES' });
      e.observations.push({ injected: 'EACCES', real: true });
    }
    const start = page.getByRole('button', { name: '검색 후 변환', exact: true }).first();
    if (mode === 'duplicate') { await start.dblclick(); e.actions.push({ type: 'click', name: '검색 후 변환 실제 더블클릭' }); }
    else await click('검색 후 변환');
    await until(async () => (await state()).total >= 40, '격리 실제 복사본 검색과 시작');
    await snapshot('장애 후 시작');
    if (mode === 'drive-detach') {
      await until(async () => (await state()).phase === 'converting', '분리 전 실제 처리 중');
      await exec('sudo', ['-n', 'umount', '-l', mount]); mounted = false;
      assert.deepEqual(await fs.readdir(mount), []);
      e.observations.push({ injected: 'lazy-unmounted-tmpfs-during-conversion', real: true, state: await state() });
    }
    if (mode === 'kill') {
      await until(async () => (await state()).phase === 'converting', '강제종료 전 실제 처리 중');
      e.observations.push({ label: '강제종료 직전', state: await state() });
      const child = app.process(); assert.equal(child.exitCode, null);
      child.kill('SIGKILL'); await until(() => child.signalCode === 'SIGKILL', '소유 프로세스 SIGKILL', 15000); app = null;
    } else {
      await until(async () => (await state()).phase === (mode === 'disk-full' ? 'paused' : 'done'), '장애 처리 완료');
      const done = await state(); await snapshot('장애 처리 결과');
      if (mode === 'disk-full') { assert.ok(done.counts.wait > 0, '공간 부족 파일은 재개 대기'); assert.match(done.message, /안전 중단/); }
      else if (['permission-revoke', 'drive-detach'].includes(mode)) assert.ok(done.counts.fail > 0, '실제 실패가 GUI 기록에 있어야 함');
      else { assert.equal(done.counts.fail, 0); assert.equal(done.completed, done.total); }
      await app.close(); app = null;
    }
    if (revoked) { await fs.chmod(root, 0o700); revoked = false; }
    if (mode === 'disk-full') await fs.unlink(path.join(mount, 'fill'));
    if (mode === 'broken-settings') {
      const config = path.join(e.profile, 'automatic.json');
      let before = null; try { before = await fs.readFile(config, 'utf8'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      e.observations.push({ injected: 'malformed-json', path: config, previous: before });
      await fs.writeFile(config, '{broken');
    }
    await launch(); await snapshot('같은 프로필 재시작');
    e.observations.push({ label: '재시작 기록', log: await page.evaluate(() => window.hwp2x.readLog()), automatic: await page.evaluate(() => window.hwp2x.autoState()) });
    if (mode !== 'kill' && mode !== 'broken-settings') assert.ok((await state()).total > 0, '재시작 작업 기록 보존');
    if (mode === 'kill') assert.ok((await state()).phase !== 'converting', '강제종료 후 유령 실행 상태 금지');
    if (mode === 'disk-full' || mode === 'kill') {
      const restored = await state();
      assert.equal(restored.phase, 'paused');
      assert.ok(restored.counts.wait > 0, '재시작 후 남은 작업 보존');
      await page.getByRole('button', { name: '이어하기', exact: true }).click();
      await until(async () => (await state()).phase === 'done', 'GUI 이어하기 완료');
      const resumed = await state();
      assert.equal(resumed.total, restored.total);
      assert.equal(resumed.completed, resumed.total);
      assert.equal(resumed.counts.wait, 0);
      assert.equal(resumed.counts.fail, 0);
      await snapshot('장애 해소 후 GUI 이어하기 완료');
    }
    for (const input of e.inputs) {
      if (mode === 'drive-detach' && input.path.startsWith(mount + path.sep)) continue;
      assert.equal(hash(await fs.readFile(input.path)), input.sha256, '격리 복사본 보존');
    }
    if (e.rendererErrors.length) throw Error('renderer 오류 발생');
  } catch (error) { e.failures.push(String(error.stack || error)); }
  finally {
    if (app) { try { await app.close(); } catch (error) { e.failures.push(String(error)); } }
    if (revoked) await fs.chmod(e.isolatedPaths.docs, 0o700).catch(error => e.failures.push(String(error)));
    if (mounted) await exec('sudo', ['-n', 'umount', mount]).catch(error => e.failures.push(String(error)));
    try { e.source.afterHash = hash(await fs.readFile(e.source.path)); assert.equal(e.source.afterHash, e.source.beforeHash); } catch (error) { e.failures.push(String(error)); }
    e.finishedAt = new Date().toISOString(); e.passed = e.failures.length === 0;
    await fs.writeFile(path.join(directory, 'evidence.json'), JSON.stringify(e, null, 2));
    console.log(JSON.stringify({ scenario: mode, passed: e.passed, evidence: path.join(directory, 'evidence.json'), failures: e.failures }));
  }
  return e;
}
async function main() {
  assert.deepEqual([...process.argv.slice(2)].sort(), ['--isolated', '--packaged']);
  if (ensureDisplay(__filename)) return;
  const results = [];
  for (const mode of ['kill', 'disk-full', 'permission-revoke', 'drive-detach', 'broken-settings', 'duplicate']) results.push(await runScenario(mode));
  await fs.mkdir(path.join(__dirname, 'evidence-review'), { recursive: true });
  await fs.writeFile(path.join(__dirname, 'evidence-review', 'latest-faults.json'), JSON.stringify(results.map(e => path.join(e.directory, 'evidence.json')), null, 2));
  console.log(JSON.stringify({ suite: 'fault-matrix', passed: results.every(e => e.passed), evidence: results.map(e => path.join(e.directory, 'evidence.json')) }));
  if (results.some(e => !e.passed)) process.exitCode = 1;
}
module.exports = { runScenario, main };
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
