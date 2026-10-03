# Evidence-linked diagnosis

`diagnosis record/get` stores bounded hypotheses and proposed fix steps linked
to owned terminal incident rows. Gather further evidence through a separately
requested `incident collect`; diagnosis never dispatches probes or commands.

Record supplies a registered workspace, 1–8 hypotheses and 1–8 fix proposals.
Hypotheses contain statement, rationale, low/medium/high asserted confidence,
assumptions, unknowns and supporting/contradicting incident ID/sequence/hash
references. Up to 32 distinct references across eight incidents are resolved.
Proposals cite hypothesis IDs and describe a fix and verification in prose.
They are nonexecuting interpretations. Omit secrets from all caller prose.

Server-derived facts retain only validated observation metadata, source hashes,
timestamps and registration fingerprints. Incomplete support requires an unknown
explanation. High confidence is a caller assertion, not a verified cause or a
calibrated probability. Every source is revalidated after all registry awaits.

Get preserves historical facts and interpretations while reporting each support
as current/stale/unavailable. Missing/hash-replaced source or registration drift
cannot become fresh support. These checks grant no patch/deployment authority.
Registered workspace/host checks are metadata checks, not physical authentication.

Migration 017 adds immutable owner-scoped documents, 32 per owner/256 globally,
32 KiB total per document. Exact-input repeat keeps the original; different ID
reuse fails. Quotas, corruption checks and one request deadline bound state and
reads. Old binaries ignore the new table. No automatic retry or replay exists.

v1.49 is a candidate until local, Ubuntu/package, installed transport/lifecycle
and native gates close. v1.50 will separately prepare local fix tasks. No live
fleet, native provider authentication or publication approval is implied.
