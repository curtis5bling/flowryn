// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import * as api from '../api';

import { WorkspaceApp } from './WorkspaceApp';

vi.mock('../realtime', () => ({ connectRealtime: vi.fn(), bindRealtime: vi.fn(() => () => {}) }));
vi.mock('../api', () => ({
  listProjects: vi.fn(), listTasks: vi.fn(), listMembers: vi.fn(), listPresence: vi.fn(),
  listComments: vi.fn(), listProjectActivity: vi.fn(), unreadNotificationCount: vi.fn(),
  listNotifications: vi.fn(),
}));
afterEach(cleanup);

it('opens an existing task and renders its discussion without an out-of-scope presence reference', async () => {
  const project = { id: 'project', workspaceId: 'workspace', name: 'Launch', description: '', status: 'active' as const, color: '#123456', createdBy: 'owner', createdAt: '', updatedAt: '', taskTotal: 1, completedTasks: 0 };
  const task = { id: 'task', workspaceId: 'workspace', projectId: 'project', title: 'Existing task', description: '', status: 'todo' as const, priority: 'medium' as const, dueDate: null, assigneeId: null, position: 0, createdBy: 'owner', createdAt: '', updatedAt: '' };
  const pagination = { page: 1, limit: 100, pages: 1, total: 1 };
  vi.mocked(api.listProjects).mockResolvedValue({ items: [project], pagination });
  vi.mocked(api.listTasks).mockResolvedValue({ items: [task], pagination });
  vi.mocked(api.listMembers).mockResolvedValue({ members: [] });
  vi.mocked(api.listPresence).mockResolvedValue({ members: [] });
  vi.mocked(api.listProjectActivity).mockResolvedValue({ activities: [] });
  vi.mocked(api.listComments).mockResolvedValue({ items: [{ id: 'comment', body: 'Existing discussion', authorId: { _id: 'ada', name: 'Ada' }, createdAt: new Date().toISOString(), editedAt: null }], pagination });
  vi.mocked(api.unreadNotificationCount).mockResolvedValue({ count: 0 });
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  render(<QueryClientProvider client={cache}><WorkspaceApp workspaceId="workspace" workspaceName="Team" userName="Ada" onLogout={() => {}} /></QueryClientProvider>);
  fireEvent.click(await screen.findByRole('button', { name: 'Existing task' }));
  expect(screen.getByRole('heading', { name: 'Discussion' })).toBeTruthy();
  expect(await screen.findByText('Existing discussion')).toBeTruthy();
  expect(api.listPresence).toHaveBeenCalledTimes(1);
  cleanup();
  cache.clear();
});
