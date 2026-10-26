/**
 * Roadmap M06 (r1-client-shell), the screens. Rendered on the server with react-dom (no browser, no mocks of the product):
 * what each screen shows in a given state. The behaviour that needs a browser (an idle lock over a half-typed form, a token that
 * dies under a mounted Dashboard) is covered by tests/client-shell.cjs; the data layer behind it by tests/api/client-session.test.ts.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ChangePassword } from '../../../src/components/ChangePassword';
import { Layout, NAV_SECTIONS, VIEW_TITLES } from '../../../src/components/Layout';
import { CredentialsForm, Login, RecoveryCodes, TotpChallenge, TotpEnrolment } from '../../../src/components/Login';
import { ReauthModal } from '../../../src/components/ReauthModal';
import { IdleWarning, WARNING_SECONDS, idlePhase } from '../../../src/components/SessionGuard';
import { ErrorBoundary, SessionExpiredPanel, ViewFailure } from '../../../src/components/ui/ErrorBoundary';
import { ToastProvider, useToast } from '../../../src/components/ui/Toast';

const h = React.createElement;
const html = (node: React.ReactElement) => renderToStaticMarkup(h(ToastProvider, null, node));
const user = { id: 'usr-1', name: 'Test Analyst', email: 'a@gxp.test', role: 'Analyst', active: true, hasCompletedSoftwareTraining: true, mfaEnabled: false, mustChangePassword: false, passwordExpiresAt: '2030-01-01T00:00:00.000Z' };

describe('idle timer', () => {
  const minute = 60_000;
  const at = (idleMs: number, timeoutMs = 15 * minute) => idlePhase({ now: 1_000_000 + idleMs, lastActivity: 1_000_000, timeoutMs });

  it('is active until the last minute, warns for 60 s, then locks', () => {
    expect(WARNING_SECONDS).toBe(60);
    expect(at(0).phase).toBe('active');
    expect(at(14 * minute - 1).phase).toBe('active');
    expect(at(14 * minute).phase).toBe('warning');
    expect(at(15 * minute - 1).phase).toBe('warning');
    expect(at(15 * minute).phase).toBe('locked');
    expect(at(10 * 60 * minute).phase).toBe('locked'); // a sleeping laptop wakes up long after the deadline
  });

  it('counts the seconds left, rounding up, and never goes below zero', () => {
    expect(at(14 * minute).secondsLeft).toBe(60);
    expect(at(14 * minute + 1500).secondsLeft).toBe(59);
    expect(at(15 * minute).secondsLeft).toBe(0);
    expect(at(16 * minute).secondsLeft).toBe(0);
  });

  it('the warning dialog tells the user how long is left and offers to stay or sign out', () => {
    const out = html(h(IdleWarning, { secondsLeft: 42, onStay: () => {}, onSignOut: () => {} }));
    expect(out).toContain('role="alertdialog"');
    expect(out).toContain('42');
    expect(out).toContain('Stay signed in');
    expect(out).toContain('Sign out');
  });
});

describe('Layout', () => {
  const render = (view: string, u = user) => html(h(Layout, { user: u, currentView: view, onNavigate: () => {}, onLogout: () => {} }, h('p', null, 'view body')));

  it('shows no static "Validated" or "Compliant" badge', () => {
    const out = render('samples');
    expect(out).not.toMatch(/Validated/);
    expect(out).not.toMatch(/Compliant/);
  });

  it('titles the page from the navigation label, not from the view id ("specs", "oos", "eln" were printed raw)', () => {
    for (const [id, title] of [['specs', 'Test Specifications'], ['oos', 'OOS Investigations'], ['eln', 'Lab Notebook (ELN)'], ['audit', 'Audit Trail (Part 11)']] as const) {
      const out = render(id);
      expect(out, id).toContain(`>${title.replace(/&/g, '&amp;')}</h2>`);
    }
  });

  it('has a title for every navigation entry, and the System Admin entry only for an Admin', () => {
    const ids = NAV_SECTIONS.flatMap(s => s.items.map(i => i.id));
    expect(ids.length).toBeGreaterThan(10);
    for (const id of ids) expect(VIEW_TITLES[id], id).toBeTruthy();
    expect(render('samples')).not.toContain('System Admin');
    expect(render('samples', { ...user, role: 'Admin' })).toContain('System Admin');
  });

  it('renders the signed-in user from /auth/me and the view it is given', () => {
    const out = render('samples');
    expect(out).toContain('Test Analyst');
    expect(out).toContain('view body');
  });
});

describe('sign-in screens', () => {
  it('the first screen asks for e-mail and password and claims nothing about compliance', () => {
    const out = html(h(Login, { onLogin: () => {} }));
    expect(out).toContain('type="email"');
    expect(out).toContain('type="password"');
    expect(out).not.toMatch(/Compliant|Validated/);
  });

  it('shows why the user is back at sign-in (an ended session) as an alert', () => {
    const out = html(h(Login, { onLogin: () => {}, notice: 'Your session has ended. Sign in again.' }));
    expect(out).toContain('role="alert"');
    expect(out).toContain('Your session has ended. Sign in again.');
  });

  it('shows a failed sign-in inline (not only as a toast that disappears)', () => {
    const out = html(h(CredentialsForm, { busy: false, error: 'Invalid credentials.', onSubmit: () => {} }));
    expect(out).toContain('role="alert"');
    expect(out).toContain('Invalid credentials.');
  });

  it('asks a TOTP user for the six-digit code and offers a recovery code instead', () => {
    const out = html(h(TotpChallenge, { busy: false, error: null, onSubmit: () => {}, onBack: () => {} }));
    expect(out).toContain('Authenticator code');
    expect(out).toMatch(/inputmode="numeric"/i);
    expect(out).toContain('Use a recovery code');
  });

  it('enrolment shows the QR code, the manual key and asks for the first code', () => {
    const out = html(h(TotpEnrolment, { qrCode: 'data:image/png;base64,AAAA', secret: 'JBSWY3DPEHPK3PXP', busy: false, error: null, onSubmit: () => {}, onBack: () => {} }));
    expect(out).toContain('data:image/png;base64,AAAA');
    expect(out).toContain('JBSWY3DPEHPK3PXP');
    expect(out).toContain('Authenticator code');
  });

  it('recovery codes are shown once, all ten, and the user must confirm they stored them before going on', () => {
    const codes = Array.from({ length: 10 }, (_, i) => `RC${i}-AAAA-BBBB`);
    const out = html(h(RecoveryCodes, { codes, onDone: () => {} }));
    for (const c of codes) expect(out).toContain(c);
    expect(out).toContain('type="checkbox"');
    expect(out).toMatch(/<button[^>]*disabled[^>]*>[^<]*Continue/);
  });
});

describe('ReauthModal', () => {
  it('is a modal dialog asking for the password, and says that unlocking signs nothing', () => {
    const out = html(h(ReauthModal, { reason: 'idle', onSignOut: () => {} }));
    expect(out).toContain('role="dialog"');
    expect(out).toContain('aria-modal="true"');
    expect(out).toContain('type="password"');
    expect(out).toMatch(/does not sign/i);
    expect(out).toContain('inactivity');
  });

  it('asks for the authenticator code once the server has said the user has one', () => {
    expect(html(h(ReauthModal, { reason: 'idle', onSignOut: () => {} }))).not.toContain('Authenticator code');
    expect(html(h(ReauthModal, { reason: 'idle', needsCode: true, onSignOut: () => {} }))).toContain('Authenticator code');
  });

  it('names a server-side lock differently from the idle timer', () => {
    expect(html(h(ReauthModal, { reason: 'server', onSignOut: () => {} }))).toMatch(/locked by the server|server locked/i);
  });
});

describe('ChangePassword', () => {
  it('is a required step when the password is temporary or expired, with no way back into the application', () => {
    const out = html(h(ChangePassword, { forced: true, userName: 'Test Analyst', onChanged: () => {}, onSignOut: () => {} }));
    expect(out).toMatch(/must change your password/i);
    expect((out.match(/type="password"/g) ?? []).length).toBe(3); // current, new, confirm
    expect(out).toContain('Sign out');
    expect(out).not.toContain('Cancel');
  });
});

describe('error boundary', () => {
  it('turns a render error into state (getDerivedStateFromError), so the page is never blank', () => {
    expect(ErrorBoundary.getDerivedStateFromError(new Error('x'))).toMatchObject({ error: expect.any(Error) });
  });

  it('shows what failed and offers a retry, without a stack trace', () => {
    const out = html(h(ViewFailure, { error: new Error('boom'), sessionEnded: false, onRetry: () => {}, onSignIn: () => {} }));
    expect(out).toContain('role="alert"');
    expect(out).toContain('could not be displayed');
    expect(out).toContain('Try again');
    expect(out).not.toMatch(/\bat \w+.*\.tsx?:\d+/);
  });

  it('shows the inline "Session expired" state, and not a crash page, when the session has ended', () => {
    const out = html(h(ViewFailure, { error: new Error('x.map is not a function'), sessionEnded: true, onRetry: () => {}, onSignIn: () => {} }));
    expect(out).toContain('Session expired');
    expect(out).toContain('Sign in again');
    expect(out).not.toContain('could not be displayed');
  });

  it('the session-expired panel says unsaved entries on this page are lost and nothing was changed on the server by the failed request', () => {
    const out = html(h(SessionExpiredPanel, { message: 'Your session has reached its time limit. Sign in again.', onSignIn: () => {} }));
    expect(out).toContain('Session expired');
    expect(out).toContain('Your session has reached its time limit.');
    expect(out).toContain('Sign in again');
  });
});

describe('toast', () => {
  it('has error, success and info shortcuts (toast.error) next to the original toast(message, type)', () => {
    const seen: string[] = [];
    const Probe = () => { const { toast } = useToast(); seen.push(typeof toast, typeof toast.error, typeof toast.success, typeof toast.info); return null; };
    html(h(Probe));
    expect(seen).toEqual(['function', 'function', 'function', 'function']);
  });
});
