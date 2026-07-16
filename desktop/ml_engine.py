"""
VigilMask — Semantic Detection Layer (Pass 2)
=============================================
Token-classification NER over the text the deterministic pass didn't
already mask. This replaces the old Presidio + spaCy `en_core_web_sm`
setup, which was English-only — the core language-coverage gap.

Model: bardsai/eu-pii-anonimization-multilang
  - XLM-RoBERTa base (~0.3B params), trained end-to-end on real text in
    24 official EU languages (not translated English data), so Polish,
    German, French, Italian, Spanish perform at the English baseline.
  - 36 entity classes including the GDPR Article 9 special categories
    (health, biometric, genetic, ethnic origin, political opinion) that
    generic NER models miss.
  - Ships INT8-quantized ONNX weights (~300 MB), so we run it on plain
    onnxruntime CPU — no torch, no spaCy, no per-language model files.

Because XLM-RoBERTa is multilingual by construction there is no
`language=` parameter anywhere: the same forward pass handles every
supported language, which is what fixes the old hardcoded
`analyzer.analyze(text, language="en")`.

Network policy: the ONE outbound request this app ever makes is the
first-run model download from the Hugging Face CDN, cached locally.
After that, inference is fully offline. No telemetry, no analytics.
"""

import os

import numpy as np

MODEL_ID = "bardsai/eu-pii-anonimization-multilang"
# INT8 weights: ~4x smaller, tuned for CPU inference.
ONNX_FILE = "onnx/model_quantized.onnx"
MAX_TOKENS = 512     # XLM-R context limit per forward pass
CHUNK_STRIDE = 64    # overlap between windows so entities on a boundary aren't split

# Keep HF's own anonymous usage pings off — zero-telemetry policy.
os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")


class SemanticDetector:
    """Lazy-loading wrapper around the ONNX token-classification model."""

    def __init__(self):
        self._session = None
        self._tokenizer = None
        self._id2label = None
        self.load_error = None

    @property
    def ready(self) -> bool:
        return self._session is not None

    def load(self):
        """Download (first run only) and initialize the model. Safe to call
        repeatedly; raises nothing — check `.ready` / `.load_error`."""
        if self._session is not None:
            return
        try:
            import json

            import onnxruntime as ort
            from huggingface_hub import hf_hub_download
            from tokenizers import Tokenizer

            model_path = hf_hub_download(MODEL_ID, ONNX_FILE)
            tokenizer_path = hf_hub_download(MODEL_ID, "tokenizer.json")
            config_path = hf_hub_download(MODEL_ID, "config.json")

            with open(config_path, encoding="utf-8") as f:
                config = json.load(f)
            self._id2label = {int(k): v for k, v in config["id2label"].items()}

            self._tokenizer = Tokenizer.from_file(tokenizer_path)
            self._session = ort.InferenceSession(
                model_path, providers=["CPUExecutionProvider"])
            self.load_error = None
        except Exception as exc:  # noqa: BLE001 — degrade to regex-only mode
            self.load_error = f"{type(exc).__name__}: {exc}"

    def detect(self, text: str, threshold: float = 0.5):
        """Return (start, end, TYPE, score) spans for semantic entities.

        BIO decoding over word-level offsets: contiguous B-/I- tokens of
        the same class merge into one span, so multi-word names mask as
        a single placeholder instead of fragmenting.
        """
        if not self.ready or not text.strip():
            return []

        encoding = self._tokenizer.encode(text)
        spans = []
        # Sliding window over long inputs.
        step = MAX_TOKENS - CHUNK_STRIDE
        for window_start in range(0, len(encoding.ids), step):
            ids = encoding.ids[window_start:window_start + MAX_TOKENS]
            offsets = encoding.offsets[window_start:window_start + MAX_TOKENS]
            spans.extend(self._detect_window(ids, offsets, threshold))
            if window_start + MAX_TOKENS >= len(encoding.ids):
                break

        return _merge_overlaps(spans)

    def _detect_window(self, ids, offsets, threshold):
        input_ids = np.array([ids], dtype=np.int64)
        attention = np.ones_like(input_ids)
        feed = {"input_ids": input_ids, "attention_mask": attention}
        input_names = {i.name for i in self._session.get_inputs()}
        feed = {k: v for k, v in feed.items() if k in input_names}

        logits = self._session.run(None, feed)[0][0]  # (tokens, labels)
        # softmax for confidence scores
        exp = np.exp(logits - logits.max(axis=-1, keepdims=True))
        probs = exp / exp.sum(axis=-1, keepdims=True)
        label_ids = probs.argmax(axis=-1)

        spans = []
        current = None  # [start, end, type, score_sum, count]
        for (tok_start, tok_end), label_id, prob in zip(offsets, label_ids, probs):
            if tok_start == tok_end:  # special token
                continue
            label = self._id2label[int(label_id)]
            score = float(prob[label_id])
            if label == "O" or score < threshold:
                if current:
                    spans.append(current)
                    current = None
                continue
            prefix, _, entity = label.partition("-")
            entity = entity or label
            if current and current[2] == entity and prefix != "B":
                current[1] = tok_end
                current[3] += score
                current[4] += 1
            else:
                if current:
                    spans.append(current)
                current = [tok_start, tok_end, entity, score, 1]
        if current:
            spans.append(current)

        return [(s, e, t.upper(), total / n) for s, e, t, total, n in spans]


def _merge_overlaps(spans):
    """Windows overlap by design; keep the higher-confidence span."""
    result = []
    for span in sorted(spans, key=lambda s: (s[0], -s[3])):
        if result and span[0] < result[-1][1]:
            continue
        result.append(span)
    return result
