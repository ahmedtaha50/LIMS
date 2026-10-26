/**
 * Roadmap M41 (r3-directory), the directory screen rendered on the server (no browser), like the other *-ui tests. The sign-in itself is
 * covered by directory-signon.test.ts. A mapping state is written in words; only a holder of directory.approve is offered the decision;
 * the decision is signed with the DIRECTORY_MAPPING meaning; no password or key is ever put into the markup.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MappingTable, type MappingRow } from '../../src/components/DirectorySettings';

const row = (status: MappingRow['status'], over: Partial<MappingRow> = {}): MappingRow => ({
  id: `dgr-${status}`, groupDn: 'CN=LIMS-QA,OU=Groups,DC=corp,DC=example', role: 'QA', status, reason: 'Quality staff', createdBy: 'usr-admin', version: 1, ...over,
});
const render = (rows: MappingRow[], canDecide: boolean) => renderToStaticMarkup(React.createElement(MappingTable, { rows, canDecide }));

describe('the group mapping table', () => {
  it('says in words what each state means', () => {
    const html = render([row('Draft'), row('Approved'), row('Retired')], false);
    expect(html).toContain('Proposed: not used at sign-in until QA approves it');
    expect(html).toContain('Approved: members of the group receive the role at each sign-in');
    expect(html).toContain('Retired: no longer used');
  });
  it('offers approval only for a Draft and only to a person who may decide; retiring is offered for a live mapping', () => {
    expect(render([row('Draft')], false)).not.toMatch(/Approve\.\.\.|Retire\.\.\./);
    const html = render([row('Draft'), row('Approved'), row('Retired')], true);
    expect((html.match(/Approve\.\.\./g) ?? []).length).toBe(1);
    expect((html.match(/Retire\.\.\./g) ?? []).length).toBe(2);
  });
  it('says what an empty table means and is an accessible table', () => {
    const html = render([], true);
    expect(html).toContain('Nobody can sign in with the directory until QA approves a mapping.');
    expect(html).toMatch(/<caption class="sr-only">Directory group to role mapping/);
    expect((html.match(/<th scope="col"/g) ?? []).length).toBe(4);
  });
});

describe('the screen source', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'DirectorySettings.tsx'), 'utf8');
  it('signs a decision with the catalog meaning and reports every failure to the user', () => {
    expect(src).toContain('meaningCode="DIRECTORY_MAPPING"');
    expect(src).not.toMatch(/\balert\(/);
    expect(src).not.toMatch(/catch\s*(\([^)]*\))?\s*\{\s*\}/);
  });
  it('never shows the stored bind password: the field is write-only', () => {
    expect(src).toContain('hasBindPassword');
    expect(src).not.toMatch(/bindPassword\s*:\s*string\s*\|\s*null/);
  });
});
