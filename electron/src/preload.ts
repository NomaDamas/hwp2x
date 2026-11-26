const boundedError = (value: unknown): string => {
  const text = String(value);
  return text.length <= 2000 ? text : `${text.slice(0, 950)}\n[긴 오류 중간 생략]\n${text.slice(-950)}`;
};
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("hwp2x", {
  state: (query?: object) => ipcRenderer.invoke("hwp2x:state", query),
  autoState: () => ipcRenderer.invoke("hwp2x:auto-state"),
  autoIssues: (options?: object) => ipcRenderer.invoke("hwp2x:auto-issues", options),
  autoRetryIssue: (source: string) => ipcRenderer.invoke("hwp2x:auto-retry-issue", source),
  autoOpenIssue: (source: string, folder?: boolean) => ipcRenderer.invoke("hwp2x:auto-open-issue", source, folder === true),
  autoStart: () => ipcRenderer.invoke("hwp2x:auto-start"),
  autoStop: () => ipcRenderer.invoke("hwp2x:auto-stop"),
  autoConfigure: (options: object) => ipcRenderer.invoke("hwp2x:auto-configure", options),
  cleanupState: () => ipcRenderer.invoke("hwp2x:cleanup-state"),
  cleanupStart: (consent: boolean) => ipcRenderer.invoke("hwp2x:cleanup-start", consent),
  cleanupCancel: () => ipcRenderer.invoke("hwp2x:cleanup-cancel"),
  cleanupRollback: () => ipcRenderer.invoke("hwp2x:cleanup-rollback"),
  pickFolder: () => ipcRenderer.invoke("hwp2x:pick-folder"),
  scan: (root: string) => ipcRenderer.invoke("hwp2x:scan", root),
  start: (options?: object) => ipcRenderer.invoke("hwp2x:start", options),
  configure: (options: object) => ipcRenderer.invoke("hwp2x:configure", options),
  detectHancom: () => ipcRenderer.invoke("hwp2x:detect-hancom"),
  pause: () => ipcRenderer.invoke("hwp2x:pause"),
  stop: () => ipcRenderer.invoke("hwp2x:stop"),
  backup: (consent: boolean) => ipcRenderer.invoke("hwp2x:backup", consent),
  retry: (id: number) => ipcRenderer.invoke("hwp2x:retry", id),
  openFile: (id: number) => ipcRenderer.invoke("hwp2x:open-file", id),
  openResult: (id: number) => ipcRenderer.invoke("hwp2x:open-result", id),
  openFolder: (id: number) => ipcRenderer.invoke("hwp2x:open-folder", id),
  openBackup: () => ipcRenderer.invoke("hwp2x:open-backup"),
  saveReport: () => ipcRenderer.invoke("hwp2x:save-report"),
  pickHancom: () => ipcRenderer.invoke("hwp2x:pick-hancom"),
  reportBug: () => ipcRenderer.invoke("hwp2x:report-bug"),
  openLogs: () => ipcRenderer.invoke("hwp2x:open-logs"),
  readLog: () => ipcRenderer.invoke("hwp2x:read-log"),
  copyLog: () => ipcRenderer.invoke("hwp2x:copy-log"),
  reportError: (message: unknown, stack?: unknown) => {
    if (typeof message !== "string" || message.length === 0) return;
    ipcRenderer.send("hwp2x:renderer-error", { message: boundedError(message), stack: typeof stack === "string" ? boundedError(stack) : undefined });
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
  ipcRenderer.send("hwp2x:renderer-error", { message: boundedError(event.message), stack: boundedError(event.error?.stack || "") });
});
window.addEventListener("unhandledrejection", event => {
  const now = Date.now();
  if (now - lastError < 500) return;
  lastError = now;
  ipcRenderer.send("hwp2x:renderer-error", { message: boundedError(event.reason) });
});
