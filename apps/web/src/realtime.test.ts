import { QueryClient } from '@tanstack/react-query';
import type { Socket } from 'socket.io-client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { bindRealtime } from './realtime';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

class FakeSocket {
  listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  joins: string[] = [];
  on(event: string, listener: (...args: unknown[]) => void) {
    const group = this.listeners.get(event) ?? new Set();
    group.add(listener);
    this.listeners.set(event, group);
    return this;
  }
  off(event: string, listener: (...args: unknown[]) => void) {
    this.listeners.get(event)?.delete(listener);
    return this;
  }
  fire(event: string, ...args: unknown[]) {
    this.listeners.get(event)?.forEach((listener) => listener(...args));
  }
  timeout() {
    return this;
  }
  emit(event: string, id: string, callback: (error: null, result: { ok: true }) => void) {
    this.joins.push(`${event}:${id}`);
    callback(null, { ok: true });
  }
  connect() {
    this.fire('connect');
    return this;
  }
  disconnect() {
    return this;
  }
}

describe('real-time lifecycle', () => {
  it('retries temporary coordination failures once per interval and clears retries on cleanup', async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const cache = new QueryClient();
    const state = vi.fn();
    const connect = vi.spyOn(socket, 'connect');
    const cleanup = bindRealtime(socket as unknown as Socket, 'workspace', undefined, cache, state);
    await vi.advanceTimersByTimeAsync(0);
    socket.fire('connect_error', { data: { code: 'UNAVAILABLE' } });
    socket.fire('connect_error', { data: { code: 'UNAVAILABLE' } });
    expect(state).toHaveBeenLastCalledWith('reconnecting');
    await vi.advanceTimersByTimeAsync(2000);
    expect(connect).toHaveBeenCalledTimes(2);
    expect(state).toHaveBeenLastCalledWith('connected');
    socket.fire('connect_error', { data: { code: 'UNAVAILABLE' } });
    cleanup();
    await vi.advanceTimersByTimeAsync(2000);
    expect(connect).toHaveBeenCalledTimes(2);
    cache.clear();
  });

  it('refreshes expired credentials before restoring a disconnected socket', async () => {
    const socket = new FakeSocket();
    const cache = new QueryClient();
    const state = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({ ok: false })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal('fetch', fetchMock);
    const cleanup = bindRealtime(socket as unknown as Socket, 'workspace', 'project', cache, state);
    await vi.waitFor(() => expect(state).toHaveBeenLastCalledWith('connected'));
    socket.fire('disconnect', 'io server disconnect');
    await vi.waitFor(() => expect(socket.joins).toHaveLength(4));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining('/api/auth/refresh'), {
      method: 'POST',
      credentials: 'include',
    });
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
    expect(socket.joins).toEqual([
      'workspace:join:workspace',
      'project:join:project',
      'workspace:join:workspace',
      'project:join:project',
    ]);
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['presence', 'workspace'] }),
    );
    expect(invalidate).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: ['notifications', 'workspace'] }),
    );
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
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ['tasks', 'workspace'],
      refetchType: 'none',
    });
    const count = invalidate.mock.calls.length;
    socket.fire('task.updated', { workspaceId: 'workspace', eventId: '1' });
    expect(invalidate).toHaveBeenCalledTimes(count);
    cleanup();
    cache.clear();
  });
});

it('recovers an outage spanning token expiration and restores rooms and REST state exactly once', async () => {
  vi.useFakeTimers();
  const socket = new FakeSocket();
  const connect = vi.spyOn(socket, 'connect').mockImplementation(() => socket);
  const cache = new QueryClient();
  const invalidate = vi.spyOn(cache, 'invalidateQueries');
  const state = vi.fn();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: true })
    .mockResolvedValueOnce({ ok: false })
    .mockResolvedValueOnce({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
  const cleanup = bindRealtime(socket as unknown as Socket, 'workspace', 'project', cache, state);
  socket.fire('connect');
  await vi.advanceTimersByTimeAsync(0);
  socket.fire('disconnect', 'io server disconnect');
  await vi.advanceTimersByTimeAsync(0);
  socket.fire('connect_error', { data: { code: 'UNAVAILABLE' } });
  await vi.advanceTimersByTimeAsync(2000);
  socket.fire('connect_error', { data: { code: 'UNAVAILABLE' } });
  // Advance beyond the signed access token lifetime while Redis remains unavailable.
  await vi.advanceTimersByTimeAsync(16 * 60 * 1000);
  socket.fire('connect_error', new Error('Authentication required'));
  socket.fire('connect_error', new Error('Authentication required'));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/refresh'))).toHaveLength(1);
  socket.fire('connect');
  await vi.advanceTimersByTimeAsync(0);
  expect(state).toHaveBeenLastCalledWith('connected');
  expect(socket.joins).toEqual([
    'workspace:join:workspace',
    'project:join:project',
    'workspace:join:workspace',
    'project:join:project',
  ]);
  expect(
    invalidate.mock.calls.filter(([filter]) => filter?.queryKey?.[0] === 'presence'),
  ).toHaveLength(2);
  // Each REST cache, including automation, is refreshed once per successful reconnect.
  const refreshedKeys = invalidate.mock.calls.map(([filter]) => filter?.queryKey?.[0]);
  for (const key of new Set(refreshedKeys))
    expect(refreshedKeys.filter((value) => value === key)).toHaveLength(2);
  expect(refreshedKeys).toContain('automation-rules');
  expect(refreshedKeys).toContain('automation-runs');
  expect([...socket.listeners.values()].every((listeners) => listeners.size === 1)).toBe(true);
  expect(connect).toHaveBeenCalledTimes(5);
  cleanup();
  cache.clear();
  expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  expect(vi.getTimerCount()).toBe(0);
});

it('stops after a terminal refresh failure', async () => {
  vi.useFakeTimers();
  const socket = new FakeSocket();
  const connect = vi.spyOn(socket, 'connect').mockImplementation(() => socket);
  const cache = new QueryClient();
  const state = vi.fn();
  const fetchMock = vi.fn().mockResolvedValue({ ok: false });
  vi.stubGlobal('fetch', fetchMock);
  const cleanup = bindRealtime(socket as unknown as Socket, 'workspace', undefined, cache, state);
  socket.fire('connect_error', new Error('Authentication required'));
  await vi.advanceTimersByTimeAsync(0);
  socket.fire('connect_error', { data: { code: 'UNAVAILABLE' } });
  socket.fire('connect_error', new Error('Authentication required'));
  await vi.advanceTimersByTimeAsync(10000);
  expect(connect).toHaveBeenCalledTimes(1);
  expect(fetchMock).toHaveBeenCalledTimes(2);
  expect(state).toHaveBeenLastCalledWith('disconnected');
  cleanup();
  cache.clear();
});

it('does not reconnect when logout disposes a pending recovery', async () => {
  vi.useFakeTimers();
  const socket = new FakeSocket();
  const connect = vi.spyOn(socket, 'connect').mockImplementation(() => socket);
  let release!: (response: { ok: boolean }) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    ),
  );
  const cache = new QueryClient();
  const cleanup = bindRealtime(socket as unknown as Socket, 'workspace', undefined, cache, vi.fn());
  socket.fire('connect_error', new Error('Authentication required'));
  cleanup();
  release({ ok: true });
  await vi.advanceTimersByTimeAsync(10000);
  expect(connect).toHaveBeenCalledTimes(1);
  expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  cache.clear();
  expect(vi.getTimerCount()).toBe(0);
});

it('retries temporary refresh failures but stops a rejected post-refresh authentication cycle', async () => {
  vi.useFakeTimers();
  const socket = new FakeSocket();
  const connect = vi.spyOn(socket, 'connect').mockImplementation(() => socket);
  const cache = new QueryClient();
  const state = vi.fn();
  const fetchMock = vi
    .fn()
    .mockResolvedValueOnce({ ok: false, status: 503 })
    .mockResolvedValueOnce({ ok: false, status: 401 })
    .mockResolvedValueOnce({ ok: true });
  vi.stubGlobal('fetch', fetchMock);
  const cleanup = bindRealtime(socket as unknown as Socket, 'workspace', undefined, cache, state);
  socket.fire('connect_error', new Error('Authentication required'));
  await vi.advanceTimersByTimeAsync(0);
  expect(state).toHaveBeenLastCalledWith('reconnecting');
  await vi.advanceTimersByTimeAsync(2000);
  socket.fire('connect_error', new Error('Authentication required'));
  await vi.advanceTimersByTimeAsync(0);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  socket.fire('connect_error', new Error('Authentication required'));
  await vi.advanceTimersByTimeAsync(10000);
  expect(state).toHaveBeenLastCalledWith('disconnected');
  expect(connect).toHaveBeenCalledTimes(3);
  expect(fetchMock).toHaveBeenCalledTimes(3);
  cleanup();
  cache.clear();
});

it('restores the incident room and invalidates each cache once per distinct event', async () => {
  const socket = new FakeSocket();
  const cache = new QueryClient();
  const state = vi.fn();
  const cleanup = bindRealtime(
    socket as unknown as Socket,
    'workspace',
    undefined,
    cache,
    state,
    'incident',
  );
  await vi.waitFor(() => expect(state).toHaveBeenLastCalledWith('connected'));
  expect(socket.joins).toEqual(['workspace:join:workspace', 'incident:join:incident']);
  socket.fire('disconnect', 'transport close');
  socket.fire('connect');
  await vi.waitFor(() => expect(socket.joins).toHaveLength(4));
  const invalidate = vi.spyOn(cache, 'invalidateQueries');
  socket.fire('incident.timeline_added', { workspaceId: 'workspace', eventId: 'update-1' });
  socket.fire('incident.timeline_added', { workspaceId: 'workspace', eventId: 'update-1' });
  expect(
    invalidate.mock.calls.filter(([options]) => options?.queryKey?.[0] === 'incident-timeline'),
  ).toHaveLength(1);
  expect([...socket.listeners.values()].every((listeners) => listeners.size === 1)).toBe(true);
  cleanup();
  expect([...socket.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  cache.clear();
});
