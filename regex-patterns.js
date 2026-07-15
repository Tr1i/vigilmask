/**
 * VigilMask — Regex Pattern Library
 * -----------------------------------
 * This file handles STRUCTURED PII: data that follows a predictable
 * format. Regex is the right tool here because these patterns are
 * unambiguous — a Social Security Number always looks like ###-##-####,
 * so we don't need a statistical model to find it, just a pattern match.
 *
 * Each entry has:
 *   - type: the placeholder category (used to build tokens like EMAIL_A1)
 *   - regex: the pattern
 *   - validate (optional): a function to reduce false positives
 *     (e.g. Luhn check for credit cards so we don't flag random 16-digit numbers)
 */

const PII_PATTERNS = [
  {
    type: "EMAIL",
    regex: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g,
  },
  {
    type: "PHONE",
    // Matches common US/international formats: (555) 123-4567, 555-123-4567, +1 555 123 4567
    regex: /(\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  },
  {
    type: "SSN",
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    type: "CREDIT_CARD",
    regex: /\b(?:\d[ -]*?){13,16}\b/g,
    validate: (match) => luhnCheck(match.replace(/[ -]/g, "")),
  },
  {
    type: "IP_ADDRESS",
    regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  },
  {
    type: "API_KEY",
    // Covers common vendor key prefixes: OpenAI (sk-), GitHub (ghp_/gho_),
    // AWS access keys (AKIA...), Slack (xox...), Stripe (sk_live_/pk_live_)
    regex: /\b(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}|AKIA[0-9A-Z]{16}|xox[baprs]-[a-zA-Z0-9-]{10,}|sk_live_[a-zA-Z0-9]{20,}|pk_live_[a-zA-Z0-9]{20,})\b/g,
  },
  {
    type: "IBAN",
    regex: /\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g,
  },
  {
    type: "DATE_OF_BIRTH",
    // Only flags dates near explicit DOB context words — plain dates alone
    // are too ambiguous to redact (e.g. "meeting on 04/12/2024")
    regex: /\b(?:dob|date of birth|born on)\D{0,10}(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/gi,
  },
];

/**
 * Luhn algorithm — the checksum used by all major credit card networks.
 * Without this, the CREDIT_CARD regex above would flag lots of random
 * 16-digit numbers (order IDs, tracking numbers) as credit cards.
 */
function luhnCheck(numStr) {
  if (!/^\d{13,16}$/.test(numStr)) return false;
  let sum = 0;
  let shouldDouble = false;
  for (let i = numStr.length - 1; i >= 0; i--) {
    let digit = parseInt(numStr[i], 10);
    if (shouldDouble) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
    shouldDouble = !shouldDouble;
  }
  return sum % 10 === 0;
}

module.exports = { PII_PATTERNS, luhnCheck };
