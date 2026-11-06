const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
(async () => {
 const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-resume-ui-'));
 const root = path.join(temp, 'docs'), profile = path.join(temp, 'profile');
 await fs.mkdir(root);
 const xml = '<?xml version="1.0" encoding="UTF-8"?><HWPML Version="2.8"><HEAD SecCnt="1"></HEAD><BODY><SECTION Id="0"><P><TEXT><CHAR>재시작 검증</CHAR></TEXT></P></SECTION></BODY></HWPML>';
 for(let i=0;i<60;i++) await fs.writeFile(path.join(root, `문서${i}.hwpml`),xml);
 const args = ['--no-sandbox', `--user-data-dir=${profile}`];
 const launch = () => _electron.launch({ ...(process.env.HWP2X_EXECUTABLE ? {executablePath:process.env.HWP2X_EXECUTABLE,args} : {args:[...args,'.']}),env:{...process.env,HWP2X_START_ROOT:root,HWP2X_FAKE_HANCOM:''} });
 let app;
 try {
  app = await launch(); let page=await app.firstWindow();
  await page.getByRole('checkbox',{name:'AI가 읽기 편한 md 파일도 생성'}).waitFor();
  assert.equal(await page.getByRole('checkbox',{name:'AI가 읽기 편한 md 파일도 생성'}).isChecked(), true);
  await page.evaluate(()=>window.hwp2x.configure({workers:1}));
  await page.getByRole('button',{name:'검색 후 변환',exact:true}).click();
  for (let i=0;i<150 && (await page.evaluate(()=>window.hwp2x.state())).completed===0;i++) await page.waitForTimeout(100);
  const state=await page.evaluate(()=>window.hwp2x.state());
  assert.ok(state.completed>0,'완료 전 강제 종료');
  assert.equal(state.phase,'converting','완료 전에 강제 종료');
  const complete=state.files.find(f=>f.target && f.mdPath);
  assert.ok(complete);
  const before=await fs.readFile(complete.target), beforeStat=await fs.stat(complete.target);
  app.process().kill('SIGKILL'); await new Promise(resolve=>app.process().once('exit',resolve)); app=undefined;
  app=await launch(); page=await app.firstWindow();
  for (let i=0;i<50 && (await page.evaluate(()=>window.hwp2x.state())).phase!=='paused';i++) await page.waitForTimeout(100);
  await page.getByRole('button',{name:'계속',exact:true}).click();
  for (let i=0;i<900 && (await page.evaluate(()=>window.hwp2x.state())).phase!=='done';i++) await page.waitForTimeout(100);
  assert.equal((await page.evaluate(()=>window.hwp2x.state())).phase,'done');
  const final=await page.evaluate(()=>window.hwp2x.state());
  assert.equal(final.completed,60); assert.equal(final.counts.fail,0); assert.equal(final.counts.skipped,0);
  for(let i=0;i<60;i++) { assert.ok((await fs.readFile(path.join(root,`문서${i}.hwpx`))).subarray(0,2).equals(Buffer.from('PK'))); assert.match(await fs.readFile(path.join(root,`문서${i}.md`),'utf8'),/재시작 검증/); }
  assert.ok((await fs.readFile(complete.target)).equals(before)); assert.equal((await fs.stat(complete.target)).mtimeMs,beforeStat.mtimeMs);
  for(const menu of ['설정','파일','개요']) {await page.getByText(menu,{exact:true}).first().click(); assert.ok(Array.isArray((await page.evaluate(()=>window.hwp2x.state())).files));}
  assert.equal(await page.locator('[role=alert]').count(),0);
  console.log('강제 종료→동일 프로필 재실행→계속: 60개 HWPX·MD 생성, 기존 완료 파일 수정 없음, 전체 메뉴 IPC 정상');
 } finally { if(app)await app.close(); await fs.rm(temp,{recursive:true,force:true}); }
})().catch(e=>{console.error(e);process.exitCode=1});
