// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PublicStatusPage } from './PublicStatusPage';

vi.mock('../status-api', () => ({ getPublicStatus: vi.fn(async () => ({ page: { name: '<img src=x onerror=alert(1)>', slug: 'acme', description: '<script>bad()</script>', branding: { logoUrl: null, primaryColor: '#123456' }, supportUrl: null, timezone: 'UTC', lastUpdatedAt: '2026-01-01T00:00:00.000Z' }, overallStatus: 'operational', groups: [], components: [{ id: '1', name: '<b>API</b>', description: '', status: 'operational', order: 1, groupId: null }], incidents: [], maintenance: [{ id: 'm1', title: 'Database upgrade', description: 'Routine work', status: 'scheduled', scheduledStartAt: '2026-01-02T00:00:00.000Z', scheduledEndAt: '2026-01-02T01:00:00.000Z' }] })), subscribeStatus: vi.fn(), unsubscribeStatus: vi.fn() }));
describe('PublicStatusPage', () => {
  beforeEach(() => { document.title = 'Flowryn'; });
  it('renders user content as text with accessible status labels', async () => {
    const { container } = render(<QueryClientProvider client={new QueryClient()}><PublicStatusPage slug="acme" /></QueryClientProvider>);
    expect(await screen.findByRole('heading', { name: '<img src=x onerror=alert(1)>' })).toBeTruthy();
    expect(screen.getAllByText('All systems operational').length).toBeGreaterThan(0);
    expect(screen.getByRole('heading', { name: 'Database upgrade' })).toBeTruthy();
    expect(container.querySelector('script')).toBeNull(); expect(container.querySelector('img')).toBeNull();
  });
});
