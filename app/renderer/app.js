/**
 * VigilMask — renderer
 * Two halves:
 *   1. The brain visualization from the mockup, reworked so the number of
 *      bright nodes tracks the live masked-entity count from the daemon.
 *   2. UI state driven by polling window.vigilmask (the preload bridge):
 *      /status every 1.5s, /ledger when the drawer is open or the count
 *      changes.
 */

/* ------------------------------------------------------------------ */
/* Brain visualization                                                 */
/* ------------------------------------------------------------------ */

const MAX_NODES = 40; // visual cap; the stat readout shows the true count

const canvas = document.getElementById("brainCanvas");
const ctx = canvas.getContext("2d");

let W = 0, H = 0;
const DPR = Math.min(window.devicePixelRatio || 1, 2);
function resize() {
  const rect = canvas.parentElement.getBoundingClientRect();
  W = rect.width; H = rect.height;
  canvas.width = W * DPR;
  canvas.height = H * DPR;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
}
new ResizeObserver(resize).observe(canvas.parentElement);
resize();

// Deterministic pseudo-random (stable brain between reloads)
let seed = 42;
function rand() {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
}

// ---- Brain-shaped point cloud (see mockup for sculpting notes) ----
const cortex = [];
const N = 620;
const GOLDEN = Math.PI * (3 - Math.sqrt(5));

function sculpt(x, y, z) {
  let px = x * 1.02, py = y * 0.80, pz = z * 1.28;

  // Sagittal fissure: carve a groove near x=0, strongest on top
  const grooveDepth = Math.exp(-Math.pow(px / 0.13, 2));
  const topness = Math.max(0, py) / 0.80;
  const groove = 1 - 0.16 * grooveDepth * (0.35 + 0.65 * topness);
  px *= groove; py *= groove; pz *= groove;

  // Cortical folds: layered trig noise on the radius
  const folds = 1
    + 0.045 * Math.sin(6.0 * px + 1.7) * Math.sin(5.0 * py - 0.4) * Math.sin(4.0 * pz + 2.3)
    + 0.030 * Math.sin(11.0 * px - 2.1) * Math.sin(9.0 * pz + 0.9);
  px *= folds; py *= folds; pz *= folds;

  // Flatten the underside
  if (py < -0.42) py = -0.42 - (py + 0.42) * 0.35;

  return { x: px, y: py, z: pz };
}

for (let i = 0; i < N; i++) {
  const t = (i + 0.5) / N;
  const y = 1 - 2 * t;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const th = GOLDEN * i;
  const p = sculpt(r * Math.cos(th), y, r * Math.sin(th));
  p.jitter = rand() * Math.PI * 2;
  cortex.push(p);
}

// Cerebellum: small dense lobe at the back-bottom
for (let i = 0; i < 110; i++) {
  const t = (i + 0.5) / 110;
  const y = 1 - 2 * t;
  const r = Math.sqrt(Math.max(0, 1 - y * y));
  const th = GOLDEN * i * 1.3;
  const bump = 1 + 0.05 * Math.sin(14 * r * Math.cos(th)) * Math.sin(12 * y);
  cortex.push({
    x: r * Math.cos(th) * 0.42 * bump,
    y: y * 0.30 * bump - 0.44,
    z: r * Math.sin(th) * 0.40 * bump - 1.02,
    jitter: rand() * Math.PI * 2,
  });
}

const candidates = cortex.slice(0, N).filter((p) => p.y > -0.30);

// ---- Nodes + edges rebuilt whenever the masked count changes ----
let nodes = [];
let edges = [];

function rebuildNodes(count) {
  count = Math.min(count, MAX_NODES);
  seed = 42; // reseed so the layout is stable for a given count
  nodes = [];
  edges = [];
  if (count === 0) return;

  // Greedy farthest-point sampling for even spread
  nodes.push(candidates[Math.floor(rand() * candidates.length)]);
  while (nodes.length < count) {
    let best = null, bestD = -1;
    for (const c of candidates) {
      let d = Infinity;
      for (const n of nodes) {
        const dd = (c.x - n.x) ** 2 + (c.y - n.y) ** 2 + (c.z - n.z) ** 2;
        if (dd < d) d = dd;
      }
      if (d > bestD) { bestD = d; best = c; }
    }
    nodes.push(best);
  }
  nodes.forEach((n) => { n.phase = rand() * Math.PI * 2; });

  // Connect each node to its 2 nearest node neighbors
  const edgeSet = new Set();
  nodes.forEach((a, i) => {
    const dists = nodes
      .map((b, j) => ({ j, d: (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2 }))
      .filter((e) => e.j !== i)
      .sort((u, v) => u.d - v.d)
      .slice(0, 2);
    for (const e of dists) {
      const key = Math.min(i, e.j) + "-" + Math.max(i, e.j);
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        edges.push({ a: i, b: e.j, pulseT: rand(), pulseSpeed: 0.10 + rand() * 0.14 });
      }
    }
  });
}

// ---- Projection ----
const TILT = -0.16;
const cosT = Math.cos(TILT), sinT = Math.sin(TILT);
const FOV = 3.4;

function project(p, cosR, sinR) {
  const x = p.x * cosR + p.z * sinR;
  const z = -p.x * sinR + p.z * cosR;
  const y = p.y * cosT - z * sinT;
  const z2 = p.y * sinT + z * cosT;
  const scale = (Math.min(W, H) * 0.40) * (FOV / (FOV + z2));
  return {
    sx: W / 2 + x * scale,
    sy: H * 0.46 - y * scale,
    depth: z2,
  };
}

// ---- Render loop ----
const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
const TEAL = "63,214,178";
const start = performance.now();

function frame(now) {
  const t = reduceMotion ? 0 : (now - start) / 1000;
  const rot = t * (2 * Math.PI / 26);
  const cosR = Math.cos(rot), sinR = Math.sin(rot);

  ctx.clearRect(0, 0, W, H);

  // Cortex point cloud (dimmed further while paused/disconnected)
  const dim = uiState.dim ? 0.45 : 1;
  for (const p of cortex) {
    const q = project(p, cosR, sinR);
    const facing = Math.max(0, Math.min(1, (0.9 - q.depth) / 1.8));
    const shimmer = 0.85 + 0.15 * Math.sin(t * 0.8 + p.jitter);
    const alpha = (0.05 + 0.22 * facing) * shimmer * dim;
    ctx.fillStyle = "rgba(148,196,196," + alpha.toFixed(3) + ")";
    const size = 0.7 + 0.9 * facing;
    ctx.fillRect(q.sx - size / 2, q.sy - size / 2, size, size);
  }

  const proj = nodes.map((n) => project(n, cosR, sinR));

  for (const e of edges) {
    const A = proj[e.a], B = proj[e.b];
    const facing = Math.max(0, Math.min(1, (0.9 - (A.depth + B.depth) / 2) / 1.8));
    if (facing <= 0.02) continue;
    ctx.strokeStyle = "rgba(" + TEAL + "," + ((0.08 + 0.30 * facing) * dim).toFixed(3) + ")";
    ctx.lineWidth = 0.8;
    ctx.beginPath();
    ctx.moveTo(A.sx, A.sy);
    ctx.lineTo(B.sx, B.sy);
    ctx.stroke();

    if (!reduceMotion) {
      e.pulseT = (e.pulseT + e.pulseSpeed / 60) % 1;
      const px = A.sx + (B.sx - A.sx) * e.pulseT;
      const py = A.sy + (B.sy - A.sy) * e.pulseT;
      ctx.fillStyle = "rgba(" + TEAL + "," + (0.55 * facing * dim).toFixed(3) + ")";
      ctx.beginPath();
      ctx.arc(px, py, 1.4, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  nodes.forEach((n, i) => {
    const q = proj[i];
    const facing = Math.max(0, Math.min(1, (0.9 - q.depth) / 1.8));
    const pulse = reduceMotion ? 0.5 : 0.5 + 0.5 * Math.sin(t * 2.0 + n.phase);
    const r = 2.2 + 1.1 * facing;

    const glowR = r + 5 + 5 * pulse * facing;
    const g = ctx.createRadialGradient(q.sx, q.sy, 0, q.sx, q.sy, glowR);
    g.addColorStop(0, "rgba(" + TEAL + "," + (0.35 * facing * dim).toFixed(3) + ")");
    g.addColorStop(1, "rgba(" + TEAL + ",0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(q.sx, q.sy, glowR, 0, Math.PI * 2);
    ctx.fill();

    ctx.fillStyle = "rgba(" + TEAL + "," + ((0.35 + 0.65 * facing) * dim).toFixed(3) + ")";
    ctx.beginPath();
    ctx.arc(q.sx, q.sy, r, 0, Math.PI * 2);
    ctx.fill();
  });

  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

/* ------------------------------------------------------------------ */
/* Live UI state                                                       */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id);
const appEl = $("app");

const uiState = {
  connected: false,
  paused: false,
  maskedCount: -1, // force first rebuild
  dim: true,
};

function setText(id, text) {
  const el = $(id);
  if (el.textContent !== text) el.textContent = text;
}

function applyStatus(s) {
  uiState.connected = true;
  uiState.paused = s.paused;
  uiState.dim = s.paused;

  // Header engine meta
  let engineLabel;
  if (s.paused) engineLabel = "paused";
  else if (s.engine === "hybrid") engineLabel = "regex + ner";
  else if (s.model_error) engineLabel = "regex only (ner failed)";
  else if (!s.model_loaded) engineLabel = "regex only · ner loading…";
  else engineLabel = "regex only";
  setText("engineMeta", engineLabel);

  // Status block
  if (s.paused) {
    appEl.dataset.state = "paused";
    setText("statusText", "PAUSED");
    setText("mainLine", "Protection paused");
    setText("subLine", "prompts pass through unmasked");
  } else if (s.engine === "hybrid") {
    appEl.dataset.state = "protected";
    setText("statusText", "PROTECTED");
    setText("mainLine", "All entities masked locally");
    setText("subLine", `session · ${s.stats.masked} entities tokenized`);
  } else {
    appEl.dataset.state = "degraded";
    setText("statusText", "PROTECTED");
    setText("mainLine", "Structured PII masked locally");
    setText("subLine", s.model_error
      ? "ner unavailable — deterministic pass only"
      : "deterministic pass · ner model loading…");
  }

  // Stats
  setText("maskedStat", String(s.stats.masked));
  setText("rawStat", String(s.stats.sent_raw));
  setText("turnsStat", String(s.stats.turns));

  // Buttons
  const engineBtn = $("engineBtn");
  engineBtn.disabled = s.paused || (!s.model_loaded && !s.semantic_enabled);
  setText("engineBtnText", s.semantic_enabled
    ? "Switch engine — regex only"
    : "Switch engine — regex + ner");
  engineBtn.dataset.semantic = s.semantic_enabled ? "1" : "0";

  const pauseBtn = $("pauseBtn");
  pauseBtn.disabled = false;
  pauseBtn.textContent = s.paused ? "Resume protection" : "Pause protection";
  pauseBtn.classList.toggle("resume", s.paused);

  // Brain nodes track the masked count
  if (s.stats.masked !== uiState.maskedCount) {
    uiState.maskedCount = s.stats.masked;
    rebuildNodes(s.stats.masked);
    if (appEl.classList.contains("drawer-open")) refreshLedger();
  }
}

function applyDisconnected() {
  uiState.connected = false;
  uiState.dim = true;
  appEl.dataset.state = "connecting";
  setText("engineMeta", "—");
  setText("statusText", "CONNECTING");
  setText("mainLine", "Waiting for local daemon…");
  setText("subLine", "starting python on 127.0.0.1:8787");
  $("engineBtn").disabled = true;
  $("pauseBtn").disabled = true;
}

async function poll() {
  const res = await window.vigilmask.getStatus();
  if (res.ok) applyStatus(res.data);
  else applyDisconnected();
}
poll();
setInterval(poll, 1500);

/* ---- Ledger drawer ---- */

async function refreshLedger() {
  const res = await window.vigilmask.getLedger();
  const list = $("ledgerList");
  if (!res.ok || !res.data.ledger.length) {
    list.innerHTML = '<div class="ledger-empty">nothing masked yet this session</div>';
    return;
  }
  list.innerHTML = "";
  for (const entry of res.data.ledger.slice().reverse()) {
    const row = document.createElement("div");
    row.className = "ledger-row";

    const token = document.createElement("span");
    token.className = "ledger-token";
    token.textContent = entry.placeholder;

    const cat = document.createElement("span");
    cat.className = "ledger-cat";
    cat.textContent = entry.category;

    // Original values start hidden; click to reveal (trust, not surveillance)
    const value = document.createElement("span");
    value.className = "ledger-value hidden-value";
    value.textContent = "••••••";
    value.title = "click to reveal";
    value.addEventListener("click", () => {
      const hidden = value.classList.toggle("hidden-value");
      value.textContent = hidden ? "••••••" : entry.original;
    });

    row.append(token, cat, value);
    list.appendChild(row);
  }
}

$("statusRow").addEventListener("click", () => {
  const open = appEl.classList.toggle("drawer-open");
  if (open) refreshLedger();
});

$("clearBtn").addEventListener("click", async () => {
  await window.vigilmask.clearSession();
  refreshLedger();
  poll();
});

/* ---- Controls ---- */

$("engineBtn").addEventListener("click", async () => {
  const enable = $("engineBtn").dataset.semantic !== "1";
  await window.vigilmask.setControl({ semantic_enabled: enable });
  poll();
});

$("pauseBtn").addEventListener("click", async () => {
  await window.vigilmask.setControl({ paused: !uiState.paused });
  poll();
});
