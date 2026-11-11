'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { runEvidence, ensureDisplay } = require('./common/evidence.cjs');
const digest = async file => createHash('sha256').update(await fs.readFile(file)).digest('hex');
async function withMedia(evidence, kind, directory, inspect) {
  const record = { kind, directory, commands: [], mounted: false, unmounted: false };
  (evidence.cleanup.media ||= []).push(record);
  const command = (program, args) => {
    const invocation = { program, args }; record.commands.push(invocation);
    try { invocation.stdout = execFileSync(program, args, { encoding: 'utf8', timeout: 30000 }); }
    catch (error) { invocation.error = String(error); invocation.stderr = String(error.stderr || ''); throw error; }
  };
  let mounted = false;
  try {
    command('sudo', ['-n', 'true']);
    const ownership = `uid=${process.getuid()},gid=${process.getgid()}`;
    if (kind === 'tmpfs') command('sudo', ['-n', 'mount', '-t', 'tmpfs', '-o', `size=1m,mode=0700,${ownership}`, 'tmpfs', directory]);
    else {
      const image = path.join(evidence.directory, 'cleanup-fat.img');
      const handle = await fs.open(image, 'wx');
      try { await handle.truncate(16 * 1024 * 1024); } finally { await handle.close(); }
      record.image = image;
      command('mkfs.vfat', [image]);
      command('sudo', ['-n', 'mount', '-t', 'vfat', '-o', `loop,${ownership},umask=0077`, image, directory]);
    }
    mounted = record.mounted = true;
    const info = await fs.statfs(directory);
    record.filesystem = { type: info.type, bytes: info.blocks * info.bsize };
    assert.equal(info.type, kind === 'tmpfs' ? 0x01021994 : 0x4d44);
    if (kind === 'tmpfs') assert.ok(record.filesystem.bytes <= 1024 * 1024);
    await inspect(record);
  } catch (error) { record.failure = String(error.stack || error); throw error; }
  finally {
    if (mounted) {
      command('sudo', ['-n', 'umount', directory]);
      record.unmounted = true;
      assert.notEqual((await fs.statfs(directory)).type, record.filesystem.type, '전용 매체 해제');
    }
  }
}
async function prepare(evidence) {
  evidence.cleanup = { cases: [], limitations: ['실매체 검사 결과는 cleanup.cases 및 cleanup.media 참조; 실행 실패는 통과 아님', 'Windows reparse point 및 exFAT 미검증', '실제 SIGKILL 재시작: cleanup.test의 별도 Node 프로세스이며 패키지 GUI 강제종료는 아님', '접근시간은 해시 읽기로 변경될 수 있음; inode·권한·mtime 검증, ctime/birthtime 복사 보장 아님'] };
  const original = await fs.readFile(evidence.inputs[0].path);
  // A sufficiently large real batch allows cancellation after observed progress without slowing the engine.
  for (let i = 1; i < 160; i++) {
    const file = path.join(evidence.isolatedPaths.docs, `공고문-${i}.hwp`);
    await fs.writeFile(file, original, { flag: 'wx' });
    evidence.inputs.push({ path: file, sha256: evidence.source.beforeHash, bytes: original.length });
  }
  evidence.cleanup.backup = path.join(evidence.directory, 'backup');
  await fs.mkdir(evidence.cleanup.backup);
}
async function inspect({ app, page, evidence, capture }) {
  const state = () => page.evaluate(() => window.hwp2x.state());
  const cleanup = () => page.evaluate(() => window.hwp2x.cleanupState());
  const until = async (check, label) => {
    const deadline = Date.now() + 240000;
    while (Date.now() < deadline) { const value = await check(); if (value) return value; await page.waitForTimeout(10); }
    throw Error(`시간 초과: ${label}`);
  };
  const click = async name => {
    evidence.actions.push({ type: 'click', name: String(name), at: new Date().toISOString() });
    await page.getByRole('button', { name, exact: typeof name === 'string' }).first().click();
  };
  await page.evaluate(async backupDir => { await window.hwp2x.configure({ backupDir, workers: 4 }); }, evidence.cleanup.backup);
  await app.evaluate(({ dialog }, directory) => { dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [directory] }); }, evidence.isolatedPaths.docs);
  evidence.actions.push({ type: 'native-dialog-return', path: evidence.isolatedPaths.docs });
  await click(/^(다른 폴더 선택|폴더 선택)$/);
  await until(async () => (await state()).total === 160, '실제 원본 사본 검색');
  await click(/^160개 파일 변환$/);
  const converted = await until(async () => { const s = await state(); return s.phase === 'done' && s; }, '실제 변환');
  assert.equal(converted.files.length, 160);
  const metadata = new Map();
  for (const file of converted.files) {
    assert.equal(file.status, 'ok'); assert.equal(file.owned?.status, 'ok');
    assert.equal(await digest(file.source), file.owned.sourceHash);
    assert.equal(await digest(file.target), file.owned.targetHash);
    metadata.set(file.source, await fs.stat(file.source));
  }
  evidence.observations.push({ label: '실제 변환 적격성', snapshot: converted });
  await click('설정');
  assert.equal(await page.getByRole('button', { name: '백업 후 삭제 시작', exact: true }).isDisabled(), true);
  for (const text of ['서식까지 같다는 보증', '확인이 끝난 원본은 같은 폴더의 숨김 안전보관본과', '원래 이름의 파일은 원래 위치에서 사라진다']) await page.getByRole('checkbox', { name: new RegExp(text) }).check();
  const journalPath = path.join(evidence.profile, 'cleanup.json');
  const restored = async () => {
    for (const file of converted.files) {
      const before = metadata.get(file.source), after = await fs.stat(file.source);
      assert.equal(after.ino, before.ino); assert.equal(after.mode, before.mode); assert.equal(after.mtimeMs, before.mtimeMs);
      assert.equal(await digest(file.source), file.owned.sourceHash); assert.equal(await digest(file.target), file.owned.targetHash);
    }
  };
  for (let round = 1; round <= 2; round++) {
    for (const scenario of ['cancel', 'complete']) {
      for (const text of ['서식까지 같다는 보증', '확인이 끝난 원본은 같은 폴더의 숨김 안전보관본과', '원래 이름의 파일은 원래 위치에서 사라진다']) await page.getByRole('checkbox', { name: new RegExp(text) }).check();
      await click('백업 후 삭제 시작');
      if (scenario === 'cancel') {
        const running = await until(async () => { const s = await cleanup(); assert.notEqual(s.phase, 'done', '실제 취소 전 완료됨'); assert.notEqual(s.phase, 'error', s.message); return s.phase === 'running' && s.processed > 0 && s; }, '진행 확인');
        evidence.observations.push({ label: `${round} 진행 취소 전`, snapshot: running });
        await click('취소하고 복구');
      } else {
        const done = await until(async () => { const s = await cleanup(); assert.notEqual(s.phase, 'error', s.message); return s.phase === 'done' && s; }, '정리 완료');
        evidence.observations.push({ label: `${round} 완료`, snapshot: done });
        const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
        assert.equal(journal.entries.length, converted.files.length);
        for (const entry of journal.entries) {
          await assert.rejects(fs.stat(entry.source), { code: 'ENOENT' });
          assert.equal(await digest(entry.backup), entry.hash); assert.equal(await digest(entry.quarantine), entry.hash);
        }
        await capture(`${round} 완료: 영구삭제 아닌 백업과 보관`);
        const first = journal.entries[0];
        if (round === 1) {
          const collision = Buffer.from('사용자 새 파일: 덮어쓰기 금지');
          await fs.writeFile(first.source, collision, { flag: 'wx' });
          await click('원래 위치로 복구');
          await until(async () => { const s = await cleanup(); return s.phase === 'error' && s.canRollback; }, '동명 충돌 보존');
          assert.deepEqual(await fs.readFile(first.source), collision);
          assert.equal(await digest(first.quarantine), first.hash);
          evidence.observations.push({ label: '동명 파일 충돌 보존', snapshot: await cleanup() });
          await capture('동명 파일을 덮지 않고 복구 중단');
          await fs.unlink(first.source);
        } else {
          const originalBackup = await fs.readFile(first.backup);
          await fs.writeFile(first.backup, '격리 시험용 백업 손상');
          await click('원래 위치로 복구');
          await until(async () => (await cleanup()).phase === 'rolledBack', '백업 손상시 보관본 복원');
          assert.equal(await digest(first.source), first.hash);
          await fs.writeFile(first.backup, originalBackup);
          evidence.observations.push({ label: '손상 백업 대신 보관본 복원', snapshot: await cleanup() });
        }
        if (round === 1) await click('원래 위치로 복구');
      }
      const result = await until(async () => { const s = await cleanup(); assert.notEqual(s.phase, 'error', s.message); return s.phase === 'rolledBack' && s; }, '원본 복구');
      await restored();
      const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
      for (const entry of journal.entries.filter(entry => entry.intent)) {
        assert.equal(await digest(entry.backup), entry.hash);
        try { assert.equal(await digest(entry.quarantine), entry.hash); }
        catch (error) { if (scenario !== 'cancel' || error.code !== 'ENOENT') throw error; assert.equal(await digest(entry.source), entry.hash); }
      }
      evidence.cleanup.cases.push({ round, scenario, passed: true, retained: journal.entries.filter(entry => entry.intent).length });
      evidence.observations.push({ label: `${round} ${scenario} 복구`, snapshot: result });
      await capture(`${round} ${scenario} 복구`);
    }
  }
  const denied = path.join(evidence.directory, '쓰기 거부 백업');
  await fs.mkdir(denied);
  await fs.chmod(denied, 0o500);
  try {
    await assert.rejects(fs.writeFile(path.join(denied, 'probe'), 'x'), { code: 'EACCES' });
    await page.evaluate(backupDir => window.hwp2x.configure({ backupDir }), denied);
    for (const text of ['서식까지 같다는 보증', '확인이 끝난 원본은 같은 폴더의 숨김 안전보관본과', '원래 이름의 파일은 원래 위치에서 사라진다']) await page.getByRole('checkbox', { name: new RegExp(text) }).check();
    await click('백업 후 삭제 시작');
    const rejected = await until(async () => { const s = await cleanup(); return s.phase === 'error' && s; }, '실제 백업 쓰기 거부');
    await restored();
    assert.deepEqual(await fs.readdir(denied), []);
    evidence.cleanup.cases.push({ scenario: 'actual-EACCES', passed: true, originalMoved: false });
    evidence.observations.push({ label: '실제 쓰기 거부 원본 보존', snapshot: rejected });
    await capture('쓰기 거부 시 원본 이동 없음');
  } finally { await fs.chmod(denied, 0o700); }
  const rejectOnMedia = async (scenario, files, pattern) => {
    for (const text of ['서식까지 같다는 보증', '확인이 끝난 원본은 같은 폴더의 숨김 안전보관본과', '원래 이름의 파일은 원래 위치에서 사라진다']) await page.getByRole('checkbox', { name: new RegExp(text) }).check();
    await click('백업 후 삭제 시작');
    const rejected = await until(async () => { const s = await cleanup(); return ['error', 'rolledBack'].includes(s.phase) && pattern.test(s.message) && s; }, scenario);
    const journal = JSON.parse(await fs.readFile(journalPath, 'utf8'));
    assert.equal(journal.entries.length, files.length);
    for (const entry of journal.entries) {
      assert.equal(entry.intent, false, '원본 이동 의도 기록 이전 거부');
      await assert.rejects(fs.stat(entry.quarantine), { code: 'ENOENT' });
    }
    const hashes = [];
    for (const file of files) {
      const actual = await digest(file.source);
      assert.equal(actual, file.owned.sourceHash);
      assert.equal(await digest(file.target), file.owned.targetHash);
      hashes.push({ path: file.source, before: file.owned.sourceHash, after: actual });
    }
    evidence.cleanup.cases.push({ scenario, passed: true, originalMoved: false, hashes, journal });
    evidence.observations.push({ label: scenario, snapshot: rejected });
    await capture(scenario);
  };
  const full = path.join(evidence.directory, 'full-backup');
  await fs.mkdir(full);
  await withMedia(evidence, 'tmpfs', full, async record => {
    await assert.rejects(fs.writeFile(path.join(full, 'bounded-fill'), Buffer.alloc(1024 * 1024 + 1), { flag: 'wx' }), { code: 'ENOSPC' });
    record.probeError = 'ENOSPC';
    await page.evaluate(backupDir => window.hwp2x.configure({ backupDir }), full);
    await rejectOnMedia('actual-ENOSPC', converted.files, /ENOSPC/);
    await restored();
  });
  const fat = path.join(evidence.directory, 'fat-original');
  await fs.mkdir(fat);
  await fs.copyFile(converted.files[0].source, path.join(fat, '공고문.hwp'), 1);
  // Convert on a supported filesystem, then present identical bytes on FAT:
  // the converter itself publishes via hardlink and cannot create outputs on FAT.
  await page.evaluate(async ({ root, backupDir }) => {
    await window.hwp2x.configure({ backupDir });
    await window.hwp2x.scan(root);
    await window.hwp2x.start();
  }, { root: fat, backupDir: evidence.cleanup.backup });
  const fatConversion = await until(async () => { const s = await state(); return s.root === fat && s.phase === 'done' && s; }, 'FAT용 실제 사전 변환');
  assert.equal(fatConversion.files.length, 1);
  const file = fatConversion.files[0];
  assert.equal(file.status, 'ok'); assert.equal(file.owned?.status, 'ok');
  const sourceBytes = await fs.readFile(file.source), targetBytes = await fs.readFile(file.target);
  await withMedia(evidence, 'vfat', fat, async record => {
    await fs.writeFile(file.source, sourceBytes, { flag: 'wx' });
    await fs.writeFile(file.target, targetBytes, { flag: 'wx' });
    await assert.rejects(fs.link(file.source, path.join(fat, 'link-probe')), error => {
      record.probeError = error.code;
      return ['EPERM', 'EOPNOTSUPP', 'ENOTSUP'].includes(error.code);
    });
    record.conversion = '실제 변환 후 동일 경로·동일 바이트 FAT 매체로 전환; FAT 직접 변환 검증 아님';
    await rejectOnMedia('actual-FAT-hardlink', [file], /EPERM|EOPNOTSUPP|ENOTSUP/);
  });
  evidence.cleanup.unitEvidenceCommand = 'node --test electron/dist/cleanup.test.js';
}
if (require.main === module) {
  if (!process.argv.includes('--packaged')) { console.error('사용법: node electron/qa/cleanup-check.cjs --packaged'); process.exitCode = 1; }
  else if (!ensureDisplay(__filename)) runEvidence('cleanup-check', inspect, prepare).catch(error => { console.error(error); process.exitCode = 1; });
}
