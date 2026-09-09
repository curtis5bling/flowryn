import { QueryClient } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindRealtime } from './realtime';

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

class FakeSocket {
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  joins: string[] = [];
  on(event: string, listener: (...args: unknown[]) => void) { const group = this.listeners.get(event) ?? new Set(); group.add(listener); this.listeners.set(event, group); return this; }
  off(event: string, listener: (...args: unknown[]) => void) { this.listeners.get(event)?.delete(listener); return this; }
  fire(event: string, ...args: unknown[]) { this.listeners.get(event)?.forEach((listener) => listener(...args)); }
  timeout() { return this; }
  emit(event: string, id: string, callback: (error: null, result: { ok: true }) => void) { this.joins.push(`${event}:${id}`); callback(null, { ok: true }); }
  connect() { this.fire('connect'); return this; }
  disconnect() { return this; }
}

describe('real-time lifecycle', () => {
  it('refreshes expired credentials before restoring a disconnected socket', async () => {
    const socket = new FakeSocket();
    const cache = new QueryClient();
    const state = vi.fn();
    const fetchMock = vi.fn().mockResolvedValueOnce({ ok: false }).mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const cleanup = bindRealtime(socket as unknown as Socket, 'workspace', 'project', cache, state);
    await vi.waitFor(() => expect(state).toHaveBeenLastCalledWith('connected'));
    socket.fire('disconnect', 'io server disconnect');
    await vi.waitFor(() => expect(socket.joins).toHaveLength(4));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining('/api/auth/refresh'), { method: 'POST', credentials: 'include' });
    cleanup();
    cache.clear();
  });
  it('restores rooms and REST state on reconnection and removes every listener', async () => {
    const socket = new FakeSocket();
    const cache = new QueryClient();
    const invalidate = vi.spyOn(cache, 'invalidateQueries');
    const state = vi.fn();
    const cleanup = bindRealtime(socket as unknown as Socket, 'workspace', 'project', cache, state);
    await vi.waitFor(() => expect(state).toHaveBeenLastCalledWith('connected'));
    expect(socket.joins).toEqual(['workspace:join:workspace', 'project:join:project']);
    invalidate.mockClear();
    socket.fire('disconnect', 'transport close');
    expect(state).toHaveBeenLastCalledWith('reconnecting');
    socket.fire('connect');
    await vi.waitFor(() => expect(state).toHaveBeenLastCalledWith('connected'));
    expect(socket.joins).toEqual(['workspace:join:workspace', 'project:join:project', 'workspace:join:workspace', 'project:join:project']);
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['presence', 'workspace'] }));
    expect(invalidate).toHaveBeenCalledWith(expect.objectContaining({ queryKey: ['notifications', 'workspace'] }));
    expect([...socket.listeners.values()].every((group) => group.size === 1)).toBe(true);
    cleanup();
    expect([...socket.listeners.values()].every((group) => group.size === 0)).toBe(true);
    socket.fire('connect');
    expect(socket.joins).toHaveLength(4);
    cache.clear();
  });

  it('deduplicates events, ignores other workspaces and preserves pending optimistic task changes', async () => {
    const socket = new FakeSocket();
    const cache = new QueryClient();
    const state = vi.fn();
    const cleanup = bindRealtime(socket as unknown as Socket, 'workspace', undefined, cache, state);
    await vi.waitFor(() => expect(state).toHaveBeenLastCalledWith('connected'));
    const invalidate = vi.spyOn(cache, 'invalidateQueries');
    vi.spyOn(cache, 'isMutating').mockReturnValue(1);
    socket.fire('task.updated', { workspaceId: 'other', eventId: '1' });
    expect(invalidate).not.toHaveBeenCalled();
    socket.fire('task.updated', { workspaceId: 'workspace', eventId: '1' });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['tasks', 'workspace'], refetchType: 'none' });
    const count = invalidate.mock.calls.length;
    socket.fire('task.updated', { workspaceId: 'workspace', eventId: '1' });
    expect(invalidate).toHaveBeenCalledTimes(count);
    cleanup();
    cache.clear();
  });
});
