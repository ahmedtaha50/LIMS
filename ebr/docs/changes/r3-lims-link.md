# r3-lims-link: samples to the LIMS, results back (E18)

- `server/lims/client.ts` defines the integration contract (two endpoints of the LIMS, a bearer token issued by the LIMS):
  find a sample request by its external reference, create one. The EBR always looks for the reference before creating, so a
  request whose answer was lost is found at the retry, never created twice.
- `server/steps/sample/`: the sample step requests the sample when it is signed; reference `EBR:<batch>:<phase>.<step>`.
  LIMS down: 503 "the step is not recorded and no duplicate request will be made"; a refused token is reported as such.
- `GET /api/batches/:id/lims`: the batch's samples; a result is fetched and KEPT on the batch only once it is approved in
  the LIMS (audited), so it stays readable when the LIMS is down.
- `migrations/0210_lims_link.sql`: the requests of each batch.

Evidence: `tests/api/lims-link.test.ts` 4 passed against a stand-in LIMS implementing the contract, which can go down and
can lose an answer after creating the sample. Planted fault: the look-up before creating removed → a duplicate, caught.

NOT done (decision and work for the LIMS side): the LIMS in this repository does not yet offer `/api/integration/samples`
nor integration tokens. Until it does, this link is tested against the stand-in only.
