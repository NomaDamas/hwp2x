import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("hwp2x", {
  state: () => ipcRenderer.invoke("hwp2x:state"),
  pickFolder: () => ipcRenderer.invoke("hwp2x:pick-folder"),
  scan: (root: string) => ipcRenderer.invoke("hwp2x:scan", root),
  start: (options?: object) => ipcRenderer.invoke("hwp2x:start", options),
  configure: (options: object) => ipcRenderer.invoke("hwp2x:configure", options),
  pause: () => ipcRenderer.invoke("hwp2x:pause"),
  backup: (consent: boolean) => ipcRenderer.invoke("hwp2x:backup", consent),
  retry: (id: number) => ipcRenderer.invoke("hwp2x:retry", id),
  openFile: (id: number) => ipcRenderer.invoke("hwp2x:open-file", id),
  openFolder: (id: number) => ipcRenderer.invoke("hwp2x:open-folder", id),
  openBackup: () => ipcRenderer.invoke("hwp2x:open-backup"),
  saveReport: () => ipcRenderer.invoke("hwp2x:save-report"),
});
