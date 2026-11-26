// 실행: node electron/windows-path-check.cjs
// 실제 dist/main.js와 dist/engine.js를 실행한다. Windows/NTFS/COM 실행 검사는 아니다.
// 경계 대역: path.win32, 읽기 전용 메모리 FS, Electron, 한컴 탐색, 로거.
// process.platform은 호스트 그대로다. 전역 require를 바꾸지 않고 VM별 require만 주입한다.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const win = path.win32;
const root = 'C:\\사용자\\바꾼폴더';
const oldRoot = 'C:\\사용자\\이전폴더';
const checkpoint = 'C:\\프로필\\conversion-state.json';
const manual = 'C:\\사용자\\한컴 설치\\Hwp.exe';
let passed = 0;
let failed = 0;
async function check(name, body) {
  try { await body(); passed++; console.log(`통과: ${name}`); }
  catch (error) { failed++; console.error(`실패: ${name}\n${error.stack}`); }
}
function missing(p) { return Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' }); }
function memoryFS() {
  const records = new Map();
  const calls = [];
  const key = p => win.normalize(p).toLowerCase();
  const put = (p, dir, content = '') => records.set(key(p), { path: p, dir, content });
  put(root, true);
  put(`${root}\\보고서.HWP`, false, 'hwp fixture');
  put(`${root}\\하위 폴더`, true);
  put(`${root}\\하위 폴더\\한글.hwpml`, false, 'hwpml fixture');
  put(oldRoot, true);
  put(`${oldRoot}\\이전.hwp`, false, 'old');
  const api = {
    async stat(p) {
      calls.push(['stat', p]);
      const item = records.get(key(p));
      if (!item) throw missing(p);
      return { isDirectory: () => item.dir, isFile: () => !item.dir, size: Buffer.byteLength(item.content) };
    },
    async readdir(p, options) {
      calls.push(['readdir', p]);
      assert.equal(options.withFileTypes, true);
      const item = records.get(key(p));
      if (!item || !item.dir) throw missing(p);
      return [...records.values()].filter(x => key(x.path) !== key(p) && key(win.dirname(x.path)) === key(p)).map(x => ({
        name: win.basename(x.path), isDirectory: () => x.dir, isFile: () => !x.dir,
      }));
    },
    async readFile(p, encoding) {
      calls.push(['readFile', p]);
      const item = records.get(key(p));
      if (!item) throw missing(p);
      return encoding === 'utf8' ? item.content : Buffer.from(item.content);
    },
  };
  return { put, calls, api: new Proxy(api, { get(target, name) {
    if (name in target) return target[name];
    return () => { throw new Error(`검사 범위 밖 FS 호출: ${String(name)}`); };
  } }) };
}
function load(name, dependencies, globals = {}) {
  const file = path.join(__dirname, 'dist', `${name}.js`);
  const sourceFile = path.join(__dirname, 'src', `${name}.ts`);
  assert.ok(fs.statSync(file).mtimeMs >= fs.statSync(sourceFile).mtimeMs, `${name}: dist가 소스보다 오래됨; 부모 작업에서 빌드 필요`);
  const module = { exports: {} };
  const sandbox = {
    module, exports: module.exports, __dirname: path.dirname(file), __filename: file,
    Buffer, Error, SyntaxError, console, process, setTimeout, clearTimeout, setInterval, clearInterval,
    require(id) {
      if (Object.hasOwn(dependencies, id)) return dependencies[id];
      if (id.startsWith('node:') && id !== 'node:fs/promises') return require(id);
      throw new Error(`주입하지 않은 의존성: ${id}`);
    },
    ...globals,
  };
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), sandbox, { filename: file });
  return module.exports;
}
function engineModule(storage) {
  const forbidden = () => { throw new Error('이 검사는 문서 변환을 실행하지 않음'); };
  return load('engine', {
    'node:path': win, 'node:fs/promises': storage.api,
    kordoc: new Proxy({}, { get: () => forbidden }), './hancom': { convertWithHancom: forbidden }, './logger': { log: () => {} },
  });
}
async function restoreCase(mutate) {
  const storage = memoryFS();
  const { Engine } = engineModule(storage);
  const source = new Engine();
  await source.scan(root);
  const state = JSON.parse(JSON.stringify(source.state));
  state.files = [state.files[0]];
  state.files[0].target = `${root}\\보고서.hwpx`;
  state.files[0].mdPath = `${root}\\보고서.md`;
  mutate(state);
  storage.put(checkpoint, false, JSON.stringify({ version: 1, state }));
  return new Engine(checkpoint).restore();
}
async function mainHarness(savedPath) {
  const storage = memoryFS();
  storage.put('C:\\프로필\\settings.json', false, JSON.stringify({ manualHancomPath: savedPath }));
  const handlers = new Map();
  const inspected = [];
  let ready;
  let window;
  class BrowserWindow extends EventEmitter {
    constructor() {
      super(); window = this;
      this.webContents = new EventEmitter();
      this.webContents.mainFrame = {};
      this.webContents.setWindowOpenHandler = () => {};
      this.webContents.send = () => {};
    }
    isDestroyed() { return false; }
    async loadFile() {} // 화면 로드는 범위 밖. 탐색은 detect-hancom IPC로 명시 실행.
  }
  const app = new EventEmitter();
  Object.assign(app, {
    whenReady: () => ({ then(fn) { ready = Promise.resolve().then(fn); return ready; } }),
    getPath: name => name === 'userData' ? 'C:\\프로필' : 'C:\\사용자\\문서',
    getVersion: () => '검사용', getLocale: () => 'ko-KR',
  });
  const logger = { initLogger: async () => {}, log() {}, flushLog: async () => {} };
  load('main', {
    electron: { app, BrowserWindow, ipcMain: { handle: (name, fn) => handlers.set(name, fn), on() {} },
      dialog: { showErrorBox: (_title, message) => { throw new Error(message); } }, shell: {} },
    'node:path': win, 'node:fs/promises': storage.api, './engine': engineModule(storage),
    './origin': { isAppFrame: (a, b) => a === b, isSameDocument: () => true },
    './logger': logger, './report': {},
    './hancom': {
      detectHancom: async () => [{ path: manual.toLowerCase(), name: '자동 한컴', available: true }],
      inspectHancomPath: async p => { inspected.push(p); return { path: p, name: '직접 한컴', available: true }; },
    },
  }, {
    process: { platform: process.platform, arch: process.arch, versions: process.versions,
      pid: process.pid, env: { HWP2X_START_ROOT: oldRoot }, on() {} },
    setInterval: () => ({ unref() {} }),
  });
  await ready;
  assert.ok(handlers.has('hwp2x:scan'));
  const invoke = (channel, ...args) => handlers.get(`hwp2x:${channel}`)({ sender: window.webContents, senderFrame: window.webContents.mainFrame }, ...args);
  return { storage, inspected, invoke };
}
(async () => {
  await check('engine: 이전 폴더 검색 후 한글 새 폴더 selectRoot·scan', async () => {
    const storage = memoryFS();
    const { Engine } = engineModule(storage);
    const engine = new Engine();
    await engine.scan(oldRoot);
    assert.equal(engine.state.files[0].source, `${oldRoot}\\이전.hwp`);
    await engine.selectRoot(root);
    assert.equal(engine.state.root, root);
    assert.equal(engine.state.files.length, 0);
    await engine.scan(root);
    assert.equal(engine.state.files.length, 2);
    assert.equal(engine.state.files[0].name, '보고서.HWP');
    assert.equal(engine.state.files[0].dir, root);
    assert.equal(engine.state.files[1].source, `${root}\\하위 폴더\\한글.hwpml`);
    assert.ok(storage.calls.some(([op, p]) => op === 'readdir' && p === root));
  });
  await check('engine: 혼합 구분자·점·상위 이동·끝 역슬래시 정규화', async () => {
    const { Engine } = engineModule(memoryFS());
    for (const input of ['C:/사용자/바꾼폴더/', `${root}\\.`, `${root}\\하위 폴더\\..\\`]) {
      const engine = new Engine();
      await engine.scan(input);
      assert.equal(engine.state.root, root);
      assert.equal(engine.state.files[0].source, `${root}\\보고서.HWP`);
    }
  });
  await check('engine.restore: 정상 한글 경로·대문자 HWP 산출물 허용', async () => {
    assert.equal(await restoreCase(() => {}), true);
  });
  await check('engine.restore: 드라이브 대소문자 차이는 같은 root로 허용', async () => {
    assert.equal(await restoreCase(s => { s.root = s.root.replace('C:', 'c:'); }), true);
  });
  for (const [name, source] of [
    ['형제 폴더', 'C:\\사용자\\다른폴더\\보고서.HWP'],
    ['root 접두사만 같은 폴더', `${root}2\\보고서.HWP`],
    ['상위 탈출', `${root}\\..\\보고서.HWP`],
    ['다른 드라이브', 'D:\\사용자\\바꾼폴더\\보고서.HWP'],
    ['상대경로', '바꾼폴더\\보고서.HWP'],
  ]) await check(`engine.restore: ${name} 거부`, async () => {
    assert.equal(await restoreCase(s => {
      Object.assign(s.files[0], { source, dir: win.dirname(source), name: win.basename(source), target: '', mdPath: '' });
    }), false);
  });
  await check('engine.restore: 다른 파일 산출물 경로 거부', async () => {
    assert.equal(await restoreCase(s => { s.files[0].target = `${root}\\다른.hwpx`; }), false);
  });
  await check('main.scan IPC: Windows 절대경로 및 혼합 구분자로 새 폴더 검색', async () => {
    const { invoke } = await mainHarness(manual);
    for (const input of [root, 'C:/사용자/바꾼폴더/']) {
      const state = await invoke('scan', input);
      assert.equal(state.root, root);
      assert.equal(state.files.length, 2);
      assert.equal(state.files[0].source, `${root}\\보고서.HWP`);
    }
  });
  await check('main.scan IPC: 상대·드라이브 상대·빈 값·비문자열 거부', async () => {
    const { invoke, storage } = await mainHarness(manual);
    const before = storage.calls.length;
    for (const input of ['바꾼폴더\\문서', 'C:바꾼폴더', '', null, 42]) {
      await assert.rejects(invoke('scan', input), /검색할 폴더를 선택하세요/);
    }
    assert.equal(storage.calls.length, before, '잘못된 경로가 FS에 도달함');
  });
  await check('main: 한글·공백 설정 경로 로드 및 한컴 대소문자 중복 제거', async () => {
    const { invoke, inspected } = await mainHarness(manual);
    const state = await invoke('detect-hancom');
    assert.deepEqual(inspected, [manual]);
    assert.equal(state.hancomPath, manual);
    assert.equal(state.hancomCandidates.length, 1);
  });
  await check('main: 상대 한컴 설정 경로 무시', async () => {
    const { invoke, inspected } = await mainHarness('한컴 설치\\Hwp.exe');
    await invoke('detect-hancom');
    assert.deepEqual(inspected, []);
  });
  console.log(`결과: ${passed}개 통과, ${failed}개 실패`);
  console.log('한계: 실제 빌드 구현 + path.win32/메모리 FS/Electron·한컴 탐색 대역; 실제 Windows·NTFS·COM·문서 변환 미검증');
  process.exitCode = failed ? 1 : 0;
})().catch(error => { console.error(error); process.exitCode = 1; });
