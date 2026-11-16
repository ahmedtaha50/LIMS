# r3-directory: sign-on with the company directory (E17)

- `migrations/0200_directory.sql`: an account is local or from the directory; break-glass accounts are local (constraint).
- `server/directory/index.ts`: LDAP / Active Directory through `ldapts`: the service account searches, the user's own bind
  checks the password, the roles come from the groups (`EBR_LDAP_GROUP_ROLES`) at every sign-in, a change of roles is
  audited, a user in no mapped group is refused with the reason, the user name is escaped (RFC 4515), an empty password is
  never sent (it would be an anonymous bind). Distinguished names and attribute names are compared without case and spaces.
- Sign-in (gate patch to r1-identity's `server/routes/auth.ts`): with a directory configured, accounts that are not local go
  to the directory; local and break-glass accounts always sign in here. Directory unreachable: 503 with "use a break-glass
  account"; locked accounts stay locked. E-signatures of directory users are checked by the directory (gate patch to
  `server/identity/index.ts`).

Evidence: `tests/api/directory.test.ts` 7 passed against a real LDAP server on the wire (`ldapjs`, development only:
that package is decommissioned and is not shipped; the shipped client is `ldapts`). Planted fault: escaping removed → the
filter-injection test failed. Two robustness fixes came out of the test: group DNs and attribute names compared without case.

Not verified: a real Active Directory of the plant (its group names and filter are site settings).
