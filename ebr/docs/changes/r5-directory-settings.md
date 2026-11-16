# r5-directory-settings: directory settings managed in the application (E31)

Decision implemented: the plant's directory values (server, service account, groups for each role) are entered by an
administrator in the application, signed and audited, instead of being fixed in the server environment.

- `server/directory/index.ts`: `directoryConfig` reads the site settings at each sign-in (a change holds for the next one);
  each setting's default is the old environment variable, so an installation configured before R5 keeps working. The
  service account's password stays a server secret (`EBR_LDAP_BIND_PASSWORD`), never a setting.
- `testConnection` and `POST /api/settings/directory/test` (administrator): does the directory answer, does the service
  account sign in, does the search base exist; each reported on its own; signs nobody in.

Gate needs: `server/identity/index.ts` and `server/routes/auth.ts` (`await directoryConfig(pool)`); route table (67).

Evidence: `tests/api/directory-settings.test.ts` 4 passed, against a real LDAP server, configured through the settings only
(wrong filter, unknown role and non-LDAP address refused; connection test for a good, a wrong and an unreachable setup;
no account created by the test; a changed group map gives the new role at the next sign-in). The 22 tests of the R3
directory suite still pass through the environment defaults. Planted fault: settings ignored: caught.
