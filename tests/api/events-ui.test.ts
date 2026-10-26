/**
 * Roadmap M23 (r2-events), the screens: the bell shows the number of unread notifications, the list marks unread ones and links to the
 * record, and the subscription table never shows a secret. Rendered on the server with react-dom (no browser), like qms-ui.test.ts.
 */
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BellButton, NotificationList, SubscriptionTable, type NotificationItem, type SubscriptionRow } from '../../src/components/NotificationBell';

const noop = () => {};
const n = (over: Partial<NotificationItem>): NotificationItem => ({
  id: 'ntf-1', eventId: 'evt-1', type: 'result.oos_detected', title: 'OOS detected', message: 'Sample SMP-2026-00001: Assay is out of specification.',
  href: '#/samples/SMP-2026-00001', createdAt: '2026-10-20T08:00:00.000Z', readAt: null, ...over,
});

describe('the bell', () => {
  it('announces the unread count, and caps the badge at 99+', () => {
    expect(renderToStaticMarkup(React.createElement(BellButton, { unread: 0, open: false, onClick: noop }))).toContain('Notifications, none unread');
    const three = renderToStaticMarkup(React.createElement(BellButton, { unread: 3, open: false, onClick: noop }));
    expect(three).toContain('Notifications, 3 unread');
    expect(three).toContain('>3<');
    expect(renderToStaticMarkup(React.createElement(BellButton, { unread: 250, open: true, onClick: noop }))).toContain('99+');
  });
});

describe('the list', () => {
  it('marks unread notifications, links to the record and offers to mark read', () => {
    const html = renderToStaticMarkup(React.createElement(NotificationList, {
      items: [n({}), n({ id: 'ntf-2', title: 'System alert', message: 'Maintenance at 18:00', href: null, readAt: '2026-10-20T09:00:00.000Z' })],
      onRead: noop, onReadAll: noop, onOpen: noop,
    }));
    expect(html).toContain('OOS detected');
    expect(html).toContain('href="#/samples/SMP-2026-00001"');
    expect(html.match(/Unread/g)).toHaveLength(1);
    expect(html).toContain('Mark all read');
    expect(html).toContain('Maintenance at 18:00');
    expect(renderToStaticMarkup(React.createElement(NotificationList, { items: [], onRead: noop, onReadAll: noop, onOpen: noop }))).toContain('No notifications.');
  });
});

describe('the subscription table', () => {
  it('shows sink, target, events, status and fingerprint, never a secret', () => {
    const rows: SubscriptionRow[] = [{
      id: 'sub-1', name: 'ERP', sink: 'webhook', target: 'https://erp.lan/hooks', eventTypes: ['batch.released'], status: 'Active',
      secretFingerprint: '0123456789abcdef', createdBy: 'usr-admin', createdAt: '2026-10-20T08:00:00.000Z', version: 1,
      deliveries: { pending: 0, delivered: 3, dead: 1 },
    }];
    const html = renderToStaticMarkup(React.createElement(SubscriptionTable, { rows, onStatus: noop, onDeliveries: noop }));
    expect(html).toContain('https://erp.lan/hooks');
    expect(html).toContain('batch.released');
    expect(html).toContain('0123456789abcdef');
    expect(html).toContain('1 dead');
    expect(html).toContain('Disable');
    expect(html).not.toMatch(/whsec_/);
  });
});
