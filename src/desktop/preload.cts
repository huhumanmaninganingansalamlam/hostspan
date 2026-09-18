import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("hostspan", {
  snapshot: () => ipcRenderer.invoke("hostspan:snapshot"),
  daemon: (action: "start" | "stop" | "restart") => ipcRenderer.invoke("hostspan:daemon", action),
  doctor: () => ipcRenderer.invoke("hostspan:doctor"),
  chooseWorkspace: () => ipcRenderer.invoke("hostspan:choose-workspace"),
  addWorkspace: (input: unknown) => ipcRenderer.invoke("hostspan:add-workspace", input),
  removeWorkspace: (targetId: string) => ipcRenderer.invoke("hostspan:remove-workspace", targetId),
  getAutoStart: () => ipcRenderer.invoke("hostspan:get-autostart"),
  setAutoStart: (enabled: boolean) => ipcRenderer.invoke("hostspan:set-autostart", enabled),
  attach: (processId: string, readOnly: boolean) => ipcRenderer.invoke("hostspan:attach", { processId, readOnly }),
  copy: (text: string) => ipcRenderer.invoke("hostspan:copy", text),
  onUpdate: (callback: (snapshot: unknown) => void) => {
    ipcRenderer.on("hostspan:update", (_event, snapshot) => callback(snapshot));
  },
});
