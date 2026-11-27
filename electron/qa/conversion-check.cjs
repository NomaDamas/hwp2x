'use strict';
// Reuses electron/run-flow-check.cjs's real GUI/state flow; only the native dialog return is substituted.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { runEvidence, ensureDisplay } = require('./common/evidence.cjs');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const buffer = bytes => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);

async function prepareProfile(evidence) {
  const base = path.join(evidence.directory, 'conversion');
  const roots = Object.fromEntries(['controls', 'on', 'off', 'empty', 'damaged'].map(key => [key, path.join(base, key)]));
  for (const root of Object.values(roots)) await fs.mkdir(root, { recursive: true });
  evidence.conversion = { roots, protectedOutputs: [], cases: [], limitations: [], sourceSiblings: [] };
  // Observe existing sibling outputs without ever selecting the original directory in the GUI.
  for (const extension of ['.hwpx', '.md']) {
    const file = evidence.source.path.replace(/\.hwp$/i, extension);
    try { evidence.conversion.sourceSiblings.push({ path: file, sha256: hash(await fs.readFile(file)) }); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  const original = await fs.readFile(evidence.inputs[0].path);
  const copy = async (root, relative, readOnly = false) => {
    const file = path.join(root, relative);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, original, { flag: 'wx' });
    if (readOnly) await fs.chmod(file, 0o444);
    evidence.inputs.push({ path: file, sha256: hash(original), bytes: original.length, readOnly });
    return file;
  };
  for (let i = 0; i < 40; i++) await copy(roots.controls, `하위 묶음 ${i % 4}/공고문 ${i}.hwp`);
  const long = path.join(...Array.from({ length: 20 }, (_, i) => `긴 한글 경로 공백 ${i}`), '읽기 전용 공고문.hwp');
  const readOnly = await copy(roots.on, long, true);
  await copy(roots.on, '하위 폴더/공고문.hwp');
  await fs.symlink(readOnly, path.join(roots.on, '링크 공고문.hwp'));
  await fs.symlink(roots.on, path.join(roots.on, '순환 폴더 링크'), 'dir');
  evidence.conversion.pathCases = { readOnly, mode: (await fs.stat(readOnly)).mode & 0o777, longPathCharacters: readOnly.length, longPathBytes: Buffer.byteLength(readOnly), symlinkTarget: readOnly };
  assert.ok(readOnly.length > 260, '긴 경로는 260자 초과');
  await copy(roots.off, '다른 하위 폴더/공고문.hwp');
  await copy(roots.damaged, '정상 공고문.hwp');
  const corrupt = path.join(roots.damaged, '손상 오류주입.hwp');
  const damaged = original.subarray(0, 24);
  await fs.writeFile(corrupt, damaged, { flag: 'wx' });
  evidence.inputs.push({ path: corrupt, sha256: hash(damaged), bytes: damaged.length, errorInjection: true });
}

async function inspect({ app, page, evidence, capture }) {
  const { parse, validateHwpx } = await import('kordoc');
  const context = evidence.conversion;
  const state = () => page.evaluate(() => window.hwp2x.state({ limit: 200 }));
  const observe = async label => {
    const snapshot = await state();
    evidence.observations.push({ label, at: new Date().toISOString(), snapshot });
    return snapshot;
  };
  const until = async (predicate, label) => {
    const deadline = Date.now() + 180000;
    while (Date.now() < deadline) {
      const snapshot = await state();
      if (predicate(snapshot)) { evidence.observations.push({ label, at: new Date().toISOString(), snapshot }); return snapshot; }
      await page.waitForTimeout(100);
    }
    await observe(`시간 초과: ${label}`);
    throw Error(`시간 초과: ${label}`);
  };
  const click = async name => {
    evidence.actions.push({ type: 'click', name: String(name), at: new Date().toISOString() });
    await page.getByRole('button', { name, exact: typeof name === 'string' }).first().click();
  };
  // A finished run moves to 파일; the 특정 폴더 변환 menu is the way back to the folder-picking first screen.
  const firstScreen = async () => {
    // A finished run moves to 파일 a moment after 100%; let that happen first so the menu press is not undone by it.
    const phase = (await state()).phase;
    if (phase === 'done') await page.getByPlaceholder('파일 이름 검색').waitFor({ timeout: 10000 });
    // Already on the first screen (a first run, or a folder with nothing to convert): nothing to press.
    if (await page.getByRole('button', { name: '폴더 선택', exact: true }).count()) return;
    evidence.actions.push({ type: 'click', name: '특정 폴더 변환 메뉴' });
    await page.getByRole('button', { name: /^특정 폴더 변환/ }).first().click();
    await page.getByRole('button', { name: '폴더 선택', exact: true }).first().waitFor();
  };
  const select = async (root, expected) => {
    assert.ok(root.startsWith(`${evidence.directory}${path.sep}`), '격리 경로만 선택');
    await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, root);
    evidence.actions.push({ type: 'native-dialog-return', path: root });
    // Stopped/paused runs keep the run screen (다른 폴더 선택); after done the view is on 파일, so the menu opens the first screen.
    if ((await state()).phase === 'stopped') await click('다른 폴더 선택');
    else { await firstScreen(); await click('폴더 선택'); }
    const snapshot = await until(s => s.root === root && s.phase === 'idle', '폴더 재선택 및 검색');
    assert.equal(snapshot.total, expected, `검색 개수: ${root}`);
    assert.ok(snapshot.files.every(file => file.source.startsWith(`${root}${path.sep}`)), '이전 폴더 파일 없음');
    await capture(`폴더 검색 ${path.basename(root)}`);
    return snapshot;
  };
  const markdown = async enabled => {
    const checkbox = page.getByRole('checkbox', { name: 'AI가 읽기 편한 md 파일도 생성' });
    if ((await state()).makeMarkdown !== enabled) {
      evidence.actions.push({ type: 'click', name: 'Markdown 체크박스', enabled });
      await checkbox.click();
    }
    await until(s => s.makeMarkdown === enabled, `Markdown ${enabled ? '켜기' : '끄기'}`);
    await page.waitForFunction(value => document.querySelector('input[type="checkbox"]')?.checked === value, enabled);
  };
  const validate = async (snapshot, enabled) => {
    for (const file of snapshot.files.filter(file => file.target)) {
      assert.ok(file.target.startsWith(`${evidence.directory}${path.sep}`));
      const bytes = await fs.readFile(file.target);
      const structure = await validateHwpx(bytes);
      assert.equal(structure.ok, true, JSON.stringify(structure));
      const parsed = await parse(buffer(bytes));
      assert.equal(parsed.success, true, `결과 파싱: ${file.target}`);
      assert.equal(parsed.fileType, 'hwpx');
      assert.ok(parsed.markdown.trim().length > 0, '결과 본문 비어 있지 않음');
      const source = await parse(buffer(await fs.readFile(file.source)));
      assert.equal(source.success, true);
      const md = file.source.replace(/\.hwp$/i, '.md');
      let markdownHash = null;
      if (enabled) {
        let expected = source.markdown;
        for (const image of source.images || []) expected = expected.split(`(${image.filename})`).join(`(data:${image.mimeType};base64,${Buffer.from(image.data).toString('base64')})`);
        const text = await fs.readFile(md, 'utf8');
        assert.equal(text, expected, 'Markdown은 실제 원본 파싱 결과와 일치');
        markdownHash = hash(text);
        context.protectedOutputs.push({ path: md, sha256: markdownHash });
      } else {
        await assert.rejects(fs.stat(md), { code: 'ENOENT' }, 'MD 끄기에서 미생성');
      }
      const output = { path: file.target, sha256: hash(bytes), bytes: bytes.length, structure, parsed: true, markdownHash, sourceTextLength: source.markdown.length, outputTextLength: parsed.markdown.length, status: file.status, verification: file.verification };
      evidence.outputs.push(output);
      context.protectedOutputs.push({ path: output.path, sha256: output.sha256 });
    }
  };
  const scenario = async (name, work) => {
    try { await work(); context.cases.push({ name, passed: true }); }
    catch (error) { context.cases.push({ name, passed: false, error: String(error.stack || error) }); evidence.failures.push(`${name}: ${error.stack || error}`); }
    finally { await observe(name); await capture(name); }
  };
  try {
    await page.getByText('특정 폴더 변환', { exact: true }).first().waitFor();
    // Same real configuration IPC as the existing run-flow check, not an engine substitute.
    await page.evaluate(() => window.hwp2x.configure({ workers: 1 }));
    evidence.actions.push({ type: 'configure', workers: 1 });
    await scenario('일시정지 이어하기 중지 중복시작', async () => {
      await select(context.roots.controls, 40);
      await markdown(false);
      await click(/^\d+개 파일 변환$/);
      await until(s => s.phase === 'converting', '실제 변환 중');
      evidence.actions.push({ type: 'ipc-negative-probe', name: '실행 중 start 3회' });
      const repeat = await Promise.allSettled([1, 2, 3].map(() => page.evaluate(() => window.hwp2x.start())));
      assert.ok(repeat.every(r => r.status === 'rejected' && /이미 변환 중/.test(String(r.reason))), '중복 시작 거부');
      await until(s => s.completed >= 1 && s.phase === 'converting', '일부 실제 변환');
      await click('일시정지');
      const paused = await until(s => s.phase === 'paused', '일시정지');
      assert.ok(paused.files.some(file => file.status === 'wait'));
      await capture('일시정지');
      await page.waitForTimeout(500);
      assert.equal((await state()).completed, paused.completed, '일시정지 중 처리 수 유지');
      await click('이어하기');
      await until(s => s.phase === 'converting' && s.completed > paused.completed, '이어하기 실제 추가 변환');
      await click('중지');
      const stopped = await until(s => s.phase === 'stopped', '중지');
      assert.ok(stopped.files.some(file => file.status === 'wait'));
      await validate(stopped, false);
    });
    // Recover only through the real GUI if a control assertion failed while a run was active.
    if (['converting', 'paused'].includes((await state()).phase)) {
      await click('중지');
      await until(s => s.phase === 'stopped', '실패 후 안전 중지');
    }
    await scenario('하위폴더 한글 공백 긴경로 읽기전용 링크 및 MD 켜기', async () => {
      await select(context.roots.on, 2);
      await markdown(true);
      await click(/^\d+개 파일 변환$/);
      const done = await until(s => s.phase === 'done', 'MD 켜기 완료');
      assert.equal(done.completed, 2);
      assert.equal(done.counts.fail, 0);
      assert.equal(done.files.filter(file => file.target).length, 2);
      await validate(done, true);
      assert.equal((await fs.stat(context.pathCases.readOnly)).mode & 0o777, 0o444);
      await assert.rejects(fs.stat(path.join(context.roots.on, '링크 공고문.hwpx')), { code: 'ENOENT' });
    });
    await scenario('같은 폴더 반복 및 기존 출력 보존', async () => {
      await firstScreen();
      await click('검색 후 변환');
      const done = await until(s => s.phase === 'done' && s.counts.skipped === 2, '반복 실행 건너뜀');
      assert.equal(done.total, 2);
      for (const file of context.protectedOutputs) assert.equal(hash(await fs.readFile(file.path)), file.sha256, file.path);
    });
    await scenario('다른 폴더 재선택 및 MD 끄기', async () => {
      await select(context.roots.off, 1);
      await markdown(false);
      await click(/^\d+개 파일 변환$/);
      const done = await until(s => s.phase === 'done', 'MD 끄기 완료');
      assert.equal(done.files.filter(file => file.target).length, 1);
      assert.equal(done.counts.fail, 0);
      await validate(done, false);
    });
    await scenario('빈 폴더', async () => {
      await select(context.roots.empty, 0);
      await click('검색 후 변환');
      const empty = await until(s => s.phase === 'idle' && s.total === 0, '빈 폴더 처리');
      assert.equal(empty.completed, 0);
      assert.deepEqual(await fs.readdir(context.roots.empty), []);
    });
    await scenario('손상 파일 오류와 정상 파일 계속 처리', async () => {
      await select(context.roots.damaged, 2);
      await markdown(false);
      await click(/^\d+개 파일 변환$/);
      const done = await until(s => s.phase === 'done', '손상 혼합 완료');
      assert.equal(done.counts.fail, 1);
      const failed = done.files.find(file => file.source.endsWith('손상 오류주입.hwp'));
      assert.equal(failed.status, 'fail');
      assert.ok(failed.message);
      assert.equal(done.files.filter(file => file.target).length, 1);
      await assert.rejects(fs.stat(failed.source.replace(/\.hwp$/, '.hwpx')), { code: 'ENOENT' });
      await validate(done, false);
    });
    await scenario('실제 권한 거부 하위폴더 건너뛰기', async () => {
      const root = path.join(evidence.directory, '권한 검사');
      const denied = path.join(root, '접근 금지');
      await fs.mkdir(denied, { recursive: true });
      const source = path.join(denied, '보존.hwp');
      const bytes = await fs.readFile(evidence.source.path);
      await fs.writeFile(source, bytes);
      await fs.writeFile(path.join(root, '정상.hwp'), bytes);
      await fs.chmod(denied, 0);
      try {
        await assert.rejects(fs.readdir(denied), { code: 'EACCES' }, '실제 OS 권한 거부가 발생해야 함');
        const scanned = await select(root, 1);
        assert.ok(scanned.skippedDirs.includes(denied));
        await click(/^\d+개 파일 변환$/);
        const done = await until(s => s.phase === 'done', '권한 거부 후 정상 문서 완료');
        assert.equal(done.completed, 1);
        assert.equal(done.counts.fail, 0);
        await validate(done, false);
      } finally {
        await fs.chmod(denied, 0o700);
        assert.equal(hash(await fs.readFile(source)), hash(bytes));
        assert.equal(hash(await fs.readFile(path.join(root, '정상.hwp'))), hash(bytes));
        await assert.rejects(fs.stat(path.join(denied, '보존.hwpx')), { code: 'ENOENT' });
      }
      await click(/^파일(?:\s+\d+)?$/);
      await page.getByRole('button').filter({ hasText: '정상.hwp' }).first().click();
      const target = path.join(root, '정상.hwpx');
      const before = hash(await fs.readFile(target));
      assert.equal(await page.getByRole('button', { name: '다시 시도', exact: true }).isDisabled(), true, '완료 파일은 중복 재시도 금지');
      assert.equal(hash(await fs.readFile(target)), before);
      assert.equal((await fs.readdir(root)).filter(name => name.endsWith('.hwpx')).length, 1);
      await capture('완료 파일 GUI 재시도 금지');
    });
  } finally {
    for (const file of [...context.sourceSiblings, ...context.protectedOutputs, ...evidence.inputs]) {
      try { assert.equal(hash(await fs.readFile(file.path)), file.sha256, `보존 SHA-256: ${file.path}`); }
      catch (error) { evidence.failures.push(String(error.stack || error)); }
    }
    context.limitations.push('HWPX 구조 및 재파싱, Markdown 원본 파싱 일치를 검증하며 시각적 서식 무손실은 입증하지 않음');
    await observe('최종 보존 검사');
    await capture('최종 상태');
  }
}

if (require.main === module) {
  if (!process.argv.includes('--packaged')) {
    console.error('사용법: node electron/qa/conversion-check.cjs --packaged');
    process.exitCode = 1;
  } else if (!ensureDisplay(__filename)) {
    runEvidence('conversion-check', inspect, prepareProfile).catch(error => { console.error(error); process.exitCode = 1; });
  }
}
