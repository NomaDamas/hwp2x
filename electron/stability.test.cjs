const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitLog(profile, event) {
  for (let i = 0; i < 60; i++) {
    const text = await logText(profile).catch(() => '');
    if (text.includes(`"event":"${event}"`)) return text;
    await sleep(100);
  }
  throw new Error(`log event timeout: ${event}`);
}

async function launch(extra = {}) {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-stability-'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-root-'));
  const app = await electron.launch({
    args: ['--no-sandbox', '.', `--user-data-dir=${profile}`],
    env: { ...process.env, NODE_ENV: 'test', HWP2X_TEST_HOOKS: '1', HWP2X_START_ROOT: root, ...extra },
    timeout: 60000,
  });
  return { app, child: app.process(), profile, root };
}

async function logText(profile) {
  const dir = path.join(profile, 'logs');
  const entries = await fs.readdir(dir);
  const file = entries.find(name => /^hwp2x-.*\.log$/.test(name));
  assert.ok(file, '실제 로그 파일 생성');
  return fs.readFile(path.join(dir, file), 'utf8');
}

(async () => {
  const first = await launch({ HWP2X_TEST_DIALOG: '0' });
  try {
    let opened = '';
    await first.app.evaluate(({ shell, dialog }) => {
      shell.openExternal = async url => { global.__hwp2xOpened = url; };
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    const page = await first.app.firstWindow();
    await page.getByText('설정', { exact: true }).first().click();
    await page.getByRole('button', { name: '작성 초안 열기', exact: true }).waitFor();
    await page.getByRole('button', { name: '로그 폴더 열기', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Hwp.exe 선택', exact: true }).waitFor();
    const info = await page.evaluate(() => window.hwp2x.systemInfo());
    assert.equal(info.platform, process.platform);
    await page.evaluate(() => window.hwp2x.scan(12).catch(() => undefined));
    await page.evaluate(() => window.hwp2x.reportError('STABILITY_RENDERER_ERROR', 'test stack'));
    let errorLogged = false;
    for (let i = 0; i < 50; i++) {
      const text = await logText(first.profile).catch(() => '');
      errorLogged = text.includes('STABILITY_RENDERER_ERROR') && text.includes('ipc.fail');
      if (errorLogged) break;
      await sleep(100);
    }
    assert.equal(errorLogged, true, 'renderer 오류와 IPC 실패 로그 완료');
    await page.getByRole('button', { name: '작성 초안 열기', exact: true }).click();
    for (let i = 0; i < 50 && !opened; i++) {
      opened = await first.app.evaluate(() => global.__hwp2xOpened || '');
      await sleep(100);
    }
    assert.match(opened, /^https:\/\/github\.com\/NomaDamas\/hwp2x\/issues\/new\?/);
    assert.ok(decodeURIComponent(opened).includes('STABILITY_RENDERER_ERROR'), `최근 renderer 오류 포함: ${decodeURIComponent(opened)}`);
    assert.ok(!decodeURIComponent(opened).includes('/home/'), '민감 홈 경로 미포함');
    const logs = await logText(first.profile);
    assert.match(logs, /"event":"app\.start"/);
    assert.match(logs, /"event":"ipc\.fail"/);
    assert.match(logs, /"event":"renderer\.error"/);
  } finally {
    try { await first.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]?.close(); }); await waitLog(first.profile, '종료 완료'); } catch {}
    if (first.child.exitCode === null) first.child.kill('SIGKILL');
    await fs.rm(first.root, { recursive: true, force: true });
  }

  const forced = await launch({ HWP2X_TEST_STOP_DELAY_MS: '3000', HWP2X_TEST_CLOSE_TIMEOUT_MS: '50', HWP2X_TEST_DIALOG: '1' });
  try {
    await forced.app.firstWindow();
    await forced.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    const logs = await waitLog(forced.profile, '강제 종료');
    assert.equal((logs.match(/"event":"test\.dialog"/g) || []).length, 1, '중복 close 대화상자 없음');
    assert.match(logs, /"event":"강제 종료"/);
    if (forced.child.exitCode === null) forced.child.kill('SIGKILL');
  } finally { await fs.rm(forced.root, { recursive: true, force: true }); }

  const failed = await launch({ HWP2X_TEST_SAVE_FAIL: '1', HWP2X_TEST_DIALOG: '1' });
  try {
    await failed.app.firstWindow();
    await failed.app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
    const logs = await waitLog(failed.profile, '저장 실패');
    assert.match(logs, /"event":"저장 실패"/);
    assert.match(logs, /검사용 저장 실패/);
    if (failed.child.exitCode === null) failed.child.kill('SIGKILL');
  } finally { await fs.rm(failed.root, { recursive: true, force: true }); }

  console.log('stability xvfb checks OK');
  process.exit(0);
})().catch(error => { console.error(error); process.exitCode = 1; });
