# r5-yield: yield limits per product (E29)

Decision implemented: limits per product, with the site limits (95 to 102 %) as the default.

- `server/mbr/design.ts` (gate patch, r1-mbr): optional `yieldLimits { minPct, maxPct }`, 50 to 150 %, lower below upper;
  a product may end below 100 % (found by the test: a first rule wrongly forced the upper limit to 100 % or more). The limits
  are part of the design, so QA approves them with the version, and a copied recipe carries them.
- `server/materials/yield.ts`: the limits of the very version the batch was made from, else the site settings.
- `server/materials/service.ts` (gate patch, r2-materials): the reconciliation uses them, names them and their source in the
  exception, and records them in the signed reconciliation. The environment variables become the default of the settings.

Evidence: `tests/api/yield.test.ts` 3 passed. Planted fault: the recipe's limits ignored: caught.
