"""
VigilMask — Desktop Daemon
============================
This is the "power mode" backend. It runs as a small localhost server
that the browser extension can call when it wants stronger detection
than pure in-browser regex/wink-nlp can offer.

WHY A SEPARATE DESKTOP APP:
spaCy (and Presidio, which wraps it) is Python — it can't run inside a
browser extension directly. So this process runs independently on the
user's machine and listens on localhost only (127.0.0.1), meaning
nothing ever leaves the device. The extension talks to it over a local
HTTP call, functioning like calling a library, except the "library" is
a background process instead of an in-page import.

WHAT IS PRESIDIO:
Microsoft Presidio is an open-source PII detection + anonymization
toolkit. It's not a single model — it's a framework that combines:
  - Its own regex-based recognizers (similar to our regex-patterns.js,
    but more mature/battle-tested)
  - spaCy's NER model for names, orgs, locations
  - A confidence-scoring system so you can tune sensitivity
  - "Anonymizer" operators that handle the replace/redact step, and an
    "Deanonymizer" step for reversing it — which maps almost exactly to
    our redact()/rehydrate() design in the extension.
We're using it here instead of hand-rolling spaCy integration ourselves,
because it already solved a lot of the edge cases (overlapping entities,
context-aware confidence, etc.).

INSTALL (run once):
    pip install presidio-analyzer presidio-anonymizer flask
    python -m spacy download en_core_web_sm

RUN:
    python server.py
    # Server listens on http://127.0.0.1:8787
"""

from flask import Flask, request, jsonify
from presidio_analyzer import AnalyzerEngine
from presidio_anonymizer import AnonymizerEngine
from presidio_anonymizer.entities import OperatorConfig

app = Flask(__name__)

# AnalyzerEngine loads spaCy's en_core_web_sm under the hood plus
# Presidio's built-in regex recognizers (email, credit card, IP, etc.)
# This happens once at startup, not per-request, so subsequent calls
# are fast (typically tens of milliseconds for short text).
analyzer = AnalyzerEngine()
anonymizer = AnonymizerEngine()

# In-memory session map: token -> real value, mirroring the same
# design as RedactionEngine in the extension. In a real build you'd
# key this per conversation-id sent from the extension, and persist it
# to an encrypted local SQLite file so it survives the daemon restarting
# mid-conversation.
session_map = {}
counters = {}


def make_token(entity_type: str, value: str) -> str:
    key = f"{entity_type}:{value.strip().lower()}"
    for token, original in session_map.items():
        if original == value:
            return token
    counters[entity_type] = counters.get(entity_type, 0) + 1
    token = f"\u27e6{entity_type}_{counters[entity_type]}\u27e7"
    session_map[token] = value
    return token


@app.route("/redact", methods=["POST"])
def redact():
    """
    Expects: { "text": "..." }
    Returns: { "redacted": "..." }

    Pipeline:
      1. analyzer.analyze() finds PII spans with entity type + confidence
      2. We filter by a confidence threshold to reduce false positives
      3. We replace each span with a reversible token (not Presidio's
         built-in anonymizer output, so we can guarantee exact-match
         rehydration later)
    """
    text = request.json.get("text", "")
    results = analyzer.analyze(text=text, language="en")

    # Sort by start position descending so we can replace in-place
    # without shifting the indices of spans we haven't processed yet.
    results = sorted(results, key=lambda r: r.start, reverse=True)

    redacted = text
    for r in results:
        if r.score < 0.5:  # confidence threshold — tune this per your false-positive tolerance
            continue
        original_value = text[r.start:r.end]
        token = make_token(r.entity_type, original_value)
        redacted = redacted[:r.start] + token + redacted[r.end:]

    return jsonify({"redacted": redacted})


@app.route("/rehydrate", methods=["POST"])
def rehydrate():
    """
    Expects: { "text": "..." } (the LLM's response, possibly containing tokens)
    Returns: { "rehydrated": "..." }
    """
    text = request.json.get("text", "")
    for token, original in session_map.items():
        text = text.replace(token, original)
    return jsonify({"rehydrated": text})


@app.route("/clear_session", methods=["POST"])
def clear_session():
    session_map.clear()
    counters.clear()
    return jsonify({"cleared": True})


if __name__ == "__main__":
    # 127.0.0.1 only — never 0.0.0.0 — so this is unreachable from
    # outside the machine. This is the core privacy guarantee of the
    # whole desktop-app half of the product.
    app.run(host="127.0.0.1", port=8787)
