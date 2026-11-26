// The screen's setState is asynchronous: right after scan() returns, this.state.snapshot still holds the
// list from before the scan. Starting from that stale list sent no start call after changing folders.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function load(snapshotBefore) {
  const calls = [];
  const scanned = { phase: 'idle', root: '/selected', total: 1, files: [{ id: 0 }], makeMarkdown: true };
  const api = {
    state: async () => snapshotBefore,
    pickFolder: async () => '/selected',
    scan: async root => { calls.push(['scan', root]); return scanned; },
    start: async options => { calls.push(['start', options]); return scanned; },
  };
  const context = { window: { hwp2x: api }, document: { activeElement: null }, setTimeout, clearTimeout };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'design', 'live.js'), 'utf8'), context);
  // setState never applies synchronously here, like React batching in the real window.
  class Base { setState(update) { this.pending = { ...this.pending, ...update }; } }
  const view = new (context.window.HwpLive(Base))();
  view.state = { ...view.state, snapshot: snapshotBefore };
  return { view, calls };
}

test('다른 폴더를 고르면 검색 직후 화면 갱신을 기다리지 않고 변환을 시작한다', async () => {
  const { view, calls } = load({ phase: 'idle', root: '/old', total: 0, files: [], makeMarkdown: true });
  await view.choose(true);
  assert.deepEqual(calls.map(call => call[0]), ['scan', 'start']);
  assert.equal(calls[0][1], '/selected');
});

test('검색 위치만 정한 상태에서 시작 버튼을 누르면 검색 후 바로 변환한다', async () => {
  const { view, calls } = load({ phase: 'idle', root: '/selected', total: 0, files: [], makeMarkdown: true, counts: {} });
  await view.renderVals().start();
  assert.deepEqual(calls.map(call => call[0]), ['scan', 'start']);
});

// rc.4 shipped a render that referenced removed values and threw on every frame; render every page in both modes.
test('모든 화면은 자동 변환 꺼짐·켜짐 모두에서 오류 없이 계산되고, 켜짐이면 파일 화면에 미처리 목록이 나온다', () => {
  const { view } = load({ phase: 'done', root: '/selected', total: 1, files: [{ id: 0, name: 'a.hwp', status: 'ok', size: 1, targetSize: 1 }], counts: { ok: 1 } });
  for (const auto of [null, { enabled: true, phase: 'watching', pendingIssues: 1, processed: 3, retrying: 0, roots: ['/r'], message: '감시 중' }]) {
    view.state.auto = auto;
    view.state.issues = auto ? { items: [{ source: '/r/승인.hwp', name: '승인.hwp', reason: '처리하지 못함: 사용자 확인 필요', message: '처리하지 못함: 보안 경고 승인 필요', status: 'failed', attempts: 1, updatedAt: Date.now() }], total: 1, offset: 0 } : null;
    for (const page of ['overview', 'auto', 'files', 'settings']) {
      view.state.page = page;
      const values = view.renderVals();
      assert.equal(values.pgFiles, page === 'files');
      if (auto && page === 'files') {
        assert.equal(values.filesAuto, true);
        assert.equal(values.issueRows.length, 1);
        assert.equal(values.issueRows[0].status, '처리하지 못함');
        assert.match(values.issueRows[0].guide, /보안 수준을 낮추지 마세요/);
      }
      if (!auto && page === 'files') assert.equal(values.filesManual, true);
    }
  }
});

test('자동 변환이 화면 밖(트레이·안전 중단)에서 꺼지면 파일 화면에서 사유가 보이는 자동 변환 화면으로 옮긴다', async () => {
  const { view } = load({ phase: 'idle', root: '/r', total: 0, files: [], counts: {} });
  let applied = {};
  view.setState = update => { applied = { ...applied, ...update }; };
  view.alive = true;
  view.state = { ...view.state, page: 'files', auto: { enabled: true }, issueOffset: 200, error: '' };
  const stopped = { enabled: false, phase: 'error', message: '안전 중단: 저장 실패' };
  view.bridge = () => ({ state: async () => ({ phase: 'idle', files: [], counts: {} }), autoState: async () => stopped, cleanupState: async () => ({ phase: 'idle' }) });
  await view.refresh();
  clearTimeout(view.timer);
  assert.equal(applied.page, 'auto');
  assert.equal(applied.issueOffset, 0);
});
