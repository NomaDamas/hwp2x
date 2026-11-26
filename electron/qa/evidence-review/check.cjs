'use strict';
const fs = require('node:fs');
const path = require('node:path');
const inventory = path.join(__dirname, '..', 'inventory');
const load = name => JSON.parse(fs.readFileSync(path.join(inventory, name), 'utf8'));
const KEYS = ['normal', 'changed', 'repeated', 'emptyOrInvalid'];

// A scenario counts as real only with a passed direct GUI execution; checkIds/stubs/simulations never promote it.
function classify(scenario) {
  if (scenario?.directExecution?.status === 'passed') return 'real';
  const kinds = (scenario?.execution || []).map(x => x.kind || x.type);
  if (kinds.some(k => /simulation|stub|unit|internal/.test(String(k)))) return 'simulated';
  return 'unverified';
}

function runEvidenceReview({ faultEvidence = [] } = {}) {
  const { controls } = load('controls.json');
  const coverage = load('coverage.json');
  const failures = [];
  if (controls.length !== 119) failures.push(`항목 수 ${controls.length} != 119`);
  const byId = new Map(coverage.map(c => [c.controlId, c]));
  const faults = faultEvidence.map(file => {
    const e = JSON.parse(fs.readFileSync(file, 'utf8'));
    const before = e.source?.beforeHash, after = e.source?.afterHash;
    const validHash = typeof before === 'string' && /^[a-f0-9]{64}$/i.test(before);
    return { file, name: e.name, passed: e.passed === true && e.packaged === true && validHash && before === after };
  });
  if (!faultEvidence.length) failures.push('장애 증거 파일이 연결되지 않았습니다');
  const items = controls.map(control => {
    const cov = byId.get(control.id);
    if (!cov) { failures.push(`${control.id}: coverage 없음`); return { id: control.id, verdict: 'fail' }; }
    const scenarios = Object.fromEntries(KEYS.map(k => [k, classify(cov.scenarios?.[k])]));
    const external = cov.disposition?.kind === 'environment-dependent' || cov.disposition?.kind === 'os-surface-unobserved';
    const verdict = KEYS.every(k => scenarios[k] === 'real') ? 'pass' : 'fail';
    return { id: control.id, label: control.label, planStep: cov.planStep, observations: cov.observations?.length || 0, scenarios, disposition: cov.disposition?.kind, externalEnvironment: external ? cov.disposition.reason : null, verdict };
  });
  const failedItems = items.filter(i => i.verdict !== 'pass');
  if (failedItems.length) failures.push(`실제 증거 미충족 ${failedItems.length}/${items.length}`);
  for (const f of faults) if (!f.passed) failures.push(`장애 증거 불합격: ${f.name}`);
  const missingByStep = {};
  for (const item of failedItems) {
    const key = String(item.planStep ?? 'unknown');
    missingByStep[key] ||= { controls: 0, missingScenarios: 0, observedControls: 0 };
    missingByStep[key].controls++;
    missingByStep[key].missingScenarios += KEYS.filter(k => item.scenarios?.[k] !== 'real').length;
    if (item.observations > 0) missingByStep[key].observedControls++;
  }
  return { passed: failures.length === 0, total: items.length, realPassed: items.length - failedItems.length, missingByStep, faults, failures, items, limitation: '화면 관측·stub·내부 IPC·checkIds 연결만으로 행동 시나리오 합격을 인정하지 않음' };
}

module.exports = { runEvidenceReview };
if (require.main === module) {
  const args = process.argv.slice(2);
  if (args[0] !== '--evidence-only') { console.error('사용법: check.cjs --evidence-only [fault evidence.json...]'); process.exit(2); }
  const manifest = path.join(__dirname, 'latest-faults.json');
  const explicitFiles = args.slice(1).filter(arg => arg !== '--details');
  const faultEvidence = explicitFiles.length ? explicitFiles : fs.existsSync(manifest) ? JSON.parse(fs.readFileSync(manifest, 'utf8')) : [];
  const result = runEvidenceReview({ faultEvidence });
  const { items, ...summary } = result;
  console.log(JSON.stringify(args.includes('--details') ? result : { ...summary, failedIds: items.filter(i => i.verdict !== 'pass').map(i => i.id) }));
  process.exitCode = result.passed ? 0 : 1;
}
