/**
 * Roadmap M24 (r2-ui-foundation): the accessible primitives (src/components/ui), the DataGrid and the shell, rendered to markup.
 * What needs a real browser (focus trap, focus return, Esc, the drawer, virtual scrolling, axe) is in tests/ui-foundation.cjs.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Badge, stateTone } from '../../../src/components/ui/Badge';
import { Button, IconButton } from '../../../src/components/ui/Button';
import { EntityPicker } from '../../../src/components/ui/EntityPicker';
import { Field, fieldErrors } from '../../../src/components/ui/Field';
import { Modal, nextFocusIndex } from '../../../src/components/ui/Modal';
import { ToastProvider } from '../../../src/components/ui/Toast';
import { DataGrid, gridQuerySpec, virtualWindow } from '../../../src/components/DataGrid';
import { Inbox } from '../../../src/components/Inbox';
import { Layout, NAV_SECTIONS } from '../../../src/components/Layout';
import { SHELL_EXTENSIONS } from '../../../src/components/shell/registry';
import { ApiError } from '../../../src/lib/api';

const h = React.createElement;
const html = (node: React.ReactElement) => renderToStaticMarkup(h(ToastProvider, null, node));
const user = { id: 'usr-1', name: 'Test Analyst', email: 'a@gxp.test', role: 'Analyst', active: true, hasCompletedSoftwareTraining: true, mfaEnabled: false, mustChangePassword: false, passwordExpiresAt: '2030-01-01T00:00:00.000Z' };

describe('Button and IconButton', () => {
  it('a Button is type="button" unless told otherwise (no accidental form submits) and says when it is busy', () => {
    expect(html(h(Button, null, 'Save'))).toContain('type="button"');
    expect(html(h(Button, { type: 'submit' }, 'Save'))).toContain('type="submit"');
    const busy = html(h(Button, { busy: true }, 'Save'));
    expect(busy).toContain('aria-busy="true"');
    expect(busy).toContain('disabled=""');
  });

  it('an IconButton always carries its accessible name', () => {
    const out = html(h(IconButton, { label: 'Close dialog', icon: h('svg') }));
    expect(out).toContain('aria-label="Close dialog"');
    expect(out).toContain('title="Close dialog"');
  });
});

describe('Modal', () => {
  it('is a labelled modal dialog', () => {
    const out = html(h(Modal, { open: true, title: 'Bulk Sample Import', onClose: () => {} }, h('input', { name: 'x' })));
    expect(out).toContain('role="dialog"');
    expect(out).toContain('aria-modal="true"');
    expect(out).toMatch(/aria-labelledby="([^"]+)"[\s\S]*id="\1"[^>]*>Bulk Sample Import</);
    expect(out).toContain('aria-label="Close dialog"');
  });

  it('renders nothing when closed', () => {
    expect(html(h(Modal, { open: false, title: 'x', onClose: () => {} }, 'body'))).not.toContain('role="dialog"');
  });

  it('a dialog that must not be dismissed (a signature after the password was sent) has no close button', () => {
    const out = html(h(Modal, { open: true, title: 'Sign', onClose: () => {}, dismissible: false }, 'body'));
    expect(out).not.toContain('aria-label="Close dialog"');
  });

  it('the focus trap wraps at both ends', () => {
    expect(nextFocusIndex(3, 2, false)).toBe(0);
    expect(nextFocusIndex(3, 0, true)).toBe(2);
    expect(nextFocusIndex(3, -1, false)).toBe(0);
    expect(nextFocusIndex(3, -1, true)).toBe(2);
    expect(nextFocusIndex(3, 1, false)).toBe(null); // the browser moves it
    expect(nextFocusIndex(0, -1, false)).toBe(-1); // nothing focusable: keep the focus on the dialog
  });
});

describe('Field', () => {
  it('ties the label, the hint and the error to the control', () => {
    const out = html(h(Field, { label: 'Batch Number', hint: 'As printed on the label', error: 'Required' }, (p: any) => h('input', p)));
    const id = /<label[^>]*for="([^"]+)"/.exec(out)?.[1];
    expect(id).toBeTruthy();
    expect(out).toContain(`id="${id}"`);
    expect(out).toContain('aria-invalid="true"');
    expect(out).toMatch(/aria-describedby="[^"]+ [^"]+"/);
    expect(out).toContain('role="alert"');
  });

  it('maps a server validation error to field messages ({ error, fields })', () => {
    const e = new ApiError(400, 'VALIDATION_FAILED', 'material: Required; batch: Too long', { details: [{ path: 'material', message: 'Required' }, { path: 'items.0.batch', message: 'Too long' }] });
    expect(fieldErrors(e)).toEqual({ material: 'Required', 'items.0.batch': 'Too long' });
    expect(fieldErrors(new Error('x'))).toEqual({});
  });
});

describe('Badge', () => {
  it('shows the state as text (colour is never the only cue)', () => {
    expect(html(h(Badge, { tone: stateTone('Rejected') }, 'Rejected'))).toContain('>Rejected<');
    expect(stateTone('Approved')).toBe('success');
    expect(stateTone('Pending Review')).toBe('warning');
    expect(stateTone('Rejected')).toBe('danger');
    expect(stateTone('Something new')).toBe('neutral');
  });
});

describe('EntityPicker', () => {
  it('is a combobox with a listbox, labelled', () => {
    const out = html(h(EntityPicker, { kind: 'users', label: 'Assigned to', value: '', onChange: () => {} }));
    expect(out).toContain('role="combobox"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('aria-autocomplete="list"');
    expect(out).toMatch(/<label[^>]*for="([^"]+)"[^>]*>Assigned to<\/label>[\s\S]*id="\1"/);
  });
});

describe('DataGrid', () => {
  const columns = [{ key: 'id', header: 'Sample ID', sortable: true }, { key: 'material', header: 'Material', sortable: true }, { key: 'version', header: 'Version' }];
  const grid = () => html(h(DataGrid as any, { caption: 'Samples', endpoint: '/lists/samples', columns, rowKey: (r: any) => r.id, defaultSort: { key: 'id', dir: 'desc' } }));

  it('starts in an honest loading state, with a captioned table and sortable headers announced', () => {
    const out = grid();
    expect(out).toContain('<caption');
    expect(out).toContain('Samples');
    expect(out).toContain('role="status"');
    expect(out).toMatch(/Loading/);
    expect(out).toMatch(/<th[^>]*aria-sort="descending"[^>]*>[\s\S]*Sample ID/);
    expect(out).toMatch(/<th[^>]*aria-sort="none"[^>]*>[\s\S]*Material/);
    expect(out).toMatch(/<th(?![^>]*aria-sort)[^>]*>Version<\/th>/); // not sortable: no sort state announced
    expect(out).toContain('aria-label="Search Samples"');
  });

  it('keeps sort, direction, search, filters and the page cursor in the URL query', () => {
    const spec = gridQuerySpec(columns as any, { key: 'id', dir: 'desc' }, [{ key: 'state', label: 'State', options: [{ value: 'Logged', label: 'Logged' }] }]);
    expect(Object.keys(spec).sort()).toEqual(['after', 'before', 'dir', 'limit', 'q', 'sort', 'state'].sort());
    expect((spec.sort as any).oneOf).toEqual(['id', 'material']);
  });

  it('renders only the rows in view when a page is long (virtual window with spacers)', () => {
    expect(virtualWindow({ count: 10, rowHeight: 40, scrollTop: 0, viewport: 400 })).toEqual({ start: 0, end: 10, padTop: 0, padBottom: 0 });
    const w = virtualWindow({ count: 1000, rowHeight: 40, scrollTop: 4000, viewport: 400, overscan: 5 });
    expect(w.start).toBe(95);
    expect(w.end).toBe(115);
    expect(w.padTop).toBe(95 * 40);
    expect(w.padBottom).toBe((1000 - 115) * 40);
  });
});

describe('shell', () => {
  it('the extension registry adds My Tasks to the navigation without App or Layout naming it', () => {
    const inbox = SHELL_EXTENSIONS.find(e => e.id === 'inbox');
    expect(inbox?.label).toBe('My Tasks');
    expect(NAV_SECTIONS.flatMap(s => s.items.map(i => i.id))).toContain('inbox');
  });

  it('Layout has a skip link, a labelled main region, a navigation drawer button and a bench-mode switch', () => {
    const out = html(h(Layout, { user, currentView: 'samples', onNavigate: () => {}, onLogout: () => {} }, h('p', null, 'body')));
    expect(out).toMatch(/<a[^>]*href="#main"[^>]*>Skip to content<\/a>/);
    expect(out).toContain('id="main"');
    expect(out).toContain('aria-label="Open navigation"');
    expect(out).toMatch(/aria-pressed="(true|false)"[^>]*>[\s\S]*Bench mode/);
    expect(out).toMatch(/<nav[^>]*aria-label="Main"/);
  });

  it('the inbox starts honest: a loading state, and an order it really applies', () => {
    const out = html(h(Inbox, {}));
    expect(out).toContain('role="status"');
    expect(out).not.toMatch(/urgency/i);
  });
});
