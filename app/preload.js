/**
 * VigilMask — preload bridge
 * The renderer gets exactly four calls, all proxied through the main
 * process (see main.js). No fetch, no Node, no raw IPC.
 */
const { contextBridge, ipcRenderer } = require("electron");

const request = (method, path, body) =>
  ipcRenderer.invoke("vm:request", { method, path, body });

contextBridge.exposeInMainWorld("vigilmask", {
  getStatus: () => request("GET", "/status"),
  getLedger: () => request("GET", "/ledger"),
  setControl: (body) => request("POST", "/control", body),
  clearSession: () => request("POST", "/clear_session", {}),
});
