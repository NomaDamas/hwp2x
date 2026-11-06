// The screen's setState is asynchronous: right after scan() returns, this.state.snapshot still holds the
// list from before the scan. Starting from that stale list sent no start call after changing folders.
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function load(snapshotBefore) {
  const calls = [];
  const scanned = { phase: 'idle', root: '/selected', files: [{ id: 0 }], makeMarkdown: true };
  const api = {
    state: async () => snapshotBefore,
    pickFolder: async () => '/selected',
    scan: async root => { calls.push(['scan', root]); return scanned; },
    start: async options => { calls.push(['start', options]); return scanned; },
  };
  const context = { window: { hwp2x: api } };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, 'design', 'live.js'), 'utf8'), context);
  // setState never applies synchronously here, like React batching in the real window.
  class Base { setState(update) { this.pending = { ...this.pending, ...update }; } }
  const view = new (context.window.HwpLive(Base))();
  view.state = { ...view.state, snapshot: snapshotBefore };
  return { view, calls };
}

test('다른 폴더를 고르면 검색 직후 화면 갱신을 기다리지 않고 변환을 시작한다', async () => {
  const { view, calls } = load({ phase: 'idle', root: '/old', files: [], makeMarkdown: true });
  await view.choose(true);
  assert.deepEqual(calls.map(call => call[0]), ['scan', 'start']);
  assert.equal(calls[0][1], '/selected');
});

test('검색 위치만 정한 상태에서 시작 버튼을 누르면 검색 후 바로 변환한다', async () => {
  const { view, calls } = load({ phase: 'idle', root: '/selected', files: [], makeMarkdown: true, counts: {} });
  await view.renderVals().start();
  assert.deepEqual(calls.map(call => call[0]), ['scan', 'start']);
});
