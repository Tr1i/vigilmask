/**
 * VigilMask — Redaction Engine
 * ------------------------------
 * This is the heart of the product. It does two jobs:
 *
 *   1. redact(text)   — find PII, replace with stable placeholder tokens,
 *                        remember the mapping
 *   2. rehydrate(text) — take the LLM's response and swap placeholder
 *                        tokens back to the real values
 *
 * WHY TOKENS INSTEAD OF FAKE DATA:
 * We use placeholders like ⟦PERSON_A1⟧ instead of synthetic-but-plausible
 * fake names (e.g. "Marcus Webb"). Reasons:
 *   - Exact-match swap-back is reliable: we just search the response text
 *     for the literal token string.
 *   - Fake names can get altered by the model mid-generation (pluralized,
 *     shortened to a first name only, etc.) which breaks the reverse
 *     mapping. A bracketed token with a unique ID is much less likely to
 *     be paraphrased by the model because it looks like a variable, not
 *     prose.
 * The tradeoff: the model's reasoning may be slightly less natural than
 * with realistic fake data. That's an acceptable cost for reliability —
 * you can revisit this later with confidence scoring per use case.
 *
 * SESSION-SCOPED CONSISTENCY:
 * If "John Smith" appears three times in one conversation, it should map
 * to the SAME token every time (⟦PERSON_A1⟧), not three different ones.
 * This preserves the LLM's ability to reason about "the same person"
 * across turns. The `entityMap` below is keyed by normalized entity text
 * so repeats resolve to the same token.
 */

const { PII_PATTERNS } = require("./regex-patterns");

class RedactionEngine {
  constructor() {
    // Maps original value -> token, so repeats reuse the same token
    this.valueToToken = new Map();
    // Maps token -> original value, used for rehydration
    this.tokenToValue = new Map();
    // Per-type counters so tokens read as PERSON_A1, PERSON_A2, etc.
    this.typeCounters = {};
  }

  /**
   * Generates (or reuses) a token for a given entity type + value.
   */
  _getToken(type, value) {
    const normalized = value.trim().toLowerCase();
    const cacheKey = `${type}:${normalized}`;

    if (this.valueToToken.has(cacheKey)) {
      return this.valueToToken.get(cacheKey);
    }

    this.typeCounters[type] = (this.typeCounters[type] || 0) + 1;
    const token = `⟦${type}_${this.typeCounters[type]}⟧`;

    this.valueToToken.set(cacheKey, token);
    this.tokenToValue.set(token, value);
    return token;
  }

  /**
   * Step 1: Regex pass for structured PII (emails, phones, keys, etc.)
   */
  _redactWithRegex(text) {
    let result = text;
    for (const { type, regex, validate } of PII_PATTERNS) {
      result = result.replace(regex, (match) => {
        if (validate && !validate(match)) return match; // skip false positives
        return this._getToken(type, match);
      });
    }
    return result;
  }

  /**
   * Step 2: NER pass for unstructured entities (names, orgs, locations).
   * `nerEntities` is expected to come from an external NER call (wink-nlp,
   * spaCy via the desktop daemon, etc.) in the shape:
   *   [{ text: "Sarah Connor", type: "PERSON" }, ...]
   * This function is deliberately decoupled from any specific NER library
   * so you can swap wink-nlp for spaCy/Presidio later without touching
   * this file.
   */
  _redactWithNER(text, nerEntities) {
    let result = text;
    // Sort longest-match-first to avoid partial overlaps (e.g. "Sarah"
    // getting redacted before "Sarah Connor" has a chance to match)
    const sorted = [...nerEntities].sort((a, b) => b.text.length - a.text.length);
    for (const entity of sorted) {
      const token = this._getToken(entity.type, entity.text);
      // Escape regex special chars in the entity text before matching
      const escaped = entity.text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      result = result.replace(new RegExp(escaped, "g"), token);
    }
    return result;
  }

  /**
   * Full redaction pipeline: regex first (cheap, high-confidence),
   * then NER (catches what regex structurally cannot).
   */
  redact(text, nerEntities = []) {
    let result = this._redactWithRegex(text);
    result = this._redactWithNER(result, nerEntities);
    return result;
  }

  /**
   * Rehydration: swap every known token in the LLM's response back to
   * its real value. This is a straightforward literal string replace —
   * the reliability of this step is WHY we chose bracketed tokens over
   * fake data in the first place.
   */
  rehydrate(text) {
    let result = text;
    for (const [token, value] of this.tokenToValue.entries()) {
      result = result.split(token).join(value);
    }
    return result;
  }

  /**
   * Clears the entity map. Call this when a conversation/session ends —
   * this is also your privacy guarantee: nothing persists longer than
   * the user wants it to.
   */
  clearSession() {
    this.valueToToken.clear();
    this.tokenToValue.clear();
    this.typeCounters = {};
  }
}

module.exports = { RedactionEngine };
