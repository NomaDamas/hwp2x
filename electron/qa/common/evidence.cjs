'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function resolveExecutable() {
  const executable = path.resolve(process.env.HWP2X_EXECUTABLE || path.join(__dirname, '../../../dist-electron/linux-unpacked/hwp2x'));
  try {
    await fs.access(executable, fs.constants.X_OK);
    if (!(await fs.stat(executable)).isFile()) throw Error('파일이 아님');
  } catch (error) { throw Error(`실제 배포 실행 파일이 없거나 실행할 수 없습니다: ${executable}`, { cause: error }); }
  return executable;
}

function ensureDisplay(script) {
  if (process.platform !== 'linux' || process.env.DISPLAY) return false;
  if (process.env.HWP2X_QA_XVFB === '1') throw Error('xvfb-run 재실행 후에도 DISPLAY가 없습니다');
  const result = spawnSync('xvfb-run', ['-a', process.execPath, script, ...process.argv.slice(2)], {
    stdio: 'inherit', env: { ...process.env, HWP2X_QA_XVFB: '1' },
  });
  if (result.error) throw Error(`화면 없는 Linux 검사에는 xvfb-run이 필요합니다: ${result.error.message}`);
  process.exitCode = result.status === null ? 1 : result.status;
  return true;
}

async function prepareRun(evidence) {
  evidence.executable = await resolveExecutable();
  const original = await fs.readFile(evidence.source.path);
  evidence.source.beforeHash = hash(original);
  const docs = path.join(evidence.directory, 'docs');
  const config = path.join(evidence.directory, 'config');
  evidence.profile = path.join(evidence.directory, 'profile');
  await fs.mkdir(docs);
  const copy = path.join(docs, '공고문.hwp');
  await fs.writeFile(copy, original, { flag: 'wx' });
  evidence.inputs.push({ path: copy, sha256: hash(await fs.readFile(copy)), bytes: original.length });
  evidence.isolatedPaths = { docs, config, profile: evidence.profile };
  evidence.package = { executableSha256: hash(await fs.readFile(evidence.executable)) };
  const asarPath = path.join(path.dirname(evidence.executable), 'resources/app.asar');
  evidence.package.asarPath = asarPath;
  evidence.package.asarSha256 = hash(await fs.readFile(asarPath));
  const env = { ...process.env, XDG_CONFIG_HOME: config, HWP2X_START_ROOT: docs };
  for (const key of Object.keys(env)) {
    if (key.startsWith('HWP2X_TEST_') || key === 'HWP2X_AUTO_ROOTS' || key === 'ELECTRON_RUN_AS_NODE') delete env[key];
  }
  return { executablePath: evidence.executable, args: ['--no-sandbox', `--user-data-dir=${evidence.profile}`], env, timeout: 30000 };
}

async function captureScreenshot(page, evidence, label) {
  const file = path.join(evidence.directory, `screen-${String(evidence.screenshots.length + 1).padStart(2, '0')}.png`);
  await page.screenshot({ path: file, fullPage: true });
  evidence.screenshots.push({ label, path: file, sha256: hash(await fs.readFile(file)), at: new Date().toISOString() });
}

async function runEvidence(name, inspect, prepareProfile) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-common-'));
  const evidence = {
    schemaVersion: 1, name, directory, startedAt: new Date().toISOString(),
    executable: null, packaged: false, profile: null,
    source: { path: path.resolve(process.env.HWP2X_SAMPLE || '/tmp/hwp2x-real/공고문.hwp'), beforeHash: null, afterHash: null },
    actions: [], screenshots: [], consoleErrors: [], rendererErrors: [], observations: [], inputs: [], outputs: [], failures: [],
    exit: { code: null, signal: null }, processOutput: { stdout: '', stderr: '' },
  };
  let app, child;
  const fail = error => evidence.failures.push(String(error.stack || error));
  try {
    const options = await prepareRun(evidence);
    if (prepareProfile) await prepareProfile(evidence);
    const { _electron } = require('playwright');
    app = await _electron.launch(options);
    child = app.process();
    child.stdout?.on('data', bytes => { evidence.processOutput.stdout += bytes.toString('utf8'); });
    child.stderr?.on('data', bytes => { evidence.processOutput.stderr += bytes.toString('utf8'); });
    const observedPages = new WeakSet();
    const observePage = page => {
      if (observedPages.has(page)) return;
      observedPages.add(page);
      page.on('console', message => { if (message.type() === 'error') evidence.consoleErrors.push({ text: message.text(), location: message.location() }); });
      page.on('pageerror', error => evidence.rendererErrors.push(String(error.stack || error)));
    };
    app.on('window', observePage);
    for (const page of app.windows()) observePage(page);
    evidence.info = await app.evaluate(({ app }) => ({ packaged: app.isPackaged, version: app.getVersion(), profile: app.getPath('userData') }));
    evidence.packaged = evidence.info.packaged;
    if (!evidence.packaged) throw Error('실제 배포 패키지가 아닙니다');
    if (path.resolve(evidence.info.profile) !== evidence.profile) throw Error('앱 프로필이 격리 경로와 다릅니다');
    const page = await app.firstWindow();
    observePage(page);
    page.setDefaultTimeout(15000);
    await page.waitForFunction(() => typeof window.hwp2x?.state === 'function');
    await inspect({ app, page, evidence, capture: label => captureScreenshot(page, evidence, label) });
    if (evidence.consoleErrors.length || evidence.rendererErrors.length) throw Error('실제 GUI에서 콘솔 또는 페이지 오류가 발생했습니다');
  } catch (error) { fail(error); }
  finally {
    if (app) {
      try { await app.close(); } catch (error) { fail(error); }
      evidence.exit = { code: child.exitCode, signal: child.signalCode };
      if (child.exitCode !== 0 || child.signalCode) fail(Error(`앱 정상 종료 실패: ${JSON.stringify(evidence.exit)}`));
    }
    try {
      evidence.source.afterHash = hash(await fs.readFile(evidence.source.path));
      if (evidence.source.beforeHash && evidence.source.beforeHash !== evidence.source.afterHash) fail(Error('사용자 원본 SHA-256이 변경되었습니다'));
    } catch (error) { fail(error); }
    evidence.finishedAt = new Date().toISOString();
    evidence.passed = evidence.failures.length === 0;
    const file = path.join(directory, 'evidence.json');
    await fs.writeFile(file, JSON.stringify(evidence, null, 2), 'utf8');
    console.log(`EVIDENCE_PATH=${file}`);
    if (!evidence.passed) { console.error(evidence.failures.join('\n')); process.exitCode = 1; }
  }
  return evidence;
}

module.exports = { resolveExecutable, ensureDisplay, prepareRun, captureScreenshot, runEvidence };
