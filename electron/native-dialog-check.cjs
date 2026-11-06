const {_electron}=require('playwright');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const assert=require('node:assert/strict');
const {execFileSync}=require('node:child_process');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function dialogKey(title,key){
 for(let i=0;i<60;i++) {try{const ids=execFileSync('xdotool',['search','--onlyvisible','--name',title],{encoding:'utf8',stdio:['ignore','pipe','ignore']}).trim().split('\n');
 execFileSync('xdotool',['windowfocus','--sync',ids.at(-1)]);execFileSync('xdotool',['key',...key.split(' ')]);return;}catch{await sleep(100);}}
 throw Error('대화상자 없음: '+title);
}
(async()=>{
 const profile=await fs.mkdtemp(path.join(os.tmpdir(),'hwp2x-native-'));
 const args=['--no-sandbox',`--user-data-dir=${profile}`];
 const app=await _electron.launch({...process.env.HWP2X_EXECUTABLE?{executablePath:process.env.HWP2X_EXECUTABLE,args}:{args:[...args,'.']},env:{...process.env,HWP2X_TEST_HOOKS:'1',HWP2X_TEST_DIALOG:'',HWP2X_TEST_STOP_DELAY_MS:'15000',HWP2X_TEST_CLOSE_TIMEOUT_MS:'500'}});
 const child=app.process();
 try{
 const page=await app.firstWindow();
 await app.evaluate(({shell})=>{shell.openExternal=async url=>{global.opened=url;};});
 for(const menu of ['개요','파일','설정']){await page.getByText(menu,{exact:true}).first().click();assert.ok(Array.isArray((await page.evaluate(()=>window.hwp2x.state())).files));}
 await page.evaluate(()=>window.hwp2x.reportError('NATIVE_TEST_ERROR','검사 중 발생한 오류'));
 await sleep(600);
 const click=page.getByRole('button',{name:'작성 초안 열기',exact:true}).click();
 await dialogKey('버그 리포트','Return');await click;
 let url='';for(let i=0;i<40&&!url;i++){url=await app.evaluate(()=>global.opened||'');await sleep(100);}
 assert.match(url,/^https:\/\/github.com\/NomaDamas\/hwp2x\/issues\/new\?/);assert.ok(decodeURIComponent(url).includes('NATIVE_TEST_ERROR'));
 console.log('ISSUE_URL='+url);
 const closing=app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].close();});
 await dialogKey('종료가 지연되고 있습니다','Tab Return');await closing;
 for(let i=0;i<60&&child.exitCode===null;i++)await sleep(100);
 assert.equal(child.exitCode,0,'강제 종료 버튼으로 종료');
 const names=await fs.readdir(path.join(profile,'logs'));const logfile=path.join(profile,'logs',names.find(n=>n.endsWith('.log')));
 const text=await fs.readFile(logfile,'utf8');assert.ok(text.includes('NATIVE_TEST_ERROR'));assert.ok(text.includes('강제 종료'));
 console.log('LOG_PATH='+logfile);console.log(text.split('\n').filter(l=>l.includes('NATIVE_TEST_ERROR')||l.includes('강제 종료')).join('\n'));
 console.log('실제 대화상자: 이슈 초안 확인·종료 지연 강제 종료 클릭 통과');
 }finally{if(child.exitCode===null)await app.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
