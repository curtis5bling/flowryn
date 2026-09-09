import { realtimeEventNameSchema, type SocketAcknowledgement } from '@flowryn/shared';
import type { QueryClient } from '@tanstack/react-query';
import { io, type Socket } from 'socket.io-client';

const socketUrl = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';
export const connectRealtime = () => io(socketUrl, { withCredentials: true, autoConnect: false, transports: ['websocket', 'polling'] });
export type ConnectionState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting' | 'error';

let recovery: Promise<boolean> | undefined;
const recoverCookieSession = (): Promise<boolean> => {
  const refresh = async () => {
    // Another tab may already have replaced the shared cookies.
    const current = await fetch(`${socketUrl}/api/auth/me`, { credentials: 'include' });
    if (current.ok) return true;
    return (await fetch(`${socketUrl}/api/auth/refresh`, { method: 'POST', credentials: 'include' })).ok;
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
  let recoveryAttempted = false;
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
    recoveryAttempted = false;
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
  const recoverSession = () => {
    if (disposed || recoveryAttempted) return;
    recoveryAttempted = true;
    void recoverCookieSession().then((restored) => {
      if (!disposed && restored) socket.connect();
      else if (!disposed) onState('disconnected');
    }).catch(() => { if (!disposed) onState('disconnected'); });
  };
  const onDisconnect = (reason: string) => {
    generation++;
    onState(reason === 'io server disconnect' ? 'disconnected' : 'reconnecting');
    // An expired access token needs a fresh cookie before a new handshake.
    if (reason === 'io server disconnect') {
      recoverSession();
    }
  };
  const onError = () => { onState('error'); recoverSession(); };
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
    generation++;
    socket.off('connect', onConnect);
    socket.off('disconnect', onDisconnect);
    socket.off('connect_error', onError);
    realtimeEventNameSchema.options.forEach((event) => socket.off(event, onEvent));
    socket.disconnect();
  };
};
