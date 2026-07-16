[README.md](https://github.com/user-attachments/files/30054124/README.md)
# VigilMask — Starter Kit & Roadmap

A local-first privacy shield for AI chat. This kit contains a working
skeleton for both halves of the product: a browser extension (lightweight,
regex + in-browser NER) and a desktop daemon (stronger detection via
spaCy/Presidio).

## How the pieces fit together

```
extension/
  manifest.json         Extension config (Manifest V3)
  content-script.js      Watches the page, grabs your prompt before send,
                          rehydrates the LLM's response after it arrives
  background.js           Owns the RedactionEngine per tab, receives
                          messages from content-script.js
  redaction-engine.js      Core logic: redact() and rehydrate(), token
                          mapping, session state
  regex-patterns.js         Structured PII patterns (email, phone, SSN,
                          credit card, API keys, IBAN)

desktop/
  server.py               Localhost daemon running the two-pass hybrid
                          detection pipeline (see below)
  eu_patterns.py           Pass 1: deterministic EU regex + checksum layer
                          (IBAN, PESEL, Steuer-ID, DNI/NIE, Codice
                          Fiscale, INSEE, Belgian BNN, cards, phones...)
  ml_engine.py             Pass 2: multilingual NER via
                          bardsai/eu-pii-anonimization-multilang (ONNX,
                          24 EU languages, 36 entity classes incl. GDPR
                          Article 9 special categories)
  requirements.txt         pip install -r requirements.txt
  test_engine.py           Smoke tests for the detection layers
```

### Desktop engine design notes (July 2026 rework)

The daemon originally used Presidio + spaCy `en_core_web_sm`, which was
English-only. It now runs a two-pass hybrid pipeline:

1. **Deterministic pass** — localized regex + checksum validation for
   structured EU identifiers. Checksums (mod-97, Luhn, PESEL mod-10,
   ISO 7064) mean these detections have effectively zero false positives
   and cost microseconds.
2. **Semantic pass** — an XLM-RoBERTa token classifier trained natively
   on 24 official EU languages. No `language=` parameter exists anywhere:
   the same forward pass handles Polish declensions, German compounds,
   and French context. It also covers GDPR Article 9 special categories
   (health, biometric, political opinion, union membership) that generic
   NER models miss.

Privacy posture: token↔value mappings are **session-only** (process RAM,
per session id, gone on exit or `/clear_session`); **zero telemetry**
(the only outbound request the daemon can ever make is the one-time
model download from the Hugging Face CDN, after which it runs fully
offline).

## Development Roadmap

### Phase 0 — Regex-only prototype (1-2 weeks)
Get `redaction-engine.js` + `regex-patterns.js` working standalone in
Node, no browser yet. Write test cases: does it catch an email? A credit
card? Does the Luhn check correctly reject a random 16-digit number
that isn't really a card? This phase teaches you the token-mapping
system, which is the foundation everything else builds on.

**What you're learning:** regex pattern design, why validation functions
(like Luhn) matter for reducing false positives, and the reversible
token architecture.

### Phase 1 — Add NER for unstructured entities (2-3 weeks)
Regex can't find "my manager Sarah" — there's no fixed pattern for a
name. Bring in a Named Entity Recognition (NER) model: a classifier
that's already been trained (by someone else, no training needed from
you) to label spans of text as PERSON, ORG, GPE (place), etc.

- For the browser: **wink-nlp** or **compromise.js** (pure JavaScript,
  runs in a Web Worker, no Python needed).
- For the desktop daemon: **bardsai/eu-pii-anonimization-multilang**, a
  multilingual XLM-RoBERTa token classifier run via ONNX Runtime
  (see `ml_engine.py`). Done — this replaced the original
  Presidio/spaCy English-only setup.

**What you're learning:** the difference between rule-based detection
(regex) and statistical detection (NER), and why you need both — regex
is precise but narrow, NER is broad but probabilistic (hence the
confidence threshold in `server.py`).

### Phase 2 — Browser extension skeleton (2-3 weeks)
Wire up `manifest.json`, `content-script.js`, and `background.js`. Key
decision to understand: **content scripts can touch the webpage DOM,
but background service workers cannot** — that's why redaction logic
lives in background.js and content-script.js just relays messages to it.

**What you're learning:** Manifest V3 extension architecture — the
separation between content scripts (page-facing) and service workers
(logic-holding, event-driven, can be killed/restarted by the browser).

### Phase 3 — Desktop daemon (3-4 weeks)
Get `server.py` running locally, have the extension call
`http://127.0.0.1:8787/redact` instead of (or in addition to) the
in-browser NER. This is optional "power mode" for users who install the
companion app for stronger detection.

**What you're learning:** how a browser extension can talk to a local
process on the user's machine (this is the "proxy" part of your
original idea), and why binding to `127.0.0.1` instead of `0.0.0.0` is
what makes this a genuine privacy guarantee rather than a marketing
claim.

### Phase 4 — Rehydration robustness (ongoing — the hardest part)
Run real prompts through real LLMs (OpenAI, Claude, Gemini) and check:
does the model preserve your `⟦PERSON_1⟧`-style tokens verbatim, or
does it paraphrase them away? You'll likely find some models are more
token-preserving than others, and system-prompt hints ("preserve any
bracketed tokens exactly as given") can help — this is empirical work,
not something you can fully solve on paper.

### Phase 5 — UX and trust
- A redaction preview the user can review/edit before sending
- A visible session log of what got redacted (builds trust — users
  should be able to verify the tool is doing what it claims)
- Adjustable confidence threshold (the `0.5` in `server.py`) for
  users who want more/less aggressive redaction

## Key concepts glossary

- **NER (Named Entity Recognition):** a model that labels spans of text
  with categories like PERSON, ORG, LOCATION. Pre-trained — you use it,
  you don't train it.
- **Token/placeholder mapping:** replacing "John Smith" with a fixed
  marker like `⟦PERSON_1⟧` and remembering the pairing locally, so you
  can undo the replacement later.
- **Confidence threshold:** NER models output a probability, not a
  certainty. Filtering out low-confidence guesses (e.g. below 0.5)
  trades some missed detections for fewer false alarms.
- **Token classification:** the NER architecture used by the desktop
  engine — every token in the input gets a label (B-PERSON_NAME,
  I-HEALTH_DATA, O...), and contiguous labelled tokens merge into one
  maskable span. Cheaper and hallucination-free compared to asking a
  generative model to "find the PII".
- **ONNX Runtime:** a lean inference engine that runs the quantized
  model on CPU without needing PyTorch or the full transformers stack.
- **Manifest V3:** the current Chrome extension architecture. Content
  scripts see the page; background service workers hold logic but can
  be shut down when idle by the browser.
