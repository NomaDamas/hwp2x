import { app, BrowserWindow, ipcMain, dialog } from "electron";
import path from "node:path";
import { Engine } from "./engine";

const engine = new Engine();

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 680,
    title: "hwp2x",
    backgroundColor: "#dcdcd8",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  window.loadFile(path.join(__dirname, "..", "..", "electron", "design", "hwp2x-2-App.dc.html"));
}

app.whenReady().then(() => {
  ipcMain.handle("hwp2x:state", () => engine.snapshot());
  ipcMain.handle("hwp2x:pick-folder", async () => {
    const result = await dialog.showOpenDialog({ properties: ["openDirectory"] });
    return result.canceled ? "" : result.filePaths[0];
  });
  ipcMain.handle("hwp2x:scan", async (_event, root: string) => {
    await engine.scan(root);
    return engine.snapshot();
  });
  ipcMain.handle("hwp2x:start", async () => {
    void engine.convert();
    return engine.snapshot();
  });
  ipcMain.handle("hwp2x:pause", () => {
    engine.pause();
    return engine.snapshot();
  });
  ipcMain.handle("hwp2x:backup", async () => {
    await engine.backupLossless();
    return engine.snapshot();
  });
  createWindow();
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
