"""
VigilMask — Desktop Daemon
============================
Localhost redaction server the browser extension (or any local client)
calls for stronger detection than in-browser regex can offer. Listens on
127.0.0.1 only — nothing ever leaves the device.

DETECTION: two-pass hybrid pipeline (see eu_patterns.py / ml_engine.py)
  Pass 1  Deterministic — EU-focused regex + checksum validators for
          structured data (IBAN, PESEL, Steuer-ID, DNI/NIE, Codice
          Fiscale, INSEE/NIR, Belgian BNN, cards, emails, phones, keys).
          Runs in microseconds, zero false positives on checksummed types.
  Pass 2  Semantic — bardsai/eu-pii-anonimization-multilang, an
          XLM-RoBERTa token classifier covering 24 EU languages and 36
          entity classes including GDPR Article 9 special categories
          (health, biometric, political opinion, ...). Runs on ONNX
          Runtime CPU with INT8 weights; no language parameter needed.
          If the model isn't available the server degrades to Pass 1
          only and says so in /status.

PRIVACY GUARANTEES:
  - Session-only storage: token→value mappings live in process memory,
    keyed per session id. They are never written to disk and vanish when
    the daemon stops or /clear_session is called.
  - Zero telemetry: no analytics, no crash reporting, no logging of
    prompt text. The single outbound request this app can make is the
    first-run model download from the Hugging Face CDN; after that it
    is fully offline.

INSTALL (run once):
    pip install -r requirements.txt

RUN:
    python server.py
    # Server listens on http://127.0.0.1:8787
"""

import logging
import threading

from flask import Flask, jsonify, request

from eu_patterns import find_structured_spans
from ml_engine import MODEL_ID, SemanticDetector

app = Flask(__name__)

# Werkzeug's default access log prints request lines only (no bodies),
# but we silence it anyway: a redaction tool should not journal traffic.
logging.getLogger("werkzeug").setLevel(logging.ERROR)

detector = SemanticDetector()

DEFAULT_THRESHOLD = 0.5

# Runtime controls, flipped by the desktop app UI via /control.
#   paused            /redact passes text through untouched (and counts it)
#   semantic_enabled  toggles Pass 2 so users can run deterministic-only
_control = {"paused": False, "semantic_enabled": True}
_control_lock = threading.Lock()


def engine_name() -> str:
    if _control["paused"]:
        return "paused"
    if detector.ready and _control["semantic_enabled"]:
        return "hybrid"
    return "deterministic-only"

# ---------------------------------------------------------------------------
# Session store — RAM only, by design. No SQLite, no files, no persistence.
# A mapping that never touches disk cannot be recovered forensically after
# the process exits, which is the whole point of pseudonymization done
# client-side (GDPR Recital 26 / Article 32 posture).
# ---------------------------------------------------------------------------


class Session:
    def __init__(self):
        self.token_to_value = {}
        self.value_to_token = {}
        self.counters = {}
        self.ledger = []  # audit trail for the UI: what was masked, as what
        self.turns = 0      # /redact calls this session
        self.sent_raw = 0   # /redact calls that passed through while paused

    def make_token(self, entity_type: str, value: str) -> str:
        key = (entity_type, value.strip())
        if key in self.value_to_token:
            return self.value_to_token[key]
        self.counters[entity_type] = self.counters.get(entity_type, 0) + 1
        token = f"⟦{entity_type}_{self.counters[entity_type]}⟧"
        self.token_to_value[token] = value
        self.value_to_token[key] = token
        self.ledger.append({"placeholder": token, "category": entity_type,
                            "original": value})
        return token


_sessions = {}
_sessions_lock = threading.Lock()


def get_session(session_id: str) -> Session:
    with _sessions_lock:
        if session_id not in _sessions:
            _sessions[session_id] = Session()
        return _sessions[session_id]


# ---------------------------------------------------------------------------
# Pipeline
# ---------------------------------------------------------------------------


def run_pipeline(text: str, session: Session, threshold: float):
    """Two-pass redaction. Returns (redacted_text, entities_found)."""
    found = []

    # Pass 1 — deterministic. Mask structured data first so the ML pass
    # never even sees it (and can't mis-classify it).
    spans = find_structured_spans(text)
    for start, end, entity_type in reversed(spans):  # right-to-left keeps indices stable
        value = text[start:end]
        token = session.make_token(entity_type, value)
        text = text[:start] + token + text[end:]
        found.append({"category": entity_type, "pass": "deterministic"})

    # Pass 2 — semantic, multilingual. No language parameter: XLM-R
    # handles all 24 EU languages in the same forward pass.
    if detector.ready and _control["semantic_enabled"]:
        ml_spans = detector.detect(text, threshold=threshold)
        for start, end, entity_type, score in sorted(ml_spans, reverse=True):
            value = text[start:end]
            if "⟦" in value or "⟧" in value:
                continue  # never re-mask a placeholder from pass 1
            token = session.make_token(entity_type, value)
            text = text[:start] + token + text[end:]
            found.append({"category": entity_type, "pass": "semantic",
                          "score": round(score, 3)})

    return text, found


# ---------------------------------------------------------------------------
# API — same contract the extension already speaks, plus /status.
# ---------------------------------------------------------------------------


@app.route("/redact", methods=["POST"])
def redact():
    """
    Expects: { "text": "...", "session_id"?: "...", "threshold"?: 0.5 }
    Returns: { "redacted": "...", "entities": [...], "engine": "hybrid"|"deterministic-only" }
    """
    body = request.json or {}
    text = body.get("text", "")
    session = get_session(body.get("session_id", "default"))
    threshold = float(body.get("threshold", DEFAULT_THRESHOLD))

    session.turns += 1
    if _control["paused"]:
        session.sent_raw += 1
        return jsonify({"redacted": text, "entities": [], "engine": "paused"})

    redacted, entities = run_pipeline(text, session, threshold)
    return jsonify({
        "redacted": redacted,
        "entities": entities,
        "engine": engine_name(),
    })


@app.route("/rehydrate", methods=["POST"])
def rehydrate():
    """
    Expects: { "text": "...", "session_id"?: "..." }  (the LLM's response)
    Returns: { "rehydrated": "..." }

    Tolerant matching: LLMs sometimes rewrite ⟦PERSON_1⟧ as [PERSON_1],
    so both bracket styles are restored.
    """
    body = request.json or {}
    text = body.get("text", "")
    session = get_session(body.get("session_id", "default"))
    for token, original in session.token_to_value.items():
        text = text.replace(token, original)
        text = text.replace(f"[{token[1:-1]}]", original)
    return jsonify({"rehydrated": text})


@app.route("/ledger", methods=["GET"])
def ledger():
    """Audit ledger for the UI: every mapping made this session.

    Without a session_id, returns the merged ledger across all sessions
    (what the desktop app shows).
    """
    session_id = request.args.get("session_id")
    with _sessions_lock:
        if session_id:
            session = _sessions.get(session_id)
            entries = list(session.ledger) if session else []
        else:
            entries = [e for s in _sessions.values() for e in s.ledger]
    return jsonify({"ledger": entries})


@app.route("/control", methods=["POST"])
def control():
    """
    Runtime switches for the desktop app UI.
    Expects: { "paused"?: bool, "semantic_enabled"?: bool }
    Returns the resulting control state.
    """
    body = request.json or {}
    with _control_lock:
        for key in ("paused", "semantic_enabled"):
            if key in body:
                _control[key] = bool(body[key])
    return jsonify({"paused": _control["paused"],
                    "semantic_enabled": _control["semantic_enabled"],
                    "engine": engine_name()})


@app.route("/clear_session", methods=["POST"])
def clear_session():
    body = request.json or {}
    session_id = body.get("session_id")
    with _sessions_lock:
        if session_id:
            _sessions.pop(session_id, None)
        else:
            _sessions.clear()
    return jsonify({"cleared": True})


@app.route("/status", methods=["GET"])
def status():
    with _sessions_lock:
        stats = {
            "masked": sum(len(s.ledger) for s in _sessions.values()),
            "turns": sum(s.turns for s in _sessions.values()),
            "sent_raw": sum(s.sent_raw for s in _sessions.values()),
        }
        active = len(_sessions)
    return jsonify({
        "engine": engine_name(),
        "paused": _control["paused"],
        "semantic_enabled": _control["semantic_enabled"],
        "model": MODEL_ID,
        "model_loaded": detector.ready,
        "model_error": detector.load_error,
        "network": "127.0.0.1 only — no telemetry, no external calls after model download",
        "storage": "session-only (RAM); nothing persisted to disk",
        "active_sessions": active,
        "stats": stats,
    })


if __name__ == "__main__":
    # Load the model in the background so /redact works (regex-only)
    # immediately while the ~300 MB first-run download proceeds.
    threading.Thread(target=detector.load, daemon=True).start()

    # 127.0.0.1 only — never 0.0.0.0 — so this is unreachable from
    # outside the machine. This is the core privacy guarantee of the
    # whole desktop-app half of the product.
    app.run(host="127.0.0.1", port=8787)
