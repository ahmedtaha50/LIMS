# Regulatory anchors: citing a regulation without inventing one

A clause number written from memory by an agent ends in a change record, then in a validation document, then in front of an
inspector. This page is the rule for citations and for the words that carry regulatory weight.

## The rule

1. **Cite only what the anchor list holds.** Print it: `node scripts/citation-check.cjs --list`. It covers 21 CFR Part 11,
   EU GMP Annex 11 (the 2011 text), the GAMP 5 software categories, PIC/S PI 011 and PI 041, the ICH quality guidelines the
   source project used, and the ALCOA+ attributes. The single source is `scripts/lib/anchors.json`.
2. **Anything else is for a person.** Another CFR part, another annex, a guidance document, a pharmacopoeia chapter: write the
   claim without a clause number, or mark it "citation to be confirmed by QA". Do not guess the number.
3. **Never quote regulatory text from memory.** The list holds clause numbers with a short paraphrase of the subject. A
   document may point to the clause; the wording of the regulation is copied only by a person, from the source.
4. **A clause is a pointer, not a verdict.** The check confirms the clause exists. Whether it is the right clause for the
   claim, and whether the system satisfies it, is for QA.

## The check

```bash
node scripts/citation-check.cjs --repo .            # AGENTS.md, README, docs, validation sources
node scripts/citation-check.cjs --repo . --strict   # before a package goes to QA: unlisted citations fail too
```

| Status | Meaning | Move |
|---|---|---|
| VALID | the clause is in the list | nothing |
| INVALID | it cannot exist (a section Part 11 does not have, a paragraph past the last one, an Annex 11 clause above 17, GAMP category 2) | remove it, or replace it after a person has read the regulation |
| UNLISTED | real-looking, outside the list | a person confirms it against the text; list those citations in the handover to QA |

`factory.cjs exit validation` runs the check. Run it also after a wave: tracks write citations into comments and change records.

## The list is not a calendar

It says which numbers can exist, not which revision applies today. `--list` ends with the revisions that were open when the
list was last checked, with the date. For a document that will be signed, a person opens the source and confirms the clause:
eCFR for 21 CFR, EudraLex Volume 4 for the EU GMP annexes, picscheme.org, ich.org, ISPE for GAMP.

When a new revision comes into force: update `scripts/lib/anchors.json` from the published text (a person confirms each
number), change the dates in its `watch` notes, run `node scripts/selftest.cjs`, and re-run the check on the project: clause
numbers that moved now show as INVALID, which is the point.

## Words that carry regulatory weight

Use them only when the condition holds. Otherwise use the plain word in the right-hand column.

| Word | Only when | Otherwise say |
|---|---|---|
| validated | the summary report is approved and signed by the people the plan names | "tested", "verified by an executed test" |
| qualified (IQ/OQ/PQ done) | the protocol was executed on the target system by a named person and reviewed | "executed in a sandbox", "not performed on the target PC" |
| compliant with Part 11 / Annex 11 | never as your own conclusion | "implements controls for 11.10(e)", with the test that shows it |
| approved, reviewed, signed | a named person did it, and the record shows it | "draft", "awaiting approval"; leave the field blank |
| audit trail | computer-generated, time-stamped, written in the same transaction as the change, and not editable | "change log" |
| electronic signature | name, date and time, meaning; linked to the record version; identity re-checked at signing | "confirmation" |
| requirement (URS id) | the System Owner approved it | "proposed requirement" |
| released, production | the release was signed, built from a tagged commit, and its installer verified | "pre-release", "not a validated release" |

## What is never invented

Approvals and signatures; requirement ids presented as approved; retention periods and other numbers a regulation or a company
procedure fixes; names of procedures (SOP numbers); regulatory citations; keys and certificates. Where one is needed and
missing, implement the conservative default, leave the field blank or marked "to be decided", and put it on the open-items
list as a decision (`open-items.cjs add --kind decision`).
