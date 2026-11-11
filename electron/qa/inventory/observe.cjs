const { _electron } = require('playwright');
const fs = require('node:fs/promises'), os = require('node:os'), path = require('node:path'), crypto = require('node:crypto');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
(async () => {
  const evidence = { startedAt: new Date().toISOString(), observations: [], failures: [], unobserved: [], inputs: [], outputs: [], rendererErrors: [], scope: '현재 실제 Linux 패키지의 UI 관측. 상태/변환 mock 없음. OS 폴더 선택 반환만 대체. 최종 패키지 재실행 및 Windows 검증과 별개.' };
  try {
    const prior = JSON.parse(await fs.readFile(path.join(__dirname, 'observed.json'), 'utf8'));
    evidence.previousAttempts = [...(prior.previousAttempts || []), ...(prior.startedAt ? [{ startedAt: prior.startedAt, finishedAt: prior.finishedAt, package: prior.package, failures: prior.failures, observationCount: prior.observations?.length, isolatedPaths: prior.isolatedPaths }] : [])];
  } catch (error) { if (error.code !== 'ENOENT') evidence.previousEvidenceReadError = String(error); }
  let app, page, original, sample;
  const save = () => fs.writeFile(path.join(__dirname, 'observed.json'), JSON.stringify(evidence, null, 2));
  try {
    const catalog = JSON.parse(await fs.readFile(path.join(__dirname, 'controls.json'), 'utf8')).controls;
    const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'hwp2x-inventory-'));
    const docs = path.join(temp, '중간 상태 문서'), complete = path.join(temp, '완료 문서'), empty = path.join(temp, '빈 시작 폴더');
    evidence.isolatedPaths = { temp, docs, complete, empty, profile: path.join(temp, 'profile'), config: path.join(temp, 'config') };
    const autoRoot = path.join(temp, '자동 문서');
    evidence.isolatedPaths.autoRoot = autoRoot;
    sample = process.env.HWP2X_SAMPLE || '/tmp/hwp2x-real/공고문.hwp';
    original = await fs.readFile(sample);
    evidence.source = sample; evidence.sourceHash = hash(original);
    for (const [dir, count] of [[docs, 24], [complete, 3], [empty, 0], [autoRoot, 2]]) {
      await fs.mkdir(dir);
      for (let i = 0; i < count; i++) {
        const file = path.join(dir, `공고문-${String(i + 1).padStart(2, '0')}.hwp`);
        await fs.copyFile(sample, file);
        evidence.inputs.push({ path: file, bytes: original.length, sha256: hash(await fs.readFile(file)) });
      }
    }
    const exe = path.resolve(process.env.HWP2X_EXECUTABLE || 'dist-electron/linux-unpacked/hwp2x');
    evidence.executable = exe;
    evidence.package = { executableSha256: hash(await fs.readFile(exe)), asarPath: path.join(path.dirname(exe), 'resources', 'app.asar') };
    evidence.package.asarSha256 = hash(await fs.readFile(evidence.package.asarPath));
    const env = { ...process.env, XDG_CONFIG_HOME: evidence.isolatedPaths.config, HWP2X_START_ROOT: empty };
    for (const key of Object.keys(env)) if (key.startsWith('HWP2X_TEST_') || key === 'HWP2X_AUTO_ROOTS') delete env[key];
    env.HWP2X_TEST_HOOKS = '1'; env.HWP2X_AUTO_ROOTS = JSON.stringify([autoRoot]);
    evidence.isolation = { folderDialogReturnSubstituted: true, automaticRoots: [autoRoot], testHooks: '자동 스캔 범위 격리에만 사용; 지연·실패·상태·변환 mock 없음', authorization: 'Main이 격리 AUTO_ROOTS 사용 명시 허용' };
    evidence.scope = '현재 실제 Linux 패키지의 UI 관측. 상태/변환 mock 없음. OS 폴더 반환 대체 및 승인된 자동 스캔 루트 격리 사용. 최종 패키지 재실행·Windows 검증과 별개.';
    app = await _electron.launch({ executablePath: exe, args: ['--no-sandbox', `--user-data-dir=${evidence.isolatedPaths.profile}`], env });
    evidence.info = await app.evaluate(({ app }) => ({ version: app.getVersion(), packaged: app.isPackaged }));
    if (!evidence.info.packaged) throw Error('배포 패키지가 아님');
    page = await app.firstWindow(); page.setDefaultTimeout(10000);
    page.on('pageerror', error => evidence.rendererErrors.push(String(error)));
    await page.waitForFunction(() => typeof window.hwp2x?.state === 'function');
    const state = () => page.evaluate(() => window.hwp2x.state());
    const capture = async screen => {
      const s = await state();
      const controls = await page.locator('button,input,textarea,select,[role=button],[role=switch],[role=radio],[role=checkbox]').evaluateAll(nodes => nodes.filter(n => n.getClientRects().length && getComputedStyle(n).visibility !== 'hidden').map(n => ({ text: (n.getAttribute('aria-label') || n.innerText || n.closest('label')?.innerText || '').trim(), role: n.getAttribute('role') || n.tagName.toLowerCase(), type: n.type || null, disabled: !!n.disabled || n.getAttribute('aria-disabled') === 'true', checked: typeof n.checked === 'boolean' ? n.checked : n.getAttribute('aria-checked'), pressed: n.getAttribute('aria-pressed') })));
      for (const c of controls) {
        const normalized = c.text.replace(/\s+/g, ' ').trim();
        const candidates = catalog.filter(item => normalized === item.label || normalized.replace(/\s*\d+$/, '').trim() === item.label).map(item => item.id);
        if (/^\d+개 파일 변환$/.test(normalized)) candidates.push('overview-start');
        if (/^원본 백업 · \d+개$/.test(normalized)) candidates.splice(0, candidates.length, 'backup-open');
        if (normalized === '원본 백업' && screen.startsWith('백업 동의')) candidates.splice(0, candidates.length, 'backup-confirm');
        if (normalized === '취소' && screen.startsWith('백업 동의')) candidates.splice(0, candidates.length, 'backup-cancel');
        if (c.type === 'checkbox' && screen.startsWith('백업 동의')) candidates.splice(0, candidates.length, 'backup-consent');
        c.controlId = candidates.length === 1 ? candidates[0] : null;
        if (candidates.length !== 1) c.mapping = { candidates, reason: candidates.length ? '동일 라벨 복수 항목: 추측하지 않음' : '정확한 라벨 대응 없음' };
      }
      const observation = { screen, at: new Date().toISOString(), phase: s.phase, state: s, controls, visibleText: await page.locator('body').innerText(), automatic: await page.evaluate(() => window.hwp2x.autoState?.()).catch(String), cleanup: await page.evaluate(() => window.hwp2x.cleanupState?.()).catch(String) };
      evidence.observations.push(observation); await save(); return observation;
    };
    const step = async (name, action) => { try { await action(); } catch (error) { evidence.failures.push({ step: name, error: String(error.stack || error) }); await capture(`${name}:실패 시점`).catch(() => {}); await save(); } };
    const until = async (test, label) => {
      const end = Date.now() + 180000;
      while (Date.now() < end) { const s = await state(); if (test(s)) return s; await page.waitForTimeout(100); }
      throw Error(`시간 초과: ${label}; phase=${(await state()).phase}`);
    };
    const button = name => page.getByRole('button', { name, exact: typeof name === 'string' }).first();
    const menu = async label => { await button(new RegExp(`^${label}(\\s+\\d+)?$`)).click(); await page.waitForTimeout(200); };
    const pick = async dir => {
      await app.evaluate(({ dialog }, selected) => {
        const native = dialog.showOpenDialog;
        dialog.showOpenDialog = async (...args) => {
          const options = args[args.length - 1];
          if (options?.properties?.includes('openDirectory')) return { canceled: false, filePaths: [selected] };
          return native.apply(dialog, args);
        };
      }, dir);
      await button(/^(다른 )?폴더 선택$/).click();
      await until(s => s.root === dir && s.phase === 'idle', '폴더 선택');
      await capture(`폴더 선택:${path.basename(dir)}`);
    };
    await capture('초기 특정 폴더 변환');
    await step('변환 중간 상태', async () => {
      await pick(docs); await button(/^\d+개 파일 변환$/).click();
      await until(s => ['converting', 'done'].includes(s.phase), '변환 시작'); await capture('변환 시작');
      for (const [label, phase] of [['일시정지', 'paused'], ['이어하기', 'converting'], ['중지', 'stopped']]) {
        const readyBy = Date.now() + 10000;
        while (Date.now() < readyBy && !(await button(label).isVisible() && await button(label).isEnabled())) {
          if (['done', 'stopped'].includes((await state()).phase)) break;
          await page.waitForTimeout(100);
        }
        if (await button(label).isVisible() && await button(label).isEnabled()) {
          await button(label).click(); await until(s => s.phase === phase, label); await capture(label);
        } else evidence.unobserved.push({ screen: label, reason: `컨트롤 미노출 또는 비활성; 실제 phase=${(await state()).phase}` });
      }
    });
    await step('완료', async () => {
      await menu('특정 폴더 변환');
      const s = await state();
      if (['converting', 'paused'].includes(s.phase)) { await button('중지').click(); await until(s => s.phase === 'stopped', '중지'); }
      await pick(complete); await button(/^\d+개 파일 변환$/).click();
      await until(s => s.phase === 'done', '실제 완료'); await capture('완료');
      for (const entry of await fs.readdir(complete)) if (entry.endsWith('.hwpx')) { const file = path.join(complete, entry), bytes = await fs.readFile(file); evidence.outputs.push({ path: file, bytes: bytes.length, sha256: hash(bytes) }); }
      if (evidence.outputs.length !== 3) throw Error(`완료 폴더 실제 HWPX ${evidence.outputs.length}/3`);
    });
    await step('파일 필터 상세', async () => {
      await menu('파일'); await capture('파일 전체');
      const filters = page.locator('[role=button][aria-pressed]');
      const count = await filters.count();
      for (let i = 0; i < count; i++) { const label = await filters.nth(i).innerText(); await filters.nth(i).click(); await page.waitForTimeout(200); await capture(`파일 필터:${label}`); }
      await filters.first().click(); await page.waitForTimeout(200);
      await page.locator('[role=button]').filter({ hasText: '공고문-01.hwp' }).first().click();
      await button('상세 닫기').waitFor(); await capture('파일 상세'); await button('상세 닫기').click();
    });
    await step('백업 동의 모달', async () => {
      await button(/^원본 백업 · \d+개$/).click(); await page.getByRole('dialog').waitFor(); await capture('백업 동의 전 모달');
      await page.getByRole('dialog').getByRole('checkbox').check(); await capture('백업 동의 후 모달');
      await page.getByRole('dialog').getByRole('button', { name: '취소', exact: true }).click();
    });
    await step('설정 cleanup 동의 전', async () => {
      if (await page.getByRole('dialog').count()) await page.keyboard.press('Escape');
      await menu('설정'); await capture('설정 cleanup 동의 전');
      if (!await button('백업 후 삭제 시작').isDisabled()) throw Error('cleanup 동의 전 실행 버튼 활성');
      evidence.cleanupConsentGate = { observed: true, disabled: true, executed: false };
    });
    await step('자동 변환', async () => {
      await menu('전체 자동 변환'); await capture('자동 변환 시작 전');
      const auto = () => page.evaluate(() => window.hwp2x.autoState());
      const waitAuto = async test => { const end = Date.now() + 180000; while (Date.now() < end) { const a = await auto(); if (test(a)) return a; if (a.phase === 'error') throw Error(a.message); await page.waitForTimeout(100); } throw Error('자동 변환 대기 시간 초과'); };
      await button('자동 변환 시작').click();
      const started = await waitAuto(a => a.enabled);
      if (JSON.stringify(started.roots) !== JSON.stringify([autoRoot])) throw Error('자동 격리 루트 불일치');
      await capture('자동 start');
      await waitAuto(a => a.phase === 'watching' && a.processed >= 2); await capture('자동 watch');
      const incoming = path.join(autoRoot, '감시 신규.hwp'); await fs.copyFile(sample, incoming);
      evidence.inputs.push({ path: incoming, bytes: original.length, sha256: hash(await fs.readFile(incoming)) });
      await waitAuto(a => a.phase === 'watching' && a.processed >= 3); await capture('자동 신규 파일 감지 후 watch');
      for (const entry of await fs.readdir(autoRoot)) if (entry.endsWith('.hwpx')) { const file = path.join(autoRoot, entry), bytes = await fs.readFile(file); evidence.outputs.push({ path: file, bytes: bytes.length, sha256: hash(bytes) }); }
      await button('자동 변환 중지').click(); await waitAuto(a => !a.enabled && a.phase === 'stopped'); await capture('자동 stop');
    });
    await step('로그', async () => { await menu('설정'); await button('로그 보기').click(); await page.getByRole('dialog', { name: '상세 로그' }).waitFor(); await capture('로그 대화상자'); await page.keyboard.press('Escape'); });
  } catch (error) { evidence.failures.push({ step: '실행 준비 또는 초기화', error: String(error.stack || error) }); }
  finally {
    if (original) { try { evidence.sourceUnchanged = original.equals(await fs.readFile(sample)); if (!evidence.sourceUnchanged) evidence.failures.push({ step: '원본 불변', error: '원본 바이트 변경' }); } catch (error) { evidence.failures.push({ step: '원본 불변', error: String(error) }); } }
    if (app) { await app.evaluate(({ app }) => app.quit()).catch(() => {}); await app.close().catch(error => evidence.failures.push({ step: '앱 종료', error: String(error) })); }
    evidence.finishedAt = new Date().toISOString(); evidence.executionSucceeded = evidence.failures.length === 0; evidence.coverageComplete = evidence.executionSucceeded && evidence.unobserved.length === 0;
    await save(); console.log(JSON.stringify({ observations: evidence.observations.length, failures: evidence.failures, unobserved: evidence.unobserved, sourceUnchanged: evidence.sourceUnchanged }));
    if (!evidence.executionSucceeded) process.exitCode = 1;
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
