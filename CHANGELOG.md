# Changelog

## Desktop App Build — July 2026

VigilMask is a local-first privacy shield for AI chat: it masks personal
data (names, emails, IBANs, card numbers…) *before* a prompt leaves your
machine, and restores it in the model's reply. Until now the desktop half
was a headless Python daemon plus an HTML design mockup. This round of
work turned that mockup into a working desktop application.

### 1. New Electron desktop app (`app/`)

- **`app/main.js`** — the app's backbone. On launch it looks for the
  VigilMask daemon on `127.0.0.1:8787`; if none is running it starts
  `desktop/server.py` itself (using the repo's Python venv) and shuts it
  down again on quit. If you started the daemon by hand, the app attaches
  to it and leaves it alone.
- **Security-first plumbing** — the UI has no network access at all. All
  daemon traffic goes through the Electron main process over a bridge
  that only permits four whitelisted endpoints (`/status`, `/ledger`,
  `/control`, `/clear_session`). This means the daemon never needs to
  open CORS to browsers, preserving the "nothing but localhost"
  guarantee.
- **`app/renderer/`** — the design mockup, made real:
  - The rotating brain visualization now shows **one glowing node per
    entity masked this session**, updating live (capped at 40 nodes
    visually).
  - Four live states: *connecting* (daemon starting), *protected* (full
    hybrid engine), *degraded* (regex-only / ML model still loading),
    and *paused*.
  - The three stat tiles — **masked / sent raw / turns** — are fed by
    real daemon counters.
  - Clicking the status row opens a **session ledger drawer**: an audit
    log of every placeholder created (e.g.
    `⟦PERSON_NAME_1⟧ → PERSON_NAME`). Original values stay hidden as
    `••••••` until clicked, and a "wipe session mappings" button clears
    everything.
  - Google Fonts were replaced with system fonts so the app is fully
    offline.

### 2. Daemon extensions (`desktop/server.py`)

The Python daemon gained the runtime controls the UI needed:

- **`POST /control`** — two switches: `paused` (while paused, `/redact`
  passes text through untouched and counts it as "sent raw") and
  `semantic_enabled` (toggles the ML pass, switching between `hybrid`
  and `deterministic-only` modes).
- **`GET /status`** — now reports pause/engine state plus aggregate
  session stats (entities masked, turns processed, prompts sent raw).
- **`GET /ledger`** — without a session id, returns the merged audit log
  across all sessions (what the app displays).
- Per-session counters for turns and raw sends. Everything remains
  RAM-only — no persistence, no telemetry, unchanged privacy posture.

### 3. Dependency security

- Electron updated 38 → 43.1.1 (SemVer major) to pick up upstream
  vulnerability fixes; the app's Electron API usage (BrowserWindow,
  ipcMain, contextBridge) is unaffected.

### 4. Verification

- All 18 detection-engine smoke tests pass.
- End-to-end test against the live daemon: hybrid mode caught a name via
  the multilingual NER model plus email/phone/card via regex+checksums;
  pause mode passed text through and counted it; regex-only mode
  correctly skipped the name; ledger and stats aggregated correctly.
- The app boots cleanly, attaches to a running daemon, and reflects live
  activity in the UI.

### Running it

```
cd app
npm install
npm start
```

*(Requires Node.js; the Python daemon and its venv live in `desktop/`.
First daemon run downloads the ~300 MB multilingual NER model from
Hugging Face — the only network request the daemon can ever make.)*
