# Changelog

## Marketing Website — July 2026

VigilMask gained its public face: a complete static marketing site under
`website/`, built in a "dossier" visual style — case files, exhibits,
redaction bars — with an animated hero that types out a prompt, flags the
personal data in it, and strikes each entity into a placeholder. The site
practices what the product preaches: it makes **zero external requests**.

### 1. The site (`website/`)

- **`index.html`** — single-page landing: live redaction demo in the
  hero, "what a prompt becomes" ledger, the three-stage redaction
  procedure, dossier index, pricing terms (with Clause 1: the engine is
  identical on every tier), and a verification section.
- **Self-hosted fonts** — Archivo and IBM Plex Mono ship as local
  `.woff2` files under `assets/fonts/` with `@font-face` rules, replacing
  the Google Fonts CDN calls the design mockup originally used. No CDN,
  no analytics, no telemetry — the "zero background connections" claim
  holds on the site itself, verifiably in DevTools.
- **Deployment** — a GitHub Actions workflow
  (`.github/workflows/deploy-website.yml`) publishes `website/` to GitHub
  Pages on every push to `main` that touches it. *Intentionally not
  enabled yet* — the site is a draft; flipping repo Settings → Pages →
  Source to "GitHub Actions" is the publish switch.

### 2. The dossier: six sourced articles (`website/dossier/`)

Long-form articles behind the six index cards, written in the dossier
voice with case-file insets and pull-stat exhibits. Every statistic was
verified against primary sources before writing, and each article ends
with a numbered sources section linking them:

- **DOC 001 — What data brokers actually know about you** (FTC 2014
  findings, the Duke mental-health-data study, the Grindr/Burrill case)
- **DOC 002 — Where your prompt goes after you press send** (training
  defaults, human review, retention windows, the 2025 preservation order
  covering deleted ChatGPT conversations)
- **DOC 003 — A short history of bulk collection** (Crypto AG, ECHELON,
  Room 641A, the Snowden files — what changed and what quietly didn't)
- **DOC 004 — "Nothing to hide" doesn't hold up** (Solove's four
  counter-arguments, measured chilling effects, the Nebraska
  Facebook-messages prosecution)
- **DOC 005 — How "anonymous" data gets traced back** (Sweeney's 87%,
  AOL, Netflix Prize, mobility data, the 99.98% Nature study)
- **DOC 006 — What leaks when you paste into a chatbot** (Cyberhaven's
  measurements, the Samsung incidents, the March 2023 ChatGPT exposure,
  Google-indexed shared chats)

### 3. Real navigation, no dead links

Every `href="#"` placeholder was replaced with a real destination,
Mullvad-style: dossier cards open their articles, Download buttons lead
to a dedicated `download.html` (honest about its pre-release state — the
repository is presented as the only channel that exists today), footer
links reach a real `privacy.html` and the GitHub repo. An automated check
confirms all internal links resolve.

### 4. Draft honesty

Because the site describes a planned product, every page carries a fixed
amber **"Draft specimen"** banner stating that the site is a design
mockup and that the product, pricing, audit and downloads described are
not yet real or in effect. The download page and privacy policy repeat
the disclaimer in context.

### 5. Verification

- All pages rendered and visually checked in a browser against a local
  static server (`python -m http.server`, config in
  `.claude/launch.json`).
- Font loading confirmed via the CSS Font Loading API; the resource log
  confirms zero requests to any third-party host on every page.
- Link-checker pass over all nine HTML files: no broken internal links,
  no remaining CDN references.

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
