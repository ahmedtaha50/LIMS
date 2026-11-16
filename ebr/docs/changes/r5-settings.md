# r5-settings: site settings for sessions and sign-in (E27)

Decision implemented with the proposed defaults, kept changeable: sign-off after 15 minutes idle, 12 hours at most,
lock after 5 failed sign-ins in 15 minutes, for 30 minutes.

- `migrations/0300_site_settings.sql`: only changed values are stored; deleting is refused by trigger.
- `server/settings/index.ts`: every setting of R5 declared with its bounds (sessions, sign-in, yield, directory); a default
  can come from the old environment variable, so an installation configured before R5 keeps its values; `change` checks the
  bounds and the version read, signs (meaning approved, the reason as comment), stores, audits old and new value.
- `GET /api/settings` (administrator, QA), `PUT /api/settings/:key` (administrator).

Gate needs: `server/identity/roles.ts` (settings.read for QA and administrator, settings.manage for administrator),
`server/identity/sessions.ts` (idle and maximum length read in the session query itself: no extra query per request),
`server/routes/auth.ts` (lockout numbers read at each failure); route table (65) and permission matrix regenerated.

Found by the tests: the answer of a change was read through the pool, outside the transaction not yet committed, so it
showed the old value; it is read inside the transaction now.

Evidence: `tests/api/settings.test.ts` 4 passed. Planted fault: sign-in using a fixed 5 instead of the setting: caught.
NOT done here: the settings screen (built in r5-i18n, translated from the start).
