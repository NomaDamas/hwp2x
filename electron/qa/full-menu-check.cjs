'use strict';
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
assert.deepEqual(process.argv.slice(2), ['--packaged']);
const root = path.resolve(__dirname, '../..');
const sample = path.resolve(process.env.HWP2X_SMOKE_HWP || '/tmp/hwp2x-real/공고문.hwp');
const executable = path.resolve(process.env.HWP2X_EXECUTABLE || path.join(root, 'dist-electron/linux-unpacked/hwp2x'));
// Flow checks live outside qa/ and open their own window: give them the packaged app, the real sample and a display.
const flows = { 'run-flow-check.cjs': [], 'folder-change-check.cjs': [{ HWP2X_FOLDER_ROUTE: 'settings' }, { HWP2X_FOLDER_ROUTE: 'overview' }], 'log-view-check.cjs': [], 'auto-load-log-check.cjs': [] };
const suites = ['conversion-check.cjs', 'automatic-check.cjs', 'cleanup-check.cjs', 'gui-controls-check.cjs', 'accessibility-check.cjs', 'support-check.cjs', 'autolaunch-check.cjs', 'lifecycle-check.cjs', 'open-save-check.cjs', ...Object.keys(flows)];
const results = [];
for (let round = 1; round <= 2; round++) {
  for (const suite of suites) {
    const flow = flows[suite];
    const variants = flow ? (flow.length ? flow : [{}]) : [null];
    for (const extra of variants) {
    const args = flow ? ['-a', process.execPath, path.join(root, 'electron', suite)] : [path.join(__dirname, suite), '--packaged'];
    if (suite === 'autolaunch-check.cjs') args.push('--isolated-config');
    const env = flow ? { ...process.env, HWP2X_EXECUTABLE: executable, HWP2X_SMOKE_HWP: sample, ...extra } : process.env;
    // With a display, run node on the script directly: drop xvfb-run's "-a" and the node path.
    const run = spawnSync(flow && !process.env.DISPLAY ? 'xvfb-run' : process.execPath, flow && !process.env.DISPLAY ? args : flow ? args.slice(2) : args, { encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024, env, cwd: root });
    process.stdout.write(run.stdout || '');
    process.stderr.write(run.stderr || '');
    const result = { round, suite: extra?.HWP2X_FOLDER_ROUTE ? `${suite}:${extra.HWP2X_FOLDER_ROUTE}` : suite, passed: !run.error && run.status === 0, exit: run.status, error: run.error?.message };
    results.push(result);
    console.log(JSON.stringify(result));
    }
  }
}
const audit = spawnSync(process.execPath, [path.join(__dirname, 'inventory-check.cjs'), '--evidence-only'], { encoding: 'utf8', timeout: 30000 });
process.stdout.write(audit.stdout || '');
process.stderr.write(audit.stderr || '');
const menuPassed = results.every(result => result.passed);
const auditPassed = !audit.error && audit.status === 0;
console.log(JSON.stringify({ suite: 'full-menu', passed: menuPassed, menuPassed, auditPassed, results, inventoryPassed: auditPassed, limitation: '실제 메뉴 스위트와 정적 증거 감사는 별도 판정. menuPassed는 실제 패키지 GUI 실행 결과이며, auditPassed가 false이면 정적 합격표의 미검증을 함께 기록함' }));
process.exitCode = menuPassed ? 0 : 1;
