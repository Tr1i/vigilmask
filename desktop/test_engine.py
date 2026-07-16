"""Smoke tests for the hybrid detection pipeline. Run: python test_engine.py"""

from eu_patterns import (bnn_check, codice_fiscale_check, dni_nie_check,
                         find_structured_spans, iban_check, insee_check,
                         luhn_check, pesel_check, steuer_id_check)


def check(name, condition):
    print(f"  {'PASS' if condition else 'FAIL'}  {name}")
    return condition


def main():
    ok = True
    print("Checksum validators:")
    ok &= check("IBAN valid (DE)", iban_check("DE89370400440532013000"))
    ok &= check("IBAN invalid", not iban_check("DE89370400440532013001"))
    ok &= check("Luhn valid", luhn_check("4111111111111111"))
    ok &= check("Luhn invalid", not luhn_check("4111111111111112"))
    ok &= check("PESEL valid", pesel_check("44051401359"))
    ok &= check("PESEL invalid", not pesel_check("44051401358"))
    ok &= check("Steuer-ID valid", steuer_id_check("86095742719"))
    ok &= check("Steuer-ID invalid", not steuer_id_check("86095742710"))
    ok &= check("DNI valid", dni_nie_check("12345678Z"))
    ok &= check("DNI invalid", not dni_nie_check("12345678A"))
    ok &= check("NIE valid", dni_nie_check("X1234567L"))
    ok &= check("Codice Fiscale valid", codice_fiscale_check("RSSMRA85T10A562S"))
    ok &= check("Codice Fiscale invalid", not codice_fiscale_check("RSSMRA85T10A562A"))
    ok &= check("INSEE valid", insee_check("255081416802538"))
    ok &= check("BNN valid (pre-2000)", bnn_check("85073003328"))
    ok &= check("BNN valid (post-2000)", bnn_check("01021503366"))
    ok &= check("BNN invalid", not bnn_check("85073003361"))

    print("Structured span detection:")
    text = ("Contact jan.kowalski@firma.pl or +48 22 123 45 67. "
            "PESEL 44051401359, IBAN DE89 3704 0044 0532 0130 00, "
            "card 4111 1111 1111 1111.")
    spans = find_structured_spans(text)
    types = {t for _, _, t in spans}
    ok &= check(f"finds EMAIL/PHONE/PESEL/IBAN/CREDIT_CARD (got {sorted(types)})",
                {"EMAIL", "PHONE", "PESEL", "IBAN", "CREDIT_CARD"} <= types)

    print("\nAll passed." if ok else "\nFAILURES above.")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
