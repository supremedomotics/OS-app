const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("supremeSimulator", {
  gatewayRequest: (request) => ipcRenderer.invoke("gateway-request", request),
  platform: process.platform,
  version: "0.1.0"
});