const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const root = path.resolve(__dirname, '../..');
const load = name => JSON.parse(fs.readFileSync(path.join(__dirname, 'inventory', name), 'utf8'));
const text = v => typeof v === 'string' && v.trim().length > 0;
const source = p => { assert.ok(!path.isAbsolute(p) && !p.split('/').includes('..')); return fs.readFileSync(path.join(root, p), 'utf8'); };
function audit() {
 const { controls } = load('controls.json');
 const { checks, gaps } = load('checks.json');
 const coverage = load('coverage.json');
 const fixtures = load('fixtures.json');
 assert.ok(controls.length > 40, '주요 버튼만 추린 목록은 전수 목록이 아닙니다');
 const ids = new Set();
 for (const c of controls) {
  assert.ok(!ids.has(c.id), `중복 ${c.id}`); ids.add(c.id);
  for (const k of ['id','surface','label','purpose','input','enabledWhen','success','cancelOrError']) assert.ok(text(c[k]), `${c.id}: ${k}`);
  assert.ok(['wired','dead','conditional'].includes(c.reachability));
  for (const k of ['normal','changed','repeated','emptyOrInvalid']) assert.ok(text(c.scenarios[k]), `${c.id}: 시나리오 ${k}`);
  assert.ok(c.sources.length > 0);
  for (const s of c.sources) assert.ok(text(s.anchor) && source(s.path).includes(s.anchor), `${c.id}: 소스 근거 변경 ${s.path}`);
 }
 const checkIds = new Set(checks.map(c=>c.id)); assert.equal(checkIds.size,checks.length);
 for (const c of checks) {
  assert.ok(source(c.path).includes(c.assertionAnchor), `${c.id}: assertion 근거 없음`);
  assert.ok(text(c.proves) && text(c.doesNotProve));
  assert.ok(['unit','gui','simulation'].includes(c.kind));
 }
 assert.equal(coverage.length,controls.length);
 const covered = new Set();
 for (const c of coverage) {
  assert.ok(ids.has(c.controlId) && !covered.has(c.controlId)); covered.add(c.controlId);
  assert.ok(Array.isArray(c.checkIds)); c.checkIds.forEach(id=>assert.ok(checkIds.has(id),id));
  assert.ok(text(c.unverified) && Number.isInteger(c.planStep));
 }
 assert.ok(gaps.length && fixtures.unavailable.length);
 assert.ok(fixtures.real.sha256.match(/^[a-f0-9]{64}$/));
 assert.equal(fixtures.real.policy,'격리 복사본만 변경');
 const evidence = load('checks.json');
 assert.ok(evidence.runs.length >= 1, '실제 검사 실행 기록 없음');
 for (const run of evidence.runs) {
   source(run.path);
   assert.ok(text(run.command) && Number.isInteger(run.exitCode) && text(run.output));
 }
 for (const check of checks) {
   assert.ok(['passed','failed','not-run'].includes(check.execution?.status));
   if (check.execution.status !== 'not-run') {
     const run = evidence.runs.find(r => r.path === check.path);
     assert.ok(run && (run.exitCode === 0) === (check.execution.status === 'passed'));
   }
 }
 assert.ok(evidence.release.sha256.match(/^[a-f0-9]{64}$/));
 assert.ok(Object.values(evidence.release.matches).every(v => v === true), '배포본과 목록 소스 불일치');
 assert.equal(fixtures.execution.sourceBefore, fixtures.real.sha256);
 assert.equal(fixtures.execution.sourceAfter, fixtures.real.sha256);
 const observed = load('observed.json');
 assert.equal(observed.executionSucceeded, true, '실제 패키지 관측 실패');
 assert.deepEqual(observed.failures, []);
 assert.equal(observed.info.packaged, true);
 assert.equal(digest(observed.executable), observed.package.executableSha256);
 assert.equal(digest(observed.package.asarPath), observed.package.asarSha256);
 assert.equal(digest(fixtures.real.path), fixtures.real.sha256, '지정 원본 해시 변경');
 assert.ok(observed.inputs.length > 0 && observed.outputs.length > 0, '실제 입출력 근거 없음');
 for (const entry of [...observed.inputs, ...observed.outputs]) {
   const relative = path.relative(observed.isolatedPaths.temp, entry.path);
   assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), '격리 경로 밖 입력');
   assert.notEqual(entry.path, fixtures.real.path);
   assert.equal(digest(entry.path), entry.sha256, `실측 파일 변경: ${entry.path}`);
 }
 for (const entry of observed.inputs) assert.equal(entry.sha256, fixtures.real.sha256, '지정 실제 자료의 복사본 아님');
 for (const item of coverage) {
   assert.ok(item.disposition && text(item.disposition.reason));
   for (const scenario of Object.values(item.scenarios)) {
     if (scenario.directExecution?.status === 'passed') {
       const names = scenario.directExecution.states.map(s => typeof s === 'string' ? s : s.screen);
       assert.ok(names.length > 0 && names.every(name => observed.observations.some(s => s.screen === name)), `${item.controlId}: 실제 관측 상태 없음`);
     }
   }
 }
 for (const item of coverage) for (const key of ['normal','changed','repeated','emptyOrInvalid']) {
   const scenario = item.scenarios?.[key];
   assert.ok(scenario && Array.isArray(scenario.checkIds), `${item.controlId}: ${key} 연결 없음`);
   scenario.checkIds.forEach(id => assert.ok(checkIds.has(id)));
   assert.ok(text(scenario.limitation));
 }
 console.log(JSON.stringify({result:'합격표 구조·소스 근거 검사 통과',controls:controls.length,checks:checks.length,gaps:gaps.length,dead:controls.filter(c=>c.reachability==='dead').map(c=>c.id),note:'기능 자체의 합격 판정이 아닙니다. 미검증은 coverage와 gaps에 남습니다.'},null,2));
}
assert.equal(process.argv[2],'--audit-only','지원 명령: --audit-only');
audit();
