'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { promisify } = require('node:util');
const execFile = promisify(require('node:child_process').execFile);
const { runEvidence, ensureDisplay } = require('./common/evidence.cjs');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { if (await check()) return; await sleep(100); }
  throw Error(`시간 초과: ${label}`);
}
async function exists(file) {
  try { await fs.stat(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
const auto = page => page.evaluate(() => window.hwp2x.autoState());
const resume = page => page.getByRole('checkbox', { name: /로그인하면 자동 변환 다시 시작/ });
async function click(page, evidence, locator, name) {
  await locator.click(); evidence.actions.push({ type: 'click', name, at: new Date().toISOString() });
}
async function openAutomatic(page, evidence) {
  await click(page, evidence, page.getByRole('button', { name: /^전체 자동 변환(?:\s*켜짐)?$/ }), '전체 자동 변환');
}
async function toggle(page, evidence, value) {
  assert.equal(await resume(page).isChecked(), !value);
  await click(page, evidence, resume(page), `로그인 자동 재개 ${value}`);
  await until(async () => (await auto(page)).resumeAtLogin === value && await resume(page).isChecked() === value, '자동 재개 저장', 15000);
}
async function prepare(evidence, options) {
  assert.equal(process.platform, 'linux', '격리 XDG 검사는 Linux 전용');
  assert.equal(path.dirname(options.env.XDG_CONFIG_HOME), evidence.directory);
  delete options.env.PORTABLE_EXECUTABLE_FILE;
  delete options.env.APPIMAGE;
  options.env.HWP2X_TEST_HOOKS = '1';
  options.env.HWP2X_AUTO_ROOTS = JSON.stringify([evidence.isolatedPaths.docs]);
  evidence.isolation = { xdg: options.env.XDG_CONFIG_HOME, hooks: ['automatic roots only'], realUserAutostartAccess: false };
  evidence.desktop = path.join(options.env.XDG_CONFIG_HOME, 'autostart', 'hwp2x.desktop');
  await fs.mkdir(path.dirname(evidence.desktop), { recursive: true });
  evidence.otherDesktop = path.join(path.dirname(evidence.desktop), 'other-application.desktop');
  evidence.otherContents = '[Desktop Entry]\nType=Application\nName=다른 앱 보존\nExec=/bin/true\n';
  await fs.writeFile(evidence.otherDesktop, evidence.otherContents, { flag: 'wx' });
  evidence.limitations = ['실제 OS 로그아웃·로그인·재부팅 미실행', 'Windows/macOS 로그인 등록 미검증', '실제 다른 사용자 계정 대신 격리 XDG의 타 앱 설정 보존 검증'];
}
async function preserveOther(evidence) {
  assert.equal(await fs.readFile(evidence.otherDesktop, 'utf8'), evidence.otherContents);
  assert.deepEqual((await fs.readdir(path.dirname(evidence.desktop))).filter(name => name.endsWith('.tmp')), []);
}
function desktopCommand(text) {
  const line = text.split('\n').find(value => value.startsWith('Exec='));
  assert.ok(line, '실제 desktop Exec 필수');
  const match = /^Exec="((?:\\.|[^"\\])+)" --automatic$/.exec(line);
  assert.ok(match, `지원하지 않는 desktop Exec: ${line}`);
  return { executablePath: match[1].replace(/\\([\\"`$])/g, '$1').replace(/%%/g, '%'), args: ['--automatic'] };
}
let desktopLaunchEnv;
let registered;
async function main() {
  assert.ok(process.argv.includes('--packaged'), '--packaged 필수');
  assert.ok(process.argv.includes('--isolated-config'), '--isolated-config 필수: 실제 사용자 설정 사용 금지');
  const first = await runEvidence('autolaunch-register', async ({ page, evidence, capture }) => {
    await openAutomatic(page, evidence);
    assert.equal((await auto(page)).resumeAtLogin, false);
    for (let round = 1; round <= 2; round++) {
      await toggle(page, evidence, true);
      const text = await fs.readFile(evidence.desktop, 'utf8');
      assert.match(text, /^Type=Application$/m);
      assert.match(text, /^Terminal=false$/m);
      assert.deepEqual(desktopCommand(text), { executablePath: evidence.portable, args: ['--automatic'] });
      assert.equal((await fs.stat(evidence.desktop)).mode & 0o777, 0o600);
      await preserveOther(evidence);
      evidence.observations.push({ type: 'registered', round, desktop: evidence.desktop, text, state: await auto(page) });
      await capture(`실제 등록 ${round}`);
      await toggle(page, evidence, false);
      assert.equal(await exists(evidence.desktop), false);
      await preserveOther(evidence);
      evidence.observations.push({ type: 'unregistered', round, state: await auto(page) });
      await capture(`실제 해제 ${round}`);
    }
    await toggle(page, evidence, true);
    registered = { profile: evidence.profile, command: desktopCommand(await fs.readFile(evidence.desktop, 'utf8')), portable: evidence.portable };
  }, async (evidence, options) => {
    await prepare(evidence, options);
    evidence.portable = path.join(evidence.directory, '한글 공백 포터블', '한글 변환기');
    await fs.mkdir(path.dirname(evidence.portable));
    await fs.symlink(evidence.executable, evidence.portable);
    options.env.PORTABLE_EXECUTABLE_FILE = evidence.portable;
    evidence.portableScope = '실제 패키지 실행파일을 가리키는 격리 symlink; Windows 압축해제 포터블 자체는 미검증';
  });
  if (!first.passed) return;
  await runEvidence('autolaunch-desktop-command', async ({ app, page, evidence, capture }) => {
    const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().filter(w => !w.isDestroyed()).some(w => w.isVisible()));
    await until(async () => (await auto(page)).enabled, 'desktop 명령 자동 시작');
    assert.equal(await visible(), false, '--automatic 숨김 시작');
    const input = path.join(evidence.isolatedPaths.docs, '로그인 후 신규 공고문.hwp');
    await fs.copyFile(evidence.source.path, input);
    const output = input.replace(/\.hwp$/, '.hwpx');
    await until(() => exists(output), '신규 HWP 실제 변환');
    await execFile('python3', ['-c', 'import sys,zipfile\nz=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None; assert "Contents/header.xml" in z.namelist(); assert any(n.startswith("Contents/section") and n.endswith(".xml") for n in z.namelist())', output]);
    assert.deepEqual(await fs.readFile(input), await fs.readFile(evidence.source.path));
    assert.equal(await visible(), false, '변환 뒤 숨김 유지');
    evidence.outputs.push({ path: output, bytes: (await fs.stat(output)).size });
    const originalPid = app.process().pid;
    const duplicate = await execFile(registered.command.executablePath, evidence.launchArgs, { env: desktopLaunchEnv, timeout: 15000, killSignal: 'SIGKILL' });
    assert.equal(app.process().pid, originalPid);
    assert.equal(app.process().exitCode, null);
    assert.equal(await visible(), false, '중복 자동 실행도 숨김 유지');
    evidence.observations.push({ type: 'desktop-command-hidden-conversion-and-duplicate', command: registered.command, originalPid, duplicateStdout: duplicate.stdout, duplicateStderr: duplicate.stderr, automatic: await auto(page) });
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].show());
    await openAutomatic(page, evidence);
    await capture('desktop 명령 신규 변환 결과');
    await click(page, evidence, page.getByRole('button', { name: '자동 변환 중지', exact: true }), '자동 변환 중지');
    await until(async () => !(await auto(page)).enabled, '자동 변환 중지');
    await toggle(page, evidence, false);
    await preserveOther(evidence);
  }, async (evidence, options) => {
    await prepare(evidence, options);
    await fs.cp(registered.profile, evidence.profile, { recursive: true });
    options.executablePath = registered.command.executablePath;
    options.args.push(...registered.command.args);
    options.env.PORTABLE_EXECUTABLE_FILE = registered.portable;
    evidence.launchArgs = [...options.args];
    desktopLaunchEnv = options.env;
  });
  for (const failure of ['blocked-directory', 'moved-portable']) {
    await runEvidence(`autolaunch-${failure}`, async ({ page, evidence, capture }) => {
      await openAutomatic(page, evidence);
      assert.equal((await auto(page)).resumeAtLogin, false);
      await click(page, evidence, resume(page), '등록 실패 유발');
      await page.getByText(/작업을 완료하지 못했습니다/).first().waitFor();
      await until(async () => !(await resume(page).isChecked()), '실패 옵션 false', 15000);
      assert.equal((await auto(page)).resumeAtLogin, false);
      const settingsFile = path.join(evidence.profile, 'automatic.json');
      if (await exists(settingsFile)) assert.equal(JSON.parse(await fs.readFile(settingsFile, 'utf8')).resumeAtLogin, false);
      if (failure === 'blocked-directory') assert.equal(await fs.readFile(path.dirname(evidence.desktop), 'utf8'), '등록을 막는 실제 파일');
      else { assert.equal(await exists(evidence.desktop), false); await preserveOther(evidence); }
      evidence.observations.push({ type: 'real-registration-failure', failure, state: await auto(page), body: await page.locator('body').innerText() });
      await capture('실제 등록 실패와 옵션 false');
      if (failure === 'moved-portable') {
        await fs.rename(path.join(evidence.directory, '이동 후 실행파일'), path.join(evidence.directory, '이동 전 실행파일'));
        await toggle(page, evidence, true);
        const entry = await fs.readFile(evidence.desktop, 'utf8');
        assert.ok(entry.includes('이동 전 실행파일'));
        assert.equal((await auto(page)).resumeAtLogin, true);
        await toggle(page, evidence, false);
        assert.equal(await exists(evidence.desktop), false);
        evidence.observations.push({ type: 'restored-portable-reregister', registered: true, removed: true });
        await capture('실행 경로 복구 후 재등록과 해제');
      }
    }, async (evidence, options) => {
      await prepare(evidence, options);
      if (failure === 'blocked-directory') {
        await fs.unlink(evidence.otherDesktop);
        await fs.rmdir(path.dirname(evidence.desktop));
        await fs.writeFile(path.dirname(evidence.desktop), '등록을 막는 실제 파일', { flag: 'wx' });
      } else {
        const old = path.join(evidence.directory, '이동 전 실행파일');
        const moved = path.join(evidence.directory, '이동 후 실행파일');
        await fs.symlink(evidence.executable, old);
        await fs.rename(old, moved);
        options.env.PORTABLE_EXECUTABLE_FILE = old;
        evidence.limitations.push('이동으로 사라진 경로 거부 검증; 이동 후 재등록 및 OS 로그인은 미검증');
      }
    });
  }
  await runEvidence('autolaunch-corrupt-settings', async ({ page, evidence, capture }) => {
    await openAutomatic(page, evidence);
    const state = await auto(page);
    assert.equal(state.resumeAtLogin, false);
    assert.equal(state.enabled, false);
    assert.equal(await exists(evidence.desktop), false);
    assert.equal(await fs.readFile(path.join(evidence.profile, 'automatic.json'), 'utf8'), '{broken');
    await page.getByText(/자동 변환 설정을 읽지 못했습니다/).waitFor();
    evidence.observations.push({ type: 'corrupt-settings', state, body: await page.locator('body').innerText() });
    await capture('손상 설정에서 자동 실행하지 않음');
    await preserveOther(evidence);
  }, async (evidence, options) => {
    await prepare(evidence, options);
    await fs.mkdir(evidence.profile, { recursive: true });
    await fs.writeFile(path.join(evidence.profile, 'automatic.json'), '{broken');
  });
}
if (!ensureDisplay(__filename)) main().catch(error => { console.error(error); process.exitCode = 1; });
