// @vitest-environment jsdom
import type { Incident, Runbook } from '@flowryn/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, expect, it, vi } from 'vitest';

import * as api from '../incidents-api';

import { IncidentDetail } from './IncidentDetail';
import { IncidentDeclaration, RunbookEditor } from './IncidentForms';

vi.mock('../incidents-api', () => ({
  declareIncident: vi.fn(),
  saveRunbook: vi.fn(),
  commandIncident: vi.fn(),
  incidentTimeline: vi.fn(),
  incidentPresence: vi.fn(),
}));
const clients: QueryClient[] = [];
const mount = (element: ReactNode) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  clients.push(client);
  return render(<QueryClientProvider client={client}>{element}</QueryClientProvider>);
};
afterEach(() => {
  cleanup();
  clients.splice(0).forEach((client) => client.clear());
  vi.resetAllMocks();
});
const userId = '111111111111111111111111';
const workspaceId = '222222222222222222222222';
const members = [{ user: { _id: userId, name: 'Ada' }, role: 'owner' }];
const incident: Incident = {
  id: '333333333333333333333333',
  workspaceId,
  title: 'API outage',
  summary: 'Summary',
  impact: 'Unavailable',
  incidentNumber: 'INC-000001',
  severity: 'sev1',
  status: 'monitoring',
  commanderId: userId,
  responderIds: [],
  linkedProjectIds: [],
  linkedTaskIds: [],
  declaredBy: userId,
  declaredAt: '2026-09-01T00:00:00Z',
  acknowledgedAt: '2026-09-01T00:01:00Z',
  resolvedAt: null,
  resolutionSummary: null,
  archivedAt: null,
  runbooks: [],
  createdAt: '2026-09-01T00:00:00Z',
  updatedAt: '2026-09-01T00:00:00Z',
};
it('requires sev1 confirmation and retries the exact declaration after an ambiguous failure', async () => {
  vi.mocked(api.declareIncident)
    .mockRejectedValueOnce(new Error('Unavailable'))
    .mockResolvedValueOnce({ incident });
  const done = vi.fn();
  mount(
    <IncidentDeclaration
      workspaceId={workspaceId}
      admin={false}
      members={members}
      references={{ projects: [], tasks: [] }}
      onDone={done}
    />,
  );
  fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'API outage' } });
  fireEvent.change(screen.getByLabelText('Severity'), { target: { value: 'sev1' } });
  expect(
    (screen.getByRole('button', { name: 'Declare incident' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  expect(screen.queryByLabelText('Commander')).toBeNull();
  fireEvent.click(screen.getByRole('checkbox', { name: /I confirm/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Declare incident' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Retry same declaration' }));
  await waitFor(() => expect(done).toHaveBeenCalledWith(incident));
  expect(api.declareIncident).toHaveBeenCalledTimes(2);
  expect(vi.mocked(api.declareIncident).mock.calls[0]![1]).toEqual(
    vi.mocked(api.declareIncident).mock.calls[1]![1],
  );
});
it('reorders steps using keyboard-operable buttons while preserving stable IDs', async () => {
  const book: Runbook = {
    id: incident.id,
    workspaceId,
    ownerId: userId,
    name: 'Recovery',
    description: '',
    status: 'active',
    steps: [
      {
        id: '11111111-1111-4111-8111-111111111111',
        title: 'Inspect',
        instructions: '',
        position: 0,
      },
      {
        id: '22222222-2222-4222-8222-222222222222',
        title: 'Recover',
        instructions: '',
        position: 1,
      },
    ],
  };
  vi.mocked(api.saveRunbook).mockResolvedValue({ runbook: book });
  mount(
    <RunbookEditor
      workspaceId={workspaceId}
      book={book}
      userId={userId}
      members={members}
      onDone={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Move step 2 up' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save runbook' }));
  await waitFor(() => expect(api.saveRunbook).toHaveBeenCalled());
  expect(
    vi
      .mocked(api.saveRunbook)
      .mock.calls[0]![1].steps.map((step) => ({ id: step.id, position: step.position })),
  ).toEqual([
    { id: book.steps[1]!.id, position: 0 },
    { id: book.steps[0]!.id, position: 1 },
  ]);
});
it('requires a resolution summary and confirmation before resolving, and exposes response progress without optimistic mutation', async () => {
  vi.mocked(api.incidentTimeline).mockResolvedValue({
    items: [],
    pagination: { page: 1, pages: 1, limit: 50, total: 0 },
  });
  vi.mocked(api.incidentPresence).mockResolvedValue({ users: [{ id: userId, name: 'Ada' }] });
  vi.mocked(api.commandIncident).mockResolvedValue({
    incident: { ...incident, status: 'resolved' },
  });
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
  mount(
    <IncidentDetail
      workspaceId={workspaceId}
      incident={incident}
      admin
      userId={userId}
      members={members}
      references={{ projects: [], tasks: [] }}
      books={[]}
    />,
  );
  const resolve = screen.getByRole('button', { name: 'Move to resolved' });
  expect((resolve as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(screen.getByLabelText('Resolution summary'), {
    target: { value: 'Capacity restored' },
  });
  fireEvent.click(resolve);
  expect(api.commandIncident).not.toHaveBeenCalled();
  confirm.mockReturnValue(true);
  fireEvent.click(resolve);
  await waitFor(() =>
    expect(api.commandIncident).toHaveBeenCalledWith(
      workspaceId,
      incident.id,
      expect.objectContaining({
        command: {
          action: 'transition',
          status: 'resolved',
          resolutionSummary: 'Capacity restored',
        },
      }),
    ),
  );
  expect(await screen.findByText('Viewing now: Ada')).toBeTruthy();
  confirm.mockRestore();
});
