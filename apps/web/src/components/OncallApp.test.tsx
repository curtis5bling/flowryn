// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { oncallCommand, oncallList } from '../oncall-api';

import { OncallApp, PolicyEditor, ScheduleEditor, RoutingEditor } from './OncallApp';
vi.mock('../realtime', () => ({
  connectRealtime: () => ({ connect: vi.fn(), disconnect: vi.fn() }),
  bindRealtime: vi.fn((_socket, _workspace, _project, _client, onState) => {
    onState('connected');
    return () => {};
  }),
}));
vi.mock('../api', () => ({
  request: vi.fn(async () => ({ policyId: null })),
  listMembers: vi.fn(async () => ({ members: [] })),
  listProjects: vi.fn(async () => ({ items: [], pagination: { pages: 0 } })),
}));
vi.mock('../automation-api', () => ({
  automationList: vi.fn(async () => ({ items: [], pagination: { pages: 0 } })),
}));
vi.mock('../incidents-api', () => ({
  listIncidents: vi.fn(async () => ({ items: [], pagination: { pages: 0 } })),
}));
vi.mock('../oncall-api', () => ({
  oncallPath: (id: string) => `/api/workspaces/${id}/oncall`,
  oncallList: vi.fn(async () => ({ items: [], pagination: { page: 1, pages: 0 } })),
  oncallCommand: vi.fn(async () => ({})),
  saveOncall: vi.fn(),
  getAlert: vi.fn(async () => ({
    alert: {
      id: 'alert',
      title: 'Service down',
      severity: 'sev3',
      status: 'open',
      summary: 'Safe',
      fingerprint: 'service',
      occurrenceCount: 1,
      firstReceivedAt: '2026-01-01T00:00:00Z',
      lastReceivedAt: '2026-01-01T00:00:00Z',
    },
  })),
  getCoverage: vi.fn(),
  getOverrides: vi.fn(),
  getEscalationHistory: vi.fn(async () => ({
    items: [],
    executions: [],
    pagination: { pages: 0 },
  })),
  getOncallMetrics: vi.fn(),
}));
const a = '000000000000000000000001',
  b = '000000000000000000000002';
const references = {
  members: [
    { id: a, name: 'Alice' },
    { id: b, name: 'Bob' },
  ],
  schedules: [],
  policies: [],
  integrations: [],
  incidents: [],
  projects: [],
};
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe('on-call workflows', () => {
  it('creates a timezone-aware rotation with accessible stable participant ordering', () => {
    const save = vi.fn();
    render(
      <ScheduleEditor
        members={references.members}
        onSave={save}
        onClose={vi.fn()}
        pending={false}
      />,
    );
    fireEvent.change(screen.getByLabelText('Schedule name'), { target: { value: 'Primary' } });
    fireEvent.change(screen.getByLabelText('IANA timezone'), {
      target: { value: 'America/New_York' },
    });
    fireEvent.click(screen.getByText('Add participant to layer 1'));
    fireEvent.change(screen.getByLabelText('Participant 1 in layer 1'), { target: { value: a } });
    fireEvent.click(screen.getByText('Add participant to layer 1'));
    fireEvent.change(screen.getByLabelText('Participant 2 in layer 1'), { target: { value: b } });
    fireEvent.click(screen.getByLabelText('Move participant 2 in layer 1 up'));
    fireEvent.click(screen.getByText('Save schedule'));
    expect(save.mock.calls[0]![0].layers[0].participants).toEqual([b, a]);
    expect(save.mock.calls[0]![0].timezone).toBe('America/New_York');
    expect(save.mock.calls[0]![0].layers[0].handoff).toBe('elapsedUTC');
  });
  it('builds bounded policies and structured routing without arbitrary expressions', () => {
    const save = vi.fn();
    const view = render(
      <PolicyEditor references={references} onSave={save} onClose={vi.fn()} pending={false} />,
    );
    fireEvent.change(screen.getByLabelText('Policy name'), { target: { value: 'Primary' } });
    fireEvent.click(screen.getByLabelText('Alice'));
    fireEvent.click(screen.getByText('Add step'));
    fireEvent.change(screen.getAllByLabelText('Recipient target')[1]!, {
      target: { value: 'responders' },
    });
    fireEvent.click(screen.getByText('Save policy'));
    expect(save.mock.calls[0]![0].steps).toHaveLength(2);
    view.unmount();
    render(
      <RoutingEditor references={references} onSave={vi.fn()} onClose={vi.fn()} pending={false} />,
    );
    fireEvent.click(screen.getByText('Add condition'));
    expect(screen.getByLabelText('Routing field').textContent).toContain('timeWindow');
    expect(screen.queryByText('JavaScript')).toBeNull();
  });
  it('lets members acknowledge alerts while hiding administrative controls', async () => {
    vi.mocked(oncallList).mockImplementation(
      async (_workspace, resource) =>
        ({
          items:
            resource === 'alerts'
              ? [
                  {
                    id: 'alert',
                    title: 'Service down',
                    severity: 'sev3',
                    status: 'open',
                    occurrenceCount: 1,
                  },
                ]
              : [],
          pagination: { page: 1, limit: 20, total: 1, pages: 1 },
        }) as Awaited<ReturnType<typeof oncallList>>,
    );
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <OncallApp
          workspaceId="workspace"
          workspaceName="Operations"
          userId={a}
          role="member"
          onLogout={vi.fn()}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Service down' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Acknowledge alert' }));
    await waitFor(() =>
      expect(oncallCommand).toHaveBeenCalledWith(
        'workspace',
        'alerts/alert/acknowledge',
        expect.objectContaining({ operationId: expect.any(String) }),
      ),
    );
    expect(screen.queryByText('Resolve alert')).toBeNull();
    expect(screen.queryByText('Create schedule')).toBeNull();
    expect(screen.queryByText('Retry failed delivery')).toBeNull();
    client.clear();
  });
});
