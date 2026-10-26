/**
 * Roadmap M37 (r2-validation), the screen of the module qualification register. Rendered on the server with react-dom (no browser), like the
 * other *-ui tests; the data flow and the refusal are covered by qualified-modules.test.ts.
 *
 * A NotQualified module must be shown as read-only in words (not by colour alone); only a holder of validation.scope is offered the
 * declaration; the declaration is signed with the MODULE_QUALIFICATION meaning; the screen is a shell extension, so no shared file is edited.
 */
import fs from 'fs';
import path from 'path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ScopeTable, type ScopeRow } from '../../src/components/ModuleQualification';

const row = (module: string, status: ScopeRow['status'], over: Partial<ScopeRow> = {}): ScopeRow => ({
  module, title: `Title of ${module}`, segments: [module], status, declared: status !== 'Undeclared', writesAllowed: status !== 'NotQualified',
  reason: status === 'Undeclared' ? null : 'OQ executed and accepted', evidenceRef: null, updatedBy: null, updatedAt: status === 'Undeclared' ? null : '2026-10-25T10:00:00.000Z', version: status === 'Undeclared' ? 0 : 2, ...over,
});
const render = (rows: ScopeRow[], canDeclare: boolean) => renderToStaticMarkup(React.createElement(ScopeTable, { rows, canDeclare }));

describe('the module qualification table', () => {
  it('says in words that a NotQualified module is read-only, a Qualified one is open, an undeclared one is not declared', () => {
    const html = render([row('oos', 'NotQualified'), row('qms', 'Qualified'), row('eln', 'Undeclared')], false);
    expect(html).toContain('Read-only: changes are refused');
    expect(html).toContain('Qualified: changes are allowed');
    expect(html).toContain('Not declared: changes are allowed');
    expect(html).toContain('OQ executed and accepted');
    expect(html).toContain('2026-10-25 (version 2)');
  });

  it('offers the declaration only to a person who may make it', () => {
    expect(render([row('oos', 'Undeclared')], false)).not.toContain('Declare...');
    expect(render([row('oos', 'Undeclared')], true)).toContain('Declare...');
  });

  it('is an accessible table: a caption, column headers with scope, a name for the actions column', () => {
    const html = render([row('oos', 'Qualified', { evidenceRef: 'OQ-19' })], true);
    expect(html).toMatch(/<caption class="sr-only">Qualification status/);
    expect((html.match(/<th scope="col"/g) ?? []).length).toBe(5);
    expect(html).toContain('<span class="sr-only">Actions</span>');
    expect(html).toContain('Evidence: OQ-19');
  });

  it('says when the register is empty or loading instead of showing an empty table', () => {
    expect(render([], false)).toContain('No module is in the register.');
    expect(renderToStaticMarkup(React.createElement(ScopeTable, { rows: [], canDeclare: false, loading: true }))).toContain('Loading...');
  });
});

describe('the screen', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'ModuleQualification.tsx'), 'utf8');

  it('signs the declaration with the catalogue meaning, bound to the next record version, and reports every outcome', () => {
    expect(source).toContain('meaningCode="MODULE_QUALIFICATION"');
    expect(source).toContain('recordVersion={signing.row.version + 1}');
    expect(source).toContain('expectedVersion: signing.row.version');
    expect(source).toContain("toast.error(errorMessage(err, 'The module qualification could not be loaded.'))");
    expect(source).not.toMatch(/\balert\(/);
  });

  it('is added to the shell as an extension file', () => {
    const ext = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'components', 'shell', 'ext', 'module-qualification.tsx'), 'utf8');
    expect(ext).toContain("id: 'module-qualification'");
    expect(ext).toContain("section: 'Regulatory & Governance'");
  });
});
