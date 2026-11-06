const { _electron: electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');

async function waitPhase(page, phase) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => window.hwp2x.state());
    if (state.phase === phase) return state;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error(`timed out waiting for ${phase}`);
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-ui-'));
  await fs.writeFile(path.join(root, '시험.hwpml'), '<?xml version="1.0" encoding="UTF-8"?><HWPML Version="2.8"><HEAD SecCnt="1"></HEAD><BODY><SECTION Id="0"><P><TEXT><CHAR>실제 변환 시험</CHAR></TEXT></P></SECTION></BODY></HWPML>');
  await fs.writeFile(path.join(root, '손상.hwp'), 'invalid');
  if (process.env.HWP2X_SMOKE_HWP) await fs.copyFile(process.env.HWP2X_SMOKE_HWP, path.join(root, '공고문.hwp'));
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-smoke-profile-'));
  const baseArgs = ['--no-sandbox', `--user-data-dir=${profile}`];
  const opts = process.env.HWP2X_EXECUTABLE ? { executablePath: process.env.HWP2X_EXECUTABLE, args: baseArgs } : { args: [...baseArgs, '.'] };
  const app = await electron.launch({ ...opts, timeout: 60000 });
  try {
    // Only OS folder dialog is substituted; renderer clicks and IPC/backend are real.
    await app.evaluate(({dialog}, root) => { dialog.showOpenDialog = async () => ({ canceled:false, filePaths:[root] }); }, root);
    const page = await app.firstWindow();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const mainBox = page.getByRole('checkbox', {name:'AI가 읽기 편한 md 파일도 생성'});
    for (let i = 0; i < 50 && await mainBox.count() === 0; i++) await page.waitForTimeout(100);
    await mainBox.waitFor();
    assert.equal(await mainBox.isChecked(), true, '메인 화면 MD 옵션 기본 체크');
    assert.equal(await page.locator('[role=alert]').count(), 0, '상단 오류 배너 없음');
    const initial = await page.evaluate(() => window.hwp2x.state());
    assert.equal(initial.makeMarkdown, true);
    await page.getByText('설정', {exact:true}).first().click();
    await page.getByText('AI가 읽기 편한 md 파일도 생성', {exact:true}).waitFor();
    await page.getByRole('button', {name:'폴더 선택', exact:true}).click();
    await page.getByText('개요', {exact:true}).first().click();
    await page.getByRole('button', {name:'검색한 파일 변환', exact:true}).click();
    const state = await waitPhase(page, 'done');
    assert.ok(state.files.some(file => file.targetSize > 0));
    assert.ok((await fs.readFile(path.join(root,'시험.hwpx'))).subarray(0,2).equals(Buffer.from('PK')));
    assert.match(await fs.readFile(path.join(root,'시험.md'),'utf8'), /실제 변환 시험/);
    assert.equal(await fs.readFile(path.join(root,'손상.hwp'),'utf8'), 'invalid');
    await page.getByText('파일', {exact:true}).first().click();
    await page.getByText('손상.hwp', {exact:true}).first().click();
    await page.getByRole('button',{name:'다시 시도',exact:true}).click();
    await waitPhase(page, 'done');
    // 옵션을 끈 뒤 새 폴더 변환: HWPX만 생기고 MD는 없어야 함
    const off = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-ui-off-'));
    await fs.writeFile(path.join(off, '끔.hwpml'), '<?xml version="1.0" encoding="UTF-8"?><HWPML Version="2.8"><HEAD SecCnt="1"></HEAD><BODY><SECTION Id="0"><P><TEXT><CHAR>옵션 끔</CHAR></TEXT></P></SECTION></BODY></HWPML>');
    await app.evaluate(({dialog}, root) => { dialog.showOpenDialog = async () => ({ canceled:false, filePaths:[root] }); }, off);
    await page.getByText('설정', {exact:true}).first().click();
    await page.getByRole('switch', {name:/AI가 읽기 편한 md 파일도 생성/}).click();
    for (let i = 0; i < 50 && (await page.evaluate(() => window.hwp2x.state())).makeMarkdown !== false; i++) await page.waitForTimeout(100);
    assert.equal((await page.evaluate(() => window.hwp2x.state())).makeMarkdown, false, '옵션 끔 반영');
    await page.getByRole('button', {name:'폴더 선택', exact:true}).click();
    await page.getByText('개요', {exact:true}).first().click();
    await page.getByRole('button', {name:'검색한 파일 변환', exact:true}).click();
    await waitPhase(page, 'done');
    assert.ok((await fs.readFile(path.join(off,'끔.hwpx'))).subarray(0,2).equals(Buffer.from('PK')));
    await assert.rejects(fs.stat(path.join(off,'끔.md')), '옵션 끄면 MD 미생성');
    await fs.rm(off, {recursive:true, force:true});
    // Reported flow, with the default Markdown option back on: change folder, search, press convert.
    await page.getByText('설정', { exact: true }).first().click();
    await page.getByRole('switch', { name: /AI가 읽기 편한 md 파일도 생성/ }).click();
    for (let i = 0; i < 50 && (await page.evaluate(() => window.hwp2x.state())).makeMarkdown !== true; i++) await page.waitForTimeout(100);
    const second = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-ui-second-'));
    await fs.writeFile(path.join(second, '두번째.hwpml'), '<?xml version="1.0" encoding="UTF-8"?><HWPML Version="2.8"><HEAD SecCnt="1"></HEAD><BODY><SECTION Id="0"><P><TEXT><CHAR>폴더 변경</CHAR></TEXT></P></SECTION></BODY></HWPML>');
    await app.evaluate(({ dialog }, dir) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [dir] }); }, second);
    await page.getByRole('button', { name: '폴더 선택', exact: true }).click();
    for (let i = 0; i < 50 && !(await page.evaluate(() => window.hwp2x.state())).files.some(file => file.name === '두번째.hwpml'); i++) await page.waitForTimeout(100);
    await page.getByText('개요', { exact: true }).first().click();
    await page.getByRole('button', { name: '검색한 파일 변환', exact: true }).click();
    await waitPhase(page, 'done');
    assert.ok((await fs.readFile(path.join(second, '두번째.hwpx'))).subarray(0, 2).equals(Buffer.from('PK')), '바꾼 폴더 변환');
    assert.match(await fs.readFile(path.join(second, '두번째.md'), 'utf8'), /폴더 변경/);
    await fs.rm(second, { recursive: true, force: true });
    await assert.rejects(fs.stat(path.join(off,'끔.md')), '옵션 끄면 MD 미생성');
    await fs.rm(off, {recursive:true, force:true});
    // 좁은 폭: 사이드바가 위로 접히고 본문이 가로로 잘리지 않아야 함
    await page.setViewportSize({width:560, height:820});
    await page.getByText('개요', {exact:true}).first().click();
    await page.waitForTimeout(300);
    const narrow = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth - window.innerWidth, navTop: [...document.querySelectorAll('div')].find(d => d.textContent.trim().startsWith('개요') && d.getAttribute('style')?.includes('height:38px'))?.getBoundingClientRect().top }));
    assert.ok(narrow.overflow <= 1, `좁은 폭 가로 넘침 ${narrow.overflow}px`);
    await page.screenshot({path:'dist-electron/evidence/narrow.png'});
    await page.getByText('파일', {exact:true}).first().click();
    await page.setViewportSize({width:1240, height:840});
    // Converted originals can now be copied to the backup folder once a run has finished.
    const backup = page.getByRole('button', {name:/^원본 백업/});
    for (let i = 0; i < 40 && await backup.isDisabled(); i++) await page.waitForTimeout(100);
    assert.equal(await backup.isDisabled(), false, '변환 완료 후 원본 백업 가능');
    await fs.mkdir('dist-electron/evidence', {recursive:true});
    await page.screenshot({path:'dist-electron/evidence/files.png'});
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({phase:state.phase, counts:state.counts, markdown:true, originalsPreserved:true, rendererErrors:errors}));
  } finally { await app.close(); await fs.rm(root,{recursive:true,force:true}); }
})().catch(error => { console.error(error); process.exitCode=1; });
