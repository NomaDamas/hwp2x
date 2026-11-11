import { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Tray, Menu } from "electron";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isAppFrame, isSameDocument } from "./origin";
import { mkdir, writeFile, stat, readFile, rename } from "node:fs/promises";
import { Engine, mainDrive } from "./engine";
import { closeHancomSession, detectHancom, inspectHancomPath, type HancomCandidate } from "./hancom";
import { flushLog, initLogger, log, logDir, logPath, recentLog } from "./logger";
import { buildIssueUrl } from "./report";
import { AutomaticConverter, systemRoots } from "./automatic";
import { setAutoLaunch } from "./autolaunch";
import { Cleanup } from "./cleanup";
import type { ErrorContract } from "./contracts/state";

let engine: Engine;
let automatic: AutomaticConverter;
let tray: Tray | undefined;
let autoStarting = false;
let cleanup: Cleanup;
let cleanupWork: Promise<void> | undefined;
const page = path.join(__dirname, "..", "design", "app.html");
let window: BrowserWindow;
const recentErrors: string[] = [];
const testHooks = process.env.HWP2X_TEST_HOOKS === "1";
const testDialogs = (process.env.HWP2X_TEST_DIALOG ?? "").split(",").filter(Boolean);
let detectingHancom = false;
let startupNotice = "";
let lastPhase = "";
let shutdown: Promise<void> | undefined;
let exiting = false;
// The Hwp.exe the user picked by hand. It is kept in its own small file (not the run record, which a new
// scan replaces) so it survives restarts and wins over auto-detection while the file still exists.
let manualHancomPath = "";
let settingsPath = "";
async function loadManualHancom(): Promise<void> {
  try {
    const saved = JSON.parse(await readFile(settingsPath, "utf8")) as { manualHancomPath?: unknown };
    manualHancomPath = typeof saved.manualHancomPath === "string" && path.isAbsolute(saved.manualHancomPath) ? saved.manualHancomPath : "";
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") log("warn", "설정 읽기 실패", { message: errorText(error) });
  }
}
async function saveManualHancom(value: string): Promise<void> {
  await mkdir(path.dirname(settingsPath), { recursive: true });
  const temporary = `${settingsPath}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify({ manualHancomPath: value }), "utf8");
  await rename(temporary, settingsPath);
  manualHancomPath = value;
  log("info", "한컴 직접 선택 저장", { manual: value !== "" });
}

function rememberError(message: string): void {
  recentErrors.push(message);
  if (recentErrors.length > 20) recentErrors.shift();
}
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function register(channel: string, handler: (...args: unknown[]) => unknown): void {
  ipcMain.handle(`hwp2x:${channel}`, async (event, ...args) => {
    if (event.sender !== window.webContents || !isAppFrame(event.senderFrame, window.webContents.mainFrame)) {
      throw new Error("허용되지 않은 화면 요청입니다");
    }
    try {
      if (shutdown && !["state", "auto-state", "auto-issues", "cleanup-state", "system-info", "read-log"].includes(channel)) throw new Error("종료 중입니다. 작업 기록 저장이 끝날 때까지 새 작업을 시작할 수 없습니다");
      if (["scan", "start", "pick-folder", "pick-hancom", "pause", "stop"].includes(channel)) log("info", "ipc.request", { channel, phase: engine.state.phase });
      if ((autoStarting || automatic?.snapshot().enabled) && ["scan", "start", "pick-folder", "pick-hancom", "configure", "retry", "backup", "pause", "stop", "detect-hancom"].includes(channel)) {
        throw new Error("전체 자동 변환을 중지한 뒤 특정 폴더 변환을 사용할 수 있습니다");
      }
      if (cleanup?.busy && ["scan", "start", "pick-folder", "pick-hancom", "configure", "retry", "backup", "auto-start", "auto-configure"].includes(channel)) throw new Error("원본 정리 또는 복구가 끝난 뒤 사용할 수 있습니다");
      if (cleanup?.snapshot().phase === "error" && cleanup.snapshot().canRollback && ["scan", "start", "auto-start", "retry"].includes(channel)) throw new Error("원본 복구가 필요합니다. 설정에서 복구를 먼저 완료하세요");
      return await handler(...args);
    } catch (error) {
      const message = errorText(error);
      rememberError(`${channel}: ${message}`);
      const failure: ErrorContract = { message, code: error && typeof error === "object" && "code" in error && typeof error.code === "string" ? error.code : null };
      log("error", "ipc.fail", { channel, ...failure });
      throw error;
    }
  });
}
function systemInfo(): Record<string, unknown> {
  return {
    platform: process.platform,
    arch: process.arch,
    versions: { app: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
    locale: app.getLocale(),
  };
}
function usableCandidate(candidate: HancomCandidate): boolean {
  return candidate.available !== false;
}
function assertSelectionAllowed(): void {
  if (detectingHancom || engine.state.phase === "scanning" || engine.state.phase === "converting") {
    throw new Error("한컴을 감지하거나 변환하는 동안에는 선택을 바꿀 수 없습니다");
  }
}
function notify(kind: "error" | "info", message: string): void {
  if (window && !window.isDestroyed()) window.webContents.send("hwp2x:notice", { kind, message });
}
function publishHancom(status: "detecting" | "ready" | "failed", message: string): void {
  if (window && !window.isDestroyed()) window.webContents.send("hwp2x:hancom-status", { status, message, snapshot: engine.snapshot({ limit: 100 }) });
}
async function askChoice(title: string, message: string, choices: string[], safeChoice = 0): Promise<number> {
  if (testHooks && testDialogs.length > 0) {
    const answer = Number(testDialogs.shift());
    log("info", "test.dialog", { title, answer });
    return Number.isInteger(answer) ? answer : safeChoice;
  }
  const result = await dialog.showMessageBox(window, {
    type: "warning",
    title,
    message,
    buttons: choices,
    defaultId: safeChoice,
    cancelId: safeChoice,
    noLink: true,
  });
  return result.response;
}
async function finishExit(): Promise<void> {
  // The hidden conversion Hwp.exe is ours: close it before exiting so it never outlives the app.
  await Promise.race([closeHancomSession(), delay(5000)]).catch(error => log("warn", "한컴 세션 종료 실패", { message: errorText(error) }));
  await Promise.race([flushLog(), delay(2000)]).catch(() => undefined);
  exiting = true;
  if (window && !window.isDestroyed()) window.destroy();
  app.exit(0);
}
function beginShutdown(): Promise<void> {
  if (shutdown) return shutdown;
  window.setTitle("종료 중… 작업 기록을 저장하고 있습니다");
  notify("info", "종료 중… 작업 기록을 저장하고 있습니다");
  log("info", "종료 시작", { phase: engine.state.phase });
  shutdown = (async () => {
    const stopDelay = testHooks && process.env.HWP2X_TEST_STOP_DELAY_MS ? Number(process.env.HWP2X_TEST_STOP_DELAY_MS) : 0;
    const waiting = (async () => {
      if (stopDelay > 0) await delay(stopDelay);
      if (testHooks && process.env.HWP2X_TEST_SAVE_FAIL === "1") throw new Error("검사용 저장 실패");
      if (cleanup?.busy) { cleanup.cancel(); await cleanupWork; }
      if (automatic?.snapshot().enabled) await automatic.stop();
      await engine.stop();
    })();
    const timeout = testHooks && process.env.HWP2X_TEST_CLOSE_TIMEOUT_MS ? Number(process.env.HWP2X_TEST_CLOSE_TIMEOUT_MS) : 8000;
    let promptCancelled = false;
    const prompt = delay(timeout).then(async () => {
      if (promptCancelled) return "cancelled" as const;
      const answer = await askChoice("종료가 지연되고 있습니다", "작업 기록 저장이 아직 끝나지 않았습니다. 계속 기다리거나 강제 종료할 수 있습니다.", ["기다리기", "강제 종료"]);
      return answer === 1 ? "forced" as const : "wait" as const;
    });
    try {
      const outcome = await Promise.race([waiting.then(() => "saved" as const), prompt]);
      if (outcome === "forced") {
        log("warn", "강제 종료", {});
        await finishExit();
        return;
      }
      await waiting;
      log("info", "종료 완료", {});
      await finishExit();
    } catch (error) {
      promptCancelled = true;
      log("error", "저장 실패", { message: errorText(error) });
      const answer = await askChoice("작업 기록 저장 실패", `작업 기록을 저장하지 못했습니다.\n${errorText(error)}`, ["기다리기", "강제 종료"]);
      if (answer === 1) {
        await finishExit();
        return;
      }
      shutdown = undefined;
      if (!window.isDestroyed()) {
        window.setTitle("hwp2x");
        notify("error", "작업 기록을 저장하지 못해 종료를 취소했습니다. 저장 공간을 확인한 뒤 다시 닫아 주세요.");
      }
    } finally {
      promptCancelled = true;
    }
  })();
  return shutdown;
}
function item(id: unknown) {
  if (typeof id !== "number" || !Number.isSafeInteger(id)) throw new Error("잘못된 파일 번호입니다");
  const found = engine.state.files.find(file => file.id === id);
  if (!found) throw new Error("파일을 찾지 못했습니다");
  return found;
}
// Hand the path to the OS and return at once: on Linux shell.openPath can stay pending after the opener has
// already started, and waiting for it kept every other button locked. A missing target is reported up front;
// a later opener error still reaches the screen as a notice.
async function openPath(target: string): Promise<void> {
  try { await stat(target); } catch { throw new Error(`열 수 없습니다. 파일이나 폴더가 없습니다: ${target}`); }
  void shell.openPath(target).then(error => {
    if (!error) return;
    log("warn", "open.failed", { target, error });
    notify("error", `열 수 없습니다: ${error}`);
  });
}

function handleFatal(kind: string, error: unknown): void {
  const message = errorText(error);
  rememberError(`${kind}: ${message}`);
  log("error", kind, { message });
  try { engine?.pause(); } catch { /* 엔진 초기화 전 오류는 안내만 한다. */ }
  notify("error", `예기치 않은 오류가 발생해 작업을 일시정지했습니다: ${message}`);
  if (window && !window.isDestroyed()) void dialog.showMessageBox(window, { type: "error", title: "예기치 않은 오류", message, buttons: ["확인"] }).catch(() => undefined);
}
process.on("uncaughtException", error => handleFatal("uncaughtException", error));
process.on("unhandledRejection", error => handleFatal("unhandledRejection", error));

// Two copies of the app would launch Hancom at the same time and could no longer tell their Hwp.exe apart:
// a second start just brings the running window forward. (Test runs use their own profile, so they stay separate.)
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
else app.on("second-instance", () => { if (window && !window.isDestroyed()) { window.show(); if (window.isMinimized()) window.restore(); window.focus(); } });

app.whenReady().then(async () => {
  if (!primaryInstance) return;
  const logDirectory = path.join(app.getPath("userData"), "logs");
  await initLogger(logDirectory, systemInfo()).catch(error => { startupNotice = `로그를 시작하지 못했습니다: ${errorText(error)}`; });
  log("info", "app.start", {});
  engine = new Engine(path.join(app.getPath("userData"), "conversion-state.json"));
  engine.state.backupDir = path.join(app.getPath("documents"), "hwp2x_백업");
  settingsPath = path.join(app.getPath("userData"), "settings.json");
  await loadManualHancom();
  let restored = false;
  try { restored = await engine.restore(); }
  catch (error) {
    const message = `이전 작업 복원 실패: ${errorText(error)}`;
    engine.state.message = message;
    startupNotice = message;
    rememberError(message);
    log("error", "초기화 실패", { message });
  }
  automatic = new AutomaticConverter(engine, path.join(app.getPath("userData"), "automatic.json"), async () => {
    if (testHooks && process.env.HWP2X_AUTO_ROOTS) return JSON.parse(process.env.HWP2X_AUTO_ROOTS) as string[];
    return systemRoots();
  });
  await automatic.restore().catch(error => { startupNotice = `자동 변환 설정을 읽지 못했습니다: ${errorText(error)}`; });
  cleanup = new Cleanup(path.join(app.getPath("userData"), "cleanup.json"));
  await cleanup.restore().catch(error => { startupNotice = `원본 복구 기록 확인 필요: ${errorText(error)}`; });
  const refreshHancom = async () => {
    detectingHancom = true;
    publishHancom("detecting", "한컴오피스를 찾고 있습니다");
    try {
      const detected = await detectHancom();
      // A hand-picked Hwp.exe is checked again on every detection: if it was moved or uninstalled it is
      // shown as unavailable with the reason instead of silently falling back.
      let manual: HancomCandidate | undefined;
      if (manualHancomPath) {
        manual = await inspectHancomPath(manualHancomPath).catch(error => ({ path: manualHancomPath, name: "직접 선택한 한컴", available: false, unavailableReason: errorText(error) }));
        manual = { ...manual, name: `${manual.name} (직접 선택)` };
      }
      engine.state.hancomCandidates = manual ? [manual, ...detected.filter(item => item.path.toLowerCase() !== manual!.path.toLowerCase())] : detected;
      const usable = engine.state.hancomCandidates.filter(usableCandidate);
      if (manual && usableCandidate(manual)) engine.state.hancomPath = manual.path;
      else if (!usable.some(candidate => candidate.path === engine.state.hancomPath)) engine.state.hancomPath = usable[0]?.path ?? "";
      if (manual && !usableCandidate(manual)) notify("error", `직접 선택한 한컴을 쓸 수 없어 다른 엔진을 사용합니다: ${manual.unavailableReason ?? "사용할 수 없음"}`);
      log("info", "한컴 감지", { count: engine.state.hancomCandidates.length, usable: usable.length });
      publishHancom("ready", usable.length ? "한컴오피스를 찾았습니다" : "한컴오피스를 찾지 못했습니다");
    } catch (error) {
      const message = `한컴 감지 실패: ${errorText(error)}`;
      rememberError(message);
      log("error", "한컴 감지 실패", { message });
      publishHancom("failed", message);
    } finally {
      detectingHancom = false;
    }
  };
  // Start from the system drive so the user can convert without choosing a folder first.
  if (!restored) await engine.selectRoot(process.env.HWP2X_START_ROOT || mainDrive()).catch(error => {
    const message = `기본 드라이브를 열 수 없습니다: ${errorText(error)}`;
    engine.state.message = message;
    startupNotice ||= message;
    log("error", "초기화 실패", { message });
  });
  window = new BrowserWindow({
    width: 1240, height: 840, minWidth: 980, minHeight: 680,
    title: "hwp2x", backgroundColor: "#efefec", autoHideMenuBar: true,
    show: !(process.argv.includes("--automatic") && automatic.snapshot().resumeAtLogin),
    // Title bar and taskbar icon on Linux/dev runs; packaged Windows builds take the .ico from the exe.
    icon: path.join(__dirname, "..", "icons", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  const showWindow = () => { window.show(); if (window.isMinimized()) window.restore(); window.focus(); };
  tray = new Tray(path.join(__dirname, "..", "icons", "icon.png"));
  tray.setToolTip("hwp2x · 전체 자동 변환");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "hwp2x 열기", click: showWindow },
    { label: "전체 자동 변환 중지", click: () => { void automatic.stop().catch(error => notify("error", errorText(error))); } },
    { type: "separator" },
    { label: "완전히 종료", click: () => { void beginShutdown(); } },
  ]));
  tray.on("click", showWindow);
  register("cleanup-state", () => cleanup.snapshot());
  register("cleanup-start", (consent: unknown) => {
    if (consent !== true) throw new Error("백업 후 원래 위치 삭제에 동의해야 합니다");
    if (engine.running || engine.state.phase === "paused" || autoStarting || automatic.snapshot().enabled) throw new Error("변환을 중지한 뒤 원본을 정리하세요");
    if (cleanup.busy) throw new Error("이미 원본 정리 중입니다");
    cleanupWork = cleanup.start(engine.state.files, engine.state.backupDir).catch(error => notify("error", errorText(error)));
    return cleanup.snapshot();
  });
  register("cleanup-cancel", () => { cleanup.cancel(); return cleanup.snapshot(); });
  register("cleanup-rollback", () => {
    if (engine.running || autoStarting || automatic.snapshot().enabled || cleanup.busy) throw new Error("다른 작업을 중지한 뒤 복구하세요");
    cleanupWork = cleanup.rollback().catch(error => notify("error", errorText(error)));
    return cleanup.snapshot();
  });
  register("auto-state", () => automatic.snapshot());
  register("auto-issues", (options?: unknown) => automatic.issues(options as { offset?: number; limit?: number } | undefined));
  register("auto-retry-issue", async (source: unknown) => {
    if (typeof source !== "string") throw new Error("재작업할 파일을 선택하세요");
    if (cleanup.busy || (cleanup.snapshot().phase === "error" && cleanup.snapshot().canRollback)) throw new Error("원본 복구를 먼저 완료하세요");
    await automatic.retryIssue(source);
    return automatic.snapshot();
  });
  register("auto-start", async () => {
    if (detectingHancom) throw new Error("한컴 감지가 끝난 뒤 시작하세요");
    if (autoStarting) throw new Error("전체 자동 변환을 시작하는 중입니다");
    autoStarting = true;
    try { await automatic.start(); return automatic.snapshot(); }
    finally { autoStarting = false; }
  });
  register("auto-stop", async () => { await automatic.stop(); return automatic.snapshot(); });
  register("auto-configure", async (value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("잘못된 자동 변환 설정입니다");
    const options = value as { background?: boolean; resumeAtLogin?: boolean };
    for (const key of ["background", "resumeAtLogin"] as const) {
      if (options[key] !== undefined && typeof options[key] !== "boolean") throw new Error("참/거짓 설정이 필요합니다");
    }
    const previous = automatic.snapshot();
    if (options.resumeAtLogin !== undefined) await setAutoLaunch(options.resumeAtLogin);
    try { await automatic.configure(options); }
    catch (error) { if (options.resumeAtLogin !== undefined) await setAutoLaunch(previous.resumeAtLogin); throw error; }
    return automatic.snapshot();
  });
  window.on("close", event => {
    if (exiting) return;
    event.preventDefault();
    if (automatic?.snapshot().enabled && automatic.snapshot().background && tray) { window.hide(); return; }
    void beginShutdown();
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (!isSameDocument(url, window.webContents.getURL())) event.preventDefault(); });
  window.webContents.on("render-process-gone", (_event, details) => {
    log("error", "render-process-gone", { reason: details.reason, exitCode: details.exitCode });
    void askChoice("화면 프로세스가 종료되었습니다", "화면을 다시 불러오거나 앱을 종료할 수 있습니다.", ["다시 불러오기", "종료"]).then(answer => {
      if (answer === 1) void beginShutdown();
      else if (!window.isDestroyed()) void window.webContents.reload();
    });
  });
  window.webContents.on("unresponsive", () => {
    log("error", "renderer.unresponsive", {});
    void askChoice("화면이 응답하지 않습니다", "잠시 더 기다리거나 앱을 종료할 수 있습니다.", ["기다리기", "종료"]).then(answer => {
      if (answer === 1) void beginShutdown();
    });
  });
  window.webContents.on("responsive", () => log("info", "renderer.responsive", {}));
  setInterval(() => {
    const phase = engine.state.phase;
    if (phase === lastPhase) return;
    log("info", "상태 전이", { from: lastPhase || "시작", to: phase });
    lastPhase = phase;
  }, 500).unref();
  ipcMain.on("hwp2x:renderer-error", (event, payload: unknown) => {
    if (event.sender !== window.webContents) return;
    if (!payload || typeof payload !== "object") return;
    const source = payload as { message?: unknown; stack?: unknown };
    if (typeof source.message !== "string" || source.message.length > 2000) return;
    if (source.stack !== undefined && (typeof source.stack !== "string" || source.stack.length > 8000)) return;
    rememberError(`renderer: ${source.message}`);
    log("error", "renderer.error", { message: source.message, stack: typeof source.stack === "string" ? source.stack.slice(0, 4000) : undefined });
  });
  register("state", (query?: unknown) => engine.snapshot(query as Parameters<Engine["snapshot"]>[0]));
  register("pick-folder", async () => {
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
    return result.canceled ? "" : result.filePaths[0];
  });
  register("scan", async (root: unknown) => {
    if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("검색할 폴더를 선택하세요");
    log("info", "scan.begin", { root });
    await engine.scan(root);
    log("info", "scan.end", { root: engine.state.root, total: engine.state.files.length, phase: engine.state.phase });
    return engine.snapshot();
  });
  register("configure", async (options: unknown) => {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("잘못된 설정입니다");
    const next = options as { hancomPath?: unknown };
    if (next.hancomPath !== undefined) {
      assertSelectionAllowed();
      if (typeof next.hancomPath !== "string") throw new Error("한컴 경로는 문자열이어야 합니다");
      if (next.hancomPath !== "") {
        const candidate = engine.state.hancomCandidates.find(item => item.path === next.hancomPath);
        if (!candidate || !usableCandidate(candidate)) throw new Error("사용할 수 없는 한컴 설치는 선택할 수 없습니다");
      }
      // Choosing another version or kordoc is a new decision: the earlier hand-picked file no longer wins.
      if (manualHancomPath && next.hancomPath.toLowerCase() !== manualHancomPath.toLowerCase()) await saveManualHancom("");
    }
    engine.configure(options);
    await engine.checkpoint();
    return engine.snapshot();
  });
  register("detect-hancom", async () => {
    assertSelectionAllowed();
    const key = (candidate: HancomCandidate) => candidate.path.toLowerCase();
    const before = new Set(engine.state.hancomCandidates.map(key));
    const previous = engine.state.hancomCandidates.find(candidate => candidate.path === engine.state.hancomPath);
    await refreshHancom();
    const usable = engine.state.hancomCandidates.filter(usableCandidate);
    const added = engine.state.hancomCandidates.filter(candidate => !before.has(key(candidate)));
    // What is used after detection, by name; with no usable Hancom it is the built-in kordoc engine.
    const inUse = engine.state.hancomCandidates.find(candidate => candidate.path === engine.state.hancomPath && usableCandidate(candidate))?.name ?? "내장 kordoc 엔진";
    const lost = previous && !usable.some(candidate => candidate.path === previous.path);
    // What the user reads under 다시 감지 right after pressing it: what was found, what is used now, what to do.
    const message = usable.length === 0
      ? `${lost ? `사용하던 ${previous.name}을(를) 찾을 수 없습니다. ` : ""}사용할 수 있는 한컴오피스를 찾지 못해 지금은 ${inUse}으로 변환합니다. 한컴이 설치되어 있다면 [Hwp.exe 선택]으로 실행 파일을 직접 지정해 주세요.`
      : added.length
        ? `새 한컴 설치본 ${added.length}개를 찾았습니다(${added.map(candidate => candidate.name).join(", ")}). 지금은 ${inUse}을(를) 사용 중이며, 위 목록에서 [이 버전 사용]으로 바꿀 수 있습니다.`
        : usable.length > 1
          ? `새로운 한컴 설치본은 없습니다. 지금은 ${inUse}을(를) 사용 중이며, 사용할 수 있는 ${usable.length}개 중 위 목록에서 [이 버전 사용]으로 바꿀 수 있습니다.`
          : `새로운 한컴 설치본을 찾지 못했습니다. 기존 설정(${inUse})을 그대로 사용하거나, [Hwp.exe 선택]으로 실행 파일을 직접 지정해 주세요.`;
    engine.state.hancomDetectNote = message;
    log("info", "한컴 다시 감지", { before: before.size, after: engine.state.hancomCandidates.length, added: added.length, usable: usable.length });
    return engine.snapshot();
  });
  register("pick-hancom", async () => {
    assertSelectionAllowed();
    const result = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "한컴 한글", extensions: ["exe"] }] });
    if (result.canceled || !result.filePaths[0]) return engine.snapshot();
    const info = await stat(result.filePaths[0]);
    if (!info.isFile()) throw new Error("한컴 실행 파일을 선택하세요");
    const picked = await inspectHancomPath(result.filePaths[0]);
    const candidate = { ...picked, name: `${picked.name} (직접 선택)` };
    engine.state.hancomCandidates = [candidate, ...engine.state.hancomCandidates.filter(item => item.path.toLowerCase() !== candidate.path.toLowerCase())];
    await saveManualHancom(candidate.path);
    if (usableCandidate(candidate)) {
      engine.state.hancomPath = candidate.path;
    } else engine.state.message = `선택한 한컴을 사용할 수 없습니다: ${candidate.unavailableReason ?? "사용할 수 없음"}`;
    await engine.checkpoint();
    return engine.snapshot();
  });
  register("system-info", () => systemInfo());
  register("open-logs", () => openPath(logDir()));
  // Detailed log for the 로그 보기 window: newest part of today's log plus where the full file lives.
  register("read-log", async () => ({ path: logPath(), text: await recentLog(200000) }));
  // 전체 복사: copies the newest log (same range as the viewer) and returns it, so the window shows exactly what was copied.
  register("copy-log", async () => {
    log("info", "로그 복사", {});
    const text = await recentLog(200000);
    try { clipboard.writeText(text); }
    catch { throw new Error("클립보드에 복사하지 못했습니다. 로그 내용을 직접 선택해 복사해 주세요"); }
    return { path: logPath(), text };
  });
  register("report-bug", async () => {
    const consent = await askChoice(
      "버그 리포트",
      "최근 오류·실행 환경·로그 끝부분이 GitHub로 전달됩니다. 사용자 홈 경로는 가리지만 문서명 등 개인정보가 남을 수 있습니다. 긴 내용은 생략됩니다. 내용을 확인한 뒤 직접 제출해야 하며 자동 게시하지 않습니다.",
      ["브라우저에서 초안 열기", "취소"],
      1,
    );
    if (consent !== 0) return false;
    const url = buildIssueUrl({ title: "hwp2x 오류 보고", system: systemInfo(), errors: recentErrors, logTail: await recentLog() });
    if (testHooks) log("info", "test.external", { url });
    await shell.openExternal(url);
    return true;
  });
  register("start", (options?: unknown) => {
    log("info", "conversion.request", { root: engine.state.root, total: engine.state.files.length, phase: engine.state.phase, detectingHancom, hancomPath: engine.state.hancomPath });
    if (detectingHancom) throw new Error("한컴 감지가 끝난 뒤 변환을 시작하세요");
    // A second click while a run is going must not start another one; the screen keeps showing the run instead.
    if (engine.running || engine.state.phase === "converting") throw new Error("이미 변환 중입니다. 끝나거나 일시정지·중지한 뒤 다시 시작하세요");
    if (options !== undefined) {
      if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("잘못된 설정입니다");
      engine.configure(options);
    }
    // A safe stop (disk full, out of memory) already set a readable message and paused the run.
    void engine.convert().catch(error => {
      log("error", "conversion.error", { phase: engine.state.phase, error });
      rememberError(`변환: ${errorText(error)}`);
      if (!engine.state.message.startsWith("안전 중단")) engine.state.message = errorText(error);
    });
    return engine.snapshot();
  });
  register("pause", () => { engine.pause(); return engine.snapshot(); });
  register("stop", async () => { await engine.stopRun(); return engine.snapshot(); });
  register("retry", async (id: unknown) => { const file = item(id); await engine.retry(file.id); return engine.snapshot(); });
  register("backup", async (consent: unknown) => {
    if (consent !== true) throw new Error("원본 처리 동의가 필요합니다");
    await engine.backupLossless();
    return engine.snapshot();
  });
  register("open-file", (id: unknown) => openPath(item(id).source));
  register("open-result", (id: unknown) => {
    const target = item(id).target;
    if (!target) throw new Error("생성된 HWPX가 없습니다");
    return openPath(target);
  });
  register("open-folder", (id: unknown) => openPath(item(id).dir));
  register("open-backup", async () => { await mkdir(engine.state.backupDir, { recursive: true }); await openPath(engine.state.backupDir); });
  register("save-report", async () => {
    const result = await dialog.showSaveDialog(window, { defaultPath: "hwp2x-report.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!result.canceled && result.filePath) await writeFile(result.filePath, JSON.stringify(engine.snapshot(), null, 2), { encoding: "utf8", flag: "wx" });
    return !result.canceled;
  });
  window.webContents.once("did-finish-load", () => {
    if (startupNotice) notify("error", startupNotice);
    const resumeAutomatic = process.argv.includes("--automatic") && automatic.snapshot().resumeAtLogin && !(cleanup.snapshot().phase === "error" && cleanup.snapshot().canRollback);
    if (resumeAutomatic) autoStarting = true;
    void refreshHancom().then(async () => {
      if (resumeAutomatic) {
        await engine.stopRun();
        await automatic.start();
      }
    }).catch(error => notify("error", errorText(error))).finally(() => { if (resumeAutomatic) autoStarting = false; });
  });
  await window.loadFile(page);
}).catch(error => {
  const message = errorText(error);
  rememberError(`초기화: ${message}`);
  log("error", "초기화 실패", { message });
  dialog.showErrorBox("hwp2x 초기화 실패", message);
});
app.on("window-all-closed", () => app.quit());
app.on("before-quit", event => {
  if (exiting) return;
  event.preventDefault();
  void beginShutdown();
});
