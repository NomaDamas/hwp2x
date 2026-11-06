import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isAppFrame, isSameDocument } from "./origin";
import { mkdir, writeFile, stat } from "node:fs/promises";
import { Engine, mainDrive } from "./engine";
import { detectHancom, inspectHancomPath, type HancomCandidate } from "./hancom";
import { flushLog, initLogger, log, logDir, recentLog } from "./logger";
import { buildIssueUrl } from "./report";

let engine: Engine;
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
      return await handler(...args);
    } catch (error) {
      const message = errorText(error);
      rememberError(`${channel}: ${message}`);
      log("error", "ipc.fail", { channel, message });
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
  if (window && !window.isDestroyed()) window.webContents.send("hwp2x:hancom-status", { status, message, snapshot: engine.snapshot() });
}
async function askChoice(title: string, message: string, choices: string[]): Promise<number> {
  if (testHooks && testDialogs.length > 0) {
    const answer = Number(testDialogs.shift());
    log("info", "test.dialog", { title, answer });
    return Number.isInteger(answer) ? answer : 0;
  }
  const result = await dialog.showMessageBox(window, {
    type: "warning",
    title,
    message,
    buttons: choices,
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  });
  return result.response;
}
async function finishExit(): Promise<void> {
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
async function openPath(target: string): Promise<void> {
  const error = await shell.openPath(target);
  if (error) throw new Error(error);
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

app.whenReady().then(async () => {
  const logDirectory = path.join(app.getPath("userData"), "logs");
  await initLogger(logDirectory, systemInfo()).catch(error => { startupNotice = `로그를 시작하지 못했습니다: ${errorText(error)}`; });
  log("info", "app.start", {});
  engine = new Engine(path.join(app.getPath("userData"), "conversion-state.json"));
  engine.state.backupDir = path.join(app.getPath("documents"), "hwp2x_백업");
  let restored = false;
  try { restored = await engine.restore(); }
  catch (error) {
    const message = `이전 작업 복원 실패: ${errorText(error)}`;
    engine.state.message = message;
    startupNotice = message;
    rememberError(message);
    log("error", "초기화 실패", { message });
  }
  const refreshHancom = async () => {
    detectingHancom = true;
    publishHancom("detecting", "한컴오피스를 찾고 있습니다");
    try {
      engine.state.hancomCandidates = await detectHancom();
      const usable = engine.state.hancomCandidates.filter(usableCandidate);
      if (!usable.some(candidate => candidate.path === engine.state.hancomPath)) engine.state.hancomPath = usable[0]?.path ?? "";
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
    // Title bar and taskbar icon on Linux/dev runs; packaged Windows builds take the .ico from the exe.
    icon: path.join(__dirname, "..", "icons", "icon.png"),
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.on("close", event => {
    if (exiting) return;
    event.preventDefault();
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
  register("state", () => engine.snapshot());
  register("pick-folder", async () => {
    const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] });
    return result.canceled ? "" : result.filePaths[0];
  });
  register("scan", async (root: unknown) => {
    if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error("검색할 폴더를 선택하세요");
    await engine.scan(root);
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
    }
    engine.configure(options);
    await engine.checkpoint();
    return engine.snapshot();
  });
  register("detect-hancom", async () => { assertSelectionAllowed(); await refreshHancom(); return engine.snapshot(); });
  register("pick-hancom", async () => {
    assertSelectionAllowed();
    const result = await dialog.showOpenDialog(window, { properties: ["openFile"], filters: [{ name: "한컴 한글", extensions: ["exe"] }] });
    if (result.canceled || !result.filePaths[0]) return engine.snapshot();
    const info = await stat(result.filePaths[0]);
    if (!info.isFile()) throw new Error("한컴 실행 파일을 선택하세요");
    const candidate = await inspectHancomPath(result.filePaths[0]);
    engine.state.hancomCandidates = [...engine.state.hancomCandidates.filter(item => item.path !== candidate.path), candidate];
    if (usableCandidate(candidate)) engine.state.hancomPath = candidate.path;
    else engine.state.message = `선택한 한컴을 사용할 수 없습니다: ${candidate.unavailableReason ?? "사용할 수 없음"}`;
    await engine.checkpoint();
    return engine.snapshot();
  });
  register("system-info", () => systemInfo());
  register("open-logs", () => openPath(logDir()));
  register("report-bug", async () => {
    const consent = await askChoice(
      "버그 리포트",
      "작성 초안에 최근 오류와 실행 환경이 포함됩니다. 개인정보와 문서 경로를 확인한 뒤 직접 제출해야 하며, 자동으로 게시되지 않습니다.",
      ["브라우저에서 초안 열기", "취소"],
    );
    if (consent !== 0) return false;
    const url = buildIssueUrl({ title: "hwp2x 오류 보고", system: systemInfo(), errors: recentErrors, logTail: await recentLog() });
    if (testHooks) log("info", "test.external", { url });
    await shell.openExternal(url);
    return true;
  });
  register("start", (options?: unknown) => {
    if (detectingHancom) throw new Error("한컴 감지가 끝난 뒤 변환을 시작하세요");
    if (options !== undefined) {
      if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("잘못된 설정입니다");
      engine.configure(options);
    }
    // A safe stop (disk full, out of memory) already set a readable message and paused the run.
    void engine.convert().catch(error => { if (!engine.state.message.startsWith("안전 중단")) engine.state.message = errorText(error); });
    return engine.snapshot();
  });
  register("pause", () => { engine.pause(); return engine.snapshot(); });
  register("retry", async (id: unknown) => { const file = item(id); await engine.retry(file.id); return engine.snapshot(); });
  register("backup", async (consent: unknown) => {
    if (consent !== true) throw new Error("원본 처리 동의가 필요합니다");
    await engine.backupLossless();
    return engine.snapshot();
  });
  register("open-file", (id: unknown) => openPath(item(id).source));
  register("open-folder", (id: unknown) => openPath(item(id).dir));
  register("open-backup", async () => { await mkdir(engine.state.backupDir, { recursive: true }); await openPath(engine.state.backupDir); });
  register("save-report", async () => {
    const result = await dialog.showSaveDialog(window, { defaultPath: "hwp2x-report.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!result.canceled && result.filePath) await writeFile(result.filePath, JSON.stringify(engine.snapshot(), null, 2), { encoding: "utf8", flag: "wx" });
    return !result.canceled;
  });
  window.webContents.once("did-finish-load", () => {
    if (startupNotice) notify("error", startupNotice);
    void refreshHancom();
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
