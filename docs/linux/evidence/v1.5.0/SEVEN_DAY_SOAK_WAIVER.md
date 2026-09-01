# v1.5.0 seven-day soak waiver

This release intentionally does **not** claim completion of the seven-day
production soak. The product owner explicitly waived that gate on 2026-09-01
so implementation could continue to the next version.

```text
SEVEN_DAY_SOAK_GATE: WAIVED
PRODUCTION_EVIDENCE_CLAIM: NONE
```

The VM103 soak remains running as non-gating observational evidence. It must
not be used to represent a completed production soak unless a later operator
run produces the required seven-day TSV and acceptance summary.
