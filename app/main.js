/**
 * VigilMask — Electron main process
 * ---------------------------------
 * Owns two things:
 *   1. The Python daemon lifecycle: if nothing is listening on
 *      127.0.0.1:8787 we spawn desktop/server.py (using the repo venv
 *      when present) and kill it again on quit. If a daemon is already
 *      running — e.g. the user started it by hand — we attach to it and
 *      leave it alone on exit.
 *   2. All HTTP to the daemon. The renderer never talks to the network
 *      itself: it calls a narrow, path-whitelisted IPC bridge (see
 *      preload.js). That keeps the daemon CORS-closed to browsers while
 *      still feeding the UI.
 */

const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

const DAEMON_URL = "http://127.0.0.1:8787";
const DESKTOP_DIR = path.join(__dirname, "..", "desktop");

let daemonProc = null; // only set when WE spawned it

// ---------------------------------------------------------------------------
// Daemon lifecycle
// ---------------------------------------------------------------------------

async function daemonUp() {
  try {
    const res = await fetch(`${DAEMON_URL}/status`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

function pythonPath() {
  const venvPython =
    process.platform === "win32"
      ? path.join(DESKTOP_DIR, "venv", "Scripts", "python.exe")
      : path.join(DESKTOP_DIR, "venv", "bin", "python");
  return fs.existsSync(venvPython) ? venvPython : "python";
}

async function ensureDaemon() {
  if (await daemonUp()) return;

  daemonProc = spawn(pythonPath(), ["server.py"], {
    cwd: DESKTOP_DIR,
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemonProc.stdout.on("data", (d) => process.stdout.write(`[daemon] ${d}`));
  daemonProc.stderr.on("data", (d) => process.stderr.write(`[daemon] ${d}`));
  daemonProc.on("exit", (code) => {
    console.log(`[daemon] exited with code ${code}`);
    daemonProc = null;
  });
}

function stopDaemon() {
  if (daemonProc) {
    daemonProc.kill();
    daemonProc = null;
  }
}

// ---------------------------------------------------------------------------
// IPC bridge — the only network path the renderer has
// ---------------------------------------------------------------------------

const ALLOWED = new Set(["/status", "/ledger", "/control", "/clear_session"]);

ipcMain.handle("vm:request", async (_event, { method = "GET", path: apiPath, body }) => {
  if (!ALLOWED.has(apiPath)) {
    return { ok: false, error: `blocked path: ${apiPath}` };
  }
  try {
    const res = await fetch(`${DAEMON_URL}${apiPath}`, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(3000),
    });
    return { ok: res.ok, data: await res.json() };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
});

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

function createWindow() {
  const win = new BrowserWindow({
    width: 380,
    height: 780,
    useContentSize: true,
    resizable: false,
    autoHideMenuBar: true,
    backgroundColor: "#0a1420",
    title: "VigilMask",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
}

app.whenReady().then(async () => {
  ensureDaemon(); // don't block the window on daemon startup
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => app.quit());
app.on("will-quit", stopDaemon);
