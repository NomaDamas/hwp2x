import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("hwp2x", {
  state: () => ipcRenderer.invoke("hwp2x:state"),
  pickFolder: () => ipcRenderer.invoke("hwp2x:pick-folder"),
  scan: (root: string) => ipcRenderer.invoke("hwp2x:scan", root),
  start: (options?: object) => ipcRenderer.invoke("hwp2x:start", options),
  configure: (options: object) => ipcRenderer.invoke("hwp2x:configure", options),
  detectHancom: () => ipcRenderer.invoke("hwp2x:detect-hancom"),
  pause: () => ipcRenderer.invoke("hwp2x:pause"),
  backup: (consent: boolean) => ipcRenderer.invoke("hwp2x:backup", consent),
  retry: (id: number) => ipcRenderer.invoke("hwp2x:retry", id),
  openFile: (id: number) => ipcRenderer.invoke("hwp2x:open-file", id),
  openFolder: (id: number) => ipcRenderer.invoke("hwp2x:open-folder", id),
  openBackup: () => ipcRenderer.invoke("hwp2x:open-backup"),
  saveReport: () => ipcRenderer.invoke("hwp2x:save-report"),
  pickHancom: () => ipcRenderer.invoke("hwp2x:pick-hancom"),
  reportBug: () => ipcRenderer.invoke("hwp2x:report-bug"),
  openLogs: () => ipcRenderer.invoke("hwp2x:open-logs"),
  reportError: (message: unknown, stack?: unknown) => {
    if (typeof message !== "string" || message.length === 0) return;
    ipcRenderer.send("hwp2x:renderer-error", { message: message.slice(0, 2000), stack: typeof stack === "string" ? stack.slice(0, 4000) : undefined });
  },
  systemInfo: () => ipcRenderer.invoke("hwp2x:system-info"),
  onHancomStatus: (callback: (status: unknown) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, status: unknown) => callback(status);
    ipcRenderer.on("hwp2x:hancom-status", handler);
    return () => ipcRenderer.removeListener("hwp2x:hancom-status", handler);
  },
  onNotice: (callback: (notice: { kind: string; message: string }) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, notice: { kind: string; message: string }) => callback(notice);
    ipcRenderer.on("hwp2x:notice", handler);
    return () => ipcRenderer.removeListener("hwp2x:notice", handler);
  },
});
let lastError = 0;
window.addEventListener("error", event => {
  const now = Date.now();
  if (now - lastError < 500) return;
  lastError = now;
  ipcRenderer.send("hwp2x:renderer-error", { message: String(event.message).slice(0, 4000), stack: String(event.error?.stack || "").slice(0, 4000) });
});
window.addEventListener("unhandledrejection", event => {
  const now = Date.now();
  if (now - lastError < 500) return;
  lastError = now;
  ipcRenderer.send("hwp2x:renderer-error", { message: String(event.reason).slice(0, 4000) });
});
