# Reporting: every claim carries its receipt

The through-line of the whole method: a statement that something works names where it was shown.

| Say | Only when |
|---|---|
| "verified here" | you ran it in this session and read the output (give the totals) |
| "verified in CI on <OS>" | you read that job's steps and log, not just its colour |
| "running" | pushed, run not finished: schedule a check and come back |
| "not verified" | everything else: Windows-only paths, a real directory server, a browser pass, a skipped suite |

Rules:
- Lead with the outcome and what needs the user's decision. A failure goes first, never at the bottom.
- Your own mistake is named as yours, with the fix.
- Partial is partial: list what was not done and what was not run.
- Decisions only a person can make are a list, not prose: approvals, keys, certificates, retention numbers, wording review.
- Reply in the user's language, short, no jargon walls. Explain a term once when it is the obstacle (what a code-signing
  certificate is, why Windows shows a warning).
- When a permission check refuses an action, do not work around it; say what you wanted, why, and let the user decide.
- Do not commit while the tree is mid-change (agents writing, a file temporarily patched for a test): say why in one line, commit
  when it is coherent, and check the temporary change is gone before committing.

After a wave, a fix or a build, the message has five parts: what was built or fixed; the numbers (suite, evidence checks, CI);
what is not done or not verified; decisions for the user; what happens next (and when you will check again).

The third and fourth parts are read from the register, not from memory: `node scripts/open-items.cjs list` (and
`list --kind decision`). A question the user has not answered goes on the list too
(`open-items.cjs add --kind decision --source "<the message>" "<the question>"`), so it is asked again instead of forgotten.

## Exit gate

`node scripts/factory.cjs exit report --repo .` before the message is sent: the tree is clean, HEAD is pushed, the register is
consistent. Four lines stay with you: every claim names its receipt; failures and your own mistakes come first; what is not done
and the decisions are listed; what happens next is stated.
