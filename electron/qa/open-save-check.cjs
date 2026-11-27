'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { runEvidence, ensureDisplay } = require('./common/evidence.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function normalizeText(value) { return String(value).replace(/<[^>]*>/g, ' ').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[\*_~`]/g, '').replace(/https?:\/\/\S+/g, ' ').replace(/\s+/g, ' ').trim(); }
function meaningfulTokens(value) {
  return normalizeText(value).match(/[\p{L}\p{N}]+/gu)?.filter(token => token.length >= 2) || [];
}
function extractSectionText(file) {
  const xml = execFileSync('unzip', ['-p', file, 'Contents/section0.xml'], { encoding: 'utf8' });
  const text = [...xml.matchAll(/<hp:t(?:\s[^>]*)?>([\s\S]*?)<\/hp:t>/g)].map(match => match[1]).join(' ');
  return normalizeText(text);
}
async function prepare(evidence, options) {
  assert.equal(process.platform, 'linux', '현재 실제 OS 전달 검사는 Linux용입니다');
  const root = evidence.directory;
  const data = path.join(root, 'xdg-data');
  const applications = path.join(data, 'applications');
  await fs.mkdir(applications, { recursive: true });
  await fs.mkdir(evidence.isolatedPaths.config, { recursive: true });
  const receipt = path.join(root, 'os-open.jsonl');
  const handler = path.join(root, 'viewer.cjs');
  // A private MIME application receives real xdg-open requests; no shell API is replaced.
  await fs.writeFile(handler, `const fs=require('node:fs');const {spawn}=require('node:child_process');const {fileURLToPath,pathToFileURL}=require('node:url');const path=require('node:path');let target=process.argv[2];if(target.startsWith('file:'))target=fileURLToPath(target);const dir=fs.statSync(target).isDirectory();const profile=pathToFileURL(path.join(${JSON.stringify(root)},'lo-'+process.pid)).href;const child=dir?spawn('/usr/bin/zenity',['--file-selection','--directory','--filename='+target+'/','--title=열기검사 '+target],{stdio:'ignore',detached:true}):spawn('/usr/bin/libreoffice',['-env:UserInstallation='+profile,'--view','--norestore','--nodefault',target],{stdio:'ignore',detached:true});fs.appendFileSync(${JSON.stringify(receipt)},JSON.stringify({target,at:Date.now(),pid:process.pid,viewerPid:child.pid,viewer:dir?'zenity':'libreoffice'})+'\\n');child.on('exit',code=>process.exit(code||0));`);
  const desktop = 'hwp2x-qa-viewer.desktop';
  await fs.writeFile(path.join(applications, desktop), `[Desktop Entry]\nType=Application\nName=HWP2X isolated QA viewer\nExec="${process.execPath}" "${handler}" %f\nTerminal=false\nMimeType=application/x-hwp;application/haansofthwp;application/x-hwpx;application/zip;application/octet-stream;inode/directory;\n`);
  const types = ['application/x-hwp', 'application/haansofthwp', 'application/x-hwpx', 'application/zip', 'application/octet-stream', 'inode/directory'];
  await fs.writeFile(path.join(evidence.isolatedPaths.config, 'mimeapps.list'), '[Default Applications]\n' + types.map(type => `${type}=${desktop}`).join('\n') + '\n');
  execFileSync('update-desktop-database', [applications]);
  options.env.XDG_DATA_HOME = data;
  options.env.XDG_CURRENT_DESKTOP = 'GNOME';
  evidence.openSave = { receipt, cases: [], boundaries: ['shell.openPath 원함수 호출 유지', '격리 MIME 연결만 사용; 사용자 기본 앱 변경 없음', '폴더 표시는 격리 Zenity 디렉터리 선택기', '저장 대화상자 반환 대체; 실제 디스크 저장과 GUI는 대체하지 않음', 'LibreOffice 창 제목은 문서 렌더링 증명이 아님; 스크린샷 별도 검토 필요'], viewerDisplayVerified: false };
}

async function inspect({ app, page, evidence, capture }) {
  const ctx = evidence.openSave;
  const state = () => page.evaluate(() => window.hwp2x.state({ limit: 100 }));
  const until = async (fn, label, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { const value = await fn(); if (value) return value; await sleep(100); }
    throw Error(`시간 초과: ${label}`);
  };
  const click = async name => {
    evidence.actions.push({ type: 'click', name: String(name), at: new Date().toISOString() });
    await page.getByRole('button', { name, exact: typeof name === 'string' }).first().click();
  };
  const scenario = async (name, fn) => {
    console.log(`시나리오 시작: ${name}`);
    try { await fn(); ctx.cases.push({ name, passed: true }); }
    catch (error) { ctx.cases.push({ name, passed: false, error: String(error.stack || error) }); evidence.failures.push(`${name}: ${error.stack || error}`); }
    await capture(name);
    console.log(`시나리오 결과: ${name} ${ctx.cases.at(-1).passed}`);
  };
  await app.evaluate(({ shell, dialog }) => {
    const original = shell.openPath.bind(shell);
    globalThis.__openSave = { opens: [], saves: [], answer: { canceled: true }, delay: 0 };
    shell.openPath = async target => {
      const record = { target, called: Date.now() };
      globalThis.__openSave.opens.push(record);
      try { record.result = await original(target); return record.result; }
      catch (error) { record.error = String(error); throw error; }
    };
    globalThis.__openSave.originalSave = dialog.showSaveDialog;
    dialog.showSaveDialog = async (_window, options) => {
      globalThis.__openSave.saves.push(options);
      await new Promise(resolve => setTimeout(resolve, globalThis.__openSave.delay));
      return globalThis.__openSave.answer;
    };
  });
  const backup = path.join(evidence.directory, '백업 공백');
  console.log('열기 검사: 설정 및 실제 변환 시작');
  await page.evaluate(backupDir => window.hwp2x.configure({ workers: 1, backupDir }), backup);
  await page.evaluate(root => window.hwp2x.scan(root), evidence.isolatedPaths.docs);
  await until(async () => { const s = await state(); return s.phase === 'idle' && s.total === 1; }, '격리 HWP 검색');
  await click(/^1개 파일 변환$/);
  const done = await until(async () => { const s = await state(); return s.phase === 'done' && s; }, '실제 변환', 180000);
  assert.equal(done.counts.fail, 0);
  const file = done.files[0];
  assert.ok(file.target);
  const { parse, validateHwpx } = await import('kordoc');
  const bytes = await fs.readFile(file.target);
  assert.equal((await validateHwpx(bytes)).ok, true);
  const parsed = await parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(parsed.success, true);
  assert.ok(parsed.markdown.trim());
  const originalBytes = await fs.readFile(file.source);
  const original = await parse(originalBytes);
  assert.equal(original.success, true);
  const sectionText = extractSectionText(file.target);
  const originalTokens = meaningfulTokens(original.markdown);
  assert.ok(originalTokens.length > 0, '원본 본문 텍스트가 비어 있습니다');
  assert.ok(sectionText.length > 0, 'HWPX section XML 본문이 비어 있습니다');
  const sectionCompact = sectionText.replace(/[^\p{L}\p{N}]/gu, '');
  const missing = originalTokens.filter(token => !sectionCompact.includes(token.replace(/[^\p{L}\p{N}]/gu, ''))).slice(0, 10);
  assert.deepEqual(missing, [], `HWPX 본문에 원본 텍스트가 없습니다: ${missing.join(', ')}`);
  evidence.observations.push({ label: 'HWPX section XML 본문 비교', originalChars: originalTokens.join(' ').length, sectionChars: sectionText.length, viewerDisplayVerified: false });
  evidence.outputs.push({ path: file.target, sha256: hash(bytes), bytes: bytes.length });
  const open = async (label, target) => scenario(label, async () => {
    const prior = await app.evaluate(() => globalThis.__openSave.opens.length);
    await click(label === '로그 폴더 열기' ? /로그 폴더 열기$/ : label);
    await until(async () => (await app.evaluate(() => globalThis.__openSave.opens.length)) === prior + 1, '실제 shell 호출');
    const request = await app.evaluate(() => globalThis.__openSave.opens.at(-1));
    assert.equal(request.target, target);
    const receipt = await until(async () => {
      try { return (await fs.readFile(ctx.receipt, 'utf8')).trim().split('\n').map(JSON.parse).find(row => row.target === target && row.at >= request.called); }
      catch (error) { if (error.code !== 'ENOENT') throw error; return null; }
    }, 'OS가 격리 MIME 뷰어에 전달');
    evidence.observations.push({ label, shellRequest: request, osDelivered: true, receipt, documentDisplayVerified: false });
    // Capture the actual desktop independently of the application's screenshot.
    await sleep(2500);
    const image = path.join(evidence.directory, `desktop-${ctx.cases.length}.png`);
    execFileSync('import', ['-window', 'root', image], { timeout: 10000 });
    evidence.screenshots.push({ label: `${label} 실제 데스크톱`, path: image, sha256: hash(await fs.readFile(image)), at: new Date().toISOString() });
    // Only the isolated viewer group started for this receipt is terminated; modal viewer errors must not cover the app.
    try { process.kill(-receipt.viewerPid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await sleep(500);
  });
  // A finished run moves to 파일, where 백업 폴더 열기 and 변환 결과 저장 now sit next to the list.
  await click(/^파일(?:\s+\d+)?$/);
  await open('백업 폴더 열기', backup);
  await page.getByRole('button').filter({ hasText: file.name }).first().click();
  await open('원본 열기', file.source);
  await open('HWPX 열기', file.target);
  await open('폴더 열기', file.dir);
  await page.getByText('설정', { exact: true }).first().click();
  await open('로그 폴더 열기', path.join(evidence.profile, 'logs'));
  await click(/^파일(?:\s+\d+)?$/);
  const report = path.join(evidence.directory, '보고서 공백.json');
  const answer = async (value, delay = 0) => app.evaluate((_, args) => { globalThis.__openSave.answer = args.value; globalThis.__openSave.delay = args.delay; }, { value, delay });
  await scenario('보고서 저장 취소', async () => {
    const before = await fs.readdir(evidence.directory);
    await answer({ canceled: true });
    await click('변환 결과 저장');
    await until(async () => !(await page.getByRole('button', { name: '변환 결과 저장', exact: true }).isDisabled()), '취소 후 GUI 잠금 해제');
    assert.deepEqual(await fs.readdir(evidence.directory), before);
  });
  await scenario('기존 보고서 보존', async () => {
    await fs.writeFile(report, '기존 사용자 보고서\n', { flag: 'wx' });
    const before = hash(await fs.readFile(report));
    await answer({ canceled: false, filePath: report });
    await click('변환 결과 저장');
    await page.getByText(/이미|EEXIST|존재/).first().waitFor();
    assert.equal(hash(await fs.readFile(report)), before);
  });
  await scenario('보고서 두 클릭 단일 저장', async () => {
    const target = path.join(evidence.directory, '새 보고서.json');
    await answer({ canceled: false, filePath: target }, 800);
    const before = await app.evaluate(() => globalThis.__openSave.saves.length);
    evidence.actions.push({ type: 'click', name: '변환 결과 저장 빠른 두 클릭' });
    await page.getByRole('button', { name: '변환 결과 저장', exact: true }).evaluate(button => { button.click(); button.click(); });
    await until(async () => { try { return JSON.parse(await fs.readFile(target, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }, '보고서 실제 저장');
    await sleep(1000);
    assert.equal(await app.evaluate(() => globalThis.__openSave.saves.length), before + 1);
    const saved = JSON.parse(await fs.readFile(target, 'utf8'));
    assert.equal(saved.phase, 'done');
    assert.equal(saved.total, 1);
    evidence.outputs.push({ path: target, sha256: hash(await fs.readFile(target)) });
  });
  await scenario('사라진 원본 열기 거부', async () => {
    await click(/^파일(?:\s+\d+)?$/);
    await page.getByRole('button').filter({ hasText: file.name }).first().click();
    const held = `${file.source}.held`;
    const before = await app.evaluate(() => globalThis.__openSave.opens.length);
    await fs.rename(file.source, held);
    try {
      await click('원본 열기');
      await page.getByText(/파일이나 폴더가 없습니다/).first().waitFor();
      assert.equal(await app.evaluate(() => globalThis.__openSave.opens.length), before);
    } finally { await fs.rename(held, file.source); }
  });
  await scenario('연결 앱 없음 오류 안내 경계', async () => {
    await app.evaluate(({ shell }) => {
      globalThis.__openSave.restoreOpen = shell.openPath;
      shell.openPath = async () => '연결된 앱이 없습니다';
    });
    try {
      await click('원본 열기');
      await page.getByText(/열 수 없습니다: 연결된 앱이 없습니다/).first().waitFor();
      evidence.observations.push({ label: '연결 앱 실패 안내', injectedBoundary: 'shell.openPath 오류 문자열', actualMissingAssociation: false });
    } finally {
      await app.evaluate(({ shell }) => { shell.openPath = globalThis.__openSave.restoreOpen; });
    }
  });
  for (const input of evidence.inputs) assert.equal(hash(await fs.readFile(input.path)), input.sha256);
  assert.equal(hash(await fs.readFile(file.target)), hash(bytes));
  evidence.observations.push({ label: '열기 저장 최종', value: ctx });
  ctx.viewerLimitation = '검사 환경 LibreOffice가 HWPX 본문을 표시하지 않아 OS 뷰어 화면은 미확인. 대신 실제 변환 산출물의 ZIP section XML과 원본 파싱 텍스트를 직접 비교함';
  evidence.observations.push({ label: '외부 뷰어 본문 표시', verified: false, reason: ctx.viewerLimitation });
  const child = app.process();
  await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0].close(); });
  await until(() => child.exitCode !== null || child.signalCode !== null, '열기 검사 앱 종료', 15000);
  assert.equal(child.exitCode, 0);
}

if (!process.argv.includes('--packaged')) {
  console.error('사용법: node electron/qa/open-save-check.cjs --packaged');
  process.exitCode = 2;
} else if (!ensureDisplay(__filename)) runEvidence('open-save-check', inspect, prepare);
