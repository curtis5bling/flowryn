// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReliabilityApp } from './ReliabilityApp';

const api = vi.hoisted(() => ({
  createDependency: vi.fn(), createMonitor: vi.fn(), createService: vi.fn(), createSlo: vi.fn(), updateMonitor: vi.fn(), updateService: vi.fn(), updateSlo: vi.fn(async () => ({})), retryMonitorRun: vi.fn(),
  getDependencyImpact: vi.fn(async () => ({ serviceIds: ['service-2'], edges: [{ upstreamServiceId: 'service-1', downstreamServiceId: 'service-2', depth: 1 }] })), getEvaluationHistory: vi.fn(async () => ({ evaluations: [{ _id: 'evaluation-1', windowEnd: '2026-09-29T12:00:00.000Z', shortBurnRate: 2, longBurnRate: 1 }] })),
  getEvaluation: vi.fn(async () => ({ evaluation: { state: 'unknown', compliance: null, remainingBudget: null } })),
  getMonitorHistory: vi.fn(async () => ({ runs: [{ _id: 'run-1', scheduledAt: '2026-09-29T12:00:00.000Z', status: 'completed', endpointHealthy: false, errorCode: 'ENDPOINT_UNREACHABLE' }, { _id: 'run-2', scheduledAt: '2026-09-29T12:05:00.000Z', status: 'deadLetter', errorCode: 'MONITOR_INFRASTRUCTURE_FAILURE' }] })),
  getReliabilityMetrics: vi.fn(async () => ({ servicesWithoutOwners: 0, notice: 'Insufficient data is reported as unknown.' })),
  listDependencies: vi.fn(async () => ({ dependencies: [{ _id: 'dep-1', upstreamServiceId: 'service-1', downstreamServiceId: 'service-2', type: 'runtime', criticality: 'required' }] })),
  listMonitors: vi.fn(async () => ({ monitors: [{ _id: 'monitor-1', name: 'HTTPS health', url: 'https://health.company.com', health: 'failed', enabled: true }] })),
  listServiceRelationships: vi.fn(async () => ({ relationships: [{ _id: 'rel-1', targetType: 'incident', targetId: 'incident-1' }] })),
  listServices: vi.fn(async () => ({ services: [{ _id: 'service-1', name: 'API', lifecycle: 'active', criticality: 'tier1', ownerIds: ['owner-1'] }, { _id: 'service-2', name: 'DB', lifecycle: 'active', criticality: 'tier1', ownerIds: ['owner-1'] }] })),
  listSlos: vi.fn(async () => ({ slos: [{ _id: 'slo-1', name: 'Availability', objectiveTarget: 99.9, rollingWindowDays: 30 }] })),
}));
vi.mock('../reliability-api', () => api);
vi.mock('../api', () => ({ listMembers: vi.fn(async () => ({ members: [{ user: { _id: 'owner-1', name: 'Owner' }, role: 'owner' }] })) }));

const renderApp = (role = 'owner') => { const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } }); return { ...render(<QueryClientProvider client={client}><ReliabilityApp workspaceId="workspace-1" role={role} /></QueryClientProvider>), client }; };

describe('ReliabilityApp workflows', () => {
  afterEach(cleanup);
  beforeEach(() => { vi.clearAllMocks(); Object.defineProperty(navigator, 'onLine', { configurable: true, value: true }); });
  it('renders catalog, relationships, dependency table, unknown budgets, and failure history accessibly', async () => {
    renderApp();
    expect(await screen.findByRole('cell', { name: 'API' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Selected service'), { target: { value: 'service-1' } });
    expect(await screen.findByText('incident: incident-1')).toBeTruthy();
    expect(await screen.findByText('1 affected services across 1 dependencies.')).toBeTruthy();
    expect(await screen.findByText('Unknown — insufficient data')).toBeTruthy();
    fireEvent.click(screen.getByText('Burn-rate history'));
    expect(await screen.findByText(/short 2, long 1/)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Target for Availability'), { target: { value: '99.95' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save objective' }));
    await waitFor(() => expect(api.updateSlo).toHaveBeenCalledWith('workspace-1', 'slo-1', { objectiveTarget: 99.95 }));
    expect(screen.getByRole('cell', { name: 'required' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'HTTPS health' }));
    expect(await screen.findByText(/completed, failed/)).toBeTruthy();
    fireEvent.click(await screen.findByRole('button', { name: 'Retry failed run' }));
    await waitFor(() => expect(api.retryMonitorRun).toHaveBeenCalledWith('workspace-1', 'monitor-1', 'run-2'));
    expect(screen.getByLabelText('Service lifecycle')).toBeTruthy();
  });

  it('keeps secrets write-only, exposes management only to admins, and reports offline recovery state', async () => {
    const { rerender, client } = renderApp();
    const secret = await screen.findByLabelText('Secret value');
    expect(secret.getAttribute('type')).toBe('password');
    fireEvent.change(secret, { target: { value: 'do-not-display' } });
    expect(screen.queryByText('do-not-display')).toBeNull();
    fireEvent(window, new Event('offline'));
    expect((await screen.findByRole('status')).textContent).toContain('Offline');
    let release!: () => void; vi.spyOn(client, 'invalidateQueries').mockImplementation(() => new Promise<void>((resolve) => { release = resolve; }));
    fireEvent(window, new Event('online')); expect((await screen.findByRole('status')).textContent).toContain('Reconnecting'); release(); await waitFor(() => expect(screen.queryByText(/Reconnecting and refreshing/)).toBeNull());
    rerender(<QueryClientProvider client={new QueryClient()}><ReliabilityApp workspaceId="workspace-1" role="member" /></QueryClientProvider>);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'Add service' })).toBeNull());
  });
  it('retries failed REST data and rotates only a newly entered secret once', async () => {
    api.getReliabilityMetrics.mockRejectedValueOnce(new Error('offline'));
    renderApp(); expect(await screen.findByText(/Reliability metrics are unavailable/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Retry metrics' })); await waitFor(() => expect(api.getReliabilityMetrics).toHaveBeenCalledTimes(2));
    fireEvent.click(await screen.findByRole('button', { name: 'HTTPS health' }));
    const rotate = await screen.findByRole('button', { name: 'Rotate entered secret' }); expect((rotate as HTMLButtonElement).disabled).toBe(true);
    const secret = screen.getByLabelText('Secret value') as HTMLInputElement; fireEvent.change(secret, { target: { value: 'new-secret' } }); expect(rotate.getAttribute('disabled')).toBeNull();
    fireEvent.click(rotate); await waitFor(() => expect(api.updateMonitor).toHaveBeenCalledWith('workspace-1', 'monitor-1', { secretHeaders: { authorization: 'new-secret' } }));
    expect(api.updateMonitor).toHaveBeenCalledTimes(1); await waitFor(() => expect(secret.value).toBe('')); expect((rotate as HTMLButtonElement).disabled).toBe(true); expect(screen.queryByDisplayValue('new-secret')).toBeNull();
  });
});
