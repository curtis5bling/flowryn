import type { AuthResponse, LoginRequest, Project, RegisterRequest, Task, User } from '@flowryn/shared';

const apiUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

const request = async <T>(path: string, options: RequestInit = {}): Promise<T> => {
  const response = await fetch(`${apiUrl}${path}`, {
    ...options,
    credentials: 'include',
    headers: { 'Content-Type': 'application/json', ...options.headers },
  });
  if (!response.ok) throw new Error((await response.json()).error ?? 'Request failed');
  return response.status === 204 ? (undefined as T) : response.json();
};

export const getCurrentUser = () => request<AuthResponse>('/api/auth/me');
export const login = (body: LoginRequest) => request<AuthResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify(body) });
export const register = (body: RegisterRequest) => request<AuthResponse>('/api/auth/register', { method: 'POST', body: JSON.stringify(body) });
export const logout = () => request<void>('/api/auth/logout', { method: 'POST' });
export const listWorkspaces = () => request<{ workspaces: Array<{ id: string; name: string; role: string }> }>('/api/workspaces');
export const listMembers = (workspaceId: string) => request<{ members: Array<{ user: { _id: string; name: string; email: string }; role: string }> }>(`/api/workspaces/${workspaceId}/members`);
export const createWorkspace = (name: string) => request<{ workspace: { id: string; name: string } }>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) });

export type AuthUser = User;

export type ProjectSummary = Project & { taskTotal: number; completedTasks: number };
export type TaskFilters = { status?: string; priority?: string; assigneeId?: string; dueDate?: string };
export type Page<T> = { items: T[]; pagination: { page: number; limit: number; total: number; pages: number } };

export const listProjects = (workspaceId: string) => request<Page<ProjectSummary>>(`/api/workspaces/${workspaceId}/projects`);
export const createProject = (workspaceId: string, body: { name: string; description: string; color: string }) => request<{ project: Project }>(`/api/workspaces/${workspaceId}/projects`, { method: 'POST', body: JSON.stringify(body) });
export const updateProject = (workspaceId: string, projectId: string, body: Partial<{ name: string; description: string; color: string }>) => request<{ project: Project }>(`/api/workspaces/${workspaceId}/projects/${projectId}`, { method: 'PATCH', body: JSON.stringify(body) });
export const archiveProject = (workspaceId: string, projectId: string) => request<{ project: Project }>(`/api/workspaces/${workspaceId}/projects/${projectId}`, { method: 'DELETE' });
export const listTasks = (workspaceId: string, projectId: string, filters: TaskFilters = {}) => request<Page<Task>>(`/api/workspaces/${workspaceId}/projects/${projectId}/tasks?${new URLSearchParams(filters)}`);
export const createTask = (workspaceId: string, projectId: string, body: { title: string; description?: string; priority?: string; dueDate?: string | null }) => request<{ task: Task }>(`/api/workspaces/${workspaceId}/projects/${projectId}/tasks`, { method: 'POST', body: JSON.stringify(body) });
export const updateTask = (workspaceId: string, taskId: string, body: Partial<Pick<Task, 'title' | 'description' | 'status' | 'priority' | 'dueDate' | 'assigneeId'>>) => request<{ task: Task }>(`/api/workspaces/${workspaceId}/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(body) });
export const moveTask = (workspaceId: string, taskId: string, status: Task['status']) => request<{ task: Task }>(`/api/workspaces/${workspaceId}/tasks/${taskId}/status`, { method: 'PATCH', body: JSON.stringify({ status }) });
export const deleteTask = (workspaceId: string, taskId: string) => request<void>(`/api/workspaces/${workspaceId}/tasks/${taskId}`, { method: 'DELETE' });
export const listProjectActivity = (workspaceId: string, projectId: string) => request<{ activities: Array<{ id: string; action: string; timestamp: string; metadata: Record<string, unknown> }> }>(`/api/workspaces/${workspaceId}/projects/${projectId}/activity`);