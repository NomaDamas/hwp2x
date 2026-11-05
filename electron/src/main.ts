import { app, BrowserWindow, ipcMain, dialog, shell } from "electron";
import path from "node:path";
import { isAppPage } from "./origin";
import { mkdir, writeFile } from "node:fs/promises";
import { Engine } from "./engine";

const engine = new Engine();
const page = path.join(__dirname, "..", "design", "app.html");
let window: BrowserWindow;

function register(channel: string, handler: (...args: unknown[]) => unknown): void {
  ipcMain.handle(`hwp2x:${channel}`, (event, ...args) => {
    if (event.sender !== window.webContents || event.senderFrame !== event.sender.mainFrame || !isAppPage(event.senderFrame.url, page)) {
      throw new Error("허용되지 않은 화면 요청입니다");
    }
    return handler(...args);
  });
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

app.whenReady().then(async () => {
  engine.state.backupDir = path.join(app.getPath("documents"), "hwp2x_백업");
  window = new BrowserWindow({
    width: 1240, height: 840, minWidth: 980, minHeight: 680,
    title: "hwp2x", backgroundColor: "#efefec", autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, url) => { if (!isAppPage(url, page)) event.preventDefault(); });
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
  register("configure", (options: unknown) => {
    if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("잘못된 설정입니다");
    engine.configure(options);
    return engine.snapshot();
  });
  register("start", (options?: unknown) => {
    if (options !== undefined) {
      if (!options || typeof options !== "object" || Array.isArray(options)) throw new Error("잘못된 설정입니다");
      engine.configure(options);
    }
    void engine.convert().catch(error => { engine.state.message = String(error); });
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
  await window.loadFile(page);
});
app.on("window-all-closed", () => app.quit());
