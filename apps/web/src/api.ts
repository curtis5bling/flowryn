import type { AuthResponse, LoginRequest, RegisterRequest, User } from '@flowryn/shared';

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
export const createWorkspace = (name: string) => request<{ workspace: { id: string; name: string } }>('/api/workspaces', { method: 'POST', body: JSON.stringify({ name }) });

export type AuthUser = User;