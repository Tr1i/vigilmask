"""
VigilMask — Deterministic Detection Layer (Pass 1)
==================================================
Structured PII that follows a strict, checksummable format. Regex plus a
validation function is the right tool here: it runs in microseconds and,
unlike the ML pass, never produces a false positive on data that fails
its checksum.

This is the European-focused registry the research doc calls for —
US-style SSN-only detection is structurally insufficient for EU
deployment. Each entry:

    type      placeholder category (builds tokens like ⟦IBAN_1⟧)
    regex     candidate pattern (deliberately broad)
    validate  optional checksum/structure filter that kills false positives

Order matters: more specific national identifiers run before generic
number-shaped patterns so e.g. a PESEL is labelled PESEL, not PHONE.
"""

import re

import phonenumbers

# ---------------------------------------------------------------------------
# Checksum validators
# ---------------------------------------------------------------------------


def luhn_check(digits: str) -> bool:
    """Card-network checksum. Rejects random 13-19 digit numbers."""
    if not re.fullmatch(r"\d{13,19}", digits):
        return False
    total, double = 0, False
    for ch in reversed(digits):
        d = int(ch)
        if double:
            d *= 2
            if d > 9:
                d -= 9
        total += d
        double = not double
    return total % 10 == 0


def iban_check(candidate: str) -> bool:
    """ISO 13616 mod-97: rearrange, map letters to numbers, remainder must be 1."""
    s = re.sub(r"\s", "", candidate).upper()
    if not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]{11,30}", s):
        return False
    rearranged = s[4:] + s[:4]
    numeric = "".join(str(int(c, 36)) for c in rearranged)
    return int(numeric) % 97 == 1


def pesel_check(digits: str) -> bool:
    """Polish PESEL: 11 digits encoding birth date + gender, mod-10 checksum."""
    if not re.fullmatch(r"\d{11}", digits):
        return False
    month = int(digits[2:4]) % 20  # months are offset per century (21-32 = 2000s, etc.)
    day = int(digits[4:6])
    if not (1 <= month <= 12 and 1 <= day <= 31):
        return False
    weights = (1, 3, 7, 9, 1, 3, 7, 9, 1, 3)
    checksum = sum(w * int(d) for w, d in zip(weights, digits)) % 10
    return (10 - checksum) % 10 == int(digits[10])


def steuer_id_check(digits: str) -> bool:
    """German Steuer-ID: 11 digits; exactly one digit repeats (2-3 times) in the
    first ten; ISO 7064 MOD 11,10 check digit."""
    if not re.fullmatch(r"[1-9]\d{10}", digits):
        return False
    first_ten = digits[:10]
    counts = {d: first_ten.count(d) for d in set(first_ten)}
    repeated = [c for c in counts.values() if c > 1]
    if len(repeated) != 1 or repeated[0] > 3:
        return False
    product = 10
    for ch in first_ten:
        s = (int(ch) + product) % 10
        if s == 0:
            s = 10
        product = (2 * s) % 11
    check = 11 - product
    if check == 10:
        check = 0
    return check == int(digits[10])


_DNI_LETTERS = "TRWAGMYFPDXBNJZSQVHLCKE"


def dni_nie_check(candidate: str) -> bool:
    """Spanish DNI (8 digits + letter) / NIE (X|Y|Z + 7 digits + letter)."""
    s = candidate.upper().replace("-", "")
    m = re.fullmatch(r"([XYZ]?)(\d{7,8})([A-Z])", s)
    if not m:
        return False
    prefix, num, letter = m.groups()
    if prefix:
        num = str("XYZ".index(prefix)) + num
    return _DNI_LETTERS[int(num) % 23] == letter


_FSC_ODD = {c: v for c, v in zip(
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    [1, 0, 5, 7, 9, 13, 15, 17, 19, 21, 1, 0, 5, 7, 9, 13, 15, 17, 19, 21,
     2, 4, 18, 20, 11, 3, 6, 8, 12, 14, 16, 10, 22, 25, 24, 23])}
_FSC_EVEN = {c: v for c, v in zip(
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    list(range(10)) + list(range(26)))}


def codice_fiscale_check(candidate: str) -> bool:
    """Italian Codice Fiscale: 16 chars, positional odd/even weight tables,
    final letter is the checksum."""
    s = candidate.upper()
    if not re.fullmatch(r"[A-Z]{6}[0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{2}"
                        r"[A-Z][0-9LMNPQRSTUV]{3}[A-Z]", s):
        return False
    total = 0
    for i, ch in enumerate(s[:15]):
        total += _FSC_ODD[ch] if i % 2 == 0 else _FSC_EVEN[ch]
    return chr(ord("A") + total % 26) == s[15]


def insee_check(candidate: str) -> bool:
    """French NIR/INSEE: 13 digits + 2-digit key = 97 - (number mod 97).
    Corsica uses 2A/2B in the department field."""
    s = re.sub(r"\s", "", candidate).upper()
    m = re.fullmatch(r"([12]\d{2}(?:0[1-9]|1[0-2])(?:\d{2}|2[AB])\d{6})(\d{2})", s)
    if not m:
        return False
    number, key = m.groups()
    number = number.replace("2A", "19").replace("2B", "18")
    return (97 - int(number) % 97) == int(key)


def bnn_check(digits: str) -> bool:
    """Belgian National Number: 11 digits, key = 97 - (first 9 mod 97);
    people born from 2000 on are checked with a leading '2'."""
    s = re.sub(r"[.\-\s]", "", digits)
    if not re.fullmatch(r"\d{11}", s):
        return False
    body, key = int(s[:9]), int(s[9:])
    return (97 - body % 97) == key or (97 - int("2" + s[:9]) % 97) == key


# ---------------------------------------------------------------------------
# Pattern registry
# ---------------------------------------------------------------------------

PII_PATTERNS = [
    {
        "type": "EMAIL",
        "regex": re.compile(r"[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}"),
    },
    {
        "type": "IBAN",
        "regex": re.compile(r"\b[A-Z]{2}\d{2}[ ]?(?:[A-Z0-9][ ]?){11,30}\b"),
        "validate": iban_check,
    },
    {
        "type": "CREDIT_CARD",
        "regex": re.compile(r"\b(?:\d[ -]?){13,19}\b"),
        "validate": lambda m: luhn_check(re.sub(r"[ -]", "", m)),
    },
    {
        "type": "PESEL",  # Poland
        "regex": re.compile(r"\b\d{11}\b"),
        "validate": pesel_check,
    },
    {
        "type": "STEUER_ID",  # Germany
        "regex": re.compile(r"\b\d{11}\b"),
        "validate": steuer_id_check,
    },
    {
        "type": "BNN",  # Belgium (formatted 85.07.30-033.61 or bare 11 digits)
        "regex": re.compile(r"\b\d{2}\.\d{2}\.\d{2}-\d{3}\.\d{2}\b|\b\d{11}\b"),
        "validate": bnn_check,
    },
    {
        "type": "DNI_NIE",  # Spain
        "regex": re.compile(r"\b[XYZ]?\d{7,8}-?[A-Za-z]\b"),
        "validate": dni_nie_check,
    },
    {
        "type": "FISCAL_CODE",  # Italy
        "regex": re.compile(r"\b[A-Za-z]{6}\d{2}[A-Za-z]\d{2}[A-Za-z]\d{3}[A-Za-z]\b", re.IGNORECASE),
        "validate": codice_fiscale_check,
    },
    {
        "type": "INSEE",  # France (NIR, with or without spacing)
        "regex": re.compile(r"\b[12]\s?\d{2}\s?(?:0[1-9]|1[0-2])\s?(?:\d{2}|2[AB])\s?\d{3}\s?\d{3}\s?\d{2}\b"),
        "validate": insee_check,
    },
    {
        "type": "SSN",  # kept for US-format data pasted into prompts
        "regex": re.compile(r"\b\d{3}-\d{2}-\d{4}\b"),
    },
    {
        "type": "IP_ADDRESS",
        "regex": re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b"),
        "validate": lambda m: all(int(o) <= 255 for o in m.split(".")),
    },
    {
        "type": "API_KEY",
        "regex": re.compile(
            r"\b(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36}|gho_[a-zA-Z0-9]{36}"
            r"|AKIA[0-9A-Z]{16}|xox[baprs]-[a-zA-Z0-9-]{10,}"
            r"|sk_live_[a-zA-Z0-9]{20,}|pk_live_[a-zA-Z0-9]{20,})\b"),
    },
]


def find_structured_spans(text: str):
    """Run every deterministic pattern over `text`.

    Returns a list of non-overlapping (start, end, type) spans. Earlier
    registry entries win overlaps, so national IDs beat generic patterns.
    Phone numbers come from the `phonenumbers` matcher rather than a
    hand-rolled regex — it understands every EU national format instead
    of just the North American one.
    """
    spans = []

    def overlaps(start, end):
        return any(s < end and start < e for s, e, _ in spans)

    for entry in PII_PATTERNS:
        for m in entry["regex"].finditer(text):
            if overlaps(m.start(), m.end()):
                continue
            if "validate" in entry and not entry["validate"](m.group()):
                continue
            spans.append((m.start(), m.end(), entry["type"]))

    # region=None catches any number written in international +XX format.
    # Bare national formats (e.g. "0171 2345678") are only recognizable
    # relative to a region, so we additionally sweep the EU regions —
    # this is what closes the gap the old US-only phone regex left open.
    phone_regions = [None, "DE", "FR", "ES", "IT", "PL", "NL", "BE", "AT",
                     "PT", "SE", "DK", "FI", "IE", "GB", "US"]
    for region in phone_regions:
        for match in phonenumbers.PhoneNumberMatcher(
                text, region, leniency=phonenumbers.Leniency.VALID):
            if not overlaps(match.start, match.end):
                spans.append((match.start, match.end, "PHONE"))

    return sorted(spans)
