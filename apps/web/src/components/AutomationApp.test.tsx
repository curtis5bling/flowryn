// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { automationCommand, automationList, saveIntegration } from '../automation-api';

import { AutomationApp, IntegrationEditor, RuleEditor } from './AutomationApp';

vi.mock('../realtime', () => ({
  connectRealtime: vi.fn(),
  bindRealtime: vi.fn((_socket, _workspace, _project, _client, onState) => {
    onState('connected');
    return () => {};
  }),
}));
vi.mock('../api', () => ({
  listMembers: vi.fn(async () => ({ members: [] })),
  listProjects: vi.fn(async () => ({ items: [], pagination: { pages: 0 } })),
}));
vi.mock('../incidents-api', () => ({
  incidentReferences: vi.fn(),
  listIncidents: vi.fn(),
  listRunbooks: vi.fn(async () => ({ items: [], pagination: { pages: 0 } })),
}));
vi.mock('../automation-api', () => ({
  automationCommand: vi.fn(),
  automationList: vi.fn(async () => ({
    items: [],
    pagination: { page: 1, limit: 20, total: 0, pages: 0 },
  })),
  getAutomationMetrics: vi.fn(),
  getAutomationRun: vi.fn(),
  saveAutomationRule: vi.fn(),
  saveIntegration: vi.fn(),
}));
const references = { projects: [], members: [], runbooks: [], integrations: [] };
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
describe('automation management', () => {
  it('validates a structured rule and reorders actions with keyboard-accessible buttons', () => {
    const save = vi.fn();
    render(<RuleEditor references={references} onSave={save} onClose={vi.fn()} pending={false} />);
    fireEvent.change(screen.getByLabelText('Rule name'), { target: { value: 'Response' } });
    fireEvent.change(screen.getByLabelText('Timeline message'), {
      target: { value: 'First update' },
    });
    fireEvent.click(screen.getByText('Add action'));
    const messages = screen.getAllByLabelText('Timeline message');
    fireEvent.change(messages[1]!, { target: { value: 'Second update' } });
    fireEvent.click(screen.getByLabelText('Move action 2 up'));
    fireEvent.click(screen.getByText('Validate preview'));
    expect(screen.getByRole('status').textContent).toContain('valid');
    fireEvent.click(screen.getByText('Save rule'));
    expect(save.mock.calls[0]![0].actions.map((a: { message: string }) => a.message)).toEqual([
      'Second update',
      'First update',
    ]);
    expect(screen.getByRole('note').textContent).toContain('external endpoints');
  });
  it('creates allowlisted integration configuration without requesting or displaying a stored secret', () => {
    const save = vi.fn();
    render(<IntegrationEditor onSave={save} onClose={vi.fn()} pending={false} />);
    fireEvent.change(screen.getByLabelText('Integration name'), { target: { value: 'Alerts' } });
    fireEvent.change(screen.getByLabelText('Outbound HTTPS endpoint'), {
      target: { value: 'https://hooks.company.com/events' },
    });
    fireEvent.click(
      screen.getByLabelText('Accept signed alerts through explicitly configured rules'),
    );
    fireEvent.click(screen.getByLabelText('automation.manual'));
    fireEvent.click(screen.getByText('Save integration'));
    expect(save).toHaveBeenCalledWith({
      name: 'Alerts',
      type: 'genericWebhook',
      status: 'active',
      endpoint: 'https://hooks.company.com/events',
      inboundEvents: ['alert.received'],
      outboundEvents: ['automation.manual'],
    });
    expect(screen.queryByLabelText('New signing secret')).toBeNull();
  });
  it('restricts member views to rule state', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AutomationApp
          workspaceId="workspace"
          workspaceName="Team"
          role="member"
          onLogout={vi.fn()}
        />
      </QueryClientProvider>,
    );
    await screen.findByText('No automation rules yet.');
    expect(screen.queryByText('Create rule')).toBeNull();
    expect(screen.queryByText('integrations')).toBeNull();
    expect(vi.mocked(automationList).mock.calls.every((call) => call[1] === 'rules')).toBe(true);
  });
  it('shows a generated secret only once and requires confirmation for rotation', async () => {
    const integration = {
      id: 'integration',
      name: 'Alerts',
      type: 'genericWebhook',
      status: 'active',
      endpoint: 'https://hooks.company.com',
      inboundEvents: [],
      outboundEvents: ['automation.manual'],
      archivedAt: null,
    };
    vi.mocked(automationList).mockImplementation(
      async (_workspace, resource) =>
        ({
          items: resource === 'integrations' ? [integration] : [],
          pagination: { page: 1, limit: 20, total: 1, pages: 1 },
        }) as never,
    );
    vi.mocked(saveIntegration).mockResolvedValue({
      integration: integration as never,
      secret: 'new-only-once',
    });
    vi.mocked(automationCommand).mockResolvedValue({ secret: 'rotated-once' });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <AutomationApp
          workspaceId="workspace"
          workspaceName="Team"
          role="owner"
          onLogout={vi.fn()}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByText('integrations'));
    await screen.findByText('Alerts');
    fireEvent.click(screen.getByText('Set up integration'));
    fireEvent.change(screen.getByLabelText('Integration name'), { target: { value: 'New' } });
    fireEvent.click(screen.getByText('Save integration'));
    await screen.findByText('new-only-once');
    fireEvent.click(screen.getByRole('button', { name: /I saved it/ }));
    expect(screen.queryByText('new-only-once')).toBeNull();
    fireEvent.click(screen.getByText('Rotate secret'));
    expect(automationCommand).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog');
    fireEvent.click(within(dialog).getByText('Confirm action'));
    await screen.findByText('rotated-once');
    expect(automationCommand).toHaveBeenCalledWith(
      'workspace',
      'integrations/integration/rotate',
      {},
    );
    await act(async () => {
      await client.cancelQueries();
    });
    await waitFor(() => expect(screen.queryByText('new-only-once')).toBeNull());
  });
});
