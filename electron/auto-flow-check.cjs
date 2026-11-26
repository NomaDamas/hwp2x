// Real HWP copies only; no conversion, filesystem, IPC or state mocks.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const source = '/tmp/hwp2x-real/공고문.hwp';
const timeout = 180000;
async function until(check, label) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await sleep(150); }
  throw new Error(`시간 초과: ${label}`);
}
async function exists(file) { try { await fs.access(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
(async () => {
  assert.equal(process.platform, 'linux', 'Linux 실제 UI 검사');
  await fs.access(source);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-auto-real-'));
  const roots = [path.join(temp, '첫 루트'), path.join(temp, '둘째 루트')];
  const profile = path.join(temp, 'profile');
  const config = path.join(temp, 'config');
  const manual = path.join(temp, '수동');
  await Promise.all([...roots, manual, config].map(dir => fs.mkdir(dir, { recursive: true })));
  const evidence = { temp, source, roots, profile, config, checks: [], errors: [] };
  const note = (name, details) => { evidence.checks.push({ name, details, time: new Date().toISOString() }); console.log(`통과: ${name}`); };
  const copy = async (root, name) => { const file = path.join(root, `${name}.hwp`); await fs.copyFile(source, file); return file.replace(/\.hwp$/, '.hwpx'); };
  const output = async file => {
    await until(() => exists(file), `실제 출력 ${file}`);
    const { stdout } = await exec('python3', ['-c', 'import sys,zipfile,json\nz=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None\nn=z.namelist(); assert "Contents/header.xml" in n; assert any(x.startswith("Contents/section") and x.endswith(".xml") for x in n); print(json.dumps({"entries":len(n)}))', file]);
    const size = (await fs.stat(file)).size;
    assert.ok(size > 0);
    note('실제 HWPX ZIP 문서 생성', { file, size, ...JSON.parse(stdout) });
  };
  const first = await copy(roots[0], '최초 문서');
  await fs.mkdir(path.join(roots[1], '하위'), { recursive: true });
  const second = await copy(path.join(roots[1], '하위'), '중첩 문서');
  const env = { ...process.env, XDG_CONFIG_HOME: config, HWP2X_TEST_HOOKS: '1', HWP2X_AUTO_ROOTS: JSON.stringify(roots), HWP2X_START_ROOT: manual };
  const baseArgs = ['--no-sandbox', `--user-data-dir=${profile}`];
  let app, page;
  const launch = async automatic => {
    const args = [...baseArgs, ...(process.env.HWP2X_EXECUTABLE ? [] : [path.resolve(__dirname, '..')]), ...(automatic ? ['--automatic'] : [])];
    app = await _electron.launch({ ...(process.env.HWP2X_EXECUTABLE ? { executablePath: process.env.HWP2X_EXECUTABLE } : {}), args, env, timeout: 30000 });
    page = await app.firstWindow();
    page.on('pageerror', error => evidence.errors.push(error.message));
    await page.waitForFunction(() => typeof window.hwp2x?.autoState === 'function');
    note('Electron 실제 실행', { args, pid: app.process().pid });
  };
  const auto = () => page.evaluate(() => window.hwp2x.autoState());
  const screenshot = name => page.screenshot({ path: path.join(temp, `${name}.png`), fullPage: true });
  const visible = () => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().find(w => w.webContents.getURL().startsWith('file:')).isVisible());
  try {
    await launch(false);
    await page.getByRole('button', { name: '전체 자동 변환', exact: true }).click();
    const backgroundBox = page.getByRole('checkbox', { name: /창을 닫아도 트레이에서 계속/ });
    const resumeBox = page.getByRole('checkbox', { name: /로그인하면 자동 변환 다시 시작/ });
    if (!(await auto()).background) await backgroundBox.click();
    if (!(await auto()).resumeAtLogin) await resumeBox.click();
    await until(async () => { const s = await auto(); return s.background && s.resumeAtLogin; }, '설정 저장');
    const desktop = path.join(config, 'autostart', 'hwp2x.desktop');
    const desktopText = await fs.readFile(desktop, 'utf8');
    assert.match(desktopText, /^Exec=.+ --automatic$/m);
    assert.match(desktopText, /^Type=Application$/m);
    note('격리 autostart 실파일', { desktop, desktopText });
    await screenshot('01-settings');
    await page.getByRole('button', { name: /자동 변환 시작/ }).click();
    await until(async () => (await auto()).enabled, '자동 활성화');
    await Promise.all([output(first), output(second)]);
    assert.deepEqual((await auto()).roots.slice().sort(), roots.slice().sort());
    await output(await copy(roots[0], '나중에 추가'));
    await screenshot('02-automatic');
    for (const call of ['scan', 'start', 'pickFolder', 'configure', 'retry', 'backup']) {
      const result = await page.evaluate(async ({ call, root }) => { try { await window.hwp2x[call](call === 'scan' ? root : call === 'configure' ? { workers: 1 } : call === 'backup' ? true : 1); return { rejected: false }; } catch (error) { return { rejected: true, error: String(error) }; } }, { call, root: manual });
      assert.equal(result.rejected, true, `${call} 자동 실행 중 거부`);
      assert.match(result.error, /자동/);
      note('상호배타 IPC 거부', { call, ...result });
    }
    assert.equal(await page.getByRole('button', { name: '특정 폴더 변환', exact: true }).getAttribute('aria-disabled'), 'true');
    note('특정 폴더 메뉴 disabled');
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].close());
    await until(async () => !(await visible()), '닫기 후 숨김');
    assert.equal(app.process().exitCode, null);
    assert.equal(page.isClosed(), false);
    await output(await copy(roots[1], '숨김 중 추가'));
    note('window.close 숨김과 프로세스 생존');
    const typingWindow = app.waitForEvent('window');
    await app.evaluate(async ({ BrowserWindow }) => {
      const observer = new BrowserWindow({ width: 640, height: 400, title: 'hwp2x-focus-observer', webPreferences: { contextIsolation: true, nodeIntegration: false } });
      await observer.loadURL('data:text/html,<title>hwp2x-focus-observer</title><input autofocus id="typing"><p>Actual keyboard focus observer</p>');
      observer.show(); observer.focus();
    });
    const typing = await typingWindow;
    await typing.locator('#typing').click();
    const { stdout: focusId } = await exec('xdotool', ['getwindowfocus']);
    const focusedOutput = await copy(roots[0], '타이핑 중 추가');
    let expected = '';
    for (let i = 0; i < 30; i++) {
      assert.equal((await exec('xdotool', ['getwindowfocus'])).stdout.trim(), focusId.trim(), 'OS 키보드 포커스 유지');
      await exec('xdotool', ['type', '--clearmodifiers', '--delay', '15', 'abc']);
      expected += 'abc'; await sleep(100);
    }
    await output(focusedOutput);
    assert.equal(await typing.locator('#typing').inputValue(), expected);
    assert.equal((await exec('xdotool', ['getwindowfocus'])).stdout.trim(), focusId.trim());
    await typing.screenshot({ path: path.join(temp, '03-focus.png') });
    note('별도 BrowserWindow 실제 OS 타이핑 포커스 유지', { characters: expected.length });
    await typing.close();
    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().startsWith('file:')).show()); await page.getByRole('button',{name:'자동 변환 중지',exact:true}).click(); await until(async()=>!(await auto()).enabled,'UI 중지');
    assert.equal((await auto()).enabled, false);
    await until(async () => (await page.getByRole('button', { name: '특정 폴더 변환', exact: true }).getAttribute('aria-disabled')) !== 'true', '중지 후 수동 메뉴 허용');
    const manualOutput = await copy(manual, '수동 문서');
    await page.evaluate(root => window.hwp2x.scan(root), manual);
    await page.evaluate(() => window.hwp2x.start());
    await output(manualOutput);
    await until(async () => (await page.evaluate(() => window.hwp2x.state())).phase === 'done', '수동 완료');
    note('자동 중지 후 실제 수동 변환 허용');
    await screenshot('04-manual');
    await app.evaluate(({app})=>app.quit()).catch(()=>{}); await app.close(); app = undefined;
    await launch(true);
    await until(async () => (await auto()).enabled, '로그인 자동 재개');
    assert.equal(await visible(), false, '--automatic 시작 창 hidden');
    assert.equal((await auto()).resumeAtLogin, true);
    await output(await copy(roots[1], '로그인 재개 신규'));
    assert.equal(await visible(), false, '변환 후에도 hidden');
    note('동일 프로필 --automatic 숨김 재개와 신규 변환');
    assert.deepEqual(evidence.errors, [], 'renderer 오류 없음');
    evidence.passed = true;
  } catch (error) {
    evidence.passed = false; evidence.failure = String(error.stack || error);
    if (page && !page.isClosed()) {
      evidence.lastAuto = await auto().catch(String);
      evidence.lastState = await page.evaluate(() => window.hwp2x.state()).catch(String);
      await screenshot('failure').catch(() => {});
    }
    console.error(error); process.exitCode = 1;
  } finally {
    if(app) await app.evaluate(({app})=>app.quit()).catch(()=>{}); if (app) await app.close().catch(error => { evidence.closeError = String(error); process.exitCode = 1; });
    await fs.writeFile(path.join(temp, 'result.json'), JSON.stringify(evidence, null, 2));
    console.log(`검사 증거: ${temp}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
