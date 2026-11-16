# r5-lims-v1: the LIMS link over the LIMS machine API (E30)

Decision implemented: the LIMS needs no new endpoints. Its machine API (/api/v1, roadmap M22 of the LIMS) already offers
what the link needs, and its API clients screen is where the token is issued.

- Registration: `POST /api/v1/samples:batch`, body `{ items: [{ material: <product>, batch }] }`, header
  `Idempotency-Key: EBR:<batch>:<phase>.<step>`. A repeat with the same key (after an outage or a lost answer) gets the
  stored answer (`Idempotent-Replayed: true`) and registers nothing: the find-before-create of R3 is no longer needed.
- Result: `GET /api/v1/samples/{id}`; kept on the batch once the state is `Approved` (results as parameter, value, unit,
  out of specification).
- Token: the LIMS administrator creates an API client with the scopes `samples:write` and `samples:read`, an expiry and a
  signed reason; its token is `EBR_LIMS_TOKEN`. `EBR_LIMS_URL` is the LIMS address (a trailing `/api/v1` is accepted).
- Problems (`application/problem+json`) are shown with their detail; 401/403 says the token is refused.

Evidence: `tests/api/lims-link.test.ts` 8 passed, against a stand-in that behaves as the LIMS v1 does (required key, replay,
422 for a key reused with another body, problem answers), and a contract test that checks every operation, header and field
the EBR uses against `docs/api/openapi.json`, which the LIMS generates from its route declarations and checks in its own CI
(`openapi-cli.ts check`). The replay itself is proven by the LIMS's own suite (`tests/api/api-v1.test.ts`). Planted fault:
no Idempotency-Key: five tests fail (duplicates, contract).

NOT verified: a run against a live LIMS instance (the two are separate applications; the contract is checked, not a
deployment).
