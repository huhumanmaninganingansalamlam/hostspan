import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("hostspan", {
  snapshot: () => ipcRenderer.invoke("hostspan:snapshot"),
  daemon: (action: "start" | "stop") => ipcRenderer.invoke("hostspan:daemon", action),
  attach: (processId: string, readOnly: boolean) => ipcRenderer.invoke("hostspan:attach", { processId, readOnly }),
  copy: (text: string) => ipcRenderer.invoke("hostspan:copy", text),
  onUpdate: (callback: (snapshot: unknown) => void) => {
    ipcRenderer.on("hostspan:update", (_event, snapshot) => callback(snapshot));
  },
});
