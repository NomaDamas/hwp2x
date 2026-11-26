// Run after build: xvfb-run -a node electron/cleanup-flow-check.cjs
// Real sample copies, conversion, Electron UI and filesystem; no state or IPC mocks.
const { _electron } = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const source = '/tmp/hwp2x-real/공고문.hwp';
const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, label) {
  const end = Date.now() + 240000;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(20); }
  throw new Error(`시간 초과: ${label}`);
}
async function exists(file) { try { await fs.access(file); return true; } catch (e) { if (e.code === 'ENOENT') return false; throw e; } }
async function walk(dir) {
  const files = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(file)); else files.push(file);
  }
  return files;
}
(async () => {
  const originalHash = await digest(source);
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-cleanup-real-'));
  const evidence = { temp, source, originalHash, checks: [], errors: [] };
  const note = (name, details) => { evidence.checks.push({ name, details }); console.log(`통과: ${name}`); };
  let app, page;
  const close = async () => {
    if (!app) return;
    await app.evaluate(({ app }) => app.quit()).catch(() => {});
    await app.close(); app = undefined;
  };
  try {
    for (let round = 1; round <= 2; round++) {
      for (const scenario of ['complete', 'conflict', 'corrupt', 'double-corrupt', 'cancel']) {
        const name = `${round}-${scenario}`;
        const base = path.join(temp, name), root = path.join(base, '문서'), backupDir = path.join(base, '백업');
        const autoRoot = path.join(base, '자동'), config = path.join(base, 'config');
        await Promise.all([root, backupDir, autoRoot, config].map(dir => fs.mkdir(dir, { recursive: true })));
        const count = scenario === 'cancel' ? 400 : 4;
        for (let i = 0; i < count; i++) await fs.copyFile(source, path.join(root, `${String(i).padStart(3, '0')}-공고문.hwp`));
        const args = ['--no-sandbox', `--user-data-dir=${path.join(base, 'profile')}`, ...(process.env.HWP2X_EXECUTABLE ? [] : [path.resolve(__dirname, '..')])];
        app = await _electron.launch({ ...(process.env.HWP2X_EXECUTABLE ? { executablePath: process.env.HWP2X_EXECUTABLE } : {}), args, env: { ...process.env, XDG_CONFIG_HOME: config, HWP2X_TEST_HOOKS: '1', HWP2X_START_ROOT: root, HWP2X_AUTO_ROOTS: JSON.stringify([autoRoot]) }, timeout: 30000 });
        page = await app.firstWindow();
        page.on('pageerror', error => evidence.errors.push(`${name}: ${error.message}`));
        await page.waitForFunction(() => typeof window.hwp2x?.cleanupState === 'function');
        const state = () => page.evaluate(() => window.hwp2x.state());
        const cleanup = () => page.evaluate(() => window.hwp2x.cleanupState());
        await page.evaluate(async ({ root, backupDir }) => { await window.hwp2x.configure({ backupDir, workers: 4 }); await window.hwp2x.scan(root); await window.hwp2x.start(); }, { root, backupDir });
        await until(async () => (await state()).phase === 'done', `${name} 실제 변환`);
        const converted = await state();
        assert.equal(converted.files.length, count);
        for (const file of converted.files) {
          assert.equal(file.status, 'ok', `${file.name} 실제 변환 성공`);
          assert.equal(file.owned?.status, 'ok');
          assert.equal(await digest(file.source), originalHash);
          assert.equal(await digest(file.target), file.owned.targetHash);
        }
        const unchangedOutputs = async () => { for (const file of converted.files) assert.equal(await digest(file.target), file.owned.targetHash, 'HWPX 유지'); };
        const restoredSources = async () => { for (const file of converted.files) assert.equal(await digest(file.source), originalHash, '원본 SHA-256 복원'); };
        await page.getByRole('button', { name: '설정', exact: true }).click();
        const start = page.getByRole('button', { name: '백업 후 삭제 시작', exact: true });
        await start.waitFor();
        assert.equal(await start.isDisabled(), true, '동의 전 실행 차단');
        for (const text of ['서식까지 같다는 보증', '확인이 끝난 원본은 같은 폴더의 숨김 안전보관본과', '원래 이름의 파일은 원래 위치에서 사라진다']) await page.getByRole('checkbox', { name: new RegExp(text) }).check();
        await until(async () => !(await start.isDisabled()), '동의 후 실행 가능');
        if (scenario === 'complete') {
          await page.getByRole('button', { name: '전체 자동 변환', exact: true }).click();
          await page.getByRole('button', { name: /자동 변환 시작/ }).click();
          await until(async () => (await page.evaluate(() => window.hwp2x.autoState())).enabled, '자동 활성화');
          await page.getByRole('button', { name: '설정', exact: true }).click();
          assert.equal(await start.isDisabled(), true, '자동 모드 정리 버튼 잠금');
          await assert.rejects(page.evaluate(() => window.hwp2x.cleanupStart(true)), /변환.*중지|자동/);
          await page.getByRole('button', { name: /^전체 자동 변환/ }).click();
          await page.getByRole('button', { name: '자동 변환 중지', exact: true }).click();
          await until(async () => !(await page.evaluate(() => window.hwp2x.autoState())).enabled, '자동 중지');
          await page.getByRole('button', { name: '설정', exact: true }).click();
        }
        // Observe real state transitions without delaying or replacing the engine.
        await page.evaluate(() => {
          window.__cleanupObserved = [];
          window.__cleanupTimer = setInterval(async () => {
            const s = await window.hwp2x.cleanupState();
            if (window.__cleanupObserved.length < 20000) window.__cleanupObserved.push({ ...s, visibleStatus: Array.from(document.querySelectorAll('[role="status"]')).map(el => el.textContent).join(' ') });
          }, 10);
        });
        await start.click();
        if (scenario === 'cancel') {
          await until(async () => { const s = await cleanup(); assert.notEqual(s.phase, 'done', '취소 전에 완료되면 실패'); return s.phase === 'running' && s.processed > 0; }, '일부 삭제 후 취소');
          await page.getByRole('button', { name: '취소하고 복구', exact: true }).click();
          await until(async () => (await cleanup()).phase === 'rolledBack', '취소 자동 복구');
          await restoredSources();
        } else {
          await until(async () => { const s = await cleanup(); assert.notEqual(s.phase, 'error', s.message); return s.phase === 'done'; }, '백업 후 삭제 완료');
          const done = await cleanup();
          assert.equal(done.total, count); assert.equal(done.processed, count); assert.equal(done.percent, 100); assert.equal(done.canRollback, true);
          await page.getByText('완료', { exact: true }).first().waitFor();
          for (const file of converted.files) assert.equal(await exists(file.source), false);
          const backups = (await walk(backupDir)).filter(file => file.endsWith('.hwp'));
          assert.equal(backups.length, count);
          for (const file of backups) assert.equal(await digest(file), originalHash);
          await page.screenshot({ path: path.join(base, 'completed.png'), fullPage: true });
          const conflict = converted.files[0].source;
          const collision = Buffer.from('사용자가 새로 만든 충돌 파일 — 덮어쓰기 금지');
          let damaged, saved, quarantined;
          if (scenario === 'conflict') await fs.writeFile(conflict, collision, { flag: 'wx' });
          if (scenario === 'corrupt' || scenario === 'double-corrupt') {
            const journal = JSON.parse(await fs.readFile(path.join(base, 'profile', 'cleanup.json'), 'utf8'));
            const entry = journal.entries[0];
            damaged = entry.backup; saved = await fs.readFile(damaged);
            assert.equal(await digest(entry.quarantine), originalHash, '격리 원본 보존');
            await fs.writeFile(damaged, '손상된 백업');
            if (scenario === 'double-corrupt') { quarantined = entry.quarantine; await fs.writeFile(quarantined, '손상된 격리 원본'); }
          }
          await page.getByRole('button', { name: '원래 위치로 복구', exact: true }).click();
          await until(async () => ['rolledBack', 'error'].includes((await cleanup()).phase), '복구 결과');
          if (scenario === 'conflict' || scenario === 'double-corrupt') {
            const failed = await cleanup();
            assert.equal(failed.phase, 'error'); assert.equal(failed.canRollback, true);
            assert.match(failed.message, scenario === 'conflict' ? /충돌/ : /손상/);
            if (scenario === 'conflict') { assert.deepEqual(await fs.readFile(conflict), collision); await fs.unlink(conflict); }
            else { await fs.writeFile(damaged, saved); await fs.writeFile(quarantined, saved); }
            for (const file of backups) assert.equal(await digest(file), originalHash, '복구 가능 백업 보존');
            await page.screenshot({ path: path.join(base, 'recoverable-error.png'), fullPage: true });
            await page.getByRole('button', { name: '원래 위치로 복구', exact: true }).click();
            await until(async () => (await cleanup()).phase === 'rolledBack', '충돌/손상 해소 후 복구');
          }
          if (scenario === 'corrupt') {
            assert.equal((await cleanup()).phase, 'rolledBack', '백업 손상에도 격리 원본으로 복구');
            await restoredSources();
            assert.equal(await fs.readFile(damaged, 'utf8'), '손상된 백업', '손상 증거 보존');
            await fs.writeFile(damaged, saved);
          }
          await restoredSources();
        }
        await page.getByText('복구됨', { exact: true }).waitFor();
        await unchangedOutputs();
        assert.equal((await cleanup()).canRollback, false);
        const retained = (await walk(backupDir)).filter(file => file.endsWith('.hwp'));
        assert.ok(retained.length > 0, '복구 후 백업 유지');
        if (scenario !== 'cancel') assert.equal(retained.length, count);
        for (const file of retained) assert.equal(await digest(file), originalHash, '복구 후 백업 SHA-256 유지');
        const observed = await page.evaluate(() => { clearInterval(window.__cleanupTimer); return window.__cleanupObserved; });
        assert.ok(observed.some(s => s.phase === 'running'), '실제 진행 상태 관찰');
        if (scenario === 'cancel') assert.ok(observed.some(s => s.phase === 'running' && /\d+\s*\/\s*\d+개/.test(s.visibleStatus) && /\d+%/.test(s.visibleStatus)), '진행 중 화면 처리 수와 백분율 표시');
        await fs.writeFile(path.join(base, 'states.json'), JSON.stringify(observed, null, 2));
        await page.screenshot({ path: path.join(base, 'restored.png'), fullPage: true });
        note(name, { count, final: await cleanup(), observations: observed.length });
        await close();
      }
    }
    assert.deepEqual(evidence.errors, []);
    evidence.passed = true;
  } catch (error) {
    evidence.passed = false; evidence.failure = String(error.stack || error); process.exitCode = 1;
    if (page && !page.isClosed()) {
      evidence.lastState = await page.evaluate(() => window.hwp2x.cleanupState()).catch(String);
      await page.screenshot({ path: path.join(temp, 'failure.png'), fullPage: true }).catch(() => {});
    }
    console.error(error);
  } finally {
    await close();
    evidence.finalOriginalHash = await digest(source);
    if (evidence.finalOriginalHash !== originalHash) { evidence.passed = false; process.exitCode = 1; evidence.originalChanged = true; }
    await fs.writeFile(path.join(temp, 'result.json'), JSON.stringify(evidence, null, 2));
    console.log(`검사 증거: ${temp}`);
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
