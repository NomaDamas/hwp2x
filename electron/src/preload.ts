import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("hwp2x", {
  state: () => ipcRenderer.invoke("hwp2x:state"),
  pickFolder: () => ipcRenderer.invoke("hwp2x:pick-folder"),
  scan: (root: string) => ipcRenderer.invoke("hwp2x:scan", root),
  start: (options?: { makeMarkdown?: boolean }) => ipcRenderer.invoke("hwp2x:start", options),
  pause: () => ipcRenderer.invoke("hwp2x:pause"),
  backup: () => ipcRenderer.invoke("hwp2x:backup"),
});
