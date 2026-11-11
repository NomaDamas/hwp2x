const {_electron}=require('playwright');
const fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto');
(async()=>{
 const temp=await fs.mkdtemp(path.join(os.tmpdir(),'hwp2x-inventory-'));
 const sample='/tmp/hwp2x-real/공고문.hwp', original=await fs.readFile(sample);
 const docs=path.join(temp,'실제 문서');await fs.mkdir(docs);await fs.writeFile(path.join(docs,'공고문.hwp'),original);
 const exe=process.env.HWP2X_EXECUTABLE||path.resolve('dist-electron/linux-unpacked/hwp2x');
 const app=await _electron.launch({executablePath:exe,args:['--no-sandbox',`--user-data-dir=${temp}/profile`],env:{...process.env,XDG_CONFIG_HOME:path.join(temp,'config'),HWP2X_START_ROOT:docs}});
 const observations=[];
 try{
  const page=await app.firstWindow();await page.waitForFunction(()=>typeof window.hwp2x?.state==='function');
  for(const label of ['특정 폴더 변환','전체 자동 변환','파일','설정']){
   await page.getByRole('button',{name:new RegExp('^'+label+'( \\d+)?$')}).first().click();
   await page.waitForTimeout(300);
   observations.push({screen:label,controls:await page.locator('button,input,[role=button],[role=switch],[role=radio]').evaluateAll(nodes=>nodes.filter(n=>n.getClientRects().length).map(n=>({text:(n.getAttribute('aria-label')||n.innerText||n.parentElement?.innerText||'').trim().slice(0,160),role:n.getAttribute('role')||n.tagName,disabled:n.disabled||n.getAttribute('aria-disabled')==='true'})))});
  }
  await page.getByRole('button',{name:'로그 보기',exact:true}).click();await page.getByRole('dialog',{name:'상세 로그'}).waitFor();observations.push({screen:'로그 대화상자',text:await page.getByRole('dialog').innerText()});await page.keyboard.press('Escape');
  const info=await app.evaluate(({app})=>({version:app.getVersion(),packaged:app.isPackaged}));
  if(!info.packaged)throw Error('배포 패키지가 아님');
  if(!original.equals(await fs.readFile(sample)))throw Error('원본 변경');
  await fs.writeFile(path.join(__dirname,'observed.json'),JSON.stringify({executable:exe,info,sourceHash:crypto.createHash('sha256').update(original).digest('hex'),observations,scope:'실제 패키지의 기본 화면·로그 모달 관측. 변환·Windows·모든 오류 상태의 합격 증거가 아님'},null,2));
  console.log('실제 패키지 4개 메뉴·로그 대화상자 관측, 원본 불변');
 }finally{await app.evaluate(({app})=>app.quit()).catch(()=>{});await app.close().catch(()=>{});}
})().catch(e=>{console.error(e);process.exitCode=1});
