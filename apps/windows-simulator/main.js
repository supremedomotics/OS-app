const { app, BrowserWindow, ipcMain } = require("electron");
const path = require("path");

function createWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 920, minWidth: 1100, minHeight: 700,
    backgroundColor: "#0b0b0d",
    webPreferences: { preload: path.join(__dirname, "preload.js"), contextIsolation: true, nodeIntegration: false, sandbox: true }
  });
  win.loadFile(path.join(__dirname, "index.html"));
}

ipcMain.handle("gateway-request", async (_event, request) => {
  const url = new URL(request.url);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Only HTTP(S) gateway URLs are supported.");
  const headers = { ...(request.headers || {}) };
  if (request.token) headers.Authorization = `Bearer ${request.token}`;
  const response = await fetch(url, { method: request.method || "GET", headers, body: request.body ? JSON.stringify(request.body) : undefined });
  const text = await response.text();
  let data = text; try { data = JSON.parse(text); } catch {}
  return { status: response.status, ok: response.ok, data };
});

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on("window-all-closed", () => { if (process.platform !== "darwin") app.quit(); });