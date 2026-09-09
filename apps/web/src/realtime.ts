import { realtimeEventNameSchema, type SocketAcknowledgement } from '@flowryn/shared';
import type { QueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';

const socketUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
export const connectRealtime = () => io(socketUrl, { withCredentials: true, autoConnect: false, transports: ['websocket', 'polling'] });
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error';

type SessionRecovery = 'restored' | 'unavailable' | 'denied';
let recovery: Promise<SessionRecovery> | undefined;
const recoverCookieSession = (): Promise<SessionRecovery> => {
  const refresh = async (): Promise<SessionRecovery> => {
    // Another tab may already have replaced the shared cookies.
    const current = await fetch(`${socketUrl}/api/auth/me`, { credentials: 'include' });
    if (current.ok) return 'restored';
    if (current.status >= 500) return 'unavailable';
    const response = await fetch(`${socketUrl}/api/auth/refresh`, { method: 'POST', credentials: 'include' });
    return response.ok ? 'restored' : response.status >= 500 ? 'unavailable' : 'denied';
  };
  recovery ??= (async () => {
    if (globalThis.navigator?.locks) return await navigator.locks.request('flowryn-session-refresh', refresh);
    return await refresh();
  })().finally(() => { recovery = undefined; });
  return recovery;
};

export const bindRealtime = (
  socket: Socket, workspaceId: string, projectId: string | undefined,
  queryClient: QueryClient, onState: (state: ConnectionState) => void,
) => {
  let disposed = false;
  let generation = 0;
  type RecoveryState = 'idle' | 'transport-retrying' | 'refreshing-session' | 'reconnecting' | 'connected' | 'terminal-auth-failure';
  let recoveryState: RecoveryState = 'idle';
  let retry: ReturnType<typeof setTimeout> | undefined;
  const seen = new Set<string>();
  const refresh = () => {
    for (const key of ['projects', 'tasks', 'comments', 'notifications', 'notification-count', 'activity', 'presence']) {
      void queryClient.invalidateQueries({ queryKey: [key, workspaceId], refetchType: key === 'tasks' && queryClient.isMutating() > 0 ? 'none' : 'active' });
    }
  };
  const join = (event: 'workspace:join' | 'project:join', id: string) => new Promise<boolean>((resolve) => {
    socket.timeout(5000).emit(event, id, (error: Error | null, result?: SocketAcknowledgement) => resolve(!error && result?.ok === true));
  });
  const onConnect = () => {
    clearTimeout(retry);
    retry = undefined;
    recoveryState = 'connected';
    const current = ++generation;
    void (async () => {
      if (!await join('workspace:join', workspaceId)) throw new Error('Workspace access unavailable');
      if (disposed || current !== generation) return;
      if (projectId && !await join('project:join', projectId)) throw new Error('Project access unavailable');
      if (disposed || current !== generation) return;
      onState('connected');
      refresh();
    })().catch(() => { if (!disposed && current === generation) onState('error'); });
  };
  const terminal = () => {
    recoveryState = 'terminal-auth-failure';
    clearTimeout(retry); retry = undefined;
    socket.disconnect();
    onState('disconnected');
  };
  const retryTransport = () => {
    recoveryState = 'transport-retrying';
    onState('reconnecting');
    retry ??= setTimeout(() => { retry = undefined; if (!disposed) socket.connect(); }, 2000);
  };
  const recoverSession = () => {
    if (disposed || recoveryState === 'refreshing-session' || recoveryState === 'terminal-auth-failure') return;
    if (recoveryState === 'reconnecting') { terminal(); return; }
    clearTimeout(retry); retry = undefined;
    recoveryState = 'refreshing-session';
    const cycle = generation;
    void recoverCookieSession().then((restored) => {
      if (disposed || cycle !== generation) return;
      if (restored === 'unavailable') { retryTransport(); return; }
      if (restored === 'denied') { terminal(); return; }
      recoveryState = 'reconnecting';
      socket.connect();
    }).catch(() => { if (!disposed && cycle === generation) retryTransport(); });
  };
  const onDisconnect = (reason: string) => {
    generation++;
    if (disposed || recoveryState === 'terminal-auth-failure') return;
    recoveryState = 'idle';
    onState(reason === 'io server disconnect' ? 'disconnected' : 'reconnecting');
    if (reason === 'io server disconnect') recoverSession();
  };
  const onError = (error: Error & { data?: { code?: string } }) => {
    if (disposed || recoveryState === 'terminal-auth-failure' || recoveryState === 'refreshing-session') return;
    if (error?.data?.code === 'UNAVAILABLE' || (error?.data?.code !== 'AUTHENTICATION_REQUIRED' && error.message !== 'Authentication required')) {
      retryTransport();
      return;
    }
    onState('error'); recoverSession();
  };
  const onEvent = (message: { eventId?: string; workspaceId?: string }) => {
    if (message.workspaceId !== workspaceId || !message.eventId || seen.has(message.eventId)) return;
    seen.add(message.eventId);
    if (seen.size > 500) seen.delete(seen.values().next().value!);
    refresh();
  };
  socket.on('connect', onConnect);
  socket.on('disconnect', onDisconnect);
  socket.on('connect_error', onError);
  realtimeEventNameSchema.options.forEach((event) => socket.on(event, onEvent));
  onState('connecting');
  socket.connect();
  return () => {
    disposed = true;
    clearTimeout(retry);
    generation++;
    socket.off('connect', onConnect);
    socket.off('disconnect', onDisconnect);
    socket.off('connect_error', onError);
    realtimeEventNameSchema.options.forEach((event) => socket.off(event, onEvent));
    socket.disconnect();
  };
};
